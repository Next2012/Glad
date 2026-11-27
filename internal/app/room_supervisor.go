package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

// Actions share the group's atomic store; no separate task, lease or audit file.
type RoomActionRecord struct {
	ID             string `json:"id"`
	MemberID       string `json:"memberId"`
	SupervisorID   string `json:"supervisorId"`
	SupervisorName string `json:"supervisorName"`
	Kind           string `json:"kind"`
	Decision       string `json:"decision,omitempty"`
	RequestID      string `json:"requestId,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
}

func roomMember(room RoomRecord, id string) (RoomMemberRecord, bool) {
	for _, m := range room.Members {
		if m.ID == id && m.LeftAt == 0 {
			return m, true
		}
	}
	return RoomMemberRecord{}, false
}

// Role gates are keyed by persisted group history, so runtime aliases share
// revocation boundaries while unrelated groups can run provider RPCs independently.
// Lock order: target.commandMu -> group gate -> manager.mu. Never hold manager.mu
// while calling a provider, whose synchronous events can also acquire it.
func (manager *RoomManager) roleGate(historyID string) *sync.RWMutex {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.roleLocks == nil {
		manager.roleLocks = map[string]*sync.RWMutex{}
	}
	gate := manager.roleLocks[historyID]
	if gate == nil {
		gate = &sync.RWMutex{}
		manager.roleLocks[historyID] = gate
	}
	return gate
}

// Resolve a runtime alias again after waiting: SwitchHistory may have rebound it
// while another operation held the old history's gate.
func (manager *RoomManager) lockRole(roomID string) func() {
	for {
		manager.mu.Lock()
		historyID := manager.roomIDLocked(roomID)
		manager.mu.Unlock()
		gate := manager.roleGate(historyID)
		gate.Lock()
		manager.mu.Lock()
		unchanged := manager.roomIDLocked(roomID) == historyID
		manager.mu.Unlock()
		if unchanged {
			return gate.Unlock
		}
		gate.Unlock()
	}
}

const maxRoomActions = 200

func trimRoomActions(actions []RoomActionRecord) []RoomActionRecord {
	if len(actions) > maxRoomActions {
		return append([]RoomActionRecord(nil), actions[len(actions)-maxRoomActions:]...)
	}
	return actions
}

func roomActionText(action RoomActionRecord) string {
	verb := "completed an action"
	switch action.Kind {
	case "approve_member":
		if action.Decision == "allow" {
			verb = "approved permission"
		} else {
			verb = "denied permission"
		}
	case "stop_member":
		verb = "stopped turn"
	case "answer_member":
		verb = "answered question"
	}
	return fmt.Sprintf("Supervisor (%s) %s", action.SupervisorName, verb)
}

func (manager *RoomManager) supervisorTarget(callerID, roomID, memberID string) (RoomRecord, RoomMemberRecord, RoomMemberRecord, error) {
	room, err := manager.authorizedRoom(callerID, roomID)
	if err != nil {
		return room, RoomMemberRecord{}, RoomMemberRecord{}, err
	}
	supervisor, ok := roomMember(room, room.SupervisorMemberID)
	if !ok || supervisor.RuntimeSessionID != callerID {
		return room, supervisor, RoomMemberRecord{}, errors.New("Only the current group Supervisor may control members")
	}
	target, ok := roomMember(room, memberID)
	if !ok || target.ID == supervisor.ID || target.RuntimeSessionID == callerID {
		return room, supervisor, target, errors.New("Target must be another active group member")
	}
	manager.mu.Lock()
	recovering := false
	for id, history := range manager.activeIDs {
		if history == room.ID {
			if runtime := manager.runtimes[id]; runtime != nil && runtime.operationCancel != nil {
				recovering = true
			}
		}
	}
	manager.mu.Unlock()
	if recovering {
		return room, supervisor, target, errors.New("Group recovery is in progress")
	}
	return room, supervisor, target, nil
}

func (manager *RoomManager) SetSupervisor(roomID, memberID, expected string, replace bool) (RoomRecord, error) {
	unlockRole := manager.lockRole(roomID)
	defer unlockRole()
	if !manager.IsActive(roomID) {
		return RoomRecord{}, errors.New("Group is not active")
	}
	err := manager.mutate(roomID, func(room *RoomRecord) error {
		if room.SupervisorMemberID != expected || room.SupervisorMemberID != "" && memberID != "" && memberID != room.SupervisorMemberID && !replace {
			return errors.New("Supervisor changed; refresh the group and try again")
		}
		if memberID != "" {
			if _, ok := roomMember(*room, memberID); !ok {
				return errors.New("Supervisor must be an active group member")
			}
		}
		room.SupervisorMemberID = memberID
		return nil
	})
	room, _ := manager.GetRecord(roomID)
	return room, err
}
func (server *Server) setRoomSupervisor(w http.ResponseWriter, r *http.Request) {
	var input struct {
		MemberID string  `json:"memberId"`
		Expected *string `json:"expectedCurrentMemberId"`
		Replace  bool    `json:"replace"`
	}
	if err := decodeJSON(r, &input); err != nil {
		respondError(w, 400, err)
		return
	}
	if input.Expected == nil {
		respondError(w, 400, errors.New("expectedCurrentMemberId is required"))
		return
	}
	if !server.rooms.IsActive(r.PathValue("id")) {
		notFound(w, "Group is not active")
		return
	}
	room, err := server.rooms.SetSupervisor(r.PathValue("id"), input.MemberID, *input.Expected, input.Replace)
	if err != nil {
		current, _ := roomMember(room, room.SupervisorMemberID)
		respondJSON(w, 409, map[string]any{"success": false, "error": err.Error(), "currentSupervisorMemberId": room.SupervisorMemberID, "currentSupervisorName": server.sessions.memberName(current)})
		return
	}
	respondJSON(w, 200, map[string]any{"success": true, "supervisorMemberId": room.SupervisorMemberID})
}

func roomControlTools() []map[string]any {
	tools := []map[string]any{}
	for _, item := range []struct{ name, description string }{
		{"room_read_member", "Supervisor only: read another active member's live output, pending permissions and questions. Use room_turns and room_turn_details for complete native history. Offline members return available=false."},
		{"room_start_member", "Supervisor only: send a task to another idle member. The instruction is visible in the group. Busy members must be stopped and observed idle before sending."},
		{"room_stop_member", "Supervisor only: interrupt another member's expected turn. Read again to confirm it is idle before sending a task."},
		{"room_approve_member", "Supervisor only: allow or deny a pending permission once (some Codex grants last this turn). Never remembers rules or changes permission mode. Native optionId must match allow_once or reject_once and the decision."},
		{"room_answer_member", "Supervisor only: answer a pending question using its field IDs. Answers follow the provider's existing schema validation."},
	} {
		props := map[string]any{"roomId": map[string]any{"type": "string"}, "memberId": map[string]any{"type": "string"}}
		required := []string{"roomId", "memberId"}
		add := func(name, kind string, mandatory bool) {
			props[name] = map[string]any{"type": kind}
			if mandatory {
				required = append(required, name)
			}
		}
		switch item.name {
		case "room_read_member":
			add("after", "integer", false)
			add("history", "boolean", false)
			add("offset", "integer", false)
			props["limit"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 200}
		case "room_start_member":
			add("text", "string", true)
			props["quotedEntryIds"] = map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": maxRoomQuoteCount}
		case "room_stop_member":
			add("expectedTurnId", "string", true)
		case "room_approve_member":
			add("permissionId", "string", true)
			add("decision", "string", true)
			add("optionId", "string", false)
			add("reason", "string", false)
		case "room_answer_member":
			add("questionId", "string", true)
			props["answers"] = map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}}
			required = append(required, "answers")
		}
		tools = append(tools, map[string]any{"name": item.name, "description": item.description, "inputSchema": map[string]any{"type": "object", "properties": props, "required": required, "additionalProperties": false}})
	}
	return tools
}

func roomActionID(caller *Session, room RoomRecord, tool, callID string, args map[string]any) string {
	data, _ := json.Marshal(args)
	// The bridge supplies a random connection prefix. Content and caller identity
	// also participate, so reused JSON-RPC IDs cannot alias a different action.
	digest := sha256.Sum256([]byte(caller.ID + "\x00" + caller.mcpToken + "\x00" + room.ID + "\x00" + tool + "\x00" + callID + "\x00" + string(data)))
	return hex.EncodeToString(digest[:])
}

func (manager *RoomManager) callControl(ctx context.Context, caller *Session, tool, callID string, args map[string]any) (map[string]any, error) {
	roomID, memberID := stringValue(args["roomId"]), stringValue(args["memberId"])
	room, supervisor, target, err := manager.supervisorTarget(caller.ID, roomID, memberID)
	if err != nil {
		return nil, err
	}
	session := manager.sessions.Get(target.RuntimeSessionID)
	if session == nil {
		if tool == "room_read_member" {
			return map[string]any{"success": true, "available": false, "reason": "Member is offline. Use room_turns and room_turn_details for native history."}, nil
		}
		return nil, errors.New("Member is offline; resume it before controlling it")
	}
	actionID := roomActionID(caller, room, tool, callID, args)
	source := &RoomActionSource{RoomID: room.ID, MemberID: supervisor.ID, Name: manager.sessions.memberName(supervisor), ActionID: actionID, Kind: strings.TrimPrefix(tool, "room_")}
	if tool == "room_start_member" {
		text := strings.TrimSpace(stringValue(args["text"]))
		if text == "" || len(text) > maxRoomMessageBytes {
			return nil, errors.New("text must be non-empty and at most 16 KiB")
		}
		_, err := manager.PostMessage(ctx, roomID, RoomMessageInput{Text: text, ClientMessageID: "supervisor:" + actionID, SenderMemberID: supervisor.ID, Source: source, MentionedMemberIDs: []string{memberID}, QuotedEntryIDs: stringList(args["quotedEntryIds"])})
		if err != nil {
			return nil, err
		}
		saved, err := manager.GetRecord(roomID)
		if err != nil {
			return nil, err
		}
		for _, entry := range saved.Entries {
			if entry.ClientMessageID == "supervisor:"+actionID {
				for _, reply := range saved.Entries {
					if reply.TriggerEntryID == entry.ID && reply.MemberID == memberID && reply.Status == "failed" {
						return nil, errors.New(reply.Error)
					}
				}
				return map[string]any{"success": true, "accepted": true, "entryId": entry.ID}, nil
			}
		}
		return nil, errors.New("Dispatch result is unavailable")
	}
	session.commandMu.Lock()
	defer session.commandMu.Unlock()
	gate := manager.roleGate(room.ID)
	gate.RLock()
	defer gate.RUnlock()
	fresh, _, bound, err := manager.supervisorTarget(caller.ID, roomID, memberID)
	if err != nil {
		return nil, err
	}
	if fresh.ID != room.ID || bound.RuntimeSessionID != session.ID || bound.NativeConversationID != target.NativeConversationID || !sessionMatchesRoomMember(session, bound) {
		return nil, errors.New("Group member binding changed")
	}
	if tool == "room_read_member" {
		limit := int(numberInt64(args["limit"]))
		if limit == 0 {
			limit = 50
		}
		result := sessionOutput(session, uint64(max64(0, numberInt64(args["after"]))), limit, int(numberInt64(args["offset"])), boolValue(args["history"]))
		result["available"] = true
		return result, nil
	}
	for _, action := range fresh.Actions {
		if action.ID == actionID {
			return map[string]any{"success": true, "accepted": true, "duplicate": true}, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	requestID := ""
	switch tool {
	case "room_stop_member":
		expected := strings.TrimSpace(stringValue(args["expectedTurnId"]))
		if expected == "" {
			return nil, errors.New("expectedTurnId is required")
		}
		err = stopSessionControlledLocked(ctx, session, expected)
		requestID = expected
	case "room_approve_member":
		requestID = stringValue(args["permissionId"])
		err = approveSessionControlledLocked(ctx, session, requestID, stringValue(args["decision"]), stringValue(args["optionId"]), stringValue(args["reason"]), source)
	case "room_answer_member":
		requestID = stringValue(args["questionId"])
		provider, ok := session.Provider.(QuestionProvider)
		if !ok {
			return nil, errors.New("Provider does not support questions")
		}
		answers := map[string]string{}
		data, _ := json.Marshal(args["answers"])
		_ = json.Unmarshal(data, &answers)
		err = provider.AnswerUserInput(ctx, requestID, "supervisor:"+actionID, answers, nil, source)
	default:
		return nil, errors.New("Unknown group control tool")
	}
	if err != nil {
		return nil, err
	}
	action := RoomActionRecord{ID: actionID, MemberID: memberID, SupervisorID: supervisor.ID, SupervisorName: source.Name, Kind: source.Kind, Decision: stringValue(args["decision"]), RequestID: requestID, CreatedAt: millis()}
	if err := manager.mutateHistory(room.ID, func(room *RoomRecord) error { room.Actions = trimRoomActions(append(room.Actions, action)); return nil }); err != nil {
		return nil, fmt.Errorf("Action accepted but saving its record failed: %w", err)
	}
	session.appendMessage(map[string]any{"kind": "event", "level": "info", "text": roomActionText(action), "roomActionSource": source.values()})
	return map[string]any{"success": true, "accepted": true}, nil
}

func approveSessionControlledLocked(ctx context.Context, session *Session, id, decision, optionID, reason string, source *RoomActionSource) error {
	if decision != "allow" && decision != "deny" {
		return errors.New("decision must be allow or deny")
	}
	session.mu.RLock()
	permission, ok := session.Permissions[id]
	session.mu.RUnlock()
	if !ok {
		return errors.New("Permission request not found")
	}
	payload := map[string]any{"message": reason}
	wire := map[bool]string{true: "approved", false: "denied"}[decision == "allow"]
	if session.Tool.Key == "antigravity" {
		kind := map[bool]string{true: "allow_once", false: "reject_once"}[decision == "allow"]
		selected := ""
		for _, option := range permission.Options {
			if stringValue(option["kind"]) == kind && (optionID == "" || stringValue(option["optionId"]) == optionID) {
				selected = stringValue(option["optionId"])
				break
			}
		}
		if selected == "" {
			return errors.New("No matching single-use native permission option")
		}
		payload["optionId"] = selected
	} else if optionID != "" {
		return errors.New("optionId is only supported for native Antigravity permission options")
	}
	// Mark the permission before the provider publishes its completion event.
	session.mu.Lock()
	permission.Actor = "Supervisor (" + source.Name + ")"
	session.Permissions[id] = permission
	session.mu.Unlock()
	provider, supported := session.Provider.(ApprovalProvider)
	if !supported {
		return errors.New("Provider does not support approvals")
	}
	err := provider.Approve(ctx, id, wire, payload)
	if err != nil {
		session.mu.Lock()
		if pending, ok := session.Permissions[id]; ok {
			pending.Actor = ""
			session.Permissions[id] = pending
		}
		session.mu.Unlock()
	}
	return err
}

func (manager *RoomManager) supervisorTargetForDispatch(source *RoomActionSource, sessionID string) (RoomRecord, RoomMemberRecord, RoomMemberRecord, error) {
	manager.mu.Lock()
	room, err := manager.store.Get(source.RoomID)
	manager.mu.Unlock()
	if err != nil {
		return room, RoomMemberRecord{}, RoomMemberRecord{}, err
	}
	supervisor, ok := roomMember(room, source.MemberID)
	if !ok {
		return room, supervisor, RoomMemberRecord{}, errors.New("Supervisor left the group")
	}
	for _, m := range room.Members {
		if m.RuntimeSessionID == sessionID && m.LeftAt == 0 {
			return manager.supervisorTarget(supervisor.RuntimeSessionID, source.RoomID, m.ID)
		}
	}
	return room, supervisor, RoomMemberRecord{}, errors.New("Target left the group")
}

func (manager *RoomManager) clearExcludedSupervisor(historyID string, excluded map[string]bool) {
	gate := manager.roleGate(historyID)
	gate.Lock()
	defer gate.Unlock()
	_ = manager.mutateHistory(historyID, func(room *RoomRecord) error {
		member, ok := roomMember(*room, room.SupervisorMemberID)
		if !ok || excluded[member.ID] || manager.sessions.Get(member.RuntimeSessionID) == nil {
			room.SupervisorMemberID = ""
		}
		return nil
	})
}

func sessionMatchesRoomMember(session *Session, member RoomMemberRecord) bool {
	session.mu.RLock()
	defer session.mu.RUnlock()
	return !session.closed && !session.recovering && (member.NativeConversationID == "" || sessionNativeConversationID(session) == member.NativeConversationID)
}
