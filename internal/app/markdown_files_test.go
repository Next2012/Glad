package app

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestMarkdownWorkspaceResources(t *testing.T) {
	root := t.TempDir()
	manager := NewSessionManager(root)
	manager.sessions["markdown"] = newSession("markdown", "Markdown", "codex-structured", ToolInfo{Key: "codex"}, root)
	server := &Server{sessions: manager}
	mux := http.NewServeMux()
	server.registerWorkspaceRoutes(mux)
	for _, item := range []struct{ name, content, contentType string }{
		{"中文 notes.md", "# Notes", "text/plain; charset=utf-8"},
		{"page.html", "<script>alert(1)</script>", "text/plain; charset=utf-8"},
		{"diagram.svg", `<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>`, "image/svg+xml"},
	} {
		if err := os.WriteFile(filepath.Join(root, item.name), []byte(item.content), 0o600); err != nil {
			t.Fatal(err)
		}
		for _, filename := range []string{item.name, filepath.Join(root, item.name)} {
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/sessions/markdown/workspace-resource?path="+url.QueryEscape(filename), nil))
			if recorder.Code != http.StatusOK || recorder.Body.String() != item.content || recorder.Header().Get("Content-Type") != item.contentType {
				t.Fatalf("resource %s: status=%d type=%s body=%s", filename, recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body)
			}
			if recorder.Header().Get("Content-Security-Policy") != "default-src 'none'; sandbox" || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("resource is missing content isolation headers")
			}
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	targets := []string{outside, "missing.txt"}
	if err := os.Symlink(outside, filepath.Join(root, "linked.txt")); err == nil {
		targets = append(targets, "linked.txt")
	}
	for _, filename := range targets {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/sessions/markdown/workspace-resource?path="+url.QueryEscape(filename), nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("invalid resource %s returned %d", filename, recorder.Code)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "large.txt"), bytes.Repeat([]byte("a"), maxWorkspaceFileBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/sessions/markdown/workspace-resource?path=large.txt", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("oversize file returned %d", recorder.Code)
	}
}
