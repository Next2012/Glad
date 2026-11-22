package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type agySubagentStep struct {
	Index     int64  `json:"step_index"`
	Type      string `json:"type"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	Content   string `json:"content"`
	Thinking  string `json:"thinking"`
	ToolCalls []struct {
		ID   string         `json:"id"`
		Name string         `json:"name"`
		Args map[string]any `json:"args"`
	} `json:"tool_calls"`
}
type agySubagentRow struct {
	offset int64
	step   agySubagentStep
}

func agySubagentCreatedAt(value string) int64 {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.UnixMilli() <= 0 {
		return 0
	}
	return parsed.UnixMilli()
}

// Read one bounded window from a newline boundary, never the whole native log.
// An unfinished final record is held for a later refresh. Oversized/malformed
// records are visibly omitted; the cursor still advances toward older history.
func agySubagentReadRows(ctx context.Context, file *os.File, end int64, limit, budget int) ([]agySubagentRow, int64, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, nil, err
	}
	if end <= 0 {
		return []agySubagentRow{}, 0, nil, nil
	}
	start := end - int64(budget)
	if start < 0 {
		start = 0
	}
	buf := make([]byte, end-start)
	n, err := file.ReadAt(buf, start)
	if err != nil && err != io.EOF {
		return nil, 0, nil, err
	}
	buf = buf[:n]
	warnings := []string{}
	first := 0
	if start > 0 {
		at := bytes.IndexByte(buf, '\n')
		if at < 0 {
			return []agySubagentRow{}, start, []string{"A native log record exceeds the preview window."}, nil
		}
		first = at + 1
	}
	last := bytes.LastIndexByte(buf, '\n')
	if last < first {
		if start > 0 {
			return []agySubagentRow{}, start, []string{"A native log record exceeds the preview window."}, nil
		}
		return []agySubagentRow{}, start, nil, nil
	}
	if limit < 1 {
		limit = 40
	}
	if limit > 80 {
		limit = 80
	}
	// Keep only the requested tail rows while scanning. A window containing
	// thousands of tiny records must not allocate one retained object per row.
	rows := make([]agySubagentRow, 0, limit)
	head, total := 0, 0
	warned := map[string]bool{}
	warn := func(message string) {
		if !warned[message] {
			warned[message] = true
			warnings = append(warnings, message)
		}
	}
	offset := first
	for offset <= last {
		if err := ctx.Err(); err != nil {
			return nil, 0, nil, err
		}
		length := bytes.IndexByte(buf[offset:last+1], '\n')
		if length < 0 {
			break
		}
		line := buf[offset : offset+length]
		rowOffset := start + int64(offset)
		offset += length + 1
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if len(line) > agySubagentRecordBytes {
			warn("An oversized native log record was omitted.")
			continue
		}
		var step agySubagentStep
		if json.Unmarshal(line, &step) != nil {
			warn("An incomplete or invalid native log record was omitted.")
			continue
		}
		row := agySubagentRow{rowOffset, step}
		if len(rows) < limit {
			rows = append(rows, row)
		} else {
			rows[head] = row
			head = (head + 1) % limit
		}
		total++
	}
	before := int64(0)
	if total > limit {
		ordered := make([]agySubagentRow, 0, limit)
		ordered = append(ordered, rows[head:]...)
		ordered = append(ordered, rows[:head]...)
		rows = ordered
		before = rows[0].offset
	} else if start > 0 {
		before = start + int64(first)
	}
	return rows, before, warnings, nil
}
func agySubagentMessages(child string, rows []agySubagentRow) []map[string]any {
	messages := []map[string]any{}
	for _, row := range rows {
		step := row.step
		base := fmt.Sprintf("agy-child-%s-%d-%d", child, step.Index, row.offset)
		add := func(kind, text, suffix string, extra map[string]any) {
			message := map[string]any{"id": base + suffix, "kind": kind, "threadId": child, "turnId": "native-log", "isRootTurn": false, "text": agySubagentText(text, 16<<10), "streaming": false, "timeSource": "native", "nativeOffset": row.offset, "nativePart": len(messages), "previewTruncated": len(text) > 16<<10, "nativeStepIndex": step.Index, "nativeRecordType": step.Type, "nativeStatus": step.Status}
			if created := agySubagentCreatedAt(step.CreatedAt); created > 0 {
				message["createdAt"] = created
			} else {
				message["createdAt"] = nil
				message["timeSource"] = "unknown"
			}
			for k, v := range extra {
				message[k] = v
			}
			messages = append(messages, message)
		}
		switch step.Type {
		case "PLANNER_RESPONSE":
			if step.Thinking != "" {
				add("reasoning", step.Thinking, "-thought", nil)
			}
			if step.Content != "" {
				add("assistant", step.Content, "-message", nil)
			}
			for i, tool := range step.ToolCalls {
				if i >= 16 {
					break
				}
				budget := 16 << 10
				extra := map[string]any{"title": tool.Name, "name": tool.Name, "toolName": tool.Name, "toolStatus": "recorded", "input": antigravityBoundValue(tool.Args, &budget)}
				if tool.ID != "" {
					extra["providerId"] = tool.ID
				}
				add("tool", "", fmt.Sprintf("-tool-%d", i), extra)
			}
		case "USER_INPUT":
			if step.Content != "" {
				add("user", antigravityTranscriptUserText(step.Content), "-message", nil)
			}
		case "ERROR_MESSAGE":
			add("event", firstNonEmpty(step.Content, "Native error record; no further details were recorded."), "-event", map[string]any{"level": "error"})
		case "SYSTEM_MESSAGE", "CHECKPOINT", "CONVERSATION_HISTORY":
			if step.Content != "" {
				add("event", step.Content, "-event", nil)
			}
		default:
			if step.Content != "" {
				add("tool", step.Content, "-result", map[string]any{"title": step.Type, "toolStatus": firstNonEmpty(step.Status, "recorded")})
			}
		}
	}
	return messages
}
func (reader *antigravitySubagentReader) page(ctx context.Context, rootID, identity, child, before string, limit int) (antigravitySubagentPage, error) {
	page := antigravitySubagentPage{Success: true, ParentSessionID: rootID, SessionID: child, Messages: []map[string]any{}, HistoryOnly: true}
	if !agySubagentUUID.MatchString(child) {
		return page, errAgySubagentNotFound
	}
	items, _, _, err := reader.graph(ctx, rootID, identity, false)
	if err != nil {
		return page, err
	}
	var owned *antigravitySubagentItem
	for i := range items {
		if items[i].ID == child {
			owned = &items[i]
			break
		}
	}
	if owned == nil {
		return page, errAgySubagentNotFound
	}
	root, err := agySubagentOpenBrain(reader.directory)
	if err != nil {
		return page, errAgySubagentNotFound
	}
	defer root.Close()
	// Cached discovery never authorizes a read: verify every current graph edge.
	for i := 0; i < len(owned.proof); i += 2 {
		if err := ctx.Err(); err != nil {
			return page, err
		}
		if _, err := agySubagentMetadata(root, owned.proof[i], owned.proof[i+1]); err != nil {
			return page, errAgySubagentNotFound
		}
	}
	file, err := agySubagentOpen(root, filepath.Join(child, ".system_generated", "logs", "transcript_full.jsonl"))
	if err != nil {
		return page, errAgySubagentNotFound
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return page, errAgySubagentNotFound
	}
	reader.mu.Lock()
	if reader.identity != identity {
		reader.mu.Unlock()
		return page, errAgySubagentChanged
	}
	version, known := reader.files[child]
	if !known || !os.SameFile(version.info, info) || info.Size() < version.size {
		version = antigravitySubagentFile{info: info, token: newUUID(), size: info.Size()}
	}
	version.size = info.Size()
	reader.files[child] = version
	reader.mu.Unlock()
	page.TranscriptEpoch = version.token
	end := info.Size()
	if before != "" {
		if len(before) > 1024 {
			return page, errors.New("Invalid native history cursor")
		}
		data, err := base64.RawURLEncoding.DecodeString(before)
		if err != nil {
			return page, errors.New("Invalid native history cursor")
		}
		var cursor antigravitySubagentCursor
		if json.Unmarshal(data, &cursor) != nil || cursor.Identity != identity || cursor.Child != child || cursor.File != version.token || cursor.Offset < 0 || cursor.Offset > info.Size() {
			return page, errAgySubagentChanged
		}
		end = cursor.Offset
	}
	if limit < 1 {
		limit = 40
	}
	if limit > 80 {
		limit = 80
	}
	rows, next, warnings, err := agySubagentReadRows(ctx, file, end, limit, agySubagentPageBytes)
	if err != nil {
		return page, err
	}
	page.Messages = agySubagentMessages(child, rows)
	page.Warnings = warnings
	if next > 0 && next < end {
		encoded, _ := json.Marshal(antigravitySubagentCursor{identity, child, version.token, next})
		page.NextBefore = base64.RawURLEncoding.EncodeToString(encoded)
		page.HasMore = true
	}
	return page, nil
}
func (p *AntigravityProvider) subagentHistory(ctx context.Context, child, before string, limit int) (antigravitySubagentPage, error) {
	root, identity, valid := p.subagentIdentity()
	if !valid {
		return antigravitySubagentPage{}, errAgySubagentChanged
	}
	page, err := p.subagentReader().page(ctx, root, identity, child, strings.TrimSpace(before), limit)
	if err != nil {
		return page, err
	}
	_, current, valid := p.subagentIdentity()
	if !valid || current != identity {
		return page, errAgySubagentChanged
	}
	return page, nil
}
