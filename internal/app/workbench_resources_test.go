package app

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkbenchOwnedResourcesAllowHEADRangeAndDownload(t *testing.T) {
	root := t.TempDir()
	filename := "report.pdf"
	content := "%PDF-1.7\nfixture resource\n"
	if err := os.WriteFile(filepath.Join(root, filename), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	manager := NewSessionManager(root)
	session := newSession("owned", "Resource", "codex-structured", ToolInfo{Key: "codex"}, root)
	defer session.cancel()
	manager.sessions[session.ID] = session
	server := &Server{sessions: manager}
	mux := http.NewServeMux()
	server.registerWorkspaceRoutes(mux)
	bridge := &workbenchBridge{server: server, mux: mux, ctx: context.Background(), owned: map[string]bool{"owned": true}}
	path := "/api/sessions/owned/workspace-resource?path=" + url.QueryEscape(filename) + "&download=1"
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response := httptest.NewRecorder()
		err := bridge.serveRequest(response, workbenchMessage{Method: method, Path: path, RequestHeaders: map[string]string{"Range": "bytes=0-8", "Accept-Encoding": "gzip", "Cookie": "foreign=true"}})
		if err != nil || response.Code != http.StatusPartialContent || response.Header().Get("Content-Range") == "" || response.Header().Get("Content-Length") != "9" || !strings.HasPrefix(response.Header().Get("Content-Disposition"), "attachment;") {
			t.Fatalf("resource proxy failed %s: %d %#v %v", method, response.Code, response.Header(), err)
		}
		if response.Header().Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
			t.Fatal("resource isolation lost")
		}
		if method == http.MethodHead && response.Body.Len() != 0 {
			t.Fatal("HEAD proxy returned resource body")
		}
		if method == http.MethodGet && response.Body.String() != content[:9] {
			t.Fatal("proxy range bytes differ")
		}
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		if err := bridge.serveRequest(httptest.NewRecorder(), workbenchMessage{Method: method, Path: strings.Replace(path, "/owned/", "/foreign/", 1), RequestHeaders: map[string]string{"Range": "bytes=0-1"}}); err == nil {
			t.Fatal("foreign session resource became accessible")
		}
	}
	captured := http.Header{}
	mux.HandleFunc("GET /capture-static", func(w http.ResponseWriter, r *http.Request) {
		captured = r.Header.Clone()
		w.Header().Set("ETag", `"resource"`)
		w.WriteHeader(http.StatusNotModified)
	})
	response := httptest.NewRecorder()
	if err := bridge.serveRequest(response, workbenchMessage{Method: http.MethodGet, Path: "/capture-static", RequestHeaders: map[string]string{"if-none-match": `"resource"`, "If-Range": `"resource"`, "If-Modified-Since": "Sun, 22 Nov 2026 01:00:00 GMT", "Accept-Encoding": "gzip", "Authorization": "secret", "Cookie": "foreign=true", "Range": "bytes=0-1\r\nInjected:true"}}); err != nil {
		t.Fatal(err)
	}
	if captured.Get("If-None-Match") != `"resource"` || captured.Get("If-Range") != `"resource"` || captured.Get("If-Modified-Since") == "" || captured.Get("Accept-Encoding") != "" || captured.Get("Authorization") != "" || captured.Get("Cookie") != "" || captured.Get("Range") != "" {
		t.Fatalf("unsafe request headers forwarded: %#v", captured)
	}
}

func TestWorkbenchResourcesStayBoundedBeforeEncoding(t *testing.T) {
	mux := http.NewServeMux()
	var written int64
	mux.HandleFunc("GET /large", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "999999999")
		w.Header().Set("Content-Disposition", "attachment; filename=large.pdf")
		var err error
		written, err = io.Copy(w, bytes.NewReader(bytes.Repeat([]byte("x"), maxWorkbenchHTTPBodyBytes+1024)))
		if err == nil {
			t.Error("large response was copied without enforcing protocol bound")
		}
	})
	bridge := &workbenchBridge{mux: mux, ctx: context.Background(), owned: map[string]bool{}}
	response := httptest.NewRecorder()
	if err := bridge.serveRequest(response, workbenchMessage{Method: http.MethodGet, Path: "/large"}); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusRequestEntityTooLarge || response.Body.Len() > 4096 || written > maxWorkbenchHTTPBodyBytes || response.Header().Get("Content-Length") != "" || response.Header().Get("Content-Disposition") != "" {
		t.Fatalf("proxy buffered oversize response or kept stale headers: status%d len%d copied%d", response.Code, response.Body.Len(), written)
	}
	writer := &workbenchResponseLimitWriter{ResponseRecorder: httptest.NewRecorder()}
	writer.Body.Write(make([]byte, maxWorkbenchHTTPBodyBytes))
	if _, err := io.WriteString(writer, "beyond"); err == nil || !writer.overflow {
		t.Fatal("StringWriter bypassed response bound")
	}
}

func TestWorkbenchResourceMetadataHeaderWhitelist(t *testing.T) {
	headers := http.Header{}
	for _, name := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified", "Vary", "Content-Security-Policy", "Content-Disposition", "X-Content-Type-Options"} {
		headers.Set(name, "value")
	}
	headers.Set("Set-Cookie", "foreign=true")
	headers.Set("Location", "https://foreign.invalid")
	headers.Set("Content-Encoding", "gzip")
	headers.Set("ETag", "bad\r\nheader")
	forwarded := workbenchResourceResponseHeaders(headers)
	if len(forwarded) != 9 || forwarded["Content-Length"] != "value" || forwarded["Content-Range"] != "value" || forwarded["ETag"] != "" || forwarded["Content-Encoding"] != "" || forwarded["Location"] != "" || forwarded["Set-Cookie"] != "" {
		t.Fatalf("unsafe metadata headers forwarded: %#v", forwarded)
	}
}
