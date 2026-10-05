package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestMarkdownMCPResourceUsesConnectionIdentityAndOriginalBytes(t *testing.T) {
	for _, sse := range []bool{false, true} {
		t.Run(fmt.Sprint(sse), func(t *testing.T) {
			uri := "botlink-hub://resource/software/pdf-instance/b3JpZ2luYWw"
			pdf := []byte("%PDF-1.7\n原始PDF内容\n%%EOF\n")
			token := strings.Repeat("original-owner-", 4)
			calls := []string{}
			hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+token {
					t.Error("resource did not use the explicitly configured original identity")
					w.WriteHeader(403)
					return
				}
				var req map[string]any
				_ = json.NewDecoder(r.Body).Decode(&req)
				method := stringValue(req["method"])
				calls = append(calls, method)
				result := map[string]any{}
				if r.Method != "POST" || method != "resources/read" || r.Header.Get("Mcp-Session-Id") != "" || r.Header.Get("MCP-Protocol-Version") != "2026-07-28" || mapValue(req["params"])["uri"] != uri {
					t.Error("resource download changed URI, protocol or frontend session lifecycle")
				}
				result["contents"] = []any{map[string]any{"uri": uri, "mimeType": "application/pdf", "blob": base64.StdEncoding.EncodeToString(pdf)}}
				response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": result})
				if sse {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", response)
				} else {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write(response)
				}
			}))
			defer hub.Close()
			root := t.TempDir()
			tokenFile := filepath.Join(root, "original.token")
			_ = os.WriteFile(tokenFile, []byte(token), 0600)
			manager := NewSessionManager(root)
			session := newSession("owned", "PDF", "codex-structured", ToolInfo{Key: "codex"}, root)
			session.environment = []string{"GLAD_WORKBENCH_MCP_URL=" + hub.URL, "GLAD_WORKBENCH_MCP_TOKEN_FILE=" + tokenFile}
			manager.sessions[session.ID] = session
			server := &Server{sessions: manager}
			mux := http.NewServeMux()
			server.registerWorkspaceRoutes(mux)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest("GET", "/api/sessions/owned/mcp-resource?uri="+url.QueryEscape(uri), nil))
			if response.Code != 200 || response.Body.String() != string(pdf) || response.Header().Get("Content-Type") != "application/pdf" {
				t.Fatalf("original PDF was not downloadable: %d %q", response.Code, response.Body.String())
			}
			if len(calls) != 1 || strings.Contains(response.Body.String(), token) || response.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("download changed the business operation or exposed credentials")
			}
		})
	}
}

func TestMarkdownMCPResourceDoesNotSubstituteIdentity(t *testing.T) {
	root := t.TempDir()
	manager := NewSessionManager(root)
	manager.sessions["owned"] = newSession("owned", "PDF", "codex-structured", ToolInfo{Key: "codex"}, root)
	server := &Server{sessions: manager}
	mux := http.NewServeMux()
	server.registerWorkspaceRoutes(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("GET", "/api/sessions/owned/mcp-resource?uri=botlink-hub://resource/software/pdf/old", nil))
	if response.Code != 409 || !strings.Contains(response.Body.String(), "原用户") {
		t.Fatal("missing identity did not report a configuration error")
	}
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) }))
	defer hub.Close()
	tokenFile := filepath.Join(root, "restricted.token")
	_ = os.WriteFile(tokenFile, []byte(strings.Repeat("restricted", 8)), 0600)
	manager.sessions["owned"].environment = []string{"GLAD_WORKBENCH_MCP_URL=" + hub.URL, "GLAD_WORKBENCH_MCP_TOKEN_FILE=" + tokenFile}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("GET", "/api/sessions/owned/mcp-resource?uri=botlink-hub://resource/software/pdf/old", nil))
	if response.Code != 403 {
		t.Fatal("restricted identity was replaced by another credential")
	}
}

func TestMarkdownMCPResponseJoinsSSEDataAndMatchesRequest(t *testing.T) {
	stream := ": heartbeat\r\n\r\n" +
		"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\r\n\r\n" +
		"data: {\"jsonrpc\":\"2.0\",\"id\":\"other\",\"result\":{}}\r\n\r\n" +
		"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"resources/read\",\r\n" +
		"data: \"result\":{\"contents\":[]}}\r\n\r\n"
	result, err := decodeMarkdownMCPResponse(strings.NewReader(stream), "text/event-stream", "resources/read")
	if err != nil || mapValue(result["result"])["contents"] == nil {
		t.Fatalf("valid multiline SSE response was rejected: %v", err)
	}
}

func TestMarkdownMCPResponseRejectsMalformedEnvelope(t *testing.T) {
	for _, payload := range []string{
		`{"id":"resources/read","result":{}}`,
		`{"jsonrpc":"1.0","id":"resources/read","result":{}}`,
		`{"jsonrpc":"2.0","id":"resources/read","result":"invalid"}`,
		`{"jsonrpc":"2.0","id":"resources/read","result":{},"error":{}}`,
	} {
		if _, err := decodeMarkdownMCPResponse(strings.NewReader(payload), "application/json", "resources/read"); err == nil {
			t.Fatal("malformed envelope accepted")
		}
	}
}

func TestOrdinaryGladSessionDownloadsResourceWithExplicitOriginalIdentity(t *testing.T) {
	lifecycleHome(t)
	t.Setenv("GLAD_SKILL_SESSION_ROOT", t.TempDir())
	uri := "botlink-hub://resource/software/pdf/original"
	pdf := "%PDF-1.7\nfirst delivered file\n%%EOF\n"
	token := strings.Repeat("ordinary-original-owner-", 3)
	tokenFile := filepath.Join(t.TempDir(), "original-owner.token")
	if err := os.WriteFile(tokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if r.Header.Get("Authorization") != "Bearer "+token || input["method"] != "resources/read" || r.Header.Get("Mcp-Session-Id") != "" {
			t.Error("ordinary page changed original identity or resource lifecycle")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": input["id"], "result": map[string]any{"contents": []any{
			map[string]any{"uri": uri, "blob": base64.StdEncoding.EncodeToString([]byte(pdf)), "mimeType": "application/pdf"},
		}}})
	}))
	defer hub.Close()
	t.Setenv("GLAD_WORKBENCH_MCP_URL", hub.URL)
	t.Setenv("GLAD_WORKBENCH_MCP_TOKEN_FILE", tokenFile)
	t.Setenv("GLAD_UNRELATED_PRIVATE_SETTING", "must-not-copy")
	server, err := NewServer(t.TempDir(), 0, fstest.MapFS{})
	if err != nil {
		t.Fatal(err)
	}
	session, err := server.sessions.Create(context.Background(), CreateSessionRequest{ToolKey: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Provider.Close(context.Background()); session.cancel() })
	if len(session.environment) != 2 {
		t.Fatal("ordinary session did not capture exactly the two explicit metadata fields")
	}
	mux := http.NewServeMux()
	server.registerWorkspaceRoutes(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("GET", "/api/sessions/"+session.ID+"/mcp-resource?uri="+url.QueryEscape(uri), nil))
	if response.Code != 200 || response.Body.String() != pdf || calls != 1 {
		t.Fatalf("ordinary first resource could not be downloaded: status=%d calls=%d", response.Code, calls)
	}
	// 同进程另一个未配置 WSS 目标仍拒绝普通页面身份，显式空值也覆盖子进程继承。
	wss, err := newWorkbenchServer(t.TempDir(), fstest.MapFS{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(wss.sessions.environment, ";") != "GLAD_WORKBENCH_MCP_URL=;GLAD_WORKBENCH_MCP_TOKEN_FILE=" {
		t.Fatal("unconfigured WSS target inherited ordinary identity metadata")
	}
	wssSession, err := wss.sessions.Create(context.Background(), CreateSessionRequest{ToolKey: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = wssSession.Provider.Close(context.Background()); wssSession.cancel() })
	childMetadata, err := os.ReadFile(filepath.Join(wssSession.WorkingDirectory, "codex-environment.json"))
	var inherited map[string]string
	if err != nil || json.Unmarshal(childMetadata, &inherited) != nil || inherited["url"] != "" || inherited["tokenFile"] != "" {
		t.Fatal("unconfigured WSS child inherited ordinary MCP metadata")
	}
	wssMux := http.NewServeMux()
	wss.registerWorkspaceRoutes(wssMux)
	response = httptest.NewRecorder()
	wssMux.ServeHTTP(response, httptest.NewRequest("GET", "/api/sessions/"+wssSession.ID+"/mcp-resource?uri="+url.QueryEscape(uri), nil))
	if response.Code != 409 || calls != 1 {
		t.Fatal("unconfigured WSS resource substituted ordinary credentials")
	}
}
