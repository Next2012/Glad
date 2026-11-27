package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type groupControlProvider struct {
	roomRuntimeProvider
	input    ProviderInput
	decision string
	payload  map[string]any
	answers  map[string]string
}

func (p *groupControlProvider) Send(ctx context.Context, input ProviderInput) error {
	p.input = input
	return p.roomRuntimeProvider.Send(ctx, input)
}
func (p *groupControlProvider) Approve(_ context.Context, _ string, decision string, payload map[string]any) error {
	p.decision = decision
	p.payload = payload
	return nil
}
func (p *groupControlProvider) AnswerUserInput(_ context.Context, _, _ string, answers map[string]string, _ []Attachment, _ ...*RoomActionSource) error {
	p.answers = answers
	return nil
}

func supervisorTestGroup(t *testing.T) (*RoomManager, *Session, *Session, *groupControlProvider, RoomRecord, RoomMemberRecord, RoomMemberRecord) {
	t.Helper()
	manager, caller, _, room, supervisor := newRuntimeRoomTest(t)
	target := newSession(newUUID(), "Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	provider := &groupControlProvider{}
	target.Provider = provider
	manager.sessions.sessions[target.ID] = target
	member, err := manager.AddSession(room.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.SetSupervisor(room.ID, supervisor.ID, "", false); err != nil {
		t.Fatal(err)
	}
	return manager, caller, target, provider, room, supervisor, member
}
func TestGroupSupervisorRoleAndScope(t *testing.T) {
	m, caller, target, _, room, supervisor, member := supervisorTestGroup(t)
	ctx := context.Background()
	args := map[string]any{"roomId": room.ID, "memberId": member.ID}
	if _, err := m.CallMCP(ctx, caller, "room_read_member", args); err != nil {
		t.Fatal(err)
	}
	if _, err := m.CallMCP(ctx, target, "room_read_member", map[string]any{"roomId": room.ID, "memberId": supervisor.ID}); err == nil {
		t.Fatal("ordinary member controlled supervisor")
	}
	if _, err := m.CallMCP(ctx, caller, "room_read_member", map[string]any{"roomId": room.ID, "memberId": supervisor.ID}); err == nil {
		t.Fatal("self control allowed")
	}
	other, _ := m.Create("Other")
	if _, err := m.CallMCP(ctx, caller, "room_read_member", map[string]any{"roomId": other.ID, "memberId": member.ID}); err == nil {
		t.Fatal("cross group allowed")
	}
	if _, err := m.SetSupervisor(room.ID, member.ID, "", true); err == nil {
		t.Fatal("stale replacement allowed")
	}
	if _, err := m.SetSupervisor(room.ID, member.ID, supervisor.ID, false); err == nil {
		t.Fatal("replacement without confirm allowed")
	}
	if _, err := m.SetSupervisor(room.ID, member.ID, supervisor.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.CallMCP(ctx, caller, "room_read_member", args); err == nil {
		t.Fatal("revoked supervisor allowed")
	}
	if err := m.RemoveMember(room.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	saved, _ := m.GetRecord(room.ID)
	if saved.SupervisorMemberID != "" {
		t.Fatal("departed supervisor survived")
	}
}
func TestGroupSupervisorIdleDispatchAndIdempotency(t *testing.T) {
	m, caller, target, p, room, _, member := supervisorTestGroup(t)
	ctx := context.Background()
	args := map[string]any{"roomId": room.ID, "memberId": member.ID, "text": "Implement task"}
	for i := 0; i < 2; i++ {
		if _, err := m.CallMCP(ctx, caller, "room_start_member", args, "connection:1"); err != nil {
			t.Fatal(err)
		}
	}
	if p.calls.Load() != 1 {
		t.Fatal("duplicate dispatch", p.calls.Load())
	}
	if p.input.Source == nil || p.input.Source.RoomID != room.ID {
		t.Fatal("missing dispatch source")
	}
	saved, _ := m.GetRecord(room.ID)
	if len(saved.Entries) != 2 || saved.Entries[0].SenderMemberID == "" {
		t.Fatal("dispatch not visible", saved.Entries)
	}
	args["text"] = "Different task"
	if _, err := m.CallMCP(ctx, caller, "room_start_member", args, "connection:1"); err != nil {
		t.Fatal(err)
	}
	if p.calls.Load() != 2 {
		t.Fatal("call ID incorrectly aliases different content")
	}
	target.mu.Lock()
	target.StatusValue = "running"
	target.mu.Unlock()
	if _, err := m.CallMCP(ctx, caller, "room_start_member", args, "connection:2"); err == nil {
		t.Fatal("started busy target")
	}
}
func TestGroupSupervisorRechecksQueuedControl(t *testing.T) {
	for _, tool := range []string{"room_read_member", "room_start_member", "room_stop_member", "room_approve_member", "room_answer_member"} {
		t.Run(tool, func(t *testing.T) {
			m, caller, target, p, room, supervisor, member := supervisorTestGroup(t)
			target.Messages = []map[string]any{{"kind": "turn-start", "turnId": "turn"}}
			args := map[string]any{"roomId": room.ID, "memberId": member.ID}
			switch tool {
			case "room_start_member":
				args["text"] = "Task"
			case "room_stop_member":
				args["expectedTurnId"] = "turn"
			case "room_approve_member":
				args["permissionId"] = "permission"
				args["decision"] = "allow"
			case "room_answer_member":
				args["questionId"] = "question"
				args["answers"] = map[string]string{"field": "answer"}
			}
			target.commandMu.Lock()
			done := make(chan error, 1)
			go func() { _, err := m.CallMCP(context.Background(), caller, tool, args, "race"); done <- err }()
			// Wait until a dispatched entry exists for start; other actions block at the command lock.
			if tool == "room_start_member" {
				deadline := time.Now().Add(time.Second)
				for {
					saved, _ := m.GetRecord(room.ID)
					if len(saved.Entries) > 0 {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("dispatch did not reach queue")
					}
					time.Sleep(time.Millisecond)
				}
			} else {
				time.Sleep(20 * time.Millisecond)
			}
			if _, err := m.SetSupervisor(room.ID, "", supervisor.ID, false); err != nil {
				t.Fatal(err)
			}
			target.commandMu.Unlock()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("revoked queued control succeeded")
				}
			case <-time.After(time.Second):
				t.Fatal("control deadlocked")
			}
			if p.calls.Load() != 0 || p.interrupts.Load() != 0 || p.decision != "" || p.answers != nil {
				t.Fatal("revoked action reached provider")
			}
		})
	}
}
func TestGroupSupervisorApprovalBoundariesAndAudit(t *testing.T) {
	for _, tool := range []string{"codex", "claude-code", "antigravity"} {
		t.Run(tool, func(t *testing.T) {
			m, caller, target, p, room, _, member := supervisorTestGroup(t)
			target.Tool.Key = tool
			target.Permissions["permission"] = Permission{ID: "permission", Status: "pending", Options: []map[string]any{{"optionId": "one", "kind": "allow_once"}, {"optionId": "no", "kind": "reject_once"}, {"optionId": "forever", "kind": "allow_always"}}}
			args := map[string]any{"roomId": room.ID, "memberId": member.ID, "permissionId": "permission", "decision": "allow"}
			if tool == "antigravity" {
				args["optionId"] = "forever"
				if _, err := m.CallMCP(context.Background(), caller, "room_approve_member", args); err == nil {
					t.Fatal("permanent grant allowed")
				}
				args["optionId"] = "no"
				if _, err := m.CallMCP(context.Background(), caller, "room_approve_member", args); err == nil {
					t.Fatal("mismatched decision allowed")
				}
				delete(args, "optionId")
			}
			args["decision"] = "bypass"
			if _, err := m.CallMCP(context.Background(), caller, "room_approve_member", args); err == nil {
				t.Fatal("bypass allowed")
			}
			args["decision"] = "allow"
			if _, err := m.CallMCP(context.Background(), caller, "room_approve_member", args, "approve"); err != nil {
				t.Fatal(err)
			}
			if p.decision != "approved" {
				t.Fatal("bad wire", p.decision)
			}
			if tool == "antigravity" && p.payload["optionId"] != "one" {
				t.Fatal("bad option", p.payload)
			}
			saved, _ := m.GetRecord(room.ID)
			if len(saved.Actions) != 1 || saved.Actions[0].SupervisorName == "" {
				t.Fatal("action not persisted", saved.Actions)
			}
			if _, err := m.CallMCP(context.Background(), caller, "room_approve_member", args, "approve"); err != nil {
				t.Fatal("duplicate result", err)
			}
			persisted, _ := m.store.Get(room.ID)
			if len(persisted.Actions) != 1 {
				t.Fatal("duplicate action record")
			}
		})
	}
}
func TestGroupSupervisorStopQuestionAndOfflineRead(t *testing.T) {
	m, caller, target, p, room, _, member := supervisorTestGroup(t)
	ctx := context.Background()
	target.Messages = []map[string]any{{"kind": "turn-start", "turnId": "turn"}}
	args := map[string]any{"roomId": room.ID, "memberId": member.ID, "expectedTurnId": "old"}
	if _, err := m.CallMCP(ctx, caller, "room_stop_member", args); err == nil {
		t.Fatal("stopped wrong turn")
	}
	args["expectedTurnId"] = "turn"
	if _, err := m.CallMCP(ctx, caller, "room_stop_member", args); err != nil {
		t.Fatal(err)
	}
	if p.interrupts.Load() != 1 {
		t.Fatal("not interrupted")
	}
	answers := map[string]any{"roomId": room.ID, "memberId": member.ID, "questionId": "question", "answers": map[string]string{"destination": "Local"}}
	if _, err := m.CallMCP(ctx, caller, "room_answer_member", answers); err != nil {
		t.Fatal(err)
	}
	if p.answers["destination"] != "Local" {
		t.Fatal("missing answer")
	}
	m.sessions.mu.Lock()
	delete(m.sessions.sessions, target.ID)
	m.sessions.mu.Unlock()
	result, err := m.CallMCP(ctx, caller, "room_read_member", map[string]any{"roomId": room.ID, "memberId": member.ID})
	if err != nil || result["available"] != false {
		t.Fatal(result, err)
	}
}
func TestAntigravityOfflineNativeTurnDetails(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	session := newSession("agy", "AGY", "antigravity-structured", ToolInfo{Key: "antigravity"}, t.TempDir())
	session.State["antigravitySessionId"] = "native"
	path := antigravityNativeTranscriptPath("native")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("完整输出", 10000)
	records := []map[string]any{
		{"type": "USER_INPUT", "step_index": 0, "created_at": "2026-11-20T01:00:00Z", "content": "First question"},
		{"type": "PLANNER_RESPONSE", "step_index": 1, "status": "DONE", "content": "First answer", "tool_calls": []any{map[string]any{"name": "read_file"}}},
		{"type": "GENERIC", "step_index": 2, "content": long},
		{"type": "USER_INPUT", "step_index": 3, "created_at": "2026-11-20T01:01:00Z", "content": "Second question"},
		{"type": "PLANNER_RESPONSE", "step_index": 4, "status": "DONE", "content": "Second answer"},
	}
	var raw strings.Builder
	for _, r := range records {
		data, _ := json.Marshal(r)
		raw.Write(data)
		raw.WriteByte('\n')
	}
	_ = os.WriteFile(path, []byte(raw.String()), 0600)
	turns, native, err := conversationTurns(context.Background(), session)
	if err != nil || len(turns) != 2 {
		t.Fatal(turns, err)
	}
	if turns[0].Tools != 1 || turns[0].Assistant != "First answer" || turns[1].User != "Second question" {
		t.Fatal(turns)
	}
	var detail strings.Builder
	args := map[string]any{"turnIds": []string{turns[0].ID}, "limit": 8192}
	for {
		page, err := turnDetails(context.Background(), turns, native, args)
		if err != nil {
			t.Fatal(err)
		}
		detail.WriteString(stringValue(page["text"]))
		if !boolValue(page["hasMore"]) {
			break
		}
		args["offset"] = page["nextOffset"]
	}
	if !strings.Contains(detail.String(), long) || strings.Contains(detail.String(), "Second question") {
		t.Fatal("native detail lost or selected another turn")
	}
}

func TestGroupSupervisorRolePromptIsRecipientSpecific(t *testing.T) {
	m, caller, target, worker, room, leader, member := supervisorTestGroup(t)
	supervisor := &groupControlProvider{}
	caller.Provider = supervisor
	_, err := m.PostMessage(context.Background(), room.ID, RoomMessageInput{Text: "Coordinate the work", MentionedMemberIDs: []string{leader.ID, member.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(supervisor.input.AgentText, "You are this group's current Supervisor") || strings.Contains(worker.input.AgentText, "You are this group's current Supervisor") {
		t.Fatal("role instructions not scoped to recipient")
	}
	if target == nil {
		t.Fatal("missing target")
	}
}
func TestGroupSupervisorRejectsChangedNativeBinding(t *testing.T) {
	m, caller, target, provider, room, _, member := supervisorTestGroup(t)
	_ = m.mutate(room.ID, func(room *RoomRecord) error {
		for i := range room.Members {
			if room.Members[i].ID == member.ID {
				room.Members[i].NativeConversationID = "old"
			}
		}
		return nil
	})
	target.State["threadId"] = "new"
	_, err := m.CallMCP(context.Background(), caller, "room_start_member", map[string]any{"roomId": room.ID, "memberId": member.ID, "text": "wrong conversation"})
	if err == nil || provider.calls.Load() != 0 {
		t.Fatal("controlled rebound conversation", err)
	}
}
func TestGroupSupervisorPreservesRoleAcrossCopiesAndClearsExcluded(t *testing.T) {
	m, _, _, _, room, leader, _ := supervisorTestGroup(t)
	fork, err := m.CopyHistory(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fork.SupervisorMemberID != leader.ID {
		t.Fatal("role lost on copy")
	}
	m.clearExcludedSupervisor(fork.ID, map[string]bool{leader.ID: true})
	saved, _ := m.GetHistoryRecord(fork.ID)
	if saved.SupervisorMemberID != "" {
		t.Fatal("excluded role survived")
	}
}
func TestAntigravityManagedMCPRuleKeepsExplicitPolicy(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	session := newSession(newUUID(), "Agy", "antigravity-structured", ToolInfo{Key: "antigravity"}, t.TempDir())
	session.mcpURL = "http://localhost:1234"
	p := NewAntigravityProvider(session, nil)
	settings := map[string]any{"toolPermission": "strict"}
	agySetRules(settings, agyRuleDocument{Ask: []string{"mcp(glad/room_start_member)"}, Deny: []string{"mcp(glad/room_approve_member)"}})
	dir, err := p.newPermissionProfile(settings)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := agyReadSettings(filepath.Join(p.permissionRoot(), dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	rules, _ := agyRules(loaded)
	if loaded["toolPermission"] != "strict" || len(rules.Ask) != 1 || len(rules.Deny) != 1 || len(rules.Allow) != 1 || rules.Allow[0] != "mcp(glad/*)" {
		t.Fatal("managed rule replaced user policy", loaded)
	}
	if _, err := os.Stat(filepath.Join(p.permissionRoot(), "settings.json")); !os.IsNotExist(err) {
		t.Fatal("global settings modified", err)
	}
}

func TestAntigravityACPGladMCPPreapprovalHonorsPolicy(t *testing.T) {
	for _, test := range []struct {
		name, policy string
		ask, deny    []string
		approval     bool
		result       string
	}{
		{name: "managed allow", policy: "request-review", result: "accepted"},
		{name: "strict", policy: "strict", approval: true},
		{name: "explicit ask", policy: "request-review", ask: []string{"mcp(glad/room_members)"}, approval: true},
		{name: "global ask", policy: "always-proceed", ask: []string{"mcp(*)"}, approval: true},
		{name: "explicit deny", policy: "request-review", deny: []string{"mcp(glad/*)"}, result: "denied"},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := antigravityFixture(t)
			p.session.mcpURL = "http://localhost:1"
			change := agyPermissionChange{Policy: map[string]any{"toolPermission": test.policy}}
			doc := agyTestDocument(t, p)
			rules := agyTestRules(t, doc, "session")
			change.Rules = map[string]agyRuleDocument{"session": {Ask: test.ask, Deny: test.deny, Allow: []string{}, Revision: rules.Revision}}
			if err := p.ApplyPermissions(context.Background(), change); err != nil {
				t.Fatal(err)
			}
			antigravitySend(t, p, "agy-glad-permission")
			antigravityWait(t, time.Second, func() bool {
				p.session.mu.RLock()
				pending := len(p.session.Permissions) > 0
				p.session.mu.RUnlock()
				return pending || antigravityIdle(p)
			})
			p.session.mu.RLock()
			pending := len(p.session.Permissions)
			p.session.mu.RUnlock()
			if test.approval {
				if pending != 1 {
					t.Fatal("explicit review bypassed")
				}
			} else {
				if pending != 0 {
					t.Fatal("managed tool still asked")
				}
				messages := antigravityMessages(p)
				found := false
				for _, message := range messages {
					if strings.Contains(stringValue(message["text"]), "AGY approval "+test.result) {
						found = true
					}
				}
				if !found {
					t.Fatal("wrong native option", messages)
				}
			}
		})
	}
}

func TestGroupSupervisorAnswersRealClaudeQuestion(t *testing.T) {
	m, caller, target, _, room, _, member := supervisorTestGroup(t)
	target.Tool.Key = "claude-code"
	target.Kind = "claude-structured"
	provider := NewClaudeProvider(target, nil)
	target.Provider = provider
	wire := &bufferWriteCloser{}
	provider.stdin = wire
	provider.addQuestion("question-rpc", "question-tool", map[string]any{"questions": []any{map[string]any{"question": "Which database?"}}})
	questionID := stringValue(target.Messages[0]["id"])
	args := map[string]any{"roomId": room.ID, "memberId": member.ID, "questionId": questionID, "answers": map[string]string{"Which database?": "SQLite"}}
	if _, err := m.CallMCP(context.Background(), caller, "room_answer_member", args, "claude-answer"); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(wire.Bytes()), &response); err != nil {
		t.Fatal(err)
	}
	decision := mapValue(mapValue(response["response"])["response"])
	if mapValue(mapValue(decision["updatedInput"])["answers"])["Which database?"] != "SQLite" || decision["decisionClassification"] != "user_temporary" {
		t.Fatal("wrong native question response", response)
	}
	if len(target.Permissions) != 0 || target.Messages[0]["answerRoomActionSource"] == nil {
		t.Fatal("question lost source or became an approval")
	}
	if _, err := m.CallMCP(context.Background(), caller, "room_answer_member", args, "claude-answer"); err != nil {
		t.Fatal("retry", err)
	}
}
func TestGroupSupervisorUsesNativeClaudeApprovalWithoutUpgrades(t *testing.T) {
	m, caller, target, _, room, _, member := supervisorTestGroup(t)
	target.Tool.Key = "claude-code"
	target.Kind = "claude-structured"
	provider := NewClaudeProvider(target, map[string]any{"permissionMode": "manual"})
	target.Provider = provider
	wire := &bufferWriteCloser{}
	provider.stdin = wire
	provider.handleControlRequest(map[string]any{"request_id": "permission-rpc", "request": map[string]any{"subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": "tool", "input": map[string]any{"command": "echo test"}}})
	permissionID := ""
	for id := range target.Permissions {
		permissionID = id
	}
	_, err := m.CallMCP(context.Background(), caller, "room_approve_member", map[string]any{"roomId": room.ID, "memberId": member.ID, "permissionId": permissionID, "decision": "allow"})
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(wire.Bytes()), &response); err != nil {
		t.Fatal(err)
	}
	decision := mapValue(mapValue(response["response"])["response"])
	if decision["behavior"] != "allow" || len(sliceValue(decision["updatedPermissions"])) != 0 || stringValue(provider.options["permissionMode"]) != "manual" || len(provider.allowedTools) != 0 {
		t.Fatal("approval promoted permissions", response)
	}
}

// A slow provider and a queued role writer in one group must not stall any
// independent group's role changes, live reads or normal message dispatch.
type slowGroupControlProvider struct {
	groupControlProvider
	entered chan struct{}
	release chan struct{}
}

func (p *slowGroupControlProvider) wait(ctx context.Context) error {
	close(p.entered)
	select {
	case <-p.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p *slowGroupControlProvider) Send(ctx context.Context, _ ProviderInput) error {
	return p.wait(ctx)
}
func (p *slowGroupControlProvider) Interrupt(ctx context.Context) error { return p.wait(ctx) }
func (p *slowGroupControlProvider) Approve(ctx context.Context, _, _ string, _ map[string]any) error {
	return p.wait(ctx)
}
func (p *slowGroupControlProvider) AnswerUserInput(ctx context.Context, _, _ string, _ map[string]string, _ []Attachment, _ ...*RoomActionSource) error {
	return p.wait(ctx)
}

func TestGroupSupervisorSlowRPCDoesNotBlockOtherGroups(t *testing.T) {
	for _, tool := range []string{"room_start_member", "room_stop_member", "room_approve_member", "room_answer_member"} {
		t.Run(tool, func(t *testing.T) {
			m, caller, target, _, room, leader, member := supervisorTestGroup(t)
			slow := &slowGroupControlProvider{entered: make(chan struct{}), release: make(chan struct{})}
			target.Provider = slow
			target.Messages = []map[string]any{{"kind": "turn-start", "turnId": "turn"}}
			target.Permissions["permission"] = Permission{ID: "permission", Status: "pending"}
			other, _ := m.Create("Independent")
			bCaller := newSession(newUUID(), "Other Supervisor", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
			bCaller.Provider = &groupControlProvider{}
			bTarget := newSession(newUUID(), "Other Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
			bTarget.Provider = &groupControlProvider{}
			m.sessions.sessions[bCaller.ID] = bCaller
			m.sessions.sessions[bTarget.ID] = bTarget
			bLeader, _ := m.AddSession(other.ID, bCaller.ID)
			bMember, _ := m.AddSession(other.ID, bTarget.ID)
			alias, _ := m.Create("Alias")
			if err := m.SwitchHistory(alias.ID, room.ID); err != nil {
				t.Fatal(err)
			}
			args := map[string]any{"roomId": room.ID, "memberId": member.ID}
			switch tool {
			case "room_start_member":
				args["text"] = "Task"
			case "room_stop_member":
				args["expectedTurnId"] = "turn"
			case "room_approve_member":
				args["permissionId"] = "permission"
				args["decision"] = "allow"
			case "room_answer_member":
				args["questionId"] = "question"
				args["answers"] = map[string]string{"field": "value"}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var once sync.Once
			release := func() { once.Do(func() { close(slow.release) }) }
			defer release()
			done := make(chan error, 1)
			go func() { _, err := m.CallMCP(ctx, caller, tool, args); done <- err }()
			select {
			case <-slow.entered:
			case <-time.After(time.Second):
				t.Fatal("RPC not reached")
			}
			writer := make(chan error, 1)
			go func() { _, err := m.SetSupervisor(alias.ID, "", leader.ID, false); writer <- err }()
			select {
			case err := <-writer:
				t.Fatal("writer crossed an active effect", err)
			case <-time.After(20 * time.Millisecond):
			}
			independent := make(chan error, 1)
			go func() {
				if _, err := m.SetSupervisor(other.ID, bLeader.ID, "", false); err != nil {
					independent <- err
					return
				}
				if _, err := m.CallMCP(ctx, bCaller, "room_read_member", map[string]any{"roomId": other.ID, "memberId": bMember.ID}); err != nil {
					independent <- err
					return
				}
				_, err := m.PostMessage(ctx, other.ID, RoomMessageInput{Text: "Independent task", MentionedMemberIDs: []string{bMember.ID}})
				independent <- err
			}()
			select {
			case err := <-independent:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("slow group blocked independent group")
			}
			release()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if err := <-writer; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestGroupSupervisorActionRetentionAndSnapshot(t *testing.T) {
	m, caller, target, _, room, _, member := supervisorTestGroup(t)
	target.Messages = []map[string]any{{"kind": "turn-start", "turnId": "turn"}}
	for i := 0; i < maxRoomActions+5; i++ {
		if _, err := m.CallMCP(context.Background(), caller, "room_stop_member", map[string]any{"roomId": room.ID, "memberId": member.ID, "expectedTurnId": "turn"}, fmt.Sprint(i)); err != nil {
			t.Fatal(err)
		}
	}
	saved, err := m.store.Get(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Actions) != maxRoomActions {
		t.Fatal("unbounded actions", len(saved.Actions))
	}
	first := roomActionID(caller, room, "room_stop_member", "5", map[string]any{"roomId": room.ID, "memberId": member.ID, "expectedTurnId": "turn"})
	if saved.Actions[0].ID != first {
		t.Fatal("retention did not keep newest records")
	}
	result, err := m.CallMCP(context.Background(), caller, "room_stop_member", map[string]any{"roomId": room.ID, "memberId": member.ID, "expectedTurnId": "turn"}, "5")
	if err != nil || result["duplicate"] != true {
		t.Fatal("recent retry was repeated", result, err)
	}
	page, err := m.GetPublic(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := page["actions"]; ok {
		t.Fatal("snapshot transfers unused action history")
	}
	event := target.Messages[len(target.Messages)-1]
	if !strings.Contains(stringValue(event["text"]), "stopped turn") {
		t.Fatal("internal action key displayed", event)
	}
}

func TestGroupSupervisorDeletingHistoryKeepsUnrelatedRuntimeBinding(t *testing.T) {
	m, caller, _, _, room, _, member := supervisorTestGroup(t)
	alias, err := m.Create("Temporary runtime")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SwitchHistory(alias.ID, room.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(alias.ID); err != nil {
		t.Fatal(err)
	}
	if !m.IsActive(alias.ID) {
		t.Fatal("deleting old history closed a different active history")
	}
	if _, err := m.CallMCP(context.Background(), caller, "room_read_member", map[string]any{"roomId": alias.ID, "memberId": member.ID}); err != nil {
		t.Fatal(err)
	}
}
