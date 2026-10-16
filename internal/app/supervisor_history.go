package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type transcriptIndexRow struct {
	Start, End          int64
	Time, Kind, Preview string
}

type supervisorHistoryIndex struct {
	Info    os.FileInfo
	Through int64
	Rows    []transcriptIndexRow
	Bytes   int
}

const supervisorIndexCacheBytes = 16 << 20

func (session *Session) rememberTranscriptPath(thread map[string]any) {
	if path, id := stringValue(thread["path"]), stringValue(thread["id"]); path != "" && id != "" {
		session.mu.Lock()
		session.nativeTranscriptPath, session.nativeTranscriptID = path, id
		session.mu.Unlock()
	}
}

// Resolve from provider identity, never from a caller-supplied filesystem path.
func sessionTranscriptPath(session *Session) (string, error) {
	session.mu.RLock()
	id, tool, cwd := sessionNativeConversationID(session), session.Tool.Key, session.WorkingDirectory
	hint, hintID := session.nativeTranscriptPath, session.nativeTranscriptID
	session.mu.RUnlock()
	if id == "" || strings.ContainsAny(id, `/\`) {
		return "", errors.New("Native conversation is not available yet")
	}
	if hint != "" && hintID == id {
		if info, err := os.Stat(hint); err == nil && info.Mode().IsRegular() {
			return filepath.Abs(hint)
		}
	}
	if tool == "claude-code" {
		return filepath.Abs(filepathForClaudeTranscript(cwd, id))
	}
	if tool != "codex" {
		return "", errors.New("Provider transcript is unsupported")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	matches, err := filepath.Glob(filepath.Join(codexHome, "sessions", "*", "*", "*", "*-"+id+".jsonl"))
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", errors.New("Native transcript has not been located. Use read_session for live output.")
	}
	return filepath.Abs(matches[len(matches)-1])
}

func transcriptIndexPreview(record map[string]any) (string, string) {
	kind := stringValue(record["type"])
	payload := mapValue(record["payload"])
	text := ""
	if kind == "response_item" {
		kind = firstNonEmpty(stringValue(payload["role"]), stringValue(payload["type"]))
		text = codexRolloutContentText(payload["content"])
		if text == "" {
			text = firstNonEmpty(stringValue(payload["name"]), stringValue(payload["arguments"]), codexRolloutOutputText(payload["output"]))
		}
	} else if kind == "user" || kind == "assistant" {
		message := mapValue(record["message"])
		if value, ok := message["content"].(string); ok {
			text = value
		} else {
			text = textFromClaudeContent(sliceValue(message["content"]))
		}
	} else if kind == "event_msg" {
		kind = firstNonEmpty(stringValue(payload["type"]), kind)
		text = firstNonEmpty(stringValue(payload["message"]), stringValue(payload["text"]))
	} else {
		// Keep a compact index; the byte reader still exposes every record.
		return "", ""
	}
	if visible, _, ok := roomTransportEnvelope(text); ok {
		text = visible
	}
	if source, visible := supervisorEnvelope(text); source != nil {
		text = visible
	}
	// Index only a short prefix; normalizing an entire tool output can create
	// a large temporary slice of words just to display a 180-byte preview.
	text = strings.Join(strings.Fields(codexPreviewText(text, 600)), " ")
	return kind, codexPreviewText(text, 180)
}

// Only offsets and short previews are cached. Raw transcripts are never copied
// or rewritten. A partial trailing JSONL record is indexed after it completes.
func (manager *SupervisorManager) sessionHistory(ctx context.Context, session *Session, offset, limit int) (map[string]any, error) {
	path, err := sessionTranscriptPath(session)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("Native transcript is not a regular file")
	}
	manager.historyMu.Lock()
	defer manager.historyMu.Unlock()
	if manager.historyIndexes == nil {
		manager.historyIndexes = map[string]*supervisorHistoryIndex{}
	}
	index := manager.historyIndexes[path]
	if index == nil || !os.SameFile(index.Info, info) || info.Size() < index.Info.Size() || (info.Size() == index.Info.Size() && !info.ModTime().Equal(index.Info.ModTime())) {
		index = &supervisorHistoryIndex{}
	}
	reader := bufio.NewReader(io.NewSectionReader(file, index.Through, info.Size()-index.Through))
	for {
		if err := ctx.Err(); err != nil {
			delete(manager.historyIndexes, path)
			return nil, err
		}
		line, readErr := reader.ReadBytes('\n')
		if len(line) == 0 || (readErr == io.EOF && line[len(line)-1] != '\n') {
			break
		}
		if readErr != nil && readErr != io.EOF {
			delete(manager.historyIndexes, path)
			return nil, readErr
		}
		start := index.Through
		index.Through += int64(len(line))
		var record map[string]any
		if json.Unmarshal(line, &record) == nil {
			kind, preview := transcriptIndexPreview(record)
			if kind != "" {
				row := transcriptIndexRow{start, index.Through, stringValue(record["timestamp"]), kind, preview}
				index.Rows = append(index.Rows, row)
				index.Bytes += len(row.Time) + len(kind) + len(preview) + 64
				if index.Bytes > supervisorIndexCacheBytes {
					delete(manager.historyIndexes, path)
					index.Rows = nil
					return scanTranscriptIndexPage(ctx, file, info, path, offset, limit)
				}
			}
		}
		if readErr == io.EOF {
			break
		}
	}
	index.Info = info
	bytes := index.Bytes
	for key, cached := range manager.historyIndexes {
		if key != path {
			bytes += cached.Bytes
		}
	}
	if bytes > supervisorIndexCacheBytes || len(manager.historyIndexes) >= 16 {
		clear(manager.historyIndexes)
	}
	if index.Bytes <= supervisorIndexCacheBytes {
		manager.historyIndexes[path] = index
	}
	if limit <= 0 {
		limit = 50
	}
	limit = min(200, limit)
	offset = min(max(0, offset), len(index.Rows))
	end := min(len(index.Rows), offset+limit)
	return transcriptIndexPage(path, info, index.Through, index.Rows[offset:end], offset, len(index.Rows)), nil
}

// An unusually large index stays pageable without retaining all of its rows.
func scanTranscriptIndexPage(ctx context.Context, file *os.File, info os.FileInfo, path string, offset, limit int) (map[string]any, error) {
	if limit <= 0 {
		limit = 50
	}
	limit = min(limit, 200)
	offset = max(0, offset)
	rows := make([]transcriptIndexRow, 0, limit)
	reader := bufio.NewReader(io.NewSectionReader(file, 0, info.Size()))
	var through int64
	total := 0
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line, err := reader.ReadBytes('\n')
		if err != nil && err != io.EOF {
			return nil, err
		}
		if len(line) == 0 || line[len(line)-1] != '\n' {
			break
		}
		start := through
		through += int64(len(line))
		var record map[string]any
		if json.Unmarshal(line, &record) != nil {
			continue
		}
		kind, preview := transcriptIndexPreview(record)
		if kind == "" {
			continue
		}
		if total >= offset && len(rows) < limit {
			rows = append(rows, transcriptIndexRow{start, through, stringValue(record["timestamp"]), kind, preview})
		}
		total++
	}
	return transcriptIndexPage(path, info, through, rows, min(offset, total), total), nil
}

func transcriptIndexPage(path string, info os.FileInfo, through int64, rows []transcriptIndexRow, offset, total int) map[string]any {
	var markdown strings.Builder
	fmt.Fprintf(&markdown, "# Conversation index\n\nOriginal record: %s\n\n| Record | Time | Kind | Preview | Bytes (end exclusive) |\n|---|---|---|---|---|\n", path)
	for i, row := range rows {
		clean := func(value string) string { return strings.NewReplacer("|", "\\|", "\n", " ", "\r", " ").Replace(value) }
		fmt.Fprintf(&markdown, "| %d | %s | %s | %s | %d–%d |\n", offset+i+1, clean(row.Time), clean(row.Kind), clean(row.Preview), row.Start, row.End)
	}
	next := offset + len(rows)
	return map[string]any{"success": true, "rawPath": path, "indexMarkdown": markdown.String(), "indexedThrough": through, "fileSize": info.Size(), "modifiedAt": info.ModTime().UnixMilli(), "total": total, "nextOffset": next, "hasMore": next < total, "liveOutputTool": "read_session"}
}

func readSessionRecord(ctx context.Context, session *Session, offset int64, limit int) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := sessionTranscriptPath(session)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("Native transcript is not a regular file")
	}
	offset = min(max(int64(0), offset), info.Size())
	if limit <= 0 {
		limit = 32 << 10
	}
	limit = min(limit, 128<<10)
	buffer := make([]byte, min(int64(limit), info.Size()-offset))
	n, err := file.ReadAt(buffer, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}
	buffer = buffer[:n]
	// Avoid losing a multibyte character across chunks. JSONL is UTF-8.
	end := len(buffer)
	for end > 0 && !utf8.Valid(buffer[:end]) {
		end--
		if n-end > 3 {
			return nil, errors.New("Transcript contains invalid UTF-8; read the original file")
		}
	}
	if n > 0 && end == 0 {
		return nil, errors.New("Read limit is too small for a complete UTF-8 character")
	}
	buffer = buffer[:end]
	next := offset + int64(len(buffer))
	return map[string]any{"success": true, "rawPath": path, "text": string(buffer), "offset": offset, "nextOffset": next, "hasMore": next < info.Size(), "fileSize": info.Size()}, nil
}
