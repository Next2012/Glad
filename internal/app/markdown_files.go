package app

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Previews stream independently of the editor's 4 MiB read/modify limit. Bound
// very large responses without loading a PDF or image into daemon memory.
const maxMarkdownResourceBytes int64 = 256 << 20

var markdownFileReferenceSuffix = regexp.MustCompile(`(?::[1-9][0-9]*(?::[1-9][0-9]*)?|#L[1-9][0-9]*(?:C[1-9][0-9]*|-L?[1-9][0-9]*)?)$`)
var errMarkdownResourceDenied = errors.New("File is outside the session working directory")

// File URLs and source references occur in persisted CLI answers. Normalize the
// link spelling, then retain the same cwd/symlink boundary as workspace edits.
func markdownResourcePath(root, filename string) (string, error) {
	if strings.HasPrefix(strings.ToLower(filename), "file:") {
		parsed, err := url.Parse(filename)
		if err != nil || !strings.EqualFold(parsed.Scheme, "file") || parsed.User != nil || parsed.Port() != "" || (parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost")) {
			return "", errMarkdownResourceDenied
		}
		filename = parsed.Path
	}
	if filename == "" || strings.ContainsRune(filename, '\x00') {
		return "", errors.New("Invalid file path")
	}
	// A real filename ending in :12 or #L12 must win over reference parsing.
	check := filename
	if !filepath.IsAbs(check) {
		check = filepath.Join(root, check)
	}
	if _, err := os.Lstat(check); errors.Is(err, os.ErrNotExist) {
		filename = markdownFileReferenceSuffix.ReplaceAllString(filename, "")
	}
	if filepath.IsAbs(filename) {
		absoluteRoot, err := filepath.Abs(root)
		if err != nil {
			return "", err
		}
		relative, err := filepath.Rel(absoluteRoot, filename)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			// A session cwd may itself be a symlink; accept its real spelling too.
			realRoot, resolveErr := filepath.EvalSymlinks(root)
			if resolveErr != nil {
				return "", resolveErr
			}
			relative, err = filepath.Rel(realRoot, filename)
		}
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return "", errMarkdownResourceDenied
		}
		filename = relative
	}
	clean := filepath.Clean(filename)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errMarkdownResourceDenied
	}
	resolved, err := resolveInside(root, clean)
	if err != nil && err.Error() == "Access denied" {
		return "", errMarkdownResourceDenied
	}
	return resolved, err
}

func markdownResourceError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, os.ErrNotExist):
		http.Error(writer, "File does not exist", http.StatusNotFound)
	case errors.Is(err, errMarkdownResourceDenied):
		http.Error(writer, "File is outside the session working directory", http.StatusNotFound)
	case errors.Is(err, os.ErrPermission):
		http.Error(writer, "File access denied", http.StatusForbidden)
	default:
		http.Error(writer, "Unable to open file", http.StatusBadRequest)
	}
}

// Files are plain text, images or PDF, never executable same-origin HTML.
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
	resolved, err := markdownResourcePath(session.WorkingDirectory, filename)
	if err != nil {
		markdownResourceError(writer, err)
		return
	}
	// Reject named pipes and devices before Open: opening a FIFO for reading can
	// block before the descriptor-level check below gets a chance to run.
	info, err := os.Stat(resolved)
	if err != nil {
		markdownResourceError(writer, err)
		return
	}
	if !info.Mode().IsRegular() {
		http.Error(writer, "File path is a directory or non-regular file", http.StatusBadRequest)
		return
	}
	if info.Size() > maxMarkdownResourceBytes {
		http.Error(writer, "File exceeds the 256 MiB preview/download limit", http.StatusRequestEntityTooLarge)
		return
	}
	file, err := os.Open(resolved)
	if err != nil {
		markdownResourceError(writer, err)
		return
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil {
		markdownResourceError(writer, err)
		return
	}
	if !info.Mode().IsRegular() {
		http.Error(writer, "File path is a directory or non-regular file", http.StatusBadRequest)
		return
	}
	if info.Size() > maxMarkdownResourceBytes {
		http.Error(writer, "File exceeds the 256 MiB preview/download limit", http.StatusRequestEntityTooLarge)
		return
	}
	var header [512]byte
	n, err := io.ReadFull(file, header[:])
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		markdownResourceError(writer, err)
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		markdownResourceError(writer, err)
		return
	}
	contentType := http.DetectContentType(header[:n])
	if strings.EqualFold(filepath.Ext(resolved), ".svg") {
		contentType = "image/svg+xml"
	} else if !strings.HasPrefix(contentType, "image/") && contentType != "application/pdf" {
		contentType = "text/plain; charset=utf-8"
	}
	disposition := "inline"
	if request.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": filepath.Base(resolved)}))
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	writer.Header().Set("Cache-Control", "no-store")
	http.ServeContent(writer, request, filepath.Base(resolved), info.ModTime(), file)
}
