package app

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestWorkbenchSecurityInvalidHTTPMessagesDoNotPanic(t *testing.T) {
	for _, body := range []string{"null", "[]", `"text"`, "{"} {
		t.Run("body_"+body, func(t *testing.T) {
			bridge := &workbenchBridge{server: &Server{baseDir: t.TempDir()},
				ctx: context.Background(), owned: map[string]bool{}, mux: http.NewServeMux()}
			response := httptest.NewRecorder()
			// JSON null 是合法 JSON，但不能作为创建会话的对象写入。
			err := bridge.serveRequest(response, workbenchMessage{Method: http.MethodPost,
				Path: "/api/sessions", Body: base64.StdEncoding.EncodeToString([]byte(body))})
			if err == nil && response.Code < http.StatusBadRequest {
				t.Fatal("invalid session body was accepted")
			}
		})
	}
	for _, method := range []string{"", "INVALID\nMETHOD", "GET\r", "TRACE"} {
		t.Run("method_"+method, func(t *testing.T) {
			root := t.TempDir()
			manager := NewSessionManager(root)
			session := newSession("owned", "security test", "codex-structured", ToolInfo{Key: "codex"}, root)
			t.Cleanup(session.cancel)
			manager.sessions[session.ID] = session
			bridge := &workbenchBridge{ctx: context.Background(), owned: map[string]bool{"owned": true},
				server: &Server{sessions: manager}, mux: http.NewServeMux()}
			// 使用有效路由，避免请求在进入 method 校验前就因路径被拒绝。
			bridge.mux.HandleFunc("/api/sessions/owned/metadata", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			})
			response := httptest.NewRecorder()
			err := bridge.serveRequest(response, workbenchMessage{Method: method, Path: "/api/sessions/owned/metadata"})
			if err == nil && response.Code < http.StatusBadRequest {
				t.Fatal("invalid or unauthorized HTTP method was accepted")
			}
		})
	}
}

func TestWorkbenchClaudeApprovalMatchesLocalActions(t *testing.T) {
	for _, action := range []string{"bypass", "allow-edits", "allow-tool"} {
		t.Run(action, func(t *testing.T) {
			payload := map[string]any{"type": "claude-permission", "id": "pending",
				"approved": true, "action": action}
			if !workbenchPayloadAllowed(payload) {
				t.Fatalf("local approval action %q was blocked", action)
			}
		})
	}
	for _, payload := range []map[string]any{
		{"type": "claude-permission", "id": "pending", "approved": true, "action": "approved"},
		{"type": "claude-permission", "id": "pending", "approved": true, "action": "allow-once"},
		{"type": "claude-permission", "id": "pending", "approved": false},
	} {
		if !workbenchPayloadAllowed(payload) {
			t.Fatal("ordinary one-time approval or denial was blocked")
		}
	}
}

func TestWorkbenchSecurityMissingMetadataAllowsRecovery(t *testing.T) {
	server := &Server{sessions: NewSessionManager(t.TempDir())}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sessions/{id}/metadata", server.sessionMetadata)
	bridge := &workbenchBridge{server: server, mux: mux, ctx: context.Background(), owned: map[string]bool{}}
	response := httptest.NewRecorder()
	err := bridge.serveRequest(response, workbenchMessage{Method: http.MethodGet,
		Path: "/api/sessions/previous-connection-id/metadata"})
	// 显式重连后旧 runtime ID 不存在；404 让工作台进入保存的 native ID 恢复分支。
	if err != nil || response.Code != http.StatusNotFound {
		t.Fatalf("missing metadata must be recoverable as 404: status=%d error=%v", response.Code, err)
	}
	foreign := newSession("foreign", "other session", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	t.Cleanup(foreign.cancel)
	server.sessions.sessions[foreign.ID] = foreign
	response = httptest.NewRecorder()
	err = bridge.serveRequest(response, workbenchMessage{Method: http.MethodGet, Path: "/api/sessions/foreign/metadata"})
	if err == nil && response.Code != http.StatusForbidden {
		t.Fatal("existing foreign session metadata must remain forbidden")
	}
}

func TestWorkbenchSecuritySessionSettingsDoNotPersistSharedDefaults(t *testing.T) {
	root := t.TempDir()
	server, err := newWorkbenchServer(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if server.config != nil || server.sessions.config != nil {
		t.Fatal("outbound bridge is attached to the user's shared Glad configuration")
	}
	session := newSession("owned", "security test", "codex-structured", ToolInfo{Key: "codex"}, root)
	t.Cleanup(session.cancel)
	provider := NewCodexProvider(session, map[string]any{"permissionMode": "on-request", "sandboxMode": "workspace-write"})
	provider.defaultsStore = server.sessions.config
	session.Provider = provider
	server.sessions.sessions[session.ID] = session
	mux := http.NewServeMux()
	server.registerProviderRoutes(mux)
	bridge := &workbenchBridge{server: server, mux: mux, ctx: context.Background(), owned: map[string]bool{"owned": true}}
	response := httptest.NewRecorder()
	body := base64.StdEncoding.EncodeToString([]byte(`{"model":"synthetic-test-model","sandboxMode":"read-only"}`))
	err = bridge.serveRequest(response, workbenchMessage{Method: http.MethodPatch,
		Path: "/api/sessions/owned/codex-settings", Body: body, ContentType: "application/json"})
	if err != nil || response.Code != http.StatusOK {
		t.Fatalf("ordinary settings update failed: status=%d error=%v", response.Code, err)
	}
	if provider.options["model"] != "synthetic-test-model" || provider.defaultsStore != nil {
		t.Fatal("session settings must update only the bridge session")
	}
}

// 生成独立 CA 及其签发的 localhost 证书，验证时保留正常 TLS 校验。
func workbenchSecurityTLSServer(t *testing.T, handler http.Handler) (*httptest.Server, string) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: now.Add(-time.Minute),
		NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: now.Add(-time.Minute),
		NotAfter: now.Add(time.Hour), DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12,
		Certificates: []tls.Certificate{{Certificate: [][]byte{leafDER, caDER}, PrivateKey: leafKey}}}
	server.StartTLS()
	t.Cleanup(server.Close)
	caPath := filepath.Join(t.TempDir(), "test-ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return server, caPath
}

func TestWorkbenchSecurityRejectsTLSRedirectDowngrade(t *testing.T) {
	var plaintextRequests atomic.Int32
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plaintextRequests.Add(1)
		connection, err := websocket.Accept(w, r, nil)
		if err == nil {
			defer connection.CloseNow()
		}
	}))
	t.Cleanup(plain.Close)
	secure, caPath := workbenchSecurityTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL+"/api/assistant-connections/ws", http.StatusTemporaryRedirect)
	}))
	client, err := workbenchTLSClient(caPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, strings.Replace(secure.URL, "https://", "wss://", 1)+"/api/assistant-connections/ws",
		&websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Authorization": {"Bearer synthetic-security-test-credential"}}})
	if connection != nil {
		_ = connection.CloseNow()
	}
	if err == nil || plaintextRequests.Load() != 0 {
		t.Fatal("WSS redirect reached a plaintext endpoint and could disclose credentials")
	}
}

func TestWorkbenchSecurityAcceptsTrustedTLSWithoutRedirect(t *testing.T) {
	secure, caPath := workbenchSecurityTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, nil)
		if err == nil {
			defer connection.CloseNow()
		}
	}))
	client, err := workbenchTLSClient(caPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(ctx, strings.Replace(secure.URL, "https://", "wss://", 1),
		&websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if response.TLS == nil {
		t.Fatal("trusted connection did not use TLS")
	}
}

func TestWorkbenchSecurityMarkdownUsesResourceForwardingProtocol(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("执行实际 Markdown renderer 的转发协议需要 Node")
	}
	source, err := filepath.Abs("../../lib/web/markdown.js")
	if err != nil {
		t.Fatal(err)
	}
	// 仅替代 Markdown 库的注册接口，执行仓库里的真实 link/image renderer。
	const script = `
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const prefix = '/agent-workbench/api/assistant-connections/test-glad/ui/';
const renderer = {rules: {image: () => ''}, renderToken: () => ''};
const parser = {renderer, use() {}, inline: {ruler: {before() {}}}};
const window = {
  markdownit: () => parser, markdownitTaskLists: () => {},
  gladWorkbenchResourceURL: value => value.startsWith('/') ? prefix + value.slice(1) : value
};
const context = {window, document: {addEventListener() {}}, texmath: () => {}};
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), context);
function token(key, value) {
  return {attrs: {[key]: value}, attrGet(k) {return this.attrs[k];},
    attrSet(k, v) {this.attrs[k] = v;}};
}
const image = token('src', 'diagram.png');
renderer.rules.image([image], 0, {}, {sessionId: 'owned'}, renderer);
assert.strictEqual(image.attrs.src, prefix + 'api/sessions/owned/workspace-resource?path=diagram.png');
const link = token('href', 'result.txt');
renderer.rules.link_open([link], 0, {}, {sessionId: 'owned'}, renderer);
assert.strictEqual(link.attrs.href, prefix + 'api/sessions/owned/workspace-resource?path=result.txt');
assert.strictEqual(link.attrs.target, '_blank');
const external = token('href', 'https://external.example/result');
renderer.rules.link_open([external], 0, {}, {sessionId: 'owned'}, renderer);
assert.strictEqual(external.attrs.href, 'https://external.example/result');
`
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, node, "-e", script, source).CombinedOutput(); err != nil {
		t.Fatalf("Markdown resource forwarding failed: %v\n%s", err, output)
	}
}
