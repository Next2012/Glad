package app

import (
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Markdown links are relative to their session's working directory. Files are
// served as plain text or images, never as executable same-origin HTML.
func (server *Server) markdownWorkspaceResource(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	filename := request.URL.Query().Get("path")
	if filename == "" {
		http.Error(writer, "Missing file path", http.StatusBadRequest)
		return
	}
	if filepath.IsAbs(filename) {
		var err error
		filename, err = filepath.Rel(session.WorkingDirectory, filename)
		if err != nil {
			http.NotFound(writer, request)
			return
		}
	}
	resolved, err := resolveInside(session.WorkingDirectory, filename)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxWorkspaceFileBytes {
		http.Error(writer, "File is not a regular file or exceeds 4 MB", http.StatusBadRequest)
		return
	}
	file, err := os.Open(resolved)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxWorkspaceFileBytes+1))
	if err != nil || len(content) > maxWorkspaceFileBytes {
		http.Error(writer, "Unable to read file within the 4 MB limit", http.StatusBadRequest)
		return
	}
	contentType := http.DetectContentType(content)
	if strings.EqualFold(filepath.Ext(resolved), ".svg") {
		contentType = "image/svg+xml"
	} else if !strings.HasPrefix(contentType, "image/") {
		contentType = "text/plain; charset=utf-8"
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filepath.Base(resolved)}))
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(content)
}
