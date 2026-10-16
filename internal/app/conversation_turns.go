package app

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	defaultTurnPageSize    = 20
	maxTurnPageSize        = 100
	maxDetailTurns         = 20
	defaultTurnDetailBytes = 32 << 10
	maxTurnDetailBytes     = 128 << 10
)

type conversationTurn struct {
	ID           string           `json:"turnId"`
	Number       int              `json:"number"`
	CreatedAt    int64            `json:"createdAt"`
	Status       string           `json:"status"`
	User         string           `json:"userPreview"`
	Assistant    string           `json:"assistantPreview"`
	Tools        int              `json:"toolCount"`
	Trigger      string           `json:"triggerEntryId,omitempty"`
	References   []string         `json:"quotedEntryIds,omitempty"`
	Origin       string           `json:"originRoomId,omitempty"`
	Hidden       bool             `json:"-"`
	Start, End   int64            `json:"-"`
	InputHash    string           `json:"-"`
	Live         []map[string]any `json:"-"`
	AssistantIDs []string         `json:"-"`
	Aliases      []string         `json:"aliases,omitempty"`
}

func (turn conversationTurn) summary() map[string]any {
	result := map[string]any{
		"turnId": turn.ID, "number": turn.Number, "createdAt": turn.CreatedAt,
		"status": turn.Status, "userPreview": turn.User,
		"assistantPreview": turn.Assistant, "toolCount": turn.Tools,
	}
	if turn.Trigger != "" {
		result["triggerEntryId"] = turn.Trigger
	}
	if len(turn.References) > 0 {
		result["quotedEntryIds"] = turn.References
	}
	if turn.Origin != "" {
		result["originRoomId"] = turn.Origin
	}
	if len(turn.Aliases) > 0 {
		result["aliases"] = turn.Aliases
	}
	return result
}

func turnInput(text string) (string, string) {
	visible := text
	if v, _, ok := roomTransportEnvelope(text); ok {
		visible = v
	}
	if _, v := supervisorEnvelope(visible); v != "" {
		visible = v
	}
	hash := sha256.Sum256([]byte(text))
	return visible, hex.EncodeToString(hash[:])
}

// This index retains previews and byte ranges only. Full detail remains in the
// provider's original transcript and is streamed in bounded chunks on demand.
func indexConversation(ctx context.Context, file *os.File, tool string) ([]conversationTurn, error) {
	turns := []conversationTurn{}
	byID := map[string]int{}
	current := -1
	var position int64
	reader := bufio.NewReader(file)
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
		start := position
		position += int64(len(line))
		var record map[string]any
		if json.Unmarshal(line, &record) != nil {
			continue
		}
		kind := stringValue(record["type"])
		payload := mapValue(record["payload"])
		id, user, assistant := "", "", ""
		toolCall := false
		if tool == "claude-code" {
			if boolValue(record["isSidechain"]) {
				continue
			}
			if kind == "user" {
				user = claudeTranscriptUserText(record)
				if user != "" {
					id = stringValue(record["uuid"])
				}
			}
			if kind == "assistant" {
				for _, v := range sliceValue(mapValue(record["message"])["content"]) {
					b := mapValue(v)
					if b["type"] == "text" {
						assistant += stringValue(b["text"])
					}
					if b["type"] == "tool_use" {
						toolCall = true
					}
				}
			}
		} else {
			if kind == "event_msg" && payload["type"] == "user_message" {
				user = stringValue(payload["message"])
			}
			if kind == "event_msg" && payload["type"] == "task_started" {
				id = stringValue(payload["turn_id"])
			}
			if kind == "response_item" {
				if payload["role"] == "user" && codexRolloutUserAuthored(payload) {
					user = codexRolloutContentText(payload["content"])
				}
				if payload["role"] == "assistant" {
					assistant = codexRolloutContentText(payload["content"])
				}
				toolCall = payload["type"] == "function_call" || payload["type"] == "custom_tool_call"
				if v := stringValue(mapValue(payload["internal_chat_message_metadata_passthrough"])["turn_id"]); v != "" {
					id = v
				}
			}
		}
		if id != "" {
			if index, ok := byID[id]; ok {
				current = index
			} else {
				current = len(turns)
				byID[id] = current
				var createdAt int64
				if timestamp := stringValue(record["timestamp"]); timestamp != "" {
					createdAt = parseTimeMillis(timestamp)
				}
				turns = append(turns, conversationTurn{ID: id, CreatedAt: createdAt, Status: "running", Start: start})
			}
		}
		if current < 0 {
			continue
		}
		turn := &turns[current]
		turn.End = position
		if user != "" {
			visible, hash := turnInput(user)
			turn.User = codexPreviewText(visible, 800)
			turn.InputHash = hash
			if source, _ := supervisorEnvelope(user); source != nil && source.Kind == "trigger" {
				turn.Hidden = true
			}
			meta := roomTransportMetadata(user)
			turn.Trigger = stringValue(meta["entryId"])
			turn.References = stringList(meta["quotedEntryIds"])
			_, turn.Origin, _ = roomTransportEnvelope(user)
		}
		if assistant != "" {
			turn.Assistant = codexPreviewText(assistant, 1200)
			if tool == "claude-code" {
				if id := stringValue(mapValue(record["message"])["id"]); id != "" {
					turn.AssistantIDs = append(turn.AssistantIDs, id)
				}
				turn.Status = "completed"
			}
		}
		if toolCall {
			turn.Tools++
		}
		if kind == "event_msg" && (payload["type"] == "task_complete" || payload["type"] == "turn_aborted") {
			turn.Status = "completed"
			if payload["type"] == "turn_aborted" {
				turn.Status = "cancelled"
			}
		}
	}
	return turns, nil
}

func stringList(value any) []string {
	if list, ok := value.([]string); ok {
		return list
	}
	list := []string{}
	for _, v := range sliceValue(value) {
		if s, ok := v.(string); ok {
			list = append(list, s)
		}
	}
	return list
}

func conversationTurns(ctx context.Context, session *Session) ([]conversationTurn, string, error) {
	path, pathErr := sessionTranscriptPath(session)
	turns := []conversationTurn{}
	if pathErr == nil {
		file, err := os.Open(path)
		if err == nil {
			turns, err = session.turnIndexes.read(ctx, file, session.Tool.Key)
			file.Close()
		}
		if err != nil {
			pathErr = err
			path = ""
		}
	}
	session.mu.RLock()
	conversationID := sessionNativeConversationID(session)
	live := make([]map[string]any, len(session.Messages))
	for i, m := range session.Messages {
		live[i] = cloneMap(m)
	}
	status := session.StatusValue
	session.mu.RUnlock()
	byID := map[string]int{}
	byHash := map[string][]int{}
	byAssistant := map[string]int{}
	for i, t := range turns {
		byID[t.ID] = i
		for _, id := range t.AssistantIDs {
			byAssistant[id] = i
		}
		if t.InputHash != "" {
			byHash[t.InputHash] = append(byHash[t.InputHash], i)
		}
	}
	grouped := map[string][]map[string]any{}
	claimed := map[int]bool{}
	order := []string{}
	for _, source := range roomSourceMessages(live, conversationID) {
		if grouped[source.TurnID] == nil {
			order = append(order, source.TurnID)
		}
		grouped[source.TurnID] = append(grouped[source.TurnID], source.Message)
	}
	for _, id := range order {
		messages := grouped[id]
		index, found := byID[id]
		input := ""
		var started int64
		for _, m := range messages {
			if m["kind"] == "user" {
				input = firstNonEmpty(stringValue(m["agentText"]), stringValue(m["text"]))
				started = numberInt64(m["createdAt"])
			}
			if !found && m["kind"] == "assistant" {
				if i, ok := byAssistant[stringValue(m["providerId"])]; ok {
					index, found = i, true
				}
			}
		}
		visible, hash := turnInput(input)
		if !found && input != "" {
			matches := byHash[hash]
			bestDistance := int64(30001)
			for _, i := range matches {
				if claimed[i] {
					continue
				}
				distance := turns[i].CreatedAt - started
				if distance < 0 {
					distance = -distance
				}
				if len(matches) == 1 || distance < bestDistance {
					index, found = i, true
					bestDistance = distance
				}
			}
		}
		if !found {
			index = len(turns)
			byID[id] = index
			turns = append(turns, conversationTurn{ID: id, Status: "running", InputHash: hash})
		}
		claimed[index] = true
		turn := &turns[index]
		if turn.ID != id {
			turn.Aliases = append(turn.Aliases, id)
		}
		if input != "" {
			turn.User = codexPreviewText(visible, 800)
			if source, _ := supervisorEnvelope(input); source != nil && source.Kind == "trigger" {
				turn.Hidden = true
			}
			meta := roomTransportMetadata(input)
			if meta != nil {
				turn.Trigger = stringValue(meta["entryId"])
				turn.References = stringList(meta["quotedEntryIds"])
			}
			if _, origin, ok := roomTransportEnvelope(input); ok {
				turn.Origin = origin
			}
		}
		for _, m := range messages {
			if turn.CreatedAt == 0 {
				turn.CreatedAt = numberInt64(m["createdAt"])
			}
			if m["kind"] == "assistant" {
				turn.Assistant = codexPreviewText(stringValue(m["text"]), 1200)
			}
			if m["kind"] == "turn-end" {
				turn.Status = firstNonEmpty(stringValue(m["status"]), stringValue(m["turnStatus"]), "completed")
			}
		}
		// Preserve a live snapshot alongside native detail, including not-yet-
		// flushed output. The response identifies both representations explicitly.
		turn.Live = messages
		if turn.End == 0 {
			for _, m := range messages {
				if m["kind"] == "tool" {
					turn.Tools++
				}
			}
		}
	}
	visibleTurns := turns[:0]
	for _, turn := range turns {
		if turn.User != "" || turn.Assistant != "" {
			visibleTurns = append(visibleTurns, turn)
		}
	}
	turns = visibleTurns
	sort.SliceStable(turns, func(i, j int) bool { return turns[i].CreatedAt < turns[j].CreatedAt })
	if len(turns) > 0 && status != "idle" {
		turns[len(turns)-1].Status = status
	}
	for i := range turns {
		turns[i].Number = i + 1
	}
	if pathErr != nil && len(turns) == 0 {
		return nil, "", pathErr
	}
	return turns, path, nil
}

func selectedTurns(turns []conversationTurn, args map[string]any) []conversationTurn {
	ids := stringList(args["turnIds"])
	numbers := map[int64]bool{}
	for _, v := range sliceValue(args["turnNumbers"]) {
		numbers[numberInt64(v)] = true
	}
	result := []conversationTurn{}
	for _, turn := range turns {
		if len(ids) > 0 {
			found := false
			for _, id := range ids {
				if turn.ID == id {
					found = true
				}
				for _, alias := range turn.Aliases {
					if alias == id {
						found = true
					}
				}
			}
			if !found {
				continue
			}
		}
		if len(numbers) > 0 && !numbers[int64(turn.Number)] {
			continue
		}
		if from := numberInt64(args["fromTurn"]); from > 0 && int64(turn.Number) < from {
			continue
		}
		if to := numberInt64(args["toTurn"]); to > 0 && int64(turn.Number) > to {
			continue
		}
		result = append(result, turn)
	}
	return result
}

func turnSummaries(turns []conversationTurn, args map[string]any) map[string]any {
	selected := selectedTurns(turns, args)
	offset := min(len(selected), max(0, int(numberInt64(args["offset"]))))
	limit := int(numberInt64(args["limit"]))
	if limit <= 0 {
		limit = defaultTurnPageSize
	}
	limit = min(limit, maxTurnPageSize)
	end := min(len(selected), offset+limit)
	return map[string]any{"success": true, "turns": selected[offset:end], "total": len(selected), "nextOffset": end, "hasMore": end < len(selected), "summaryKind": "extracted previews; not model-generated summaries"}
}

// Detail offsets count bytes in the concatenated native JSONL and live JSONL
// for this exact ordered selection. Stable IDs should be used across calls.
func turnDetails(ctx context.Context, turns []conversationTurn, path string, args map[string]any) (map[string]any, error) {
	selected := selectedTurns(turns, args)
	if len(selected) == 0 {
		return nil, fmt.Errorf("No matching turns")
	}
	if len(selected) > maxDetailTurns {
		return nil, fmt.Errorf("Select at most 20 turns for details")
	}
	offset := max(int64(0), numberInt64(args["offset"]))
	limit := int(numberInt64(args["limit"]))
	if limit <= 0 {
		limit = defaultTurnDetailBytes
	}
	limit = min(limit, maxTurnDetailBytes)
	snapshot := sha256.New()
	var readers []io.Reader
	var file *os.File
	if path != "" {
		var err error
		file, err = os.Open(path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(snapshot, "%s:%d:%d;", path, info.Size(), info.ModTime().UnixNano())
	}
	ids := []string{}
	for _, turn := range selected {
		ids = append(ids, turn.ID)
		fmt.Fprintf(snapshot, "%s:%d:%d;", turn.ID, turn.Start, turn.End)
		if file != nil && turn.End > turn.Start {
			readers = append(readers, io.NewSectionReader(file, turn.Start, turn.End-turn.Start))
		}
		for _, m := range turn.Live {
			data, _ := json.Marshal(map[string]any{"source": "live", "turnId": turn.ID, "message": m})
			snapshot.Write(data)
			readers = append(readers, strings.NewReader(string(data)+"\n"))
		}
	}
	snapshotID := hex.EncodeToString(snapshot.Sum(nil))
	if expected := stringValue(args["snapshotId"]); expected != "" && expected != snapshotID {
		return nil, fmt.Errorf("Selected turn details changed; restart at offset 0 for a new snapshot")
	}
	reader := io.MultiReader(readers...)
	if _, err := io.CopyN(io.Discard, reader, offset); err != nil && err != io.EOF {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	more := len(data) > limit
	if more {
		data = data[:limit]
	}
	for len(data) > 0 && !utf8.Valid(data) {
		data = data[:len(data)-1]
	}
	if len(data) == 0 && more {
		return nil, fmt.Errorf("Limit is too small for a UTF-8 character")
	}
	return map[string]any{"success": true, "turnIds": ids, "text": string(data), "offset": offset, "nextOffset": offset + int64(len(data)), "hasMore": more, "snapshotId": snapshotID, "format": "native JSONL followed by labeled live snapshots per turn"}, nil
}
