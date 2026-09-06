package app

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexSettingsUsePersistedGladDefaultsAndExplicitOverrides(t *testing.T) {
	store := &ConfigStore{
		path: filepath.Join(t.TempDir(), "config.json"),
		data: map[string]any{"codexDefaults": map[string]any{
			"model": "saved-model", "effort": "high",
			"sandboxMode": "workspace-write", "permissionMode": "on-request",
		}},
	}
	manager := NewSessionManager(t.TempDir())
	manager.config = store
	options := manager.codexOptions(map[string]any{"model": "explicit-model"})
	if options["model"] != "explicit-model" || options["effort"] != "high" ||
		options["sandboxMode"] != "workspace-write" || options["permissionMode"] != "on-request" {
		t.Fatalf("Glad defaults were not merged correctly: %#v", options)
	}

	session := newSession(
		"settings", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, manager.baseDir,
	)
	provider := NewCodexProvider(session, options)
	provider.defaultsStore = store
	if err := provider.UpdateSettings(context.Background(), map[string]any{
		"sandboxMode": "danger-full-access", "permissionMode": "never",
	}); err != nil {
		t.Fatal(err)
	}
	stored := mapValue(store.Get("codexDefaults"))
	if stored["model"] != "saved-model" || stored["effort"] != "high" ||
		stored["sandboxMode"] != "danger-full-access" || stored["permissionMode"] != "never" {
		t.Fatalf("partial settings update lost persisted defaults: %#v", stored)
	}
	if _, err := normalizeCodexSettings(map[string]any{"sandboxMode": "unsafe"}); err == nil {
		t.Fatal("invalid sandbox mode was accepted")
	}
}

func TestCodexGlobalDefaultsUseAtomicAppServerBatchWrite(t *testing.T) {
	session := newSession(
		"global-settings", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	provider := NewCodexProvider(session, map[string]any{
		"model": "gpt-test", "effort": "high",
		"sandboxMode": "workspace-write", "permissionMode": "on-request",
	})
	writes := make(chan []byte, 1)
	provider.stdin = &channelWriteCloser{writes: writes}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := provider.WriteGlobalDefaults(ctx)
		done <- err
	}()

	var request map[string]any
	select {
	case encoded := <-writes:
		if err := json.Unmarshal(bytes.TrimSpace(encoded), &request); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for config/batchWrite")
	}
	if request["method"] != "config/batchWrite" {
		t.Fatalf("expected atomic config/batchWrite, got %#v", request)
	}
	edits := sliceValue(mapValue(request["params"])["edits"])
	values := map[string]any{}
	for _, raw := range edits {
		edit := mapValue(raw)
		if edit["mergeStrategy"] != "upsert" {
			t.Fatalf("global edit was not an upsert: %#v", edit)
		}
		values[stringValue(edit["keyPath"])] = edit["value"]
	}
	if values["model"] != "gpt-test" || values["model_reasoning_effort"] != "high" ||
		values["sandbox_mode"] != "workspace-write" || values["approval_policy"] != "on-request" {
		t.Fatalf("unexpected global config edits: %#v", values)
	}
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{}})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
