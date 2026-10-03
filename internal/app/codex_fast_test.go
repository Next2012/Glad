package app

import (
	"context"
	"path/filepath"
	"testing"
)

func TestCodexFastRequiresAdvertisedModelCapability(t *testing.T) {
	for _, tc := range []struct {
		name  string
		model map[string]any
		want  string
	}{
		{"catalog", map[string]any{"serviceTiers": []any{map[string]any{"id": "priority"}}}, "priority"},
		{"legacy", map[string]any{"additionalSpeedTiers": []string{"fast"}}, "priority"},
		{"missing", map[string]any{}, ""},
		{"other tier", map[string]any{"serviceTiers": []any{map[string]any{"id": "ultrafast"}}}, ""},
		{"catalog overrides legacy", map[string]any{"serviceTiers": []any{}, "additionalSpeedTiers": []string{"fast"}}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := codexFastServiceTier(tc.model); got != tc.want {
				t.Fatalf("Fast tier = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCodexFastIsSessionScopedAndChangesNextTurn(t *testing.T) {
	store := &ConfigStore{path: filepath.Join(t.TempDir(), "config.json"), data: map[string]any{
		"codexDefaults": map[string]any{"model": "fast-model", "effort": "high", "serviceTier": "priority"},
	}}
	manager := NewSessionManager(t.TempDir())
	manager.config = store
	session := newSession("fast", "Fast", "codex-structured", ToolInfo{Key: "codex"}, manager.baseDir)
	provider := NewCodexProvider(session, manager.codexOptions(nil))
	provider.defaultsStore = store
	provider.threadID = "existing-thread"
	provider.models = []map[string]any{{"id": "fast-model", "fastServiceTier": "priority"}, {"id": "standard-model"}}
	provider.applyConfig(map[string]any{"service_tier": "fast"})
	params := map[string]any{}
	provider.applyThreadOptions(params)
	if params["serviceTier"] != "default" {
		t.Fatalf("new session inherited Fast: %#v", params)
	}
	if err := provider.UpdateSettings(context.Background(), map[string]any{"serviceTier": "fast"}); err != nil {
		t.Fatal(err) // An existing thread must not require an obsolete settings RPC.
	}
	provider.handleNotification("thread/settings/updated", map[string]any{
		"threadId": provider.threadID, "threadSettings": map[string]any{"serviceTier": nil, "effort": "low"},
	})
	params = map[string]any{}
	provider.applyTurnOptions(params)
	if params["serviceTier"] != "priority" || params["model"] != "fast-model" || params["effort"] != "high" {
		t.Fatalf("next turn lost selected settings: %#v", params)
	}
	if err := provider.UpdateSettings(context.Background(), map[string]any{"serviceTier": "default"}); err != nil {
		t.Fatal(err)
	}
	provider.applyTurnOptions(params)
	if params["serviceTier"] != "default" {
		t.Fatal("disabling Fast did not explicitly reset the next turn")
	}
	if err := provider.UpdateSettings(context.Background(), map[string]any{"model": "standard-model", "serviceTier": "priority"}); err == nil {
		t.Fatal("unsupported Fast selection was accepted")
	}
	if provider.options["model"] != "fast-model" {
		t.Fatal("failed settings update changed the selected model")
	}
	if err := provider.UpdateSettings(context.Background(), map[string]any{"serviceTier": "priority"}); err != nil {
		t.Fatal(err)
	}
	if err := provider.UpdateSettings(context.Background(), map[string]any{"model": "standard-model"}); err != nil {
		t.Fatal(err)
	}
	if provider.options["serviceTier"] != "default" {
		t.Fatal("switching to an unsupported model retained Fast")
	}
	other := NewCodexProvider(session, manager.codexOptions(nil))
	if other.options["serviceTier"] != "default" {
		t.Fatal("another session inherited the Fast choice")
	}
	for _, value := range []any{true, "ultrafast", "", "priority\ninvalid"} {
		if _, err := normalizeCodexSettings(map[string]any{"serviceTier": value}); err == nil {
			t.Fatalf("invalid service tier accepted: %#v", value)
		}
	}
}

func TestCodexNextTurnRestoresDefaultPermissions(t *testing.T) {
	session := newSession("defaults", "Defaults", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	provider := NewCodexProvider(session, map[string]any{
		"permissionMode": "never", "sandboxMode": "danger-full-access",
	})
	provider.applyConfig(map[string]any{"approval_policy": "on-request", "sandbox_mode": "read-only"})
	if err := provider.UpdateSettings(context.Background(), map[string]any{"permissionMode": "default", "sandboxMode": "default"}); err != nil {
		t.Fatal(err)
	}
	params := map[string]any{}
	provider.applyTurnOptions(params)
	if params["approvalPolicy"] != "on-request" || mapValue(params["sandboxPolicy"])["type"] != "readOnly" {
		t.Fatalf("default permissions did not apply to the next turn: %#v", params)
	}
}

func TestCodexChildThreadCannotChangeFastSelection(t *testing.T) {
	session := newSession("settings", "Settings", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	provider := NewCodexProvider(session, map[string]any{"model": "fast-model", "serviceTier": "priority"})
	provider.threadID = "root"
	provider.models = []map[string]any{{"id": "fast-model", "fastServiceTier": "priority"}}
	provider.handleNotification("thread/settings/updated", map[string]any{
		"threadId": "child", "threadSettings": map[string]any{"model": "other", "serviceTier": nil},
	})
	if provider.options["model"] != "fast-model" || provider.serviceTierLocked() != "priority" {
		t.Fatal("child settings overwrote the main session's choice")
	}
	provider.handleNotification("thread/settings/updated", map[string]any{
		"threadId": "root", "threadSettings": map[string]any{"serviceTier": nil},
	})
	if provider.serviceTierLocked() != "default" {
		t.Fatal("null standard tier retained Fast")
	}
}
