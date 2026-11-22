//go:build linux

package app

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestMarkdownWorkspaceResourceRejectsFIFOWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	pipe := filepath.Join(root, "resource.pipe")
	if err := syscall.Mkfifo(pipe, 0600); err != nil {
		t.Fatal(err)
	}
	manager := NewSessionManager(root)
	session := newSession("fifo", "FIFO regression", "codex-structured", ToolInfo{Key: "codex"}, root)
	defer session.cancel()
	manager.sessions[session.ID] = session
	server := &Server{sessions: manager}
	mux := http.NewServeMux()
	server.registerWorkspaceRoutes(mux)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			done := make(chan int, 1)
			go func() {
				response := httptest.NewRecorder()
				mux.ServeHTTP(response, httptest.NewRequest(method, "/api/sessions/fifo/workspace-resource?path=resource.pipe", nil))
				done <- response.Code
			}()
			select {
			case status := <-done:
				if status != http.StatusBadRequest {
					t.Fatalf("FIFO returned %d instead of rejecting a non-regular file", status)
				}
			case <-time.After(time.Second):
				// Unblock a regressed read-only Open before failing; a failing test
				// must not leave a blocked request goroutine behind.
				fd, err := syscall.Open(pipe, syscall.O_RDWR|syscall.O_NONBLOCK, 0600)
				if err != nil {
					t.Fatalf("FIFO request blocked and recovery descriptor failed: %v", err)
				}
				defer syscall.Close(fd)
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Fatal("FIFO request did not finish after opening the recovery descriptor")
				}
				t.Fatal("FIFO was opened before checking whether it is a regular file")
			}
		})
	}
}
