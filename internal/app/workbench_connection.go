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
	"net"
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
	Type           string         `json:"type"`
	ID             string         `json:"id,omitempty"`
	Method         string         `json:"method,omitempty"`
	Path           string         `json:"path,omitempty"`
	Body           string         `json:"body,omitempty"`
	ContentType    string         `json:"content_type,omitempty"`
	Status         int            `json:"status,omitempty"`
	SessionID      string         `json:"session_id,omitempty"`
	Payload        map[string]any `json:"payload,omitempty"`
	ClientID       string         `json:"client_id,omitempty"`
	ThreadID       string         `json:"thread_id,omitempty"`
	ToolKey        string         `json:"tool_key,omitempty"`
	WorkbenchID    string         `json:"workbench_id,omitempty"`
	WorkbenchAlias string         `json:"workbench_alias,omitempty"`
	Settings       map[string]any `json:"settings,omitempty"`
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

// 连接只管理自己创建的会话，普通 Glad 的群聊和其他会话保持独立。
func newWorkbenchServer(baseDir string, assets fs.FS) (*Server, error) {
	server := &Server{baseDir: baseDir, assets: assets, sessions: NewSessionManager(baseDir), attachments: NewAttachmentStore()}
	empty := &ConfigStore{data: map[string]any{}}
	server.notifications = NewNotificationService(empty, server.sessions, nil)
	server.skillhub = NewSkillHubService(empty, server.sessions)
	return server, nil
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
	if _, err := normalizeWorkbenchURL(*address); err != nil {
		return err
	}
	if *tokenPath == "" || flags.NArg() != 0 {
		return errors.New("需要 --token-file 指定客户端凭据")
	}
	tokenBytes, err := os.ReadFile(*tokenPath)
	if err != nil {
		return fmt.Errorf("读取客户端凭据: %w", err)
	}
	certificate := []byte(nil)
	if *caPath != "" {
		certificate, err = os.ReadFile(*caPath)
		if err != nil {
			return err
		}
	}
	sharing, err := OpenWorkbenchSharing(*directory, assets)
	if err != nil {
		return err
	}
	options := workbenchConnectOptions{URL: *address, Token: strings.TrimSpace(string(tokenBytes)), CACertificate: string(certificate),
		Directory: *directory, MCPURL: *mcpURL, MCPTokenFile: *mcpToken, GladID: sharing.config.GladID, Alias: *name}
	if *name == "Glad" {
		options.Alias = sharing.config.Alias
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	fmt.Println("GLAD_WORKBENCH_CONNECTING")
	// 心跳仍同步工作台身份，连接成功日志只输出一次。
	var connected sync.Once
	return connectWorkbench(ctx, options, assets, func(*workbenchBridge, string, string) {
		connected.Do(func() { fmt.Println("GLAD_WORKBENCH_CONNECTED") })
	})
}

type workbenchConnectOptions struct {
	URL, Token, CACertificate, Directory, MCPURL, MCPTokenFile, GladID, Alias string
	Config                                                                    *ConfigStore
}

func connectWorkbench(parent context.Context, options workbenchConnectOptions, assets fs.FS, observer func(*workbenchBridge, string, string)) error {
	address, err := normalizeWorkbenchURL(options.URL)
	if err != nil {
		return err
	}
	endpoint, _ := url.Parse(address)
	token := strings.TrimSpace(options.Token)
	if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		return errors.New("客户端凭据无效")
	}
	baseDir, err := filepath.Abs(options.Directory)
	if err != nil {
		return err
	}
	if info, err := os.Stat(baseDir); err != nil || !info.IsDir() {
		return errors.New("本地工作目录不存在")
	}
	if (options.MCPURL == "") != (options.MCPTokenFile == "") {
		return errors.New("MCPHub 地址和凭据文件需要同时配置")
	}
	client, err := workbenchTLSClientPEM([]byte(options.CACertificate))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
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
	// MCP 路由仅传给本连接创建的 CLI 子进程，不改动 Glad 其他会话的环境。
	if options.MCPURL != "" {
		server.sessions.environment = []string{"GLAD_WORKBENCH_MCP_URL=" + options.MCPURL, "GLAD_WORKBENCH_MCP_TOKEN_FILE=" + options.MCPTokenFile}
	}
	if options.Config != nil {
		server.config = options.Config
		server.sessions.config = options.Config
		server.notifications = NewNotificationService(options.Config, server.sessions, nil)
		server.skillhub = NewSkillHubService(options.Config, server.sessions)
	}
	server.notifications.Start(ctx)
	defer server.notifications.Close()
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
	if err := bridge.write(map[string]any{"type": "hello", "protocol": "glad-workbench/v1", "name": options.Alias, "glad_id": options.GladID, "tools": tools}); err != nil {
		return err
	}
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
			if observer != nil {
				observer(bridge, message.WorkbenchID, message.WorkbenchAlias)
			}
		case "pong":
			if observer != nil && message.WorkbenchID != "" {
				observer(bridge, message.WorkbenchID, message.WorkbenchAlias)
			}
		case "http_request":
			bridge.tasks.Add(1)
			go func() { defer bridge.tasks.Done(); bridge.httpRequest(message) }()
		case "socket_open":
			bridge.openStream(message)
		case "socket_data":
			bridge.mu.Lock()
			stream := bridge.streams[message.ID]
			bridge.mu.Unlock()
			allowed := workbenchPayloadAllowed(message.Payload)

			if stream != nil && allowed {
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
	var data []byte
	var err error
	if caPath != "" {
		data, err = os.ReadFile(caPath)
		if err != nil {
			return nil, err
		}
	}
	return workbenchTLSClientPEM(data)
}

func workbenchTLSClientPEM(data []byte) (*http.Client, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	if len(data) > 0 {
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(data) {
			return nil, errors.New("CA 证书格式无效")
		}
		config.RootCAs = roots
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: config, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second, DialContext: (&net.Dialer{Timeout: 15 * time.Second}).DialContext}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
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
	if message.Method != http.MethodGet && message.Method != http.MethodPost && message.Method != http.MethodPut && message.Method != http.MethodPatch && message.Method != http.MethodDelete {
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
		// 会话目录由共享配置固定；模型和权限选项沿用 Glad 的同一套会话操作。
		value["workingDirectory"] = bridge.server.baseDir
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
		if strings.HasSuffix(path, "-settings") {
			var settings map[string]any
			if json.Unmarshal(body, &settings) != nil || !workbenchSettingsAllowed(settings) {
				return errors.New("工作台不能扩大本地执行权限")
			}
		}
	} else if !((message.Method == http.MethodGet && !strings.HasPrefix(path, "/api/")) ||
		(message.Method == http.MethodGet && (path == "/api/config" || path == "/api/tools" || path == "/api/claude-config" || path == "/api/sessions" || path == "/api/skillhub/status" || path == "/api/skillhub/skills")) ||
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

// 与 Glad 本地界面相同的权限枚举；设置最终由对应后端处理。
func workbenchSettingsAllowed(settings map[string]any) bool {
	if mode, ok := settings["permissionMode"]; ok {
		switch mode {
		case "default", "on-request", "on-failure", "untrusted", "never", "manual", "auto", "acceptEdits", "bypassPermissions", "dontAsk", "plan":
		default:
			return false
		}
	}
	if mode, ok := settings["sandboxMode"]; ok {
		switch mode {
		case "default", "read-only", "workspace-write", "danger-full-access":
		default:
			return false
		}
	}
	return true
}

func workbenchPayloadAllowed(payload map[string]any) bool {
	kind := stringValue(payload["type"])
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
