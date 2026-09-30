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

func TestWorkbenchResumeReachesTheSameLocalHandler(t *testing.T) {
	bridge := &workbenchBridge{ctx: context.Background(), mux: http.NewServeMux(), owned: map[string]bool{"owned": true}}
	called := false
	bridge.mux.HandleFunc("POST /api/sessions/owned/claude-resume", func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(http.StatusBadRequest) })
	body := base64.StdEncoding.EncodeToString([]byte(`{"resumeSessionId":"invalid"}`))
	response := httptest.NewRecorder()
	if err := bridge.serveRequest(response, workbenchMessage{Method: "POST", Path: "/api/sessions/owned/claude-resume", Body: body}); err != nil || !called || response.Code != http.StatusBadRequest {
		t.Fatalf("local handler semantics changed: called=%v status=%d err=%v", called, response.Code, err)
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
