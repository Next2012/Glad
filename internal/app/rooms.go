package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxRoomNameBytes      = 200
	maxRoomMessageBytes   = 16 << 10
	maxRoomQuoteCount     = 32
	maxRoomReferenceBytes = 128 << 10
	maxRoomMemberCount    = 32
)

type RoomManager struct {
	mu          sync.Mutex
	store       RoomStore
	sessions    *SessionManager
	attachments *AttachmentStore
	resolver    RoomTurnResolver
}

// RoomTurnResolver keeps persistence independent from provider history. A
// native-history/MCP resolver can be composed later without changing schema or
// RoomManager's message lifecycle.
type RoomTurnResolver interface {
	Resolve(RoomMemberRecord, RoomEntryRecord) (RoomTurnView, bool)
}

type RoomTurnView struct {
	Text   string
	Status string
	TurnID string
}

type RoomNotificationTarget struct {
	RoomID, RoomName, MemberName string
}

type sessionRoomTurnResolver struct{ sessions *SessionManager }

var roomAvatarPalettes = map[string][]string{
	"claude-code": {"#2563EB", "#4F46E5", "#0891B2", "#0F766E", "#6366F1", "#0284C7"},
	"codex":       {"#EA580C", "#D97706", "#DC2626", "#DB2777", "#CA8A04", "#E11D48"},
}

func chooseRoomAvatarColor(toolKey, seed string, used map[string]bool) string {
	palette := roomAvatarPalettes[toolKey]
	if len(palette) == 0 {
		palette = []string{"#7C3AED", "#2563EB", "#DB2777", "#0891B2"}
	}
	hash := 0
	for _, value := range seed {
		hash = (hash*33 + int(value)) & 0x7fffffff
	}
	for offset := 0; offset < len(palette); offset++ {
		color := palette[(hash+offset)%len(palette)]
		if !used[color] {
			return color
		}
	}
	return palette[hash%len(palette)]
}

func (resolver sessionRoomTurnResolver) Resolve(member RoomMemberRecord, entry RoomEntryRecord) (RoomTurnView, bool) {
	session := resolver.sessions.Get(member.RuntimeSessionID)
	if session == nil {
		return RoomTurnView{}, false
	}
	text, status, turnID := resolveSessionTurn(session, entry)
	return RoomTurnView{Text: text, Status: status, TurnID: turnID}, true
}

type RoomMessageInput struct {
	Text               string                           `json:"text"`
	MentionedMemberIDs []string                         `json:"mentionedMemberIds"`
	QuotedEntryIDs     []string                         `json:"quotedEntryIds"`
	Attachments        map[string]RoomTargetAttachments `json:"attachmentsByMember,omitempty"`
}

type RoomTargetAttachments struct {
	ImageIDs []string `json:"imageIds"`
	FileIDs  []string `json:"fileIds"`
}

func NewRoomManager(store RoomStore, sessions *SessionManager, attachments *AttachmentStore) *RoomManager {
	return &RoomManager{
		store: store, sessions: sessions, attachments: attachments,
		resolver: sessionRoomTurnResolver{sessions: sessions},
	}
}

func (manager *RoomManager) Start(ctx context.Context) {
	subscription := manager.sessions.Events().Subscribe("", 1024)
	go func() {
		defer subscription.Close()
		for {
			select {
			case event := <-subscription.Events():
				if stringValue(event.Payload["type"]) == "session-renamed" {
					manager.syncSessionName(event.SessionID, stringValue(event.Payload["name"]))
					continue
				}
				if stringValue(event.Payload["type"]) == "state" {
					state := mapValue(event.Payload["state"])
					manager.syncSessionConversation(event.SessionID, firstNonEmpty(
						stringValue(state["threadId"]), stringValue(state["claudeSessionId"]), stringValue(state["resumeSessionId"]),
					))
				}
				message := mapValue(event.Payload["message"])
				if stringValue(event.Payload["type"]) == "message" && stringValue(message["kind"]) == "user" {
					manager.captureDirectSessionMessage(event.SessionID, message)
					continue
				}
				if stringValue(event.Payload["type"]) != "message" || stringValue(message["kind"]) != "turn-end" {
					continue
				}
				// Codex publishes child-agent turn completions through the same
				// session hub. An unbound direct mini-session entry must wait for
				// the root turn rather than attaching itself to the first child.
				if root, declared := message["isRootTurn"]; declared && !boolValue(root) {
					continue
				}
				manager.finishSessionTurn(event.SessionID, stringValue(message["turnId"]), message)
			case <-subscription.Done():
				return
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (manager *RoomManager) syncSessionConversation(sessionID, conversationID string) {
	if strings.TrimSpace(conversationID) == "" {
		return
	}
	rooms, err := manager.store.List()
	if err != nil {
		return
	}
	for _, snapshot := range rooms {
		roomID := snapshot.ID
		_ = manager.mutate(roomID, func(room *RoomRecord) error {
			changed := false
			for index := range room.Members {
				if room.Members[index].RuntimeSessionID == sessionID && room.Members[index].LeftAt == 0 {
					room.Members[index].NativeConversationID = conversationID
					changed = true
				}
			}
			if !changed {
				return errors.New("session is not an active member")
			}
			return nil
		})
	}
}

// Messages authored inside the full mini-session still belong to every room
// where that live session is an active member. Room-dispatched messages use a
// reserved client ID prefix and already have their own timeline entries.
func (manager *RoomManager) captureDirectSessionMessage(sessionID string, message map[string]any) {
	clientID := stringValue(message["clientMessageId"])
	if strings.HasPrefix(clientID, "room-") {
		return
	}
	text := strings.TrimSpace(stringValue(message["text"]))
	if text == "" && len(sliceValue(message["attachments"])) > 0 {
		text = "Sent attachments"
	}
	if text == "" {
		return
	}
	rooms, err := manager.store.List()
	if err != nil {
		return
	}
	for _, snapshot := range rooms {
		roomID := snapshot.ID
		_ = manager.mutate(roomID, func(room *RoomRecord) error {
			var member *RoomMemberRecord
			for index := range room.Members {
				candidate := &room.Members[index]
				if candidate.LeftAt == 0 && candidate.RuntimeSessionID == sessionID {
					member = candidate
					break
				}
			}
			if member == nil {
				return errors.New("session is not an active member")
			}
			for _, entry := range room.Entries {
				if entry.ClientMessageID != "" && entry.ClientMessageID == clientID {
					return errors.New("session message is already indexed")
				}
			}
			now := millis()
			room.Entries = append(room.Entries, RoomEntryRecord{
				ID: newUUID(), Sequence: room.NextSequence, Type: "user", UserText: text,
				MentionedMemberIDs: []string{member.ID}, Status: "completed", CreatedAt: now,
			})
			room.NextSequence++
			room.Entries = append(room.Entries, RoomEntryRecord{
				ID: newUUID(), Sequence: room.NextSequence, Type: "session", MemberID: member.ID,
				SourceSessionID: sessionID, NativeConversationID: member.NativeConversationID,
				NativeTurnID: stringValue(message["turnId"]), ClientMessageID: clientID,
				Status: "running", CreatedAt: now,
			})
			room.NextSequence++
			return nil
		})
	}
}

func (manager *RoomManager) syncSessionName(sessionID, name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	rooms, err := manager.store.List()
	if err != nil {
		return
	}
	for _, snapshot := range rooms {
		roomID := snapshot.ID
		_ = manager.mutate(roomID, func(room *RoomRecord) error {
			changed := false
			for index := range room.Members {
				if room.Members[index].RuntimeSessionID == sessionID && room.Members[index].LeftAt == 0 {
					room.Members[index].DisplayName = name
					changed = true
				}
			}
			if !changed {
				return errors.New("session is not an active member")
			}
			return nil
		})
	}
}

func (manager *RoomManager) finishSessionTurn(sessionID, runtimeTurnID string, turnEnd map[string]any) {
	rooms, err := manager.store.List()
	if err != nil {
		return
	}
	for _, snapshot := range rooms {
		roomID := snapshot.ID
		retryEntryIDs := []string{}
		_ = manager.mutate(roomID, func(room *RoomRecord) error {
			changed := false
			for index := range room.Entries {
				entry := &room.Entries[index]
				if entry.Type != "session" || entry.SourceSessionID != sessionID ||
					(entry.NativeTurnID != "" && entry.NativeTurnID != runtimeTurnID) {
					continue
				}
				status := firstNonEmpty(stringValue(turnEnd["status"]), stringValue(turnEnd["turnStatus"]), "completed")
				entry.Status = status
				entry.NativeTurnID = firstNonEmpty(entry.NativeTurnID, runtimeTurnID)
				if session := manager.sessions.Get(sessionID); session != nil {
					session.mu.RLock()
					conversationID := sessionNativeConversationID(session)
					session.mu.RUnlock()
					entry.NativeConversationID = firstNonEmpty(conversationID, entry.NativeConversationID)
					for memberIndex := range room.Members {
						if room.Members[memberIndex].ID == entry.MemberID && conversationID != "" {
							room.Members[memberIndex].NativeConversationID = conversationID
						}
					}
					if session.Tool.Key == "claude-code" {
						stableID := resolveClaudeNativeTurnID(session, entry.ClientMessageID, entry.NativeConversationID)
						entry.NativeTurnID = firstNonEmpty(stableID, entry.NativeTurnID)
						if stableID == "" {
							retryEntryIDs = append(retryEntryIDs, entry.ID)
						}
					}
				}
				changed = true
			}
			if !changed {
				return errors.New("no matching room turn")
			}
			return nil
		})
		for _, entryID := range retryEntryIDs {
			go manager.retryClaudeTurnLocator(roomID, entryID, sessionID)
		}
	}
}

func (manager *RoomManager) retryClaudeTurnLocator(roomID, entryID, sessionID string) {
	for _, delay := range []time.Duration{100 * time.Millisecond, 400 * time.Millisecond, time.Second} {
		time.Sleep(delay)
		session := manager.sessions.Get(sessionID)
		if session == nil {
			return
		}
		manager.mu.Lock()
		room, err := manager.store.Get(roomID)
		if err != nil {
			manager.mu.Unlock()
			return
		}
		var entry *RoomEntryRecord
		for index := range room.Entries {
			if room.Entries[index].ID == entryID {
				entry = &room.Entries[index]
				break
			}
		}
		if entry == nil {
			manager.mu.Unlock()
			return
		}
		stableID := resolveClaudeNativeTurnID(session, entry.ClientMessageID, entry.NativeConversationID)
		if stableID != "" {
			entry.NativeTurnID = stableID
			room.UpdatedAt = millis()
			_ = manager.store.Save(room)
			manager.mu.Unlock()
			return
		}
		manager.mu.Unlock()
	}
}

func (manager *RoomManager) List() ([]map[string]any, error) {
	rooms, err := manager.store.List()
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(rooms))
	for _, room := range rooms {
		activeMembers := 0
		for _, member := range room.Members {
			if member.LeftAt == 0 {
				activeMembers++
			}
		}
		result = append(result, map[string]any{
			"id": room.ID, "name": room.Name, "createdAt": room.CreatedAt,
			"updatedAt": room.UpdatedAt, "memberCount": activeMembers,
			"messageCount": len(room.Entries), "serverChanNotificationEnabled": room.ServerChanNotificationEnabled,
		})
	}
	return result, nil
}

func (manager *RoomManager) Create(name string) (RoomRecord, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "New group"
	}
	if len(name) > maxRoomNameBytes {
		return RoomRecord{}, errors.New("room name is too long")
	}
	now := millis()
	room := RoomRecord{
		SchemaVersion: currentRoomSchemaVersion, ID: newUUID(), Name: name,
		CreatedAt: now, UpdatedAt: now, NextSequence: 1,
		Members: []RoomMemberRecord{}, Entries: []RoomEntryRecord{},
	}
	if err := manager.store.Save(room); err != nil {
		return RoomRecord{}, err
	}
	return room, nil
}

func (manager *RoomManager) Delete(id string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.store.Delete(id)
}

func (manager *RoomManager) Rename(id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxRoomNameBytes {
		return errors.New("invalid room name")
	}
	return manager.mutate(id, func(room *RoomRecord) error {
		room.Name = name
		return nil
	})
}

func (manager *RoomManager) SetServerChanNotification(id string, enabled bool) error {
	return manager.mutate(id, func(room *RoomRecord) error {
		room.ServerChanNotificationEnabled = enabled
		return nil
	})
}

func (manager *RoomManager) DisableServerChanNotifications() {
	rooms, err := manager.store.List()
	if err != nil {
		return
	}
	for _, room := range rooms {
		if room.ServerChanNotificationEnabled {
			_ = manager.SetServerChanNotification(room.ID, false)
		}
	}
}

func (manager *RoomManager) NotificationTargets(sessionID string) []RoomNotificationTarget {
	rooms, err := manager.store.List()
	if err != nil {
		return nil
	}
	result := []RoomNotificationTarget{}
	for _, room := range rooms {
		if !room.ServerChanNotificationEnabled {
			continue
		}
		for _, member := range room.Members {
			if member.LeftAt == 0 && member.RuntimeSessionID == sessionID {
				result = append(result, RoomNotificationTarget{RoomID: room.ID, RoomName: room.Name, MemberName: member.DisplayName})
				break
			}
		}
	}
	return result
}

func (manager *RoomManager) GetRecord(id string) (RoomRecord, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.store.Get(id)
}

func (manager *RoomManager) BindRuntimeSession(roomID, memberID, sessionID, conversationID string) error {
	return manager.mutate(roomID, func(room *RoomRecord) error {
		for index := range room.Members {
			if room.Members[index].ID == memberID && room.Members[index].LeftAt == 0 {
				room.Members[index].RuntimeSessionID = sessionID
				room.Members[index].NativeConversationID = firstNonEmpty(conversationID, room.Members[index].NativeConversationID)
				return nil
			}
		}
		return errors.New("active room member not found")
	})
}

func (manager *RoomManager) GetPublic(id string) (map[string]any, error) {
	manager.reconcileLiveMessages(id)
	manager.mu.Lock()
	room, err := manager.store.Get(id)
	if err != nil {
		manager.mu.Unlock()
		return nil, err
	}
	// Runtime session IDs are hints. Mark them unavailable after a restart but
	// retain them on disk so a later resume/fork operation can diagnose state.
	members := make([]map[string]any, 0, len(room.Members))
	memberByID := map[string]RoomMemberRecord{}
	for _, member := range room.Members {
		memberByID[member.ID] = member
		session := manager.sessions.Get(member.RuntimeSessionID)
		available := member.LeftAt == 0 && session != nil
		status, pendingPermissions, pendingQuestions := "unavailable", 0, 0
		if session != nil {
			session.mu.RLock()
			status = session.StatusValue
			pendingPermissions = len(session.Permissions)
			pendingQuestions = int(numberInt64(session.State["pendingQuestionCount"]))
			if member.ToolName == "" {
				member.ToolName = session.Tool.DisplayName
			}
			session.mu.RUnlock()
		}
		members = append(members, map[string]any{
			"id": member.ID, "sessionId": member.RuntimeSessionID,
			"displayName": member.DisplayName, "avatarSeed": member.AvatarSeed, "avatarColor": member.AvatarColor,
			"toolKey": member.ToolKey, "toolName": firstNonEmpty(member.ToolName, member.ToolKey), "workingDirectory": member.WorkingDirectory,
			"nativeConversationId": member.NativeConversationID,
			"joinedAt":             member.JoinedAt, "leftAt": member.LeftAt,
			"available": available, "status": status,
			"pendingPermissionCount": pendingPermissions, "pendingQuestionCount": pendingQuestions,
		})
	}
	entries := make([]map[string]any, 0, len(room.Entries))
	for _, entry := range room.Entries {
		entries = append(entries, manager.publicEntryLocked(room, memberByID, entry))
	}
	manager.mu.Unlock()
	return map[string]any{
		"schemaVersion": room.SchemaVersion, "id": room.ID, "name": room.Name,
		"createdAt": room.CreatedAt, "updatedAt": room.UpdatedAt,
		"serverChanNotificationEnabled": room.ServerChanNotificationEnabled,
		"members":                       members, "entries": entries,
	}, nil
}

type roomDirectCandidate struct {
	member         RoomMemberRecord
	text           string
	clientID       string
	turnID         string
	conversationID string
	createdAt      int64
	status         string
}

// Reconcile covers subscriber overflow, server-side direct sends, and messages
// produced while no room browser was open. Only turns created after the member
// joined are eligible, and room-dispatched turns are excluded by client ID.
func (manager *RoomManager) reconcileLiveMessages(roomID string) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	room, err := manager.store.Get(roomID)
	if err != nil {
		return
	}
	seen := map[string]bool{}
	for _, entry := range room.Entries {
		if entry.ClientMessageID != "" {
			seen[entry.ClientMessageID] = true
		}
	}
	candidates := []roomDirectCandidate{}
	for _, member := range room.Members {
		if member.LeftAt != 0 {
			continue
		}
		session := manager.sessions.Get(member.RuntimeSessionID)
		if session == nil {
			continue
		}
		session.mu.RLock()
		conversationID := sessionNativeConversationID(session)
		turnStatus := map[string]string{}
		for _, message := range session.Messages {
			if stringValue(message["kind"]) == "turn-end" {
				turnStatus[stringValue(message["turnId"])] = firstNonEmpty(
					stringValue(message["status"]), stringValue(message["turnStatus"]), "completed",
				)
			}
		}
		for _, message := range session.Messages {
			if stringValue(message["kind"]) != "user" || numberInt64(message["createdAt"]) < member.JoinedAt {
				continue
			}
			clientID := stringValue(message["clientMessageId"])
			if strings.HasPrefix(clientID, "room-") {
				continue
			}
			if clientID == "" {
				clientID = "direct-" + stringValue(message["id"])
			}
			if seen[clientID] {
				continue
			}
			text := strings.TrimSpace(stringValue(message["text"]))
			if text == "" && len(sliceValue(message["attachments"])) > 0 {
				text = "Sent attachments"
			}
			if text == "" {
				continue
			}
			turnID := stringValue(message["turnId"])
			status := firstNonEmpty(turnStatus[turnID], "running")
			candidates = append(candidates, roomDirectCandidate{
				member: member, text: text, clientID: clientID, turnID: turnID,
				conversationID: conversationID, createdAt: numberInt64(message["createdAt"]), status: status,
			})
			seen[clientID] = true
		}
		session.mu.RUnlock()
	}
	if len(candidates) == 0 {
		return
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].createdAt < candidates[j].createdAt })
	for _, candidate := range candidates {
		room.Entries = append(room.Entries, RoomEntryRecord{
			ID: newUUID(), Sequence: room.NextSequence, Type: "user", UserText: candidate.text,
			MentionedMemberIDs: []string{candidate.member.ID}, Status: "completed", CreatedAt: candidate.createdAt,
		})
		room.NextSequence++
		room.Entries = append(room.Entries, RoomEntryRecord{
			ID: newUUID(), Sequence: room.NextSequence, Type: "session", MemberID: candidate.member.ID,
			SourceSessionID: candidate.member.RuntimeSessionID, NativeConversationID: candidate.conversationID,
			NativeTurnID: candidate.turnID, ClientMessageID: candidate.clientID,
			Status: candidate.status, CreatedAt: candidate.createdAt,
		})
		room.NextSequence++
	}
	room.UpdatedAt = millis()
	_ = manager.store.Save(room)
}

func (manager *RoomManager) AddSession(roomID, sessionID string) (RoomMemberRecord, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	room, err := manager.store.Get(roomID)
	if err != nil {
		return RoomMemberRecord{}, err
	}
	session := manager.sessions.Get(strings.TrimSpace(sessionID))
	if session == nil {
		return RoomMemberRecord{}, errors.New("session not found")
	}
	active := 0
	usedColors := map[string]bool{}
	for _, member := range room.Members {
		if member.AvatarColor != "" {
			usedColors[member.AvatarColor] = true
		}
		if member.LeftAt == 0 {
			active++
			if member.RuntimeSessionID == session.ID {
				return RoomMemberRecord{}, errors.New("session is already in this room")
			}
		}
	}
	if active >= maxRoomMemberCount {
		return RoomMemberRecord{}, fmt.Errorf("a room can have at most %d active sessions", maxRoomMemberCount)
	}
	session.mu.RLock()
	avatarSeed := newUUID()
	member := RoomMemberRecord{
		ID: newUUID(), RuntimeSessionID: session.ID, DisplayName: session.Name,
		AvatarSeed: avatarSeed, AvatarColor: chooseRoomAvatarColor(session.Tool.Key, avatarSeed, usedColors), ToolKey: session.Tool.Key, ToolName: session.Tool.DisplayName,
		WorkingDirectory:     session.WorkingDirectory,
		NativeConversationID: sessionNativeConversationID(session),
		SessionOptions:       roomSessionOptions(session), JoinedAt: millis(),
	}
	session.mu.RUnlock()
	room.Members = append(room.Members, member)
	room.UpdatedAt = millis()
	if err := manager.store.Save(room); err != nil {
		return RoomMemberRecord{}, err
	}
	return member, nil
}

func (manager *RoomManager) RemoveMember(roomID, memberID string) error {
	return manager.mutate(roomID, func(room *RoomRecord) error {
		for index := range room.Members {
			if room.Members[index].ID == memberID && room.Members[index].LeftAt == 0 {
				room.Members[index].LeftAt = millis()
				return nil
			}
		}
		return errors.New("active room member not found")
	})
}

func (manager *RoomManager) PostMessage(ctx context.Context, roomID string, input RoomMessageInput) (map[string]any, error) {
	input.Text = strings.TrimSpace(input.Text)
	input.MentionedMemberIDs = uniqueStrings(input.MentionedMemberIDs)
	input.QuotedEntryIDs = uniqueStrings(input.QuotedEntryIDs)
	if len(input.Text) > maxRoomMessageBytes {
		return nil, errors.New("room message is too long")
	}
	if len(input.QuotedEntryIDs) > maxRoomQuoteCount {
		return nil, fmt.Errorf("a message can quote at most %d room messages", maxRoomQuoteCount)
	}
	if input.Text == "" && len(input.MentionedMemberIDs) == 0 {
		return nil, errors.New("message text or a mentioned session is required")
	}

	manager.mu.Lock()
	room, err := manager.store.Get(roomID)
	if err != nil {
		manager.mu.Unlock()
		return nil, err
	}
	activeMembers := map[string]RoomMemberRecord{}
	for _, member := range room.Members {
		if member.LeftAt == 0 {
			activeMembers[member.ID] = member
		}
	}
	targets := make([]RoomMemberRecord, 0, len(input.MentionedMemberIDs))
	for _, id := range input.MentionedMemberIDs {
		member, ok := activeMembers[id]
		if !ok {
			manager.mu.Unlock()
			return nil, fmt.Errorf("room member is unavailable: %s", id)
		}
		targets = append(targets, member)
	}
	references, missing := manager.referenceTextLocked(room, input.QuotedEntryIDs)
	now := millis()
	userEntry := RoomEntryRecord{
		ID: newUUID(), Sequence: room.NextSequence, Type: "user", UserText: input.Text,
		MentionedMemberIDs: input.MentionedMemberIDs, QuotedEntryIDs: input.QuotedEntryIDs,
		Status: "completed", CreatedAt: now,
	}
	room.NextSequence++
	room.Entries = append(room.Entries, userEntry)
	replyIDs := map[string]string{}
	for _, member := range targets {
		entry := RoomEntryRecord{
			ID: newUUID(), Sequence: room.NextSequence, Type: "session", MemberID: member.ID,
			SourceSessionID:      member.RuntimeSessionID,
			NativeConversationID: member.NativeConversationID,
			ClientMessageID:      "room-" + newUUID(), Status: "pending", CreatedAt: now,
		}
		room.NextSequence++
		replyIDs[member.ID] = entry.ID
		room.Entries = append(room.Entries, entry)
	}
	room.UpdatedAt = now
	if err := manager.store.Save(room); err != nil {
		manager.mu.Unlock()
		return nil, err
	}
	manager.mu.Unlock()

	agentText := buildRoomAgentText(input.Text, references, missing)
	var wait sync.WaitGroup
	for _, target := range targets {
		target := target
		wait.Add(1)
		go func() {
			defer wait.Done()
			manager.dispatch(ctx, roomID, replyIDs[target.ID], target, input.Text, agentText, input.Attachments[target.ID])
		}()
	}
	wait.Wait()
	return manager.GetPublic(roomID)
}

func (manager *RoomManager) dispatch(
	ctx context.Context,
	roomID, entryID string,
	member RoomMemberRecord,
	displayText, agentText string,
	attachmentIDs RoomTargetAttachments,
) {
	session := manager.sessions.Get(member.RuntimeSessionID)
	if session == nil {
		manager.failEntry(roomID, entryID, "Session is unavailable. Resume it before sending.")
		return
	}
	images := manager.attachments.Resolve(session, uniqueStrings(attachmentIDs.ImageIDs))
	files := manager.attachments.Resolve(session, uniqueStrings(attachmentIDs.FileIDs))
	if len(images) != len(uniqueStrings(attachmentIDs.ImageIDs)) || len(files) != len(uniqueStrings(attachmentIDs.FileIDs)) {
		for _, attachment := range append(images, files...) {
			manager.attachments.DeleteAttachment(session, attachment.ID)
		}
		manager.failEntry(roomID, entryID, "One or more attachments are no longer available.")
		return
	}
	providerText := promptWithFiles(agentText, files)
	manager.mu.Lock()
	room, err := manager.store.Get(roomID)
	clientID := ""
	if err == nil {
		for _, entry := range room.Entries {
			if entry.ID == entryID {
				clientID = entry.ClientMessageID
				break
			}
		}
	}
	manager.mu.Unlock()
	if clientID == "" {
		manager.failEntry(roomID, entryID, "Room dispatch is unavailable.")
		return
	}
	session.commandMu.Lock()
	err = session.Provider.Send(ctx, ProviderInput{
		ClientMessageID: clientID, Text: displayText, AgentText: providerText,
		Images: images, Files: files,
	})
	session.commandMu.Unlock()
	if err != nil {
		for _, id := range uniqueStrings(attachmentIDs.ImageIDs) {
			manager.attachments.DeleteAttachment(session, id)
		}
		for _, id := range uniqueStrings(attachmentIDs.FileIDs) {
			manager.attachments.DeleteAttachment(session, id)
		}
		manager.failEntry(roomID, entryID, err.Error())
		return
	}
	turnID, conversationID := sessionTurnLocator(session, clientID)
	_ = manager.mutate(roomID, func(room *RoomRecord) error {
		for index := range room.Entries {
			if room.Entries[index].ID != entryID {
				continue
			}
			room.Entries[index].NativeTurnID = firstNonEmpty(room.Entries[index].NativeTurnID, turnID)
			room.Entries[index].NativeConversationID = firstNonEmpty(conversationID, room.Entries[index].NativeConversationID)
			if room.Entries[index].Status == "pending" {
				room.Entries[index].Status = "running"
			}
			for memberIndex := range room.Members {
				if room.Members[memberIndex].ID == member.ID && conversationID != "" {
					room.Members[memberIndex].NativeConversationID = conversationID
				}
			}
			return nil
		}
		return errRoomNotFound
	})
}

func (manager *RoomManager) failEntry(roomID, entryID, message string) {
	_ = manager.mutate(roomID, func(room *RoomRecord) error {
		for index := range room.Entries {
			if room.Entries[index].ID == entryID {
				room.Entries[index].Status = "failed"
				room.Entries[index].Error = message
				return nil
			}
		}
		return errRoomNotFound
	})
}

func (manager *RoomManager) mutate(roomID string, update func(*RoomRecord) error) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	room, err := manager.store.Get(roomID)
	if err != nil {
		return err
	}
	if err := update(&room); err != nil {
		return err
	}
	room.UpdatedAt = millis()
	return manager.store.Save(room)
}

func (manager *RoomManager) publicEntryLocked(
	room RoomRecord,
	members map[string]RoomMemberRecord,
	entry RoomEntryRecord,
) map[string]any {
	result := map[string]any{
		"id": entry.ID, "sequence": entry.Sequence, "type": entry.Type,
		"memberId": nilIfEmpty(entry.MemberID), "mentionedMemberIds": entry.MentionedMemberIDs,
		"quotedEntryIds": entry.QuotedEntryIDs, "status": entry.Status,
		"createdAt": entry.CreatedAt,
	}
	if entry.Type == "user" {
		result["text"] = entry.UserText
		return result
	}
	member := members[entry.MemberID]
	view, available := manager.resolver.Resolve(member, entry)
	if !available {
		result["status"] = "unavailable"
		result["error"] = "Original session is unavailable"
		return result
	}
	if view.Text != "" {
		result["text"] = view.Text
	}
	if view.TurnID != "" {
		result["turnId"] = view.TurnID
	}
	if view.Status != "" {
		result["status"] = view.Status
	}
	if entry.Error != "" {
		result["error"] = entry.Error
	}
	return result
}

func (manager *RoomManager) referenceTextLocked(room RoomRecord, ids []string) ([]string, []string) {
	entries := map[string]RoomEntryRecord{}
	members := map[string]RoomMemberRecord{}
	for _, entry := range room.Entries {
		entries[entry.ID] = entry
	}
	for _, member := range room.Members {
		members[member.ID] = member
	}
	resolved, missing := []string{}, []string{}
	bytes := 0
	for _, id := range ids {
		entry, ok := entries[id]
		if !ok {
			missing = append(missing, id)
			continue
		}
		label, text := "User", entry.UserText
		if entry.Type == "session" {
			member := members[entry.MemberID]
			label = member.DisplayName
			if view, available := manager.resolver.Resolve(member, entry); available {
				text = view.Text
			} else {
				text = ""
			}
		}
		if strings.TrimSpace(text) == "" {
			missing = append(missing, id)
			continue
		}
		item := fmt.Sprintf("[%s · %s]\n%s", id, label, text)
		if bytes+len(item) > maxRoomReferenceBytes {
			missing = append(missing, id)
			continue
		}
		bytes += len(item)
		resolved = append(resolved, item)
	}
	return resolved, missing
}

func buildRoomAgentText(text string, references, missing []string) string {
	parts := []string{
		"You are being addressed as a member of a Glad group chat. Only the explicitly quoted messages below are shared context; do not assume you can see the rest of the room.",
	}
	if len(references) > 0 || len(missing) > 0 {
		parts = append(parts, "<glad_group_references>")
		parts = append(parts, references...)
		for _, id := range missing {
			parts = append(parts, fmt.Sprintf("[%s]\nMessage unavailable: the original session could not be read.", id))
		}
		parts = append(parts, "</glad_group_references>")
	}
	parts = append(parts, "<glad_group_message>\n"+text+"\n</glad_group_message>")
	return strings.Join(parts, "\n\n")
}

func resolveSessionTurn(session *Session, entry RoomEntryRecord) (string, string, string) {
	session.mu.RLock()
	defer session.mu.RUnlock()
	turnID := entry.NativeTurnID
	for _, message := range session.Messages {
		if stringValue(message["kind"]) == "user" && entry.ClientMessageID != "" &&
			stringValue(message["clientMessageId"]) == entry.ClientMessageID {
			turnID = firstNonEmpty(stringValue(message["turnId"]), turnID)
		}
	}
	text, status := "", entry.Status
	for _, message := range session.Messages {
		if turnID == "" || stringValue(message["turnId"]) != turnID {
			continue
		}
		switch stringValue(message["kind"]) {
		case "assistant":
			if stringValue(message["parentToolUseId"]) == "" && strings.TrimSpace(stringValue(message["text"])) != "" {
				text = stringValue(message["text"])
			}
		case "turn-end":
			status = firstNonEmpty(stringValue(message["status"]), stringValue(message["turnStatus"]), "completed")
		}
	}
	if status == "pending" && turnID != "" {
		status = "running"
	}
	return text, status, turnID
}

func sessionTurnLocator(session *Session, clientID string) (string, string) {
	session.mu.RLock()
	turnID := ""
	for index := len(session.Messages) - 1; index >= 0; index-- {
		message := session.Messages[index]
		if stringValue(message["clientMessageId"]) == clientID {
			turnID = stringValue(message["turnId"])
			if turnID != "" {
				break
			}
		}
	}
	conversationID := sessionNativeConversationID(session)
	session.mu.RUnlock()
	if provider, ok := session.Provider.(*CodexProvider); ok {
		provider.mu.Lock()
		turnID = firstNonEmpty(turnID, provider.turnID)
		conversationID = firstNonEmpty(conversationID, provider.threadID)
		provider.mu.Unlock()
	}
	return turnID, conversationID
}

// sessionNativeConversationID requires session.mu to be held by the caller.
func sessionNativeConversationID(session *Session) string {
	if session.Tool.Key == "codex" {
		return stringValue(session.State["threadId"])
	}
	return firstNonEmpty(stringValue(session.State["claudeSessionId"]), stringValue(session.State["resumeSessionId"]))
}

// Only recreate settings which define provider identity/behaviour. Volatile
// runtime fields and message content are intentionally excluded.
func roomSessionOptions(session *Session) map[string]any {
	options := map[string]any{}
	for _, key := range []string{"model", "effort", "permissionMode", "sandboxMode"} {
		if value := session.State[key]; value != nil && stringValue(value) != "" {
			options[key] = value
		}
	}
	return options
}

// resolveClaudeNativeTurnID is used after completion to replace Glad's live
// Claude turn UUID with the stable user-record UUID in Claude's JSONL history.
func resolveClaudeNativeTurnID(session *Session, clientID, conversationID string) string {
	if session == nil || conversationID == "" {
		return ""
	}
	session.mu.RLock()
	agentText := ""
	for _, message := range session.Messages {
		if stringValue(message["kind"]) == "user" && stringValue(message["clientMessageId"]) == clientID {
			agentText = strings.TrimSpace(stringValue(message["agentText"]))
			break
		}
	}
	cwd := session.WorkingDirectory
	session.mu.RUnlock()
	if agentText == "" {
		return ""
	}
	file, err := os.Open(filepathForClaudeTranscript(cwd, conversationID))
	if err != nil {
		return ""
	}
	defer file.Close()
	match := ""
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil || stringValue(record["type"]) != "user" {
			continue
		}
		if strings.TrimSpace(claudeTranscriptUserText(record)) == agentText {
			match = firstNonEmpty(stringValue(record["uuid"]), stringValue(record["promptId"]))
		}
	}
	return match
}

func roomContext(timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), timeout)
}
