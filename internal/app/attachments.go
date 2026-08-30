package app

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const maxAttachmentBytes = 50 << 20
const maxAttachmentChunks = 128

var safeUploadIDPattern = regexp.MustCompile(`^[a-zA-Z0-9-]{8,100}$`)

type ChunkUpload struct {
	ID    string
	Kind  string
	Name  string
	Path  string
	Total int
	Next  int
	Bytes int64
}

type AttachmentStore struct {
	root       string
	uploadRoot string
}

func NewAttachmentStore() *AttachmentStore {
	return &AttachmentStore{
		root:       filepath.Join(os.TempDir(), "glad", "attachments"),
		uploadRoot: filepath.Join(os.TempDir(), "glad", "uploads"),
	}
}

func (store *AttachmentStore) StoreImage(session *Session, data []byte) (Attachment, error) {
	extension, mediaType := imageType(data)
	if extension == "" {
		return Attachment{}, errors.New("Only PNG, JPEG, GIF, and WebP images are supported")
	}
	if len(data) == 0 || len(data) > maxAttachmentBytes {
		return Attachment{}, errors.New("Image must be 50 MB or smaller")
	}
	session.mu.Lock()
	images := 0
	for _, item := range session.Attachments {
		if item.MediaType != "" {
			images++
		}
	}
	if images >= 5 {
		session.mu.Unlock()
		return Attachment{}, errors.New("You can attach at most 5 images at a time")
	}
	directory := filepath.Join(store.root, session.ID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		session.mu.Unlock()
		return Attachment{}, err
	}
	attachment := Attachment{
		ID:        newUUID(),
		Name:      "image." + extension,
		Path:      filepath.Join(directory, newUUID()+"."+extension),
		Size:      int64(len(data)),
		MediaType: mediaType,
	}
	if err := os.WriteFile(attachment.Path, data, 0o600); err != nil {
		session.mu.Unlock()
		return Attachment{}, err
	}
	session.Attachments[attachment.ID] = attachment
	session.mu.Unlock()
	return attachment, nil
}

func (store *AttachmentStore) AppendChunk(
	session *Session,
	kind, uploadID, name string,
	index, total int,
	data []byte,
) (map[string]any, error) {
	if !safeUploadIDPattern.MatchString(uploadID) {
		return nil, errors.New("Invalid upload id")
	}
	if len(data) == 0 {
		return nil, errors.New("Attachment chunk is required")
	}
	if index < 0 || total < 1 || total > maxAttachmentChunks || index >= total {
		return nil, errors.New("Invalid chunk metadata")
	}
	name = safeFileName(name)
	session.mu.Lock()
	upload := session.Uploads[uploadID]
	if upload == nil {
		if index != 0 {
			session.mu.Unlock()
			return nil, errors.New("Upload must start with the first chunk")
		}
		directory := filepath.Join(store.uploadRoot, session.ID)
		if err := os.MkdirAll(directory, 0o700); err != nil {
			session.mu.Unlock()
			return nil, err
		}
		upload = &ChunkUpload{
			ID:    uploadID,
			Kind:  kind,
			Name:  name,
			Path:  filepath.Join(directory, uploadID+".part"),
			Total: total,
		}
		session.Uploads[uploadID] = upload
	}
	if upload.Kind != kind || upload.Name != name || upload.Total != total || upload.Next != index {
		session.mu.Unlock()
		return nil, errors.New("Attachment chunks arrived out of order")
	}
	if upload.Bytes+int64(len(data)) > maxAttachmentBytes {
		delete(session.Uploads, uploadID)
		session.mu.Unlock()
		_ = os.Remove(upload.Path)
		return nil, errors.New("Attachment must be 50 MB or smaller")
	}
	flags := os.O_CREATE | os.O_WRONLY
	if index == 0 {
		flags |= os.O_EXCL
	} else {
		flags |= os.O_APPEND
	}
	file, err := os.OpenFile(upload.Path, flags, 0o600)
	if err != nil {
		session.mu.Unlock()
		return nil, err
	}
	_, err = file.Write(data)
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		session.mu.Unlock()
		return nil, err
	}
	upload.Bytes += int64(len(data))
	upload.Next++
	if upload.Next < upload.Total {
		result := map[string]any{"complete": false, "receivedChunks": upload.Next, "size": upload.Bytes}
		session.mu.Unlock()
		return result, nil
	}
	delete(session.Uploads, uploadID)
	if kind == "image" {
		bytes, err := os.ReadFile(upload.Path)
		session.mu.Unlock()
		defer os.Remove(upload.Path)
		if err != nil {
			return nil, err
		}
		attachment, err := store.StoreImage(session, bytes)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"complete":   true,
			"attachment": map[string]any{"id": attachment.ID, "name": attachment.Name, "size": attachment.Size},
		}, nil
	}
	pending := 0
	for _, item := range session.Attachments {
		if item.MediaType == "" {
			pending++
		}
	}
	if pending >= 8 {
		session.mu.Unlock()
		_ = os.Remove(upload.Path)
		return nil, errors.New("You can attach at most 8 files at a time")
	}
	directory := filepath.Join(store.root, session.ID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		session.mu.Unlock()
		return nil, err
	}
	attachment := Attachment{
		ID:   newUUID(),
		Name: upload.Name,
		Path: filepath.Join(directory, newUUID()+"-"+upload.Name),
		Size: upload.Bytes,
	}
	if err := os.Rename(upload.Path, attachment.Path); err != nil {
		session.mu.Unlock()
		return nil, err
	}
	_ = os.Chmod(attachment.Path, 0o600)
	session.Attachments[attachment.ID] = attachment
	session.mu.Unlock()
	return map[string]any{
		"complete": true,
		"attachment": map[string]any{
			"id":   attachment.ID,
			"name": attachment.Name,
			"size": attachment.Size,
			"kind": "file",
		},
	}, nil
}

func (store *AttachmentStore) Resolve(session *Session, ids []string) []Attachment {
	result := []Attachment{}
	seen := map[string]bool{}
	session.mu.RLock()
	defer session.mu.RUnlock()
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if item, ok := session.Attachments[id]; ok {
			result = append(result, item)
		}
	}
	return result
}

func (store *AttachmentStore) DeleteAttachment(session *Session, id string) bool {
	session.mu.Lock()
	item, ok := session.Attachments[id]
	if ok {
		delete(session.Attachments, id)
	}
	session.mu.Unlock()
	if ok {
		_ = os.Remove(item.Path)
	}
	return ok
}

func (store *AttachmentStore) DeleteUpload(session *Session, id string) bool {
	session.mu.Lock()
	item, ok := session.Uploads[id]
	if ok {
		delete(session.Uploads, id)
	}
	session.mu.Unlock()
	if ok {
		_ = os.Remove(item.Path)
	}
	return ok
}

func cleanupSessionAttachments(session *Session) {
	_ = os.RemoveAll(filepath.Join(os.TempDir(), "glad", "attachments", session.ID))
	_ = os.RemoveAll(filepath.Join(os.TempDir(), "glad", "uploads", session.ID))
}

func imageType(data []byte) (string, string) {
	if len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}) {
		return "png", "image/png"
	}
	if len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
		return "jpg", "image/jpeg"
	}
	if len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a") {
		return "gif", "image/gif"
	}
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		return "webp", "image/webp"
	}
	return "", ""
}

func safeFileName(value string) string {
	if decoded, err := url.QueryUnescape(value); err == nil {
		value = decoded
	}
	value = strings.ReplaceAll(value, "\\", "/")
	value = pathBase(value)
	if value == "" {
		value = "attachment.bin"
	}
	clean := strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, value)
	clean = strings.TrimSpace(clean)
	runes := []rune(clean)
	if len(runes) > 160 {
		clean = string(runes[:160])
	}
	if clean == "" {
		return "attachment.bin"
	}
	return clean
}

func pathBase(value string) string { parts := strings.Split(value, "/"); return parts[len(parts)-1] }

func (server *Server) uploadImage(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxAttachmentBytes+1))
	if err != nil {
		respondError(writer, 413, err)
		return
	}
	attachment, err := server.attachments.StoreImage(session, data)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(
		writer,
		201,
		map[string]any{
			"success":    true,
			"attachment": map[string]any{"id": attachment.ID, "name": attachment.Name, "size": attachment.Size},
		},
	)
}

func (server *Server) uploadImageChunk(writer http.ResponseWriter, request *http.Request) {
	server.uploadChunk(writer, request, "image", "image")
}
func (server *Server) uploadFileChunk(writer http.ResponseWriter, request *http.Request) {
	server.uploadChunk(writer, request, "file", request.Header.Get("X-Glad-File-Name"))
}
func (server *Server) uploadChunk(writer http.ResponseWriter, request *http.Request, kind, name string) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, 1<<20))
	if err != nil {
		respondError(writer, 413, err)
		return
	}
	result, err := server.attachments.AppendChunk(
		session,
		kind,
		request.Header.Get("X-Glad-Upload-Id"),
		name,
		atoiDefault(request.Header.Get("X-Glad-Chunk-Index"), -1),
		atoiDefault(request.Header.Get("X-Glad-Chunk-Total"), -1),
		data,
	)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	result["success"] = true
	respondJSON(writer, 200, result)
}

func (server *Server) deleteUpload(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	respondJSON(
		writer,
		200,
		map[string]any{
			"success": true,
			"removed": server.attachments.DeleteUpload(session, request.PathValue("uploadId")),
		},
	)
}
func (server *Server) deleteAttachment(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	if !server.attachments.DeleteAttachment(session, request.PathValue("attachmentId")) {
		notFound(writer, "Attachment not found")
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}

var _ = fmt.Sprintf
