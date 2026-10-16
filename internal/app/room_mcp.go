package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

func turnQueryProperties() map[string]any {
	return map[string]any{
		"snapshotId":  map[string]any{"type": "string", "description": "Return the previous detail response snapshotId when continuing with nextOffset. If content changed, restart from offset 0."},
		"turnIds":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": maxTurnPageSize},
		"turnNumbers": map[string]any{"type": "array", "items": map[string]any{"type": "integer", "minimum": 1}, "maxItems": maxTurnPageSize},
		"fromTurn":    map[string]any{"type": "integer", "minimum": 1}, "toTurn": map[string]any{"type": "integer", "minimum": 1},
		"offset": map[string]any{"type": "integer", "minimum": 0}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": maxTurnDetailBytes},
	}
}

func roomMCPTools() []map[string]any {
	result := []map[string]any{}
	for _, item := range []struct{ name, description string }{
		{"list_rooms", "List groups this session currently belongs to. Membership grants read access to the shared group history, including before joining."},
		{"room_members", "List group members and their current session names. Duplicate names return distinct member IDs. Membership is required."},
		{"room_turns", "Read selected group turn summaries. Filter by sessionName (exact name) or memberId, turnIds, turnNumbers, or a number range. Numbers are global chronological group turn numbers; use returned stable turnId for subsequent calls. Summaries are extracted previews."},
		{"room_turn_details", "Read complete details for selected group turns as paginated JSONL. Supply turnIds or turnNumbers/range. Follow nextOffset while hasMore; offset/limit count bytes. Native records and labeled live snapshots are included."},
		{"room_references", "Inspect a command or reply's references recursively, including the command that triggered a reply and references of referenced replies. Supply entryId from the current command or turn summaries. Missing sources are explicit. maxDepth defaults to 4, maximum 8."},
	} {
		properties := map[string]any{}
		required := []string{}
		if item.name != "list_rooms" {
			properties["roomId"] = map[string]any{"type": "string"}
			required = append(required, "roomId")
		}
		if item.name == "room_turns" || item.name == "room_turn_details" {
			for k, v := range turnQueryProperties() {
				properties[k] = v
			}
			properties["memberId"] = map[string]any{"type": "string"}
			properties["sessionName"] = map[string]any{"type": "string"}
		}
		if item.name == "room_references" {
			properties["entryId"] = map[string]any{"type": "string"}
			required = append(required, "entryId")
			properties["maxDepth"] = map[string]any{"type": "integer", "minimum": 0, "maximum": 8}
		}
		result = append(result, map[string]any{"name": item.name, "description": item.description, "inputSchema": map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}})
	}
	return result
}

func allGladTools() []map[string]any { return append(supervisorTools(), roomMCPTools()...) }
func isRoomMCPTool(name string) bool {
	for _, t := range roomMCPTools() {
		if t["name"] == name {
			return true
		}
	}
	return false
}

// Authorization is checked on every request, independent of supervisor leases.
func (manager *RoomManager) authorizedRoom(callerID, roomID string) (RoomRecord, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	historyID := manager.activeIDs[roomID]
	if historyID == "" {
		for _, id := range manager.activeIDs {
			if id == roomID {
				historyID = id
				break
			}
		}
	}
	if historyID == "" {
		return RoomRecord{}, errors.New("Group is not active")
	}
	room, err := manager.store.Get(historyID)
	if err != nil {
		return room, err
	}
	for _, member := range room.Members {
		if member.RuntimeSessionID == callerID && member.LeftAt == 0 {
			return room, nil
		}
	}
	return RoomRecord{}, errors.New("Session is not a current member of this group")
}

func (manager *RoomManager) CallMCP(ctx context.Context, caller *Session, tool string, args map[string]any) (map[string]any, error) {
	if err := validateGladArguments(tool, args, roomMCPTools()); err != nil {
		return nil, err
	}
	if tool == "list_rooms" {
		manager.mu.Lock()
		ids := []string{}
		for id := range manager.activeIDs {
			ids = append(ids, id)
		}
		manager.mu.Unlock()
		rooms := []map[string]any{}
		for _, id := range ids {
			if room, err := manager.authorizedRoom(caller.ID, id); err == nil {
				rooms = append(rooms, map[string]any{"roomId": id, "historyId": room.ID, "name": room.Name})
			}
		}
		return map[string]any{"success": true, "rooms": rooms}, nil
	}
	roomID := stringValue(args["roomId"])
	room, err := manager.authorizedRoom(caller.ID, roomID)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	switch tool {
	case "room_members":
		members := []map[string]any{}
		for _, m := range room.Members {
			members = append(members, map[string]any{"memberId": m.ID, "name": manager.sessions.memberName(m), "sessionId": m.RuntimeSessionID, "conversationId": m.NativeConversationID, "left": m.LeftAt != 0})
		}
		result = map[string]any{"success": true, "members": members, "readScope": "current group membership grants shared history read access independently of supervisor Read permission"}
	case "room_references":
		result, err = manager.referenceGraph(ctx, room, args)
	case "room_turns", "room_turn_details":
		result, err = manager.queryRoomTurns(ctx, room, tool, args)
	default:
		return nil, errors.New("Unknown group tool")
	}
	if err != nil {
		return nil, err
	}
	current, err := manager.authorizedRoom(caller.ID, roomID)
	if err != nil {
		return nil, err
	}
	if current.ID != room.ID {
		return nil, errors.New("Group history changed while reading")
	}
	return result, nil
}

func (manager *SessionManager) historySession(member RoomMemberRecord) *Session {
	if s := manager.Get(member.RuntimeSessionID); s != nil {
		s.mu.RLock()
		matches := member.NativeConversationID == "" || sessionNativeConversationID(s) == member.NativeConversationID
		s.mu.RUnlock()
		if matches {
			return s
		}
	}
	s := newSession(member.RuntimeSessionID, "", member.ToolKey+"-structured", ToolInfo{Key: member.ToolKey}, member.WorkingDirectory)
	s.turnIndexes = manager.turnIndexes
	if member.ToolKey == "codex" {
		s.State["threadId"] = member.NativeConversationID
	} else {
		s.State["claudeSessionId"] = member.NativeConversationID
	}
	return s
}

type roomQueryTurn struct {
	turn           conversationTurn
	path           string
	member         RoomMemberRecord
	command, reply string
}

func (manager *RoomManager) queryRoomTurns(ctx context.Context, room RoomRecord, tool string, args map[string]any) (map[string]any, error) {
	items := []roomQueryTurn{}
	unavailable := []map[string]any{}
	// Build global numbering before applying member/name filters.
	for _, member := range room.Members {
		turns, path, err := conversationTurns(ctx, manager.sessions.historySession(member))
		if err != nil {
			unavailable = append(unavailable, map[string]any{"memberId": member.ID, "error": err.Error()})
			continue
		}
		for _, turn := range turns {
			if turn.Hidden || member.LeftAt != 0 && turn.CreatedAt > member.LeftAt {
				continue
			}
			localID := turn.ID
			turn.ID = member.ID + ":" + localID
			for i := range turn.Aliases {
				turn.Aliases[i] = member.ID + ":" + turn.Aliases[i]
			}
			command, reply := roomHistoryEntryID(member.ID, localID, "user"), roomHistoryEntryID(member.ID, localID, "assistant")
			for _, entry := range room.Entries {
				if entry.MemberID == member.ID && entry.NativeTurnID == localID {
					reply = entry.ID
					if entry.TriggerEntryID != "" {
						command = entry.TriggerEntryID
					}
				}
			}
			items = append(items, roomQueryTurn{turn: turn, path: path, member: member, command: command, reply: reply})
		}
	}
	// Plain group notes and commands without an available execution turn also
	// belong to shared history. They have stable command IDs and no session name.
	represented := map[string]bool{}
	for _, item := range items {
		represented[item.command] = true
	}
	for _, entry := range room.Entries {
		if entry.Type != "user" || represented[entry.ID] {
			continue
		}
		turn := conversationTurn{ID: "command:" + entry.ID, CreatedAt: entry.CreatedAt, Status: entry.Status, User: codexPreviewText(entry.UserText, 800), Trigger: entry.ID, References: entry.QuotedEntryIDs, Live: []map[string]any{{"kind": "user", "text": entry.UserText, "quotedEntryIds": entry.QuotedEntryIDs, "entryId": entry.ID}}}
		items = append(items, roomQueryTurn{turn: turn, command: entry.ID})
	}
	sortRoomQueryTurns(items)
	filtered := []conversationTurn{}
	lookup := map[string]roomQueryTurn{}
	for i, item := range items {
		item.turn.Number = i + 1
		if name, ok := args["sessionName"].(string); ok && manager.sessions.memberName(item.member) != name {
			continue
		}
		if id := stringValue(args["memberId"]); id != "" && item.member.ID != id {
			continue
		}
		filtered = append(filtered, item.turn)
		lookup[item.turn.ID] = item
	}
	if tool == "room_turns" {
		result := turnSummaries(filtered, args)
		summaries := []map[string]any{}
		for _, turn := range result["turns"].([]conversationTurn) {
			summary := turn.summary()
			item := lookup[turn.ID]
			summary["memberId"] = item.member.ID
			summary["sessionName"] = manager.sessions.memberName(item.member)
			summary["commandEntryId"], summary["replyEntryId"] = item.command, item.reply
			summaries = append(summaries, summary)
		}
		result["turns"], result["unavailableMembers"] = summaries, unavailable
		return result, nil
	}
	selected := selectedTurns(filtered, args)
	if len(selected) == 0 {
		return nil, fmt.Errorf("No matching turns")
	}
	if len(selected) > maxDetailTurns {
		return nil, fmt.Errorf("Select at most 20 turns")
	}
	// Page each selected turn separately. The same byte offset applies to each;
	// callers continue only the turn IDs whose hasMore is true.
	details := []map[string]any{}
	for _, turn := range selected {
		item := lookup[turn.ID]
		query := cloneMap(args)
		delete(query, "turnIds")
		delete(query, "turnNumbers")
		delete(query, "fromTurn")
		delete(query, "toTurn")
		query["limit"] = min(defaultTurnDetailBytes, max(1, int(numberInt64(firstNonNil(args["limit"], defaultTurnDetailBytes)))))
		result, err := turnDetails(ctx, []conversationTurn{turn}, item.path, query)
		if err != nil {
			return nil, err
		}
		result["turnId"], result["memberId"], result["commandEntryId"], result["replyEntryId"] = turn.ID, item.member.ID, item.command, item.reply
		details = append(details, result)
	}
	return map[string]any{"success": true, "details": details, "pagination": "Each detail has its own byte cursor; continue its turnId with nextOffset", "unavailableMembers": unavailable}, nil
}

func (manager *RoomManager) referenceGraph(ctx context.Context, room RoomRecord, args map[string]any) (map[string]any, error) {
	manager.mu.Lock()
	entries := manager.projectRoomEntriesLocked(room)
	manager.mu.Unlock()
	byID := map[string]RoomEntryRecord{}
	for _, entry := range entries {
		byID[entry.ID] = entry
	}
	// The browser projection is bounded. Resolve historical reference nodes from
	// the complete native index too, so older turns remain addressable.
	for _, member := range room.Members {
		turns, _, err := conversationTurns(ctx, manager.sessions.historySession(member))
		if err != nil {
			continue
		}
		for _, turn := range turns {
			if turn.Hidden || member.LeftAt != 0 && turn.CreatedAt > member.LeftAt {
				continue
			}
			command, reply := roomHistoryEntryID(member.ID, turn.ID, "user"), roomHistoryEntryID(member.ID, turn.ID, "assistant")
			byID[command] = RoomEntryRecord{ID: command, Type: "user", MemberID: member.ID, UserText: turn.User, QuotedEntryIDs: turn.References}
			byID[reply] = RoomEntryRecord{ID: reply, Type: "session", MemberID: member.ID, ResolvedText: turn.Assistant, TriggerEntryID: command}
			if turn.Trigger != "" {
				if _, exists := byID[turn.Trigger]; !exists {
					e := byID[command]
					e.ID = turn.Trigger
					byID[turn.Trigger] = e
				}
			}
		}
	}
	maxDepth := 4
	if v, ok := args["maxDepth"]; ok {
		maxDepth = int(numberInt64(v))
	}
	nodes := []map[string]any{}
	seen := map[string]bool{}
	cut := false
	var visit func(string, int)
	visit = func(id string, depth int) {
		if seen[id] {
			return
		}
		if depth > maxDepth || len(nodes) >= 128 {
			cut = true
			return
		}
		seen[id] = true
		entry, ok := byID[id]
		if !ok {
			nodes = append(nodes, map[string]any{"entryId": id, "available": false})
			return
		}
		node := map[string]any{"entryId": id, "available": true, "type": entry.Type, "memberId": entry.MemberID, "quotedEntryIds": entry.QuotedEntryIDs, "triggerEntryId": entry.TriggerEntryID, "preview": codexPreviewText(firstNonEmpty(entry.UserText, entry.ResolvedText), 800)}
		nodes = append(nodes, node)
		if entry.TriggerEntryID != "" {
			visit(entry.TriggerEntryID, depth+1)
		}
		for _, ref := range entry.QuotedEntryIDs {
			visit(ref, depth+1)
		}
	}
	visit(stringValue(args["entryId"]), 0)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"success": true, "nodes": nodes, "truncated": cut, "maxDepth": maxDepth}, nil
}

func roomTransportMetadata(text string) map[string]any {
	const open, close = "<glad_group_metadata>", "</glad_group_metadata>"
	if source, visible := supervisorEnvelope(text); source != nil {
		text = visible
	}
	if _, _, ok := roomTransportEnvelope(text); !ok {
		return nil
	}
	start := strings.LastIndex(text, open)
	if start < 0 {
		return nil
	}
	start += len(open)
	end := strings.Index(text[start:], close)
	if end < 0 {
		return nil
	}
	var metadata map[string]any
	if json.Unmarshal([]byte(text[start:start+end]), &metadata) != nil {
		return nil
	}
	return metadata
}

func sortRoomQueryTurns(items []roomQueryTurn) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].turn.CreatedAt == items[j].turn.CreatedAt {
			return items[i].turn.ID < items[j].turn.ID
		}
		return items[i].turn.CreatedAt < items[j].turn.CreatedAt
	})
}
