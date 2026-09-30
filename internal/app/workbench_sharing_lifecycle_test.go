package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

const lifecycleToken = "synthetic-lifecycle-credential-0123456789"

// 所有身份、对话记录和 CLI 探测都放在临时目录，避免读取开发机配置。
func lifecycleHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("GLAD_WORKBENCH_MCP_URL", "")
	t.Setenv("GLAD_WORKBENCH_MCP_TOKEN_FILE", "")
	bin := filepath.Join(home, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	for _, tool := range []string{"codex", "claude"} {
		script := "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '2.1.0\\n'; exit 0; fi\n" +
			"GLAD_LIFECYCLE_HELPER=" + quote(tool) + " exec " + quote(executable) + " -test.run=^TestWorkbenchSharingCLIHelperProcess$\n"
		if err := os.WriteFile(filepath.Join(bin, tool), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	return home
}

// 假 CLI 只实现初始化协议，并从子进程内部记录实际收到的 MCP 环境。
func TestWorkbenchSharingCLIHelperProcess(t *testing.T) {
	tool := os.Getenv("GLAD_LIFECYCLE_HELPER")
	if tool == "" {
		t.Skip("仅由临时假 CLI 调用")
	}
	data, _ := json.Marshal(map[string]string{"url": os.Getenv("GLAD_WORKBENCH_MCP_URL"), "tokenFile": os.Getenv("GLAD_WORKBENCH_MCP_TOKEN_FILE")})
	if err := os.WriteFile(tool+"-environment.json", data, 0600); err != nil {
		os.Exit(2)
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var input map[string]any
		if json.Unmarshal(scanner.Bytes(), &input) != nil {
			continue
		}
		if tool == "claude" && input["type"] == "control_request" {
			_ = encoder.Encode(map[string]any{"type": "control_response", "response": map[string]any{
				"subtype": "success", "request_id": input["request_id"], "response": map[string]any{"commands": []any{}, "models": []any{}},
			}})
		} else if tool == "codex" && input["id"] != nil {
			_ = encoder.Encode(map[string]any{"id": input["id"], "result": map[string]any{"config": map[string]any{}, "data": []any{}}})
		}
	}
	os.Exit(0)
}

type lifecyclePeerConnection struct {
	connection *websocket.Conn
	hello      map[string]any
	messages   chan lifecyclePeerMessage
	closed     chan struct{}
}

type lifecyclePeerMessage struct {
	workbenchMessage
	Name string `json:"name"`
}

type lifecyclePeer struct {
	server   *httptest.Server
	ca       string
	accepted chan *lifecyclePeerConnection
	attempts atomic.Int32
}

func newLifecyclePeer(t *testing.T, reject bool) *lifecyclePeer {
	t.Helper()
	peer := &lifecyclePeer{accepted: make(chan *lifecyclePeerConnection, 8)}
	ctx, cancel := context.WithCancel(context.Background())
	peer.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer.attempts.Add(1)
		if reject || r.Header.Get("Authorization") != "Bearer "+lifecycleToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer connection.CloseNow()
		client := &lifecyclePeerConnection{connection: connection, messages: make(chan lifecyclePeerMessage, 64), closed: make(chan struct{})}
		defer close(client.closed)
		_, data, err := connection.Read(ctx)
		if err != nil || json.Unmarshal(data, &client.hello) != nil {
			return
		}
		if err := writeWSJSON(ctx, connection, workbenchMessage{Type: "connected", ClientID: "test-client", WorkbenchID: "test-workbench", WorkbenchAlias: "工作台初始别名"}); err != nil {
			return
		}
		select {
		case peer.accepted <- client:
		case <-ctx.Done():
			return
		}
		for {
			_, data, err := connection.Read(ctx)
			if err != nil {
				return
			}
			var message lifecyclePeerMessage
			if json.Unmarshal(data, &message) == nil {
				select {
				case client.messages <- message:
				case <-ctx.Done():
					return
				}
			}
		}
	}))
	peer.ca = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: peer.server.Certificate().Raw}))
	t.Cleanup(func() { cancel(); peer.server.Close() })
	return peer
}

func (peer *lifecyclePeer) target(directory string) WorkbenchTarget {
	return WorkbenchTarget{URL: strings.Replace(peer.server.URL, "https://", "wss://", 1), Token: lifecycleToken, CACertificate: peer.ca, WorkingDirectory: directory}
}

func (peer *lifecyclePeer) accept(t *testing.T) *lifecyclePeerConnection {
	t.Helper()
	select {
	case connection := <-peer.accepted:
		return connection
	case <-time.After(3 * time.Second):
		t.Fatal("没有收到工作台连接")
		return nil
	}
}

func (connection *lifecyclePeerConnection) send(t *testing.T, message any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := writeWSJSON(ctx, connection.connection, message); err != nil {
		t.Fatal(err)
	}
}

func (connection *lifecyclePeerConnection) waitClosed(t *testing.T) {
	t.Helper()
	select {
	case <-connection.closed:
	case <-time.After(3 * time.Second):
		t.Error("连接未在取消后结束")
	}
}

func lifecycleOpen(t *testing.T, directory string) *WorkbenchSharing {
	t.Helper()
	sharing, err := OpenWorkbenchSharing(directory, fstest.MapFS{"index.html": {Data: []byte("test")}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		sharing.Stop(ctx)
	})
	return sharing
}

func lifecycleConfig(t *testing.T, home string) WorkbenchSharingConfig {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, ".glad", "agent-workbench.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config WorkbenchSharingConfig
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	return config
}

func lifecycleItems(sharing *WorkbenchSharing) []map[string]any {
	return sharing.snapshot()["workbenches"].([]map[string]any)
}

func lifecycleWait(t *testing.T, description string, ready func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if ready() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("等待%s超时", description)
	return false
}

func TestWorkbenchSharingIdentityAliasAndMultipleTargetsPersist(t *testing.T) {
	home := lifecycleHome(t)
	sharing := lifecycleOpen(t, home)
	id := sharing.snapshot()["gladId"].(string)
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id) {
		t.Fatalf("Glad ID 不是有效 UUID v4: %q", id)
	}
	if err := sharing.SetAlias("  研发助理  "); err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{"wss://one.example.test", "wss://two.example.test"} {
		if err := sharing.Add(WorkbenchTarget{URL: address, Token: lifecycleToken, WorkingDirectory: home}); err != nil {
			t.Fatal(err)
		}
	}
	reopened := lifecycleOpen(t, home)
	config := lifecycleConfig(t, home)
	if reopened.snapshot()["gladId"] != id || config.GladID != id || config.Alias != "研发助理" || len(config.Workbenches) != 2 {
		t.Fatalf("重开后身份、别名或多个工作台未保留: %#v", config)
	}
	if config.Workbenches[0].ID == config.Workbenches[1].ID || config.Workbenches[0].Token != lifecycleToken {
		t.Fatal("工作台身份重复或私有凭据未保存")
	}
	info, err := os.Stat(filepath.Join(home, ".glad", "agent-workbench.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("配置权限应为 0600: %v %v", info, err)
	}
	// 更换安装目录后应产生独立身份，同一安装重开继续使用旧身份。
	t.Setenv("HOME", t.TempDir())
	other := lifecycleOpen(t, home)
	if other.snapshot()["gladId"] == id {
		t.Fatal("两个独立安装共用 Glad ID")
	}
}

func TestWorkbenchSharingPublicSnapshotRedactsCredentials(t *testing.T) {
	home := lifecycleHome(t)
	peer := newLifecyclePeer(t, false)
	sharing := lifecycleOpen(t, home)
	if err := sharing.Add(peer.target(home)); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	(&Server{sharing: sharing}).registerWorkbenchSharingRoutes(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/agent-workbench", nil))
	var public map[string]any
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &public) != nil {
		t.Fatalf("GET 配置失败: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), lifecycleToken) || strings.Contains(response.Body.String(), "BEGIN CERTIFICATE") || strings.Contains(response.Body.String(), `"token":`) || strings.Contains(response.Body.String(), `"caCertificate":`) {
		t.Fatal("公开 GET 快照包含凭据或 CA 原文")
	}
	item := public["workbenches"].([]any)[0].(map[string]any)
	if item["hasToken"] != true || item["hasCertificate"] != true || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("快照缺少已配置标志或禁止缓存标志")
	}
}

func TestWorkbenchSharingWriteRequestsRequireSameOrigin(t *testing.T) {
	home := lifecycleHome(t)
	sharing := lifecycleOpen(t, home)
	mux := http.NewServeMux()
	(&Server{sharing: sharing}).registerWorkbenchSharingRoutes(mux)
	for _, test := range []struct {
		name, origin, fetch string
		want                int
	}{
		{"同源", "http://glad.test", "same-origin", 200},
		{"接口客户端", "", "", 200},
		{"跨域", "http://other.test", "", 403},
		{"同源头但跨站", "http://glad.test", "cross-site", 403},
		{"协议不同", "https://glad.test", "", 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			oldAlias := sharing.snapshot()["alias"]
			request := httptest.NewRequest(http.MethodPatch, "http://glad.test/api/agent-workbench", strings.NewReader(`{"alias":"`+test.name+`"}`))
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Sec-Fetch-Site", test.fetch)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Errorf("写请求状态=%d，预期%d", response.Code, test.want)
			}
			if test.want == 403 && sharing.snapshot()["alias"] != oldAlias {
				t.Error("被拒绝的请求修改了别名")
			}
		})
	}
}

func TestWorkbenchSharingFailedSaveKeepsPreviousConfiguration(t *testing.T) {
	home := lifecycleHome(t)
	peer := newLifecyclePeer(t, true)
	sharing := lifecycleOpen(t, home)
	if err := sharing.Add(peer.target(home)); err != nil {
		t.Fatal(err)
	}
	id := lifecycleItems(sharing)[0]["id"].(string)
	path := filepath.Join(home, ".glad", "agent-workbench.json")
	before, _ := os.ReadFile(path)
	snapshot, _ := json.Marshal(sharing.snapshot())
	// 用同名目录制造真实写入失败；root 用户下权限位无法可靠模拟失败。
	if err := os.Mkdir(path+".tmp", 0700); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func() error{
		"别名": func() error { return sharing.SetAlias("不应保存") },
		"开启": func() error { return sharing.SetEnabled(id, true) },
		"删除": func() error { return sharing.Delete(id) },
		"新增": func() error {
			return sharing.Add(WorkbenchTarget{URL: "wss://another.example.test", Token: lifecycleToken, WorkingDirectory: home})
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := mutate(); err == nil {
				t.Error("写入失败却返回成功")
			}
			after, _ := os.ReadFile(path)
			current, _ := json.Marshal(sharing.snapshot())
			if !bytes.Equal(before, after) || !bytes.Equal(snapshot, current) {
				t.Error("保存失败后旧配置发生改变")
			}
		})
	}
	if peer.attempts.Load() != 0 {
		t.Error("开启意图未保存却发起了连接")
	}
}

func TestWorkbenchSharingNormalServerStartupAttemptsEnabledOnce(t *testing.T) {
	home := lifecycleHome(t)
	enabled, disabled := newLifecyclePeer(t, true), newLifecyclePeer(t, true)
	sharing := lifecycleOpen(t, home)
	for _, peer := range []*lifecyclePeer{enabled, disabled} {
		if err := sharing.Add(peer.target(home)); err != nil {
			t.Fatal(err)
		}
	}
	id := lifecycleItems(sharing)[0]["id"].(string)
	if err := sharing.SetEnabled(id, true); err != nil {
		t.Fatal(err)
	}
	if !lifecycleWait(t, "首次失败", func() bool { return lifecycleItems(sharing)[0]["state"] == "disconnected" }) {
		return
	}
	enabled.attempts.Store(0)
	server, err := NewServer(home, 0, fstest.MapFS{"index.html": {Data: []byte("test")}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("正常 Glad 服务未结束")
		}
	})
	if !lifecycleWait(t, "正常启动尝试连接", func() bool {
		return enabled.attempts.Load() == 1 && lifecycleItems(server.sharing)[0]["state"] == "disconnected"
	}) {
		return
	}
	time.Sleep(1200 * time.Millisecond)
	if enabled.attempts.Load() != 1 || disabled.attempts.Load() != 0 {
		t.Errorf("启用项尝试=%d，停用项尝试=%d", enabled.attempts.Load(), disabled.attempts.Load())
	}
	if !lifecycleConfig(t, home).Workbenches[0].AutoConnect {
		t.Error("连接失败丢失已保存的开启意图")
	}
}

func TestWorkbenchSharingDisableReconnectDeleteAndStop(t *testing.T) {
	home := lifecycleHome(t)
	peer := newLifecyclePeer(t, false)
	sharing := lifecycleOpen(t, home)
	target := peer.target(home)
	target.AutoConnect = true
	if err := sharing.Add(target); err != nil {
		t.Fatal(err)
	}
	first := peer.accept(t)
	id := lifecycleItems(sharing)[0]["id"].(string)
	lifecycleWait(t, "建立连接", func() bool { return lifecycleItems(sharing)[0]["state"] == "connected" })
	if first.hello["glad_id"] != sharing.snapshot()["gladId"] || first.hello["name"] != sharing.snapshot()["alias"] {
		t.Error("握手未使用持久化的 Glad 身份和别名")
	}
	if err := sharing.SetEnabled(id, false); err != nil {
		t.Fatal(err)
	}
	first.waitClosed(t)
	lifecycleWait(t, "关闭连接", func() bool { return lifecycleItems(sharing)[0]["state"] == "disconnected" })
	if lifecycleConfig(t, home).Workbenches[0].AutoConnect {
		t.Error("关闭意图未保存")
	}
	if err := sharing.SetEnabled(id, true); err != nil {
		t.Fatal(err)
	}
	second := peer.accept(t)
	if err := sharing.Delete(id); err != nil {
		t.Fatal(err)
	}
	second.waitClosed(t)
	if len(lifecycleItems(sharing)) != 0 || len(lifecycleConfig(t, home).Workbenches) != 0 {
		t.Error("删除后仍保留工作台配置")
	}
	if err := sharing.Add(target); err != nil {
		t.Fatal(err)
	}
	third := peer.accept(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	sharing.Stop(ctx)
	third.waitClosed(t)
	if ctx.Err() != nil || lifecycleItems(sharing)[0]["state"] != "disconnected" {
		t.Error("Stop 未等待连接退出")
	}
	if !lifecycleConfig(t, home).Workbenches[0].AutoConnect {
		t.Error("服务停止改变了用户的开启意图")
	}
}

func TestWorkbenchSharingImmediateOffOnRestartsConnection(t *testing.T) {
	home := lifecycleHome(t)
	peer := newLifecyclePeer(t, false)
	sharing := lifecycleOpen(t, home)
	target := peer.target(home)
	target.AutoConnect = true
	if err := sharing.Add(target); err != nil {
		t.Fatal(err)
	}
	first := peer.accept(t)
	id := lifecycleItems(sharing)[0]["id"].(string)
	lifecycleWait(t, "建立连接", func() bool { return lifecycleItems(sharing)[0]["state"] == "connected" })
	// 两次操作无需等待网络关闭；最终开关状态应与实际连接状态一致。
	if err := sharing.SetEnabled(id, false); err != nil {
		t.Fatal(err)
	}
	if err := sharing.SetEnabled(id, true); err != nil {
		t.Fatal(err)
	}
	first.waitClosed(t)
	if lifecycleWait(t, "立即重新开启后的新连接", func() bool { return peer.attempts.Load() == 2 && lifecycleItems(sharing)[0]["state"] == "connected" }) {
		peer.accept(t)
	}
	if !lifecycleConfig(t, home).Workbenches[0].AutoConnect {
		t.Error("立即重新开启未保存意图")
	}
}

func TestWorkbenchSharingRemoteDisconnectDoesNotRetry(t *testing.T) {
	home := lifecycleHome(t)
	peer := newLifecyclePeer(t, false)
	sharing := lifecycleOpen(t, home)
	target := peer.target(home)
	target.AutoConnect = true
	if err := sharing.Add(target); err != nil {
		t.Fatal(err)
	}
	connection := peer.accept(t)
	lifecycleWait(t, "建立连接", func() bool { return lifecycleItems(sharing)[0]["state"] == "connected" })
	if err := connection.connection.CloseNow(); err != nil {
		t.Fatal(err)
	}
	connection.waitClosed(t)
	if !lifecycleWait(t, "远端断开", func() bool { return lifecycleItems(sharing)[0]["state"] == "disconnected" }) {
		return
	}
	time.Sleep(1200 * time.Millisecond)
	if peer.attempts.Load() != 1 || !lifecycleConfig(t, home).Workbenches[0].AutoConnect {
		t.Error("远端断开后重新尝试连接，或改变已保存的开启意图")
	}
}

func TestWorkbenchSharingPeerIdentityPongAndAliasPersist(t *testing.T) {
	home := lifecycleHome(t)
	peer := newLifecyclePeer(t, false)
	sharing := lifecycleOpen(t, home)
	target := peer.target(home)
	target.AutoConnect = true
	if err := sharing.Add(target); err != nil {
		t.Fatal(err)
	}
	connection := peer.accept(t)
	lifecycleWait(t, "连接身份保存", func() bool {
		config := lifecycleConfig(t, home)
		return config.Workbenches[0].WorkbenchID == "test-workbench" && config.Workbenches[0].WorkbenchAlias == "工作台初始别名"
	})
	connection.send(t, workbenchMessage{Type: "pong", WorkbenchID: "updated-workbench", WorkbenchAlias: "改名后的工作台"})
	lifecycleWait(t, "pong 身份更新保存", func() bool {
		config := lifecycleConfig(t, home)
		return config.Workbenches[0].WorkbenchID == "updated-workbench" && config.Workbenches[0].WorkbenchAlias == "改名后的工作台"
	})
	if err := sharing.SetAlias("已修改的助理名"); err != nil {
		t.Fatal(err)
	}
	select {
	case message := <-connection.messages:
		data, _ := json.Marshal(message)
		if message.Type != "client_state" || message.Name != "已修改的助理名" {
			t.Errorf("未收到客户端改名通知: %s", data)
		}
	case <-time.After(3 * time.Second):
		t.Error("修改 Glad 别名未通知已连接工作台")
	}
	reopened := lifecycleOpen(t, home)
	item := lifecycleItems(reopened)[0]
	if item["workbenchId"] != "updated-workbench" || item["workbenchAlias"] != "改名后的工作台" || reopened.snapshot()["alias"] != "已修改的助理名" {
		t.Error("重开配置后 peer 身份或 Glad 别名丢失")
	}
}

func lifecycleCreateRemoteSession(t *testing.T, connection *lifecyclePeerConnection, tool string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"toolKey": tool})
	requestID := "create-" + tool
	connection.send(t, workbenchMessage{Type: "http_request", ID: requestID, Method: http.MethodPost, Path: "/api/sessions", ContentType: "application/json", Body: base64.StdEncoding.EncodeToString(body)})
	deadline := time.After(3 * time.Second)
	for {
		select {
		case message := <-connection.messages:
			if message.Type == "http_response" && message.ID == requestID {
				data, _ := base64.StdEncoding.DecodeString(message.Body)
				if message.Status != 200 {
					t.Fatalf("创建远程 %s 会话失败: %d %s", tool, message.Status, data)
				}
				return
			}
		case <-deadline:
			t.Fatalf("创建远程 %s 会话超时", tool)
		}
	}
}

func TestWorkbenchSharingMCPEnvironmentBelongsToCreatingConnection(t *testing.T) {
	home := lifecycleHome(t)
	sharing := lifecycleOpen(t, home)
	for index := 0; index < 2; index++ {
		peer := newLifecyclePeer(t, false)
		directory := filepath.Join(home, fmt.Sprintf("workbench-%d", index))
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		target := peer.target(directory)
		target.AutoConnect = true
		target.MCPURL = fmt.Sprintf("https://mcp-%d.example.test/mcp", index)
		target.MCPTokenFile = filepath.Join(home, fmt.Sprintf("synthetic-mcp-%d.token", index))
		if err := os.WriteFile(target.MCPTokenFile, []byte("synthetic"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := sharing.Add(target); err != nil {
			t.Fatal(err)
		}
		connection := peer.accept(t)
		for _, tool := range []string{"codex", "claude-code"} {
			lifecycleCreateRemoteSession(t, connection, tool)
			command := "codex"
			if tool == "claude-code" {
				command = "claude"
			}
			data, err := os.ReadFile(filepath.Join(directory, command+"-environment.json"))
			var actual map[string]string
			if err != nil || json.Unmarshal(data, &actual) != nil || actual["url"] != target.MCPURL || actual["tokenFile"] != target.MCPTokenFile {
				t.Errorf("%s 子进程收到其他连接的 MCP 环境: %s %v", tool, data, err)
			}
		}
	}
	normalDirectory := filepath.Join(home, "ordinary")
	if err := os.Mkdir(normalDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	manager := NewSessionManager(normalDirectory)
	t.Cleanup(func() { manager.Close(context.Background()) })
	for _, tool := range []string{"codex", "claude-code"} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, err := manager.Create(ctx, CreateSessionRequest{ToolKey: tool})
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		command := "codex"
		if tool == "claude-code" {
			command = "claude"
		}
		data, err := os.ReadFile(filepath.Join(normalDirectory, command+"-environment.json"))
		var actual map[string]string
		if err != nil || json.Unmarshal(data, &actual) != nil || actual["url"] != "" || actual["tokenFile"] != "" {
			t.Errorf("普通 %s CLI 被共享 MCP 环境污染: %s %v", tool, data, err)
		}
	}
	if os.Getenv("GLAD_WORKBENCH_MCP_URL") != "" || os.Getenv("GLAD_WORKBENCH_MCP_TOKEN_FILE") != "" {
		t.Error("创建共享会话修改了 Glad 进程的 MCP 环境")
	}
}
