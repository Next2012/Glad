package app

import (
	"mime"
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
		{"中文报告.pdf", "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "application/pdf"},
		{"download.bin", "%PDF-1.7\n%%EOF\n", "application/pdf"},
		{"fake.pdf", "<script>alert(1)</script>", "text/plain; charset=utf-8"},
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
			kind, parameters, err := mime.ParseMediaType(recorder.Header().Get("Content-Disposition"))
			if err != nil || kind != "inline" || parameters["filename"] != item.name {
				t.Fatalf("resource filename is not preserved: %q", recorder.Header().Get("Content-Disposition"))
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
	if err := os.Mkdir(filepath.Join(root, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	directory := httptest.NewRecorder()
	mux.ServeHTTP(directory, httptest.NewRequest(http.MethodGet, "/api/sessions/markdown/workspace-resource?path=directory", nil))
	if directory.Code != http.StatusBadRequest {
		t.Fatalf("directory returned %d", directory.Code)
	}
	large, err := os.Create(filepath.Join(root, "large.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = large.WriteString("%PDF-1.7\n"); err != nil {
		t.Fatal(err)
	}
	if err = large.Truncate(5 << 20); err != nil {
		t.Fatal(err)
	}
	large.Close()
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(method, "/api/sessions/markdown/workspace-resource?path=large.pdf", nil)
		request.Header.Set("Range", "bytes=0-8")
		mux.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusPartialContent || recorder.Header().Get("Content-Range") != "bytes 0-8/5242880" {
			t.Fatalf("large PDF streaming failed: %d %s", recorder.Code, recorder.Header().Get("Content-Range"))
		}
		if method == http.MethodHead && recorder.Body.Len() != 0 {
			t.Fatal("HEAD returned file bytes")
		}
		if method == http.MethodGet && recorder.Body.String() != "%PDF-1.7\n" {
			t.Fatal("range returned wrong PDF bytes")
		}
	}
	if err := os.Truncate(filepath.Join(root, "large.pdf"), maxMarkdownResourceBytes+1); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/sessions/markdown/workspace-resource?path=large.pdf", nil))
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize returned %d", recorder.Code)
	}
}

func TestMarkdownResourceSourceReferencesAndDownloads(t *testing.T) {
	root := t.TempDir()
	manager := NewSessionManager(root)
	manager.sessions["resource"] = newSession("resource", "Resources", "codex-structured", ToolInfo{Key: "codex"}, root)
	server := &Server{sessions: manager}
	mux := http.NewServeMux()
	server.registerWorkspaceRoutes(mux)
	name := "中文 source.go"
	if err := os.WriteFile(filepath.Join(root, name), []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{name + ":12:3", filepath.Join(root, name) + "#L12-L18", (&url.URL{Scheme: "file", Host: "localhost", Path: filepath.Join(root, name), Fragment: "L12"}).String()} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/api/sessions/resource/workspace-resource?download=1&path="+url.QueryEscape(filename), nil)
		mux.ServeHTTP(recorder, request)
		kind, params, err := mime.ParseMediaType(recorder.Header().Get("Content-Disposition"))
		if recorder.Code != 200 || recorder.Body.String() != "package main\n" || err != nil || kind != "attachment" || params["filename"] != name {
			t.Fatalf("reference download failed: %q status%d disposition%q", filename, recorder.Code, recorder.Header().Get("Content-Disposition"))
		}
	}
	literal := name + ":12"
	if err := os.WriteFile(filepath.Join(root, literal), []byte("literal name"), 0600); err != nil {
		t.Fatal(err)
	}
	resolved, err := markdownResourcePath(root, literal)
	if err != nil || resolved != filepath.Join(root, literal) {
		t.Fatalf("literal reference-like filename was rewritten: %s %v", resolved, err)
	}
	for _, filename := range []string{"../outside:12", "file://remote-host/etc/passwd", filepath.Join(t.TempDir(), "outside")} {
		if _, err := markdownResourcePath(root, filename); err == nil {
			t.Fatalf("outside path accepted: %q", filename)
		}
	}
}
