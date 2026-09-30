package app

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

type workbenchMessage struct {
	Type        string         `json:"type"`
	ID          string         `json:"id,omitempty"`
	Method      string         `json:"method,omitempty"`
	Path        string         `json:"path,omitempty"`
	Body        string         `json:"body,omitempty"`
	ContentType string         `json:"content_type,omitempty"`
	Status      int            `json:"status,omitempty"`
	SessionID   string         `json:"session_id,omitempty"`
	Payload     map[string]any `json:"payload,omitempty"`
	ClientID    string         `json:"client_id,omitempty"`
	ThreadID    string         `json:"thread_id,omitempty"`
	ToolKey     string         `json:"tool_key,omitempty"`
}

type workbenchStream struct {
	session *Session
	ctx     context.Context
	cancel  context.CancelFunc
}

type workbenchBridge struct {
	server       *Server
	mux          *http.ServeMux
	connection   *websocket.Conn
	ctx          context.Context
	sendMu       sync.Mutex
	mu           sync.Mutex
	owned        map[string]bool
	streams      map[string]*workbenchStream
	tasks        sync.WaitGroup
	threads      map[string]bool
	threadFile   string
	threadsDirty bool
}

// newWorkbenchServer 只创建连接所需的会话与临时附件，不打开共享 Glad 配置和群聊数据。
func newWorkbenchServer(baseDir string, assets fs.FS) (*Server, error) {
	return &Server{baseDir: baseDir, assets: assets,
		sessions: NewSessionManager(baseDir), attachments: NewAttachmentStore()}, nil
}

func runWorkbenchConnection(arguments []string, assets fs.FS) error {
	flags := flag.NewFlagSet("connect", flag.ContinueOnError)
	address := flags.String("url", "", "工作台 WSS 连接地址")
	tokenPath := flags.String("token-file", "", "客户端凭据文件")
	caPath := flags.String("ca-file", "", "私有 CA 文件；省略时使用系统证书")
	name := flags.String("name", "Glad", "工作台显示的助理名称")
	directory := flags.String("directory", ".", "本地会话工作目录")
	mcpURL := flags.String("mcp-url", "", "此连接使用的 BotLink MCPHub 地址")
	mcpToken := flags.String("mcp-token-file", "", "此连接使用的 MCPHub 凭据文件")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	endpoint, err := url.Parse(*address)
	if err != nil || endpoint.Scheme != "wss" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.Path != "/api/assistant-connections/ws" {
		return errors.New("--url 必须是工作台的 wss://<地址>/api/assistant-connections/ws")
	}
	if *tokenPath == "" || flags.NArg() != 0 {
		return errors.New("用法: glad connect --url <wss-url> --token-file <path> [--ca-file <path>] [--directory <path>]")
	}
	if (*mcpURL == "") != (*mcpToken == "") {
		return errors.New("--mcp-url 和 --mcp-token-file 必须同时配置")
	}
	if *mcpURL != "" {
		if err := os.Setenv("GLAD_WORKBENCH_MCP_URL", *mcpURL); err != nil {
			return err
		}
		if err := os.Setenv("GLAD_WORKBENCH_MCP_TOKEN_FILE", *mcpToken); err != nil {
			return err
		}
	}
	tokenBytes, err := os.ReadFile(*tokenPath)
	if err != nil {
		return fmt.Errorf("读取客户端凭据: %w", err)
	}
	token := strings.TrimSpace(string(tokenBytes))
	if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		return errors.New("客户端凭据无效")
	}
	baseDir, err := filepath.Abs(*directory)
	if err != nil {
		return err
	}
	if info, err := os.Stat(baseDir); err != nil || !info.IsDir() {
		return errors.New("本地工作目录不存在")
	}
	client, err := workbenchTLSClient(*caPath)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, endpoint.String(), &websocket.DialOptions{
		HTTPClient: client, HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}},
	})
	if err != nil {
		return fmt.Errorf("连接工作台: %w", err)
	}
	defer connection.CloseNow()
	connection.SetReadLimit(32 << 20)
	server, err := newWorkbenchServer(baseDir, assets)
	if err != nil {
		return err
	}
	bridge := &workbenchBridge{server: server, mux: http.NewServeMux(), connection: connection,
		ctx: ctx, owned: map[string]bool{}, streams: map[string]*workbenchStream{}, threads: map[string]bool{}}
	server.registerRoutes(bridge.mux)
	defer func() {
		cancel()
		bridge.tasks.Wait()
		bridge.rememberAllThreads()
		server.sessions.Close(context.Background())
	}()
	tools := []string{}
	for _, tool := range detectTools(ctx) {
		if tool.Installed {
			tools = append(tools, tool.Key)
		}
	}
	if err := bridge.write(map[string]any{"type": "hello", "protocol": "glad-workbench/v1", "name": *name, "tools": tools}); err != nil {
		return err
	}
	fmt.Printf("GLAD_WORKBENCH_CONNECTING %s\n", endpoint.Host)
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = connection.Close(websocket.StatusNormalClosure, "client disconnected")
				return
			case <-ticker.C:
				if bridge.write(map[string]any{"type": "ping"}) != nil {
					_ = connection.CloseNow()
					return
				}
			}
		}
	}()
	// 此命令只尝试一次连接；主动断开后不会自动重连，也没有网络监听端口。
	for {
		readCtx, readCancel := context.WithTimeout(ctx, 45*time.Second)
		_, data, err := connection.Read(readCtx)
		readCancel()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("工作台连接已结束: %w", err)
		}
		var message workbenchMessage
		if json.Unmarshal(data, &message) != nil {
			return errors.New("工作台消息格式无效")
		}
		switch message.Type {
		case "connected":
			if err := bridge.loadThreads(endpoint.String(), message.ClientID); err != nil {
				return err
			}
			fmt.Println("GLAD_WORKBENCH_CONNECTED")
		case "pong":
		case "http_request":
			bridge.tasks.Add(1)
			go func() { defer bridge.tasks.Done(); bridge.httpRequest(message) }()
		case "socket_open":
			bridge.openStream(message)
		case "socket_data":
			bridge.mu.Lock()
			stream := bridge.streams[message.ID]
			bridge.mu.Unlock()
			if stream != nil && workbenchPayloadAllowed(message.Payload) {
				bridge.tasks.Add(1)
				go func() {
					defer bridge.tasks.Done()
					server.handleWebsocketMessage(stream.ctx, stream.session,
						func(payload map[string]any) bool { return bridge.streamData(message.ID, payload) == nil }, message.Payload)
				}()
			}
		case "socket_close":
			bridge.closeStream(message.ID)
		default:
			return errors.New("工作台消息类型无效")
		}
	}
}

func workbenchTLSClient(caPath string) (*http.Client, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	if caPath != "" {
		data, err := os.ReadFile(caPath)
		if err != nil {
			return nil, fmt.Errorf("读取工作台 CA: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(data) {
			return nil, errors.New("工作台 CA 文件无效")
		}
		config.RootCAs = roots
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: config},
		// 拒绝全部重定向，认证头只能发送给最初校验的 WSS 入口。
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

func (bridge *workbenchBridge) write(message any) error {
	bridge.sendMu.Lock()
	defer bridge.sendMu.Unlock()
	ctx, cancel := context.WithTimeout(bridge.ctx, 5*time.Second)
	defer cancel()
	return writeWSJSON(ctx, bridge.connection, message)
}

func (bridge *workbenchBridge) owns(sessionID string) bool {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.owned[sessionID]
}

func (bridge *workbenchBridge) httpRequest(message workbenchMessage) {
	response := httptest.NewRecorder()
	err := bridge.serveRequest(response, message)
	if err != nil {
		response = httptest.NewRecorder()
		respondError(response, http.StatusForbidden, err)
	}
	if response.Body.Len() > 8<<20 {
		response = httptest.NewRecorder()
		respondError(response, http.StatusRequestEntityTooLarge, errors.New("响应超过连接大小限制"))
	}
	_ = bridge.write(workbenchMessage{Type: "http_response", ID: message.ID, Status: response.Code,
		Body: base64.StdEncoding.EncodeToString(response.Body.Bytes()), ContentType: response.Header().Get("Content-Type")})
}

func (bridge *workbenchBridge) serveRequest(writer *httptest.ResponseRecorder, message workbenchMessage) error {
	if message.Method != http.MethodGet && message.Method != http.MethodPost && message.Method != http.MethodPatch && message.Method != http.MethodDelete {
		return errors.New("请求方法无效")
	}
	parsed, err := url.ParseRequestURI(message.Path)
	if err != nil || parsed.Host != "" || parsed.Scheme != "" || strings.Contains(parsed.Path, "..") || strings.HasPrefix(message.Path, "//") {
		return errors.New("请求路径无效")
	}
	body, err := base64.StdEncoding.DecodeString(message.Body)
	if err != nil || len(body) > 8<<20 {
		return errors.New("请求正文无效或过大")
	}
	path := parsed.Path
	if path == "/api/sessions" && message.Method == http.MethodPost {
		var value map[string]any
		if json.Unmarshal(body, &value) != nil || value == nil {
			return errors.New("创建对话参数无效")
		}
		// 目录与执行权限由本地客户端固定，远端创建会话时不能扩大本地权限。
		value["workingDirectory"] = bridge.server.baseDir
		value["codexOptions"] = map[string]any{"permissionMode": "on-request", "sandboxMode": "workspace-write"}
		value["claudeOptions"] = map[string]any{"permissionMode": "manual"}
		body, _ = json.Marshal(value)
	} else if strings.HasPrefix(path, "/api/sessions/") {
		parts := strings.Split(strings.TrimPrefix(path, "/api/sessions/"), "/")
		if !bridge.owns(parts[0]) {
			if message.Method == http.MethodGet && strings.HasSuffix(path, "/metadata") && bridge.server.sessions.Get(parts[0]) == nil {
				// 上一次连接的 runtime 会话已不存在；工作台可据此恢复保存的原生对话。
				respondError(writer, http.StatusNotFound, errors.New("Session not found"))
				return nil
			}
			return errors.New("工作台只能访问此连接创建的对话")
		}
		if strings.Contains(path, "global-defaults") || strings.Contains(path, "resume-threads") || strings.Contains(path, "resume-sessions") || strings.Contains(path, "thread-preview") || strings.Contains(path, "session-preview") || strings.Contains(path, "timed-inputs") || strings.Contains(path, "serverchan") {
			return errors.New("此本地历史或全局接口未开放给工作台")
		}
		if strings.HasSuffix(path, "-resume") || strings.HasSuffix(path, "-fork") {
			var value map[string]any
			if json.Unmarshal(body, &value) != nil {
				return errors.New("恢复参数无效")
			}
			var thread string
			switch {
			case strings.HasSuffix(path, "/claude-resume"):
				thread = stringValue(value["resumeSessionId"])
			case strings.HasSuffix(path, "/claude-fork"):
				thread = stringValue(value["claudeSessionId"])
			case strings.HasSuffix(path, "/codex-resume"), strings.HasSuffix(path, "/codex-fork"):
				thread = stringValue(value["threadId"])
			}
			if !bridge.knowsThread(thread) {
				return errors.New("只能恢复此工作台连接曾创建的对话")
			}
		}
		if strings.HasSuffix(path, "-settings") {
			var settings map[string]any
			if json.Unmarshal(body, &settings) != nil || !workbenchSettingsAllowed(settings) {
				return errors.New("工作台不能扩大本地执行权限")
			}
		}
	} else if !((message.Method == http.MethodGet && !strings.HasPrefix(path, "/api/")) ||
		(message.Method == http.MethodGet && (path == "/api/config" || path == "/api/tools" || path == "/api/claude-config" || path == "/api/sessions")) ||
		(path == "/api/debug/client-log" && message.Method == http.MethodPost)) {
		return errors.New("此接口未授权给工作台")
	}
	request, err := http.NewRequestWithContext(bridge.ctx, message.Method, message.Path, bytes.NewReader(body))
	if err != nil {
		return errors.New("请求格式无效")
	}
	if message.ContentType != "" {
		request.Header.Set("Content-Type", message.ContentType)
	}
	bridge.mux.ServeHTTP(writer, request)
	if path == "/api/sessions" && message.Method == http.MethodPost && writer.Code == http.StatusOK {
		var value map[string]any
		if json.Unmarshal(writer.Body.Bytes(), &value) == nil {
			bridge.mu.Lock()
			bridge.owned[stringValue(value["id"])] = true
			bridge.mu.Unlock()
			if session := bridge.server.sessions.Get(stringValue(value["id"])); session != nil {
				bridge.observeThread(session)
			}
		}
	}
	return nil
}

func workbenchSettingsAllowed(settings map[string]any) bool {
	if mode, ok := settings["permissionMode"]; ok && mode != "on-request" && mode != "manual" {
		return false
	}
	if mode, ok := settings["sandboxMode"]; ok && mode != "workspace-write" && mode != "read-only" {
		return false
	}
	return true
}

func workbenchPayloadAllowed(payload map[string]any) bool {
	kind := stringValue(payload["type"])
	if kind == "codex-global-defaults" {
		return false
	}
	if kind == "claude-resume" || kind == "codex-resume" || kind == "claude-fork" || kind == "codex-fork" {
		return false // 原生恢复由工作台使用保存且经本地登记的 thread ID 调用 HTTP 接口。
	}
	if kind == "claude-permission" && boolValue(payload["approved"]) {
		action := stringValue(payload["action"])
		return action == "" || action == "approved" || action == "allow-once"
	}
	if kind == "codex-settings" || kind == "claude-settings" {
		return workbenchSettingsAllowed(mapValue(payload["settings"]))
	}
	return true
}

func (bridge *workbenchBridge) openStream(message workbenchMessage) {
	if !bridge.owns(message.SessionID) {
		_ = bridge.write(workbenchMessage{Type: "socket_closed", ID: message.ID})
		return
	}
	session := bridge.server.sessions.Get(message.SessionID)
	if session == nil {
		_ = bridge.write(workbenchMessage{Type: "socket_closed", ID: message.ID})
		return
	}
	bridge.closeStream(message.ID)
	ctx, cancel := context.WithCancel(bridge.ctx)
	stream := &workbenchStream{session: session, ctx: ctx, cancel: cancel}
	bridge.mu.Lock()
	bridge.streams[message.ID] = stream
	bridge.mu.Unlock()
	subscription, snapshot := session.subscribeWithSnapshot(256)
	kind := "claude-snapshot"
	if session.Kind == "codex-structured" {
		kind = "codex-snapshot"
	}
	_ = bridge.streamData(message.ID, map[string]any{"type": kind, "snapshot": snapshot})
	bridge.tasks.Add(1)
	go func() {
		defer bridge.tasks.Done()
		defer subscription.Close()
		defer bridge.finishStream(message.ID, stream)
		for {
			select {
			case event := <-subscription.Events():
				kind := "claude-event"
				if event.Kind == "codex-structured" {
					kind = "codex-event"
				}
				if bridge.streamData(message.ID, map[string]any{"type": kind, "event": event.Payload}) != nil {
					return
				}
			case <-subscription.Done():
				return
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (bridge *workbenchBridge) finishStream(id string, expected *workbenchStream) {
	bridge.mu.Lock()
	if bridge.streams[id] == expected {
		delete(bridge.streams, id)
	}
	bridge.mu.Unlock()
	expected.cancel()
}

func (bridge *workbenchBridge) streamData(id string, payload map[string]any) error {
	return bridge.write(workbenchMessage{Type: "socket_data", ID: id, Payload: payload})
}

func (bridge *workbenchBridge) closeStream(id string) {
	bridge.mu.Lock()
	stream := bridge.streams[id]
	delete(bridge.streams, id)
	bridge.mu.Unlock()
	if stream != nil {
		stream.cancel()
	}
}
