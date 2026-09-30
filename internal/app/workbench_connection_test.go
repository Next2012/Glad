package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkbenchConnectionRejectsInsecureURL(t *testing.T) {
	err := runWorkbenchConnection([]string{"--url", "ws://example.test/api/assistant-connections/ws"}, nil)
	if err == nil || !strings.Contains(err.Error(), "wss://") {
		t.Fatalf("insecure connection accepted: %v", err)
	}
}

func TestWorkbenchBridgeRejectsForeignSessionsAndGlobalActions(t *testing.T) {
	bridge := &workbenchBridge{ctx: context.Background(), owned: map[string]bool{"owned": true},
		mux: http.NewServeMux()}
	for _, path := range []string{"/api/sessions/foreign/metadata",
		"/api/config/set", "//other.example/api/tools", "https://other.example/api/tools", "/../api/tools"} {
		err := bridge.serveRequest(httptest.NewRecorder(), workbenchMessage{Method: "POST", Path: path})
		if err == nil {
			t.Errorf("unauthorized path accepted: %s", path)
		}
	}
}

func TestWorkbenchBridgeMatchesGladExecutionPermissions(t *testing.T) {
	for _, settings := range []map[string]any{
		{"permissionMode": "never"}, {"permissionMode": "bypassPermissions"},
		{"sandboxMode": "danger-full-access"}, {"sandboxMode": "default"},
	} {
		if !workbenchSettingsAllowed(settings) {
			t.Errorf("local UI settings blocked: %#v", settings)
		}
	}
	if !workbenchSettingsAllowed(map[string]any{"model": "model-a", "effort": "medium"}) {
		t.Fatal("ordinary model settings rejected")
	}
	if !workbenchPayloadAllowed(map[string]any{"type": "codex-settings",
		"settings": map[string]any{"sandboxMode": "danger-full-access"}}) {
		t.Fatal("supported WebSocket settings blocked")
	}
}

func TestClaudeBootstrapIsInternalAndCodexBootstrapIsEmpty(t *testing.T) {
	claude := sessionBootstrapInput(&Session{Tool: ToolInfo{Key: "claude-code"}})
	if !claude.Internal || claude.Text != "" || claude.AgentText == "" {
		t.Fatalf("invalid Claude bootstrap: %#v", claude)
	}
	codex := sessionBootstrapInput(&Session{Tool: ToolInfo{Key: "codex"}})
	if codex.AgentText != "" || codex.Text != "" {
		t.Fatalf("Codex bootstrap changed: %#v", codex)
	}
}
