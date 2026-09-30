package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestClaudePermissionUpdatePreservesResolvedModel(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	t.Cleanup(session.cancel)
	session.setState(map[string]any{"model": "claude-opus-5-5", "effort": "high", "status": "idle"})
	for _, mode := range []string{"manual", "default", "auto"} {
		if err := provider.UpdateSettings(context.Background(), map[string]any{"permissionMode": mode}); err != nil {
			t.Fatal(err)
		}
		expectedMode := mode
		if mode == "default" {
			expectedMode = "auto"
		}
		if session.State["model"] != "claude-opus-5-5" || session.State["effort"] != "high" || session.State["permissionMode"] != expectedMode {
			t.Fatalf("权限更新覆盖未修改的设置: %#v", session.State)
		}
	}
	if err := provider.UpdateSettings(context.Background(), map[string]any{"model": "sonnet"}); err != nil {
		t.Fatal(err)
	}
	if session.State["model"] != "sonnet" {
		t.Fatal("明确的模型修改未发布")
	}
}

func TestClaudeHistoryUsesConfiguredDirectory(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", root)
	cwd := t.TempDir()
	id := "b210d874-1714-4bfa-9aab-90a43455bdac"
	path := filepathForClaudeTranscript(cwd, id)
	if filepath.Dir(filepath.Dir(path)) != filepath.Join(root, "projects") {
		t.Fatalf("历史读取未使用CLI目录: %s", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"type":"user","uuid":"message","message":{"content":"真实用户消息"}}` + "\n")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	messages, err := readClaudeTranscriptFile(cwd, id)
	if err != nil || len(messages) == 0 {
		t.Fatalf("自定义目录历史不可恢复: %v", err)
	}
}

func TestWorkbenchPutNotificationReturnsLocalConfigurationError(t *testing.T) {
	server, err := newWorkbenchServer(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	session := newSession("owned", "验证", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	t.Cleanup(session.cancel)
	server.sessions.sessions[session.ID] = session
	mux := http.NewServeMux()
	server.registerRoutes(mux)
	bridge := &workbenchBridge{ctx: context.Background(), server: server, mux: mux, owned: map[string]bool{session.ID: true}}
	response := httptest.NewRecorder()
	err = bridge.serveRequest(response, workbenchMessage{Method: http.MethodPut, Path: "/api/sessions/owned/notifications/serverchan", Body: base64.StdEncoding.EncodeToString([]byte(`{"enabled":true}`)), ContentType: "application/json"})
	if err != nil || response.Code != http.StatusConflict {
		t.Fatalf("通知请求未到本地配置校验: code=%d err=%v", response.Code, err)
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || stringValue(body["error"]) == "" {
		t.Fatal("未返回明确配置错误")
	}
}

func TestWorkbenchSkillHubStatusUsesLocalHandler(t *testing.T) {
	server, err := newWorkbenchServer(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	server.registerRoutes(mux)
	bridge := &workbenchBridge{ctx: context.Background(), server: server, mux: mux, owned: map[string]bool{}}
	response := httptest.NewRecorder()
	err = bridge.serveRequest(response, workbenchMessage{Method: http.MethodGet, Path: "/api/skillhub/status"})
	if err != nil || response.Code != http.StatusOK {
		t.Fatalf("只读状态被额外拒绝: code=%d err=%v", response.Code, err)
	}
}
