package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTurnQueriesReadOldSparseTurnsAndCompleteUTF8Details(t *testing.T) {
	session := newSession("history", "", "claude-structured", ToolInfo{Key: "claude-code"}, t.TempDir())
	session.State["claudeSessionId"] = "native"
	path := filepath.Join(t.TempDir(), "native.jsonl")
	var transcript strings.Builder
	long := strings.Repeat("完整工具输出", 20000)
	for i := 1; i <= 1100; i++ {
		user, _ := json.Marshal(map[string]any{"type": "user", "uuid": fmt.Sprint(i), "timestamp": "2026-10-16T12:00:00Z", "message": map[string]any{"content": fmt.Sprint("question ", i)}})
		answer := fmt.Sprint("answer ", i)
		if i == 1 {
			answer = long
		}
		assistant, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": answer}}}})
		transcript.Write(user)
		transcript.WriteByte('\n')
		transcript.Write(assistant)
		transcript.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(transcript.String()), 0600); err != nil {
		t.Fatal(err)
	}
	session.rememberTranscriptPath(map[string]any{"id": "native", "path": path})
	turns, native, err := conversationTurns(context.Background(), session)
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 1100 {
		t.Fatalf("old turns lost: %d", len(turns))
	}
	page := turnSummaries(turns, map[string]any{"turnNumbers": []any{float64(1), float64(19), float64(1100)}})
	if numberInt64(page["total"]) != 3 {
		t.Fatal(page)
	}
	args := map[string]any{"turnIds": []string{"1"}, "limit": 8192}
	var detail strings.Builder
	for {
		chunk, err := turnDetails(context.Background(), turns, native, args)
		if err != nil {
			t.Fatal(err)
		}
		detail.WriteString(stringValue(chunk["text"]))
		if !boolValue(chunk["hasMore"]) {
			break
		}
		args["offset"] = chunk["nextOffset"]
	}
	if !strings.Contains(detail.String(), long) || strings.Contains(detail.String(), "question 2\"") {
		t.Fatal("selected original content truncated or unrelated turn included")
	}
}

func TestGroupMCPMembershipNamesAndNestedReferences(t *testing.T) {
	rooms, session, _, room, member := newRuntimeRoomTest(t)
	session.Name = "Current name"
	session.Messages = []map[string]any{
		{"id": "u1", "kind": "user", "turnId": "turn-1", "text": "first", "createdAt": int64(1)},
		{"id": "a1", "kind": "assistant", "turnId": "turn-1", "text": "answer", "createdAt": int64(2)},
	}
	ctx := context.Background()
	page, err := rooms.CallMCP(ctx, session, "room_turns", map[string]any{"roomId": room.ID, "sessionName": "Current name"})
	if err != nil {
		t.Fatal(err)
	}
	if numberInt64(page["total"]) != 1 {
		t.Fatal(page)
	}
	if _, err = rooms.PostMessage(ctx, room.ID, RoomMessageInput{Text: "Shared note with no mention"}); err != nil {
		t.Fatal(err)
	}
	all, err := rooms.CallMCP(ctx, session, "room_turns", map[string]any{"roomId": room.ID})
	if err != nil {
		t.Fatal(err)
	}
	if numberInt64(all["total"]) != 2 {
		t.Fatal("plain group note missing", all)
	}
	var noteID string
	for _, turn := range all["turns"].([]map[string]any) {
		if turn["userPreview"] == "Shared note with no mention" {
			noteID = stringValue(turn["turnId"])
		}
	}
	detail, err := rooms.CallMCP(ctx, session, "room_turn_details", map[string]any{"roomId": room.ID, "turnIds": []string{noteID}})
	if err != nil || !strings.Contains(stringValue(detail["details"].([]map[string]any)[0]["text"]), "Shared note with no mention") {
		t.Fatal("note details unavailable", detail, err)
	}
	if _, err = rooms.CallMCP(ctx, newSession("outsider", "", "", ToolInfo{}, ""), "room_turns", map[string]any{"roomId": room.ID}); err == nil {
		t.Fatal("nonmember read group")
	}
	root := roomHistoryEntryID(member.ID, "turn-1", "assistant")
	commandB := RoomEntryRecord{ID: "command-b", Type: "user", UserText: "B", QuotedEntryIDs: []string{root}, MentionedMemberIDs: []string{member.ID}}
	replyB := RoomEntryRecord{ID: "reply-b", Type: "session", MemberID: member.ID, TriggerEntryID: commandB.ID, NativeTurnID: "turn-b"}
	commandC := RoomEntryRecord{ID: "command-c", Type: "user", UserText: "C", QuotedEntryIDs: []string{replyB.ID}}
	if err = rooms.mutate(room.ID, func(r *RoomRecord) error { r.Entries = append(r.Entries, commandB, replyB, commandC); return nil }); err != nil {
		t.Fatal(err)
	}
	graph, err := rooms.CallMCP(ctx, session, "room_references", map[string]any{"roomId": room.ID, "entryId": "command-c", "maxDepth": 8})
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, node := range graph["nodes"].([]map[string]any) {
		found[stringValue(node["entryId"])] = true
	}
	if !found["reply-b"] || !found["command-b"] || !found[root] {
		t.Fatal(graph)
	}
	if err = rooms.RemoveMember(room.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = rooms.CallMCP(ctx, session, "room_references", map[string]any{"roomId": room.ID, "entryId": "command-c"}); err == nil {
		t.Fatal("removed member retained access")
	}
}

func TestSessionNamesPersistAcrossResumeWithoutRoomFallback(t *testing.T) {
	store := &SessionNameStore{directory: t.TempDir()}
	session := newSession("one", "Manual Claude", "claude-structured", ToolInfo{Key: "claude-code"}, "/project")
	session.names = store
	session.NameManual = true
	session.setState(map[string]any{"claudeSessionId": "source"})
	if err := store.write("claude-code", "/project", "other", sessionName{"Other name", true}); err != nil {
		t.Fatal(err)
	}
	session.setState(map[string]any{"claudeSessionId": "other"})
	if session.Name != "Other name" {
		t.Fatal("resume retained previous session name", session.Name)
	}
	session.setState(map[string]any{"claudeSessionId": "missing"})
	if session.Name != "" || session.NameManual {
		t.Fatal("missing name was filled from previous session")
	}
	session.setState(map[string]any{"claudeSessionId": "source"})
	if session.Name != "Manual Claude" {
		t.Fatal("manual name not restored")
	}
	manager := NewSessionManager(t.TempDir())
	manager.names = &SessionNameStore{directory: store.directory}
	member := RoomMemberRecord{ToolKey: "claude-code", WorkingDirectory: "/project", NativeConversationID: "source", DisplayName: "Stale group snapshot"}
	if name := manager.memberName(member); name != "Manual Claude" {
		t.Fatal(name)
	}
	member.NativeConversationID = "missing"
	if name := manager.memberName(member); name != "" {
		t.Fatal("group name fallback", name)
	}
	data, _ := json.Marshal(member)
	if strings.Contains(string(data), "displayName") || strings.Contains(string(data), "Stale") {
		t.Fatal("group persists session name", string(data))
	}
	session.forkNameSource = "source"
	session.setState(map[string]any{"claudeSessionId": "fork"})
	value, _ := store.read("claude-code", "/project", "fork")
	if value.Name != "Manual Claude" {
		t.Fatal("fork did not own its name")
	}
	_ = store.write("claude-code", "/project", "fork", sessionName{"New fork name", true})
	value, _ = store.read("claude-code", "/project", "source")
	if value.Name != "Manual Claude" {
		t.Fatal("fork changed source name")
	}
}

func TestNativeSessionNamesRegisterOnceAndNeverReplaceExplicitNames(t *testing.T) {
	store := &SessionNameStore{directory: t.TempDir()}
	if err := store.registerNativeName("codex", "/project", "existing", "Saved session name"); err != nil {
		t.Fatal(err)
	}
	name, err := store.read("codex", "/project", "existing")
	if err != nil || name.Name != "Saved session name" {
		t.Fatal(name, err)
	}
	if err = store.write("codex", "/project", "existing", sessionName{Name: "", Manual: true}); err != nil {
		t.Fatal(err)
	}
	if err = store.registerNativeName("codex", "/project", "existing", "Old native name"); err != nil {
		t.Fatal(err)
	}
	name, err = store.read("codex", "/project", "existing")
	if err != nil || name.Name != "" || !name.Manual {
		t.Fatal("native discovery replaced explicit name", name, err)
	}
	session := newSession("resume", "Temporary window", "codex-structured", ToolInfo{Key: "codex"}, "/project")
	session.names = store
	session.NameManual = true
	if err = session.restoreConversationName("existing"); err != nil {
		t.Fatal(err)
	}
	if session.Name != "" {
		t.Fatal("Resume used the temporary window name", session.Name)
	}
}

func TestResumeBeforeFirstNativeIdentityDoesNotRenameSavedSession(t *testing.T) {
	store := &SessionNameStore{directory: t.TempDir()}
	if err := store.write("claude-code", "/project", "saved", sessionName{Name: "Saved name", Manual: true}); err != nil {
		t.Fatal(err)
	}
	session := newSession("new-window", "Temporary window", "claude-structured", ToolInfo{Key: "claude-code"}, "/project")
	session.names = store
	session.NameManual = true
	finish := session.beginNameRestore("saved")
	defer finish()
	session.setState(map[string]any{"claudeSessionId": "saved"})
	name, err := store.read("claude-code", "/project", "saved")
	if err != nil || name.Name != "Saved name" || session.Name != "Saved name" {
		t.Fatal("temporary name overwrote restored session", name, session.Name, err)
	}
}

func TestGroupTransportCarriesTriggerAndReferenceProvenance(t *testing.T) {
	rooms, session, _, room, member := newRuntimeRoomTest(t)
	provider := &stubProvider{}
	session.Provider = provider
	session.Messages = []map[string]any{{"kind": "user", "turnId": "old", "text": "old question", "createdAt": int64(1)}, {"kind": "assistant", "turnId": "old", "text": "old answer", "createdAt": int64(2)}}
	id := roomHistoryEntryID(member.ID, "old", "assistant")
	if _, err := rooms.PostMessage(context.Background(), room.ID, RoomMessageInput{Text: "use this", MentionedMemberIDs: []string{member.ID}, QuotedEntryIDs: []string{id}}); err != nil {
		t.Fatal(err)
	}
	meta := roomTransportMetadata(provider.inputs[0].AgentText)
	if stringValue(meta["entryId"]) == "" || len(stringList(meta["quotedEntryIds"])) != 1 {
		t.Fatal(meta)
	}
	record, _ := rooms.GetRecord(room.ID)
	if record.Entries[1].TriggerEntryID != stringValue(meta["entryId"]) {
		t.Fatal("reply lost command locator")
	}
}

func TestClaudeRepeatedPromptsKeepDistinctTurnsAndLiveAliases(t *testing.T) {
	session := newSession("repeat", "", "claude-structured", ToolInfo{Key: "claude-code"}, t.TempDir())
	session.State["claudeSessionId"] = "repeat-native"
	path := filepath.Join(t.TempDir(), "repeat.jsonl")
	var records strings.Builder
	for i := 1; i <= 2; i++ {
		user, _ := json.Marshal(map[string]any{"type": "user", "uuid": fmt.Sprint("native-", i), "timestamp": "2026-10-16T12:00:00Z", "message": map[string]any{"content": "same request"}})
		assistant, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"id": fmt.Sprint("answer-", i), "content": []any{map[string]any{"type": "text", "text": fmt.Sprint("reply ", i)}}}})
		records.Write(user)
		records.WriteByte('\n')
		records.Write(assistant)
		records.WriteByte('\n')
		session.Messages = append(session.Messages, map[string]any{"kind": "user", "turnId": fmt.Sprint("live-", i), "text": "same request"}, map[string]any{"kind": "assistant", "turnId": fmt.Sprint("live-", i), "providerId": fmt.Sprint("answer-", i), "text": fmt.Sprint("reply ", i)})
	}
	if err := os.WriteFile(path, []byte(records.String()), 0600); err != nil {
		t.Fatal(err)
	}
	session.rememberTranscriptPath(map[string]any{"id": "repeat-native", "path": path})
	turns, _, err := conversationTurns(context.Background(), session)
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 2 || turns[0].Assistant != "reply 1" || turns[1].Assistant != "reply 2" {
		t.Fatal(turns)
	}
	selected := selectedTurns(turns, map[string]any{"turnIds": []string{"live-2"}})
	if len(selected) != 1 || selected[0].ID != "native-2" {
		t.Fatal("live ID was lost when native records arrived", selected)
	}
}

func TestClaudeRepeatedUnflushedPromptDoesNotReplacePreviousTurn(t *testing.T) {
	session := newSession("repeat-live", "", "claude-structured", ToolInfo{Key: "claude-code"}, t.TempDir())
	session.State["claudeSessionId"] = "repeat-native"
	path := filepath.Join(t.TempDir(), "repeat.jsonl")
	transcript := `{"type":"user","uuid":"native-1","message":{"content":"same request"}}` + "\n" +
		`{"type":"assistant","message":{"id":"answer-1","content":[{"type":"text","text":"previous answer"}]}}` + "\n"
	if err := os.WriteFile(path, []byte(transcript), 0600); err != nil {
		t.Fatal(err)
	}
	session.rememberTranscriptPath(map[string]any{"id": "repeat-native", "path": path})
	session.Messages = []map[string]any{
		{"kind": "user", "turnId": "live-1", "text": "same request"},
		{"kind": "assistant", "turnId": "live-1", "providerId": "answer-1", "text": "previous answer"},
		{"kind": "user", "turnId": "live-2", "text": "same request"},
	}
	turns, _, err := conversationTurns(context.Background(), session)
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 2 || turns[0].Assistant != "previous answer" || turns[1].ID != "live-2" {
		t.Fatalf("unflushed input merged into a previous turn: %#v", turns)
	}
}

func TestTurnDetailsRejectChangingSnapshotAndForkKeepsLaterManualRename(t *testing.T) {
	turns := []conversationTurn{{ID: "running", User: "input", Live: []map[string]any{{"kind": "assistant", "text": "partial"}}}}
	first, err := turnDetails(context.Background(), turns, "", map[string]any{"limit": 8})
	if err != nil {
		t.Fatal(err)
	}
	turns[0].Live[0]["text"] = "changed"
	if _, err = turnDetails(context.Background(), turns, "", map[string]any{"offset": first["nextOffset"], "snapshotId": first["snapshotId"]}); err == nil {
		t.Fatal("changed detail silently continued")
	}
	s := newSession("fork", "", "claude-structured", ToolInfo{Key: "claude-code"}, "/project")
	s.names = &SessionNameStore{directory: t.TempDir()}
	if err = s.names.write("claude-code", "/project", "source", sessionName{"Old", true}); err != nil {
		t.Fatal(err)
	}
	s.forkNameSource = "source"
	s.forkNameRevision = s.nameRevision
	s.Name = "User renamed during fork"
	s.NameManual = true
	s.nameRevision++
	s.setState(map[string]any{"claudeSessionId": "destination"})
	name, _ := s.names.read("claude-code", "/project", "destination")
	if name.Name != "User renamed during fork" {
		t.Fatal("late fork identity overwrote manual rename")
	}
	name, _ = s.names.read("claude-code", "/project", "source")
	if name.Name != "Old" {
		t.Fatal("source name changed")
	}
}

func TestTurnDetailsUseLiveOutputBeforeNativeFileExists(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	s := newSession("live-only", "", "claude-structured", ToolInfo{Key: "claude-code"}, t.TempDir())
	s.State["claudeSessionId"] = "not-flushed"
	s.Messages = []map[string]any{{"kind": "user", "text": "current input", "turnId": "current"}, {"kind": "assistant", "text": "unflushed output", "turnId": "current"}}
	turns, path, err := conversationTurns(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	result, err := turnDetails(context.Background(), turns, path, map[string]any{"turnIds": []string{"current"}})
	if err != nil || !strings.Contains(stringValue(result["text"]), "unflushed output") {
		t.Fatal(result, err)
	}
}
