package app

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkbenchRestoreChecksBackendSelectedID(t *testing.T) {
	for _, path := range []string{"/api/sessions/owned/claude-resume", "/api/sessions/owned/claude-fork"} {
		bridge := &workbenchBridge{ctx: context.Background(), mux: http.NewServeMux(),
			owned: map[string]bool{"owned": true}, threads: map[string]bool{"known": true}}
		body := base64.StdEncoding.EncodeToString([]byte(`{"threadId":"known","resumeSessionId":"other","claudeSessionId":"other"}`))
		if err := bridge.serveRequest(httptest.NewRecorder(), workbenchMessage{Method: "POST", Path: path, Body: body}); err == nil {
			t.Fatal("backend selected an unregistered conversation")
		}
	}
}

func TestWorkbenchThreadRecordRetriesAfterWriteFailure(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "records")
	if err := os.WriteFile(parent, []byte("temporary obstacle"), 0600); err != nil {
		t.Fatal(err)
	}
	session := newSession("owned", "test", "codex-structured", ToolInfo{Key: "codex"}, root)
	t.Cleanup(session.cancel)
	session.State["threadId"] = "native-01"
	bridge := &workbenchBridge{threads: map[string]bool{}, threadFile: filepath.Join(parent, "threads.json")}
	bridge.rememberThread(session, false)
	if !bridge.threadsDirty {
		t.Fatal("failed write was treated as persisted")
	}
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	bridge.rememberThread(session, false)
	if bridge.threadsDirty {
		t.Fatal("retry did not commit thread record")
	}
	if _, err := os.Stat(bridge.threadFile); err != nil {
		t.Fatal(err)
	}
}
