package app

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	sessioncore "glad-web/internal/session"
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
	activeIDs   map[string]string
	operations  map[string]*sync.Mutex
	runtimes    map[string]*roomRuntime
	events      *sessioncore.EventHub
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
	RoomID, RoomName, MemberName, ToolName    string
	ActiveMembers, RoundTotal, RoundCompleted int
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
	Source             *SupervisorSource                `json:"-"`
	SenderMemberID     string                           `json:"-"`
	ClientMessageID    string                           `json:"clientMessageId,omitempty"`
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
		resolver:  sessionRoomTurnResolver{sessions: sessions},
		activeIDs: map[string]string{}, operations: map[string]*sync.Mutex{},
		runtimes: map[string]*roomRuntime{}, events: sessioncore.NewEventHub(),
	}
}

func (manager *RoomManager) Start(ctx context.Context) {
	subscription := manager.sessions.Events().Subscribe("", 1024)
	go func() {
		defer subscription.Close()
		for {
			select {
			case event := <-subscription.Events():
				manager.sessionEvent(event)
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
				// Messages authored in a member session are projected from the
				// provider conversation when a room is read. They are not copied
				// into room persistence.
				if stringValue(event.Payload["type"]) == "message" && stringValue(message["kind"]) == "user" {
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
		_ = manager.mutateHistory(roomID, func(room *RoomRecord) error {
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
		_ = manager.mutateHistory(roomID, func(room *RoomRecord) error {
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
		_ = manager.mutateHistory(roomID, func(room *RoomRecord) error {
			changed := false
			for index := range room.Entries {
				entry := &room.Entries[index]
				if entry.Type != "session" || (entry.Status != "pending" && entry.Status != "running") || entry.SourceSessionID != sessionID ||
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
	return manager.list(true)
}

func (manager *RoomManager) History() ([]map[string]any, error) {
	return manager.list(false)
}

func (manager *RoomManager) list(activeOnly bool) ([]map[string]any, error) {
	rooms, err := manager.store.List()
	if err != nil {
		return nil, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	result := make([]map[string]any, 0, len(rooms))
	for _, room := range rooms {
		runtimeIDs := []string{room.ID}
		if activeOnly {
			runtimeIDs = nil
			for runtimeID, historyID := range manager.activeIDs {
				if historyID == room.ID {
					runtimeIDs = append(runtimeIDs, runtimeID)
				}
			}
			if len(runtimeIDs) == 0 {
				continue
			}
		}
		activeMembers := 0
		liveSessionIDs := []string{}
		for _, member := range room.Members {
			if member.LeftAt == 0 {
				activeMembers++
				if activeOnly && manager.sessions.Get(member.RuntimeSessionID) != nil {
					liveSessionIDs = append(liveSessionIDs, member.RuntimeSessionID)
				}
			}
		}
		messageCount := len(manager.projectRoomEntriesLocked(room))
		sort.Strings(runtimeIDs)
		for _, runtimeID := range runtimeIDs {
			item := manager.runtimeFieldsLocked(runtimeID, room)
			metadata := map[string]any{
				"id": runtimeID, "historyId": room.ID, "name": room.Name, "createdAt": room.CreatedAt,
				"updatedAt": room.UpdatedAt, "memberCount": activeMembers,
				"messageCount": messageCount, "draft": room.Draft,
				"serverChanNotificationEnabled": room.ServerChanNotificationEnabled,
			}
			if activeOnly {
				metadata["sessionIds"] = liveSessionIDs
			}
			for key, value := range metadata {
				item[key] = value
			}
			result = append(result, item)
		}
	}
	return result, nil
}

func (manager *RoomManager) Create(name string) (RoomRecord, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
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
	manager.activeIDs[room.ID] = room.ID
	manager.runtimeLocked(room.ID)
	manager.publishLocked(room.ID)
	return room, nil
}

func (manager *RoomManager) lockOperation(id string) func() {
	manager.mu.Lock()
	lock := manager.operations[id]
	if lock == nil {
		lock = &sync.Mutex{}
		manager.operations[id] = lock
	}
	manager.mu.Unlock()
	lock.Lock()
	return lock.Unlock
}

func (manager *RoomManager) Busy(id string) bool {
	room, err := manager.GetRecord(id)
	if err != nil {
		return false
	}
	for _, member := range room.Members {
		if member.LeftAt != 0 {
			continue
		}
		if session := manager.sessions.Get(member.RuntimeSessionID); session != nil {
			if ready, _ := sessionCanAccept(session); !ready {
				return true
			}
			session.mu.RLock()
			status := session.StatusValue
			session.mu.RUnlock()
			switch status {
			case "running", "thinking", "waiting_approval", "waiting_input":
				return true
			}
		}
	}
	return false
}

// SwitchHistory binds an existing runtime group to a saved conversation.
// Runtime identities live only in memory, just like ordinary sessions.
func (manager *RoomManager) SwitchHistory(runtimeID, historyID string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.activeIDs[runtimeID] == "" {
		return errRoomNotFound
	}
	if _, err := manager.store.Get(historyID); err != nil {
		return err
	}
	manager.activeIDs[runtimeID] = historyID
	manager.publishLocked(runtimeID)
	return nil
}

func (manager *RoomManager) IsActive(id string) bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.activeIDs[id] != ""
}

func (manager *RoomManager) roomIDLocked(id string) string {
	if historyID := manager.activeIDs[id]; historyID != "" {
		return historyID
	}
	return id
}

// Close removes the runtime group while preserving its saved history and members.
func (manager *RoomManager) Close(id string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.activeIDs[id] == "" {
		return errRoomNotFound
	}
	runtime := manager.runtimeLocked(id)
	runtime.cancel()
	if runtime.operationCancel != nil {
		runtime.operationCancel()
	}
	for _, item := range runtime.timers {
		if item.Timer != nil {
			item.Timer.Stop()
		}
	}
	delete(manager.runtimes, id)
	delete(manager.activeIDs, id)
	manager.publishLocked(id)
	return nil
}

func (manager *RoomManager) GetHistoryRecord(id string) (RoomRecord, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.store.Get(id)
}

func (manager *RoomManager) CopyHistory(id string) (RoomRecord, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	room, err := manager.store.Get(id)
	if err != nil {
		return RoomRecord{}, err
	}
	room.ID = newUUID()
	room.CreatedAt, room.UpdatedAt = millis(), millis()
	room.Draft = false
	for index := range room.Members {
		// Failed or excluded forks must not silently reuse a source session.
		room.Members[index].RuntimeSessionID = ""
	}
	if err := manager.store.Save(room); err != nil {
		return RoomRecord{}, err
	}
	return room, nil
}

func (manager *RoomManager) Delete(id string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if err := manager.store.Delete(id); err != nil {
		return err
	}
	delete(manager.activeIDs, id)
	return nil
}

func (manager *RoomManager) DeleteDraft(id string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	room, err := manager.store.Get(id)
	if err != nil {
		return err
	}
	if !room.Draft || len(room.Entries) != 0 {
		return errors.New("room is not an empty draft")
	}
	for _, member := range room.Members {
		if member.LeftAt == 0 {
			return errors.New("room is not an empty draft")
		}
	}
	if err := manager.store.Delete(id); err != nil {
		return err
	}
	delete(manager.activeIDs, id)
	return nil
}

func (manager *RoomManager) Rename(id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxRoomNameBytes {
		return errors.New("invalid room name")
	}
	return manager.mutate(id, func(room *RoomRecord) error {
		room.Name = name
		room.Draft = false
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
			_ = manager.mutateHistory(room.ID, func(saved *RoomRecord) error {
				saved.ServerChanNotificationEnabled = false
				return nil
			})
		}
	}
}

func (manager *RoomManager) NotificationTargets(sessionID, runtimeTurnID string, currentCompleted bool) []RoomNotificationTarget {
	rooms, err := manager.store.List()
	if err != nil {
		return nil
	}
	manager.mu.Lock()
	activeHistory := map[string]bool{}
	for _, historyID := range manager.activeIDs {
		activeHistory[historyID] = true
	}
	manager.mu.Unlock()
	result := []RoomNotificationTarget{}
	for _, room := range rooms {
		if !room.ServerChanNotificationEnabled || !activeHistory[room.ID] {
			continue
		}
		activeMembers := 0
		for _, member := range room.Members {
			if member.LeftAt == 0 {
				activeMembers++
			}
		}
		for _, member := range room.Members {
			if member.LeftAt == 0 && member.RuntimeSessionID == sessionID {
				total, completed := roomNotificationProgress(room, sessionID, runtimeTurnID, currentCompleted)
				result = append(result, RoomNotificationTarget{
					RoomID: room.ID, RoomName: room.Name, MemberName: member.DisplayName,
					ToolName: firstNonEmpty(member.ToolName, member.ToolKey), ActiveMembers: activeMembers,
					RoundTotal: total, RoundCompleted: completed,
				})
				break
			}
		}
	}
	return result
}

func roomNotificationProgress(room RoomRecord, sessionID, runtimeTurnID string, currentCompleted bool) (int, int) {
	targetIndex := -1
	for index := len(room.Entries) - 1; index >= 0; index-- {
		entry := room.Entries[index]
		if entry.Type != "session" || entry.SourceSessionID != sessionID {
			continue
		}
		if runtimeTurnID != "" && entry.NativeTurnID == runtimeTurnID {
			targetIndex = index
			break
		}
		if targetIndex == -1 && (entry.Status == "pending" || entry.Status == "running") {
			targetIndex = index
		}
	}
	if targetIndex < 0 {
		if currentCompleted {
			return 1, 1
		}
		return 1, 0
	}
	start := targetIndex - 1
	for start >= 0 && room.Entries[start].Type != "user" {
		start--
	}
	total, completed := 0, 0
	for index := start + 1; index < len(room.Entries); index++ {
		entry := room.Entries[index]
		if entry.Type == "user" {
			break
		}
		if entry.Type != "session" {
			continue
		}
		total++
		if entry.Status == "completed" || index == targetIndex && currentCompleted && entry.Status != "completed" {
			completed++
		}
	}
	if total == 0 {
		total = 1
	}
	return total, completed
}

func (manager *RoomManager) GetRecord(id string) (RoomRecord, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.store.Get(manager.roomIDLocked(id))
}

func (manager *RoomManager) BindRuntimeSession(roomID, memberID, sessionID, conversationID string) error {
	return manager.mutateHistory(roomID, func(room *RoomRecord) error {
		for index := range room.Members {
			if room.Members[index].ID == memberID && room.Members[index].LeftAt == 0 {
				room.Members[index].RuntimeSessionID = sessionID
				room.Members[index].NativeConversationID = firstNonEmpty(conversationID, room.Members[index].NativeConversationID)
				for entryIndex := range room.Entries {
					entry := &room.Entries[entryIndex]
					if entry.Type == "session" && entry.MemberID == memberID {
						entry.SourceSessionID = sessionID
						entry.NativeConversationID = firstNonEmpty(conversationID, entry.NativeConversationID)
					}
				}
				return nil
			}
		}
		return errors.New("active room member not found")
	})
}

func (manager *RoomManager) GetPublic(id string) (map[string]any, error) {
	return manager.getPublic(id, false)
}

func (manager *RoomManager) GetHistoryPublic(id string) (map[string]any, error) {
	return manager.getPublic(id, true)
}

func (manager *RoomManager) getPublic(id string, history bool) (map[string]any, error) {
	manager.mu.Lock()
	historyID := id
	if !history {
		historyID = manager.roomIDLocked(id)
	}
	room, err := manager.store.Get(historyID)
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
			"canAccept": func() bool {
				if session == nil || member.LeftAt != 0 {
					return false
				}
				ready, _ := sessionCanAccept(session)
				return ready
			}(),
		})
	}
	projected := manager.projectRoomEntriesLocked(room)
	entries := make([]map[string]any, 0, len(projected))
	for _, entry := range projected {
		entries = append(entries, manager.publicEntryLocked(room, memberByID, entry))
	}
	runtimeID := id
	if history {
		runtimeID = ""
	}
	fields := manager.runtimeFieldsLocked(runtimeID, room)
	manager.mu.Unlock()
	result := map[string]any{
		"schemaVersion": room.SchemaVersion, "id": id, "historyId": room.ID, "name": room.Name,
		"createdAt": room.CreatedAt, "updatedAt": room.UpdatedAt, "draft": room.Draft,
		"serverChanNotificationEnabled": room.ServerChanNotificationEnabled,
		"members":                       members, "entries": entries,
	}
	for key, value := range fields {
		result[key] = value
	}
	return result, nil
}

type roomProjectedTurn struct {
	turnID, conversationID, originRoomID, clientID, userText, assistantText, status string
	hidden                                                                          bool
	userAt, assistantAt                                                             int64
}

type roomContextTurn struct {
	TurnID, UserText, AssistantText, Status string
	CreatedAt                               int64
	HasDetails                              bool
}

type roomSourceMessage struct {
	Message        map[string]any
	TurnID         string
	ConversationID string
}

func roomHistoryEntryID(memberID, turnID, kind string) string {
	// Provider-side forks may change the conversation ID while preserving turn
	// IDs. Member + turn + role keeps room references stable across that switch.
	digest := sha256.Sum256([]byte(memberID + "\x00" + turnID + "\x00" + kind))
	return "history-" + hex.EncodeToString(digest[:16])
}

func newRoomClientID(roomID string) string {
	return "room:" + roomID + ":" + newUUID()
}

func roomClientOrigin(clientID string) (string, bool) {
	if strings.HasPrefix(clientID, "room:") {
		value := strings.TrimPrefix(clientID, "room:")
		if separator := strings.IndexByte(value, ':'); separator > 0 {
			return value[:separator], true
		}
	}
	if strings.HasPrefix(clientID, "room-") {
		return "", true
	}
	return "", false
}

// projectRoomEntriesLocked builds the room read model from durable room-owned
// entries plus every active member's provider-native conversation. Historical
// text remains provider-owned and is never written back to the room store.
func (manager *RoomManager) projectRoomEntriesLocked(room RoomRecord) []RoomEntryRecord {
	entries := append([]RoomEntryRecord(nil), room.Entries...)
	seenTurns := map[string]bool{}
	seenClients := map[string]bool{}
	for _, entry := range room.Entries {
		if entry.MemberID != "" && entry.NativeTurnID != "" {
			seenTurns[entry.MemberID+"\x00"+entry.NativeTurnID] = true
		}
		if entry.ClientMessageID != "" {
			seenClients[entry.MemberID+"\x00"+entry.ClientMessageID] = true
		}
	}
	for _, member := range room.Members {
		if member.LeftAt != 0 {
			continue
		}
		sourceMessages, conversationID, available := manager.roomMemberSourceMessages(member)
		if !available {
			continue
		}
		turns := map[string]*roomProjectedTurn{}
		order := []string{}
		for _, source := range sourceMessages {
			message := source.Message
			kind := stringValue(message["kind"])
			if kind != "user" && kind != "assistant" && kind != "turn-end" {
				continue
			}
			turnID := source.TurnID
			if turnID == "" {
				continue
			}
			turn := turns[turnID]
			if turn == nil {
				turn = &roomProjectedTurn{turnID: turnID, conversationID: source.ConversationID, status: "completed"}
				turns[turnID] = turn
				order = append(order, turnID)
			}
			switch kind {
			case "user":
				text := strings.TrimSpace(stringValue(message["text"]))
				clientID := stringValue(message["clientMessageId"])
				source := sourceValue(message["supervisorSource"])
				if source == nil {
					source, _ = supervisorEnvelope(stringValue(message["agentText"]))
				}
				if historicalSource, visible := supervisorEnvelope(text); historicalSource != nil {
					source, text = historicalSource, visible
				}
				if source != nil && source.Kind == "trigger" {
					turn.hidden = true
				}
				if origin, roomClient := roomClientOrigin(clientID); roomClient && origin != "" {
					turn.originRoomID = origin
				}
				if visible, origin, ok := roomTransportEnvelope(text); ok {
					text = visible
					if origin != "" {
						turn.originRoomID = origin
					}
				}
				if text != "" {
					turn.userText, turn.clientID = text, clientID
					turn.userAt = numberInt64(message["createdAt"])
				}
			case "assistant":
				if text := strings.TrimSpace(stringValue(message["text"])); text != "" {
					turn.assistantText = text
					turn.assistantAt = numberInt64(firstNonNil(message["completedAtMs"], message["updatedAt"], message["createdAt"]))
				}
			case "turn-end":
				turn.status = firstNonEmpty(stringValue(message["status"]), stringValue(message["turnStatus"]), "completed")
			}
		}
		for index := range entries {
			entry := &entries[index]
			if entry.Type != "session" || entry.MemberID != member.ID || entry.NativeTurnID == "" {
				continue
			}
			if turn := turns[entry.NativeTurnID]; turn != nil && turn.assistantText != "" {
				entry.ResolvedText = turn.assistantText
				entry.Status = firstNonEmpty(turn.status, entry.Status)
			}
		}
		for _, turnID := range order {
			turn := turns[turnID]
			if turn.hidden || turn.userText == "" || seenTurns[member.ID+"\x00"+turnID] ||
				(turn.clientID != "" && seenClients[member.ID+"\x00"+turn.clientID]) {
				continue
			}
			createdAt := turn.userAt
			if createdAt <= 0 {
				createdAt = turn.assistantAt
			}
			entries = append(entries, RoomEntryRecord{
				ID: roomHistoryEntryID(member.ID, turnID, "user"), Type: "user",
				UserText: turn.userText, MemberID: member.ID, MentionedMemberIDs: []string{member.ID},
				SourceSessionID: member.RuntimeSessionID, NativeConversationID: firstNonEmpty(turn.conversationID, conversationID),
				NativeTurnID: turnID, OriginRoomID: turn.originRoomID, ClientMessageID: turn.clientID,
				Status: "completed", CreatedAt: createdAt,
				Historical: true,
			})
			if turn.assistantText != "" {
				assistantAt := turn.assistantAt
				if assistantAt <= 0 {
					assistantAt = createdAt
				}
				entries = append(entries, RoomEntryRecord{
					ID: roomHistoryEntryID(member.ID, turnID, "assistant"), Type: "session",
					MemberID: member.ID, SourceSessionID: member.RuntimeSessionID,
					NativeConversationID: firstNonEmpty(turn.conversationID, conversationID), NativeTurnID: turnID,
					OriginRoomID: turn.originRoomID, Status: turn.status, CreatedAt: assistantAt,
					Historical: true, ResolvedText: turn.assistantText,
				})
			}
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].CreatedAt != entries[j].CreatedAt {
			return entries[i].CreatedAt < entries[j].CreatedAt
		}
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == "user"
		}
		return entries[i].Sequence < entries[j].Sequence
	})
	for index := range entries {
		entries[index].Sequence = int64(index + 1)
	}
	return entries
}

func (manager *RoomManager) EntryContext(roomID, entryID string, before, after int) (map[string]any, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	room, err := manager.store.Get(manager.roomIDLocked(roomID))
	if err != nil {
		return nil, err
	}
	entry, member, source, err := manager.roomSourceLocked(room, entryID)
	if err != nil {
		return nil, err
	}
	turns := roomConversationTurns(source)
	anchor := -1
	for index, turn := range turns {
		if turn.TurnID == entry.NativeTurnID {
			anchor = index
			break
		}
	}
	if anchor < 0 {
		return nil, errors.New("source turn is unavailable")
	}
	before = max(0, min(before, 50))
	after = max(0, min(after, 50))
	start, end := max(0, anchor-before), min(len(turns), anchor+after+1)
	items := make([]map[string]any, 0, end-start)
	for index := start; index < end; index++ {
		turn := turns[index]
		items = append(items, map[string]any{
			"turnId": turn.TurnID, "userText": turn.UserText, "assistantText": turn.AssistantText,
			"createdAt": turn.CreatedAt, "status": turn.Status, "hasDetails": turn.HasDetails,
			"anchor": index == anchor,
		})
	}
	return map[string]any{
		"entryId": entry.ID, "memberId": member.ID, "memberName": member.DisplayName,
		"conversationId": entry.NativeConversationID, "anchorTurnId": entry.NativeTurnID,
		"turns": items, "hasBefore": start > 0, "hasAfter": end < len(turns),
		"before": anchor - start, "after": end - anchor - 1, "totalTurns": len(turns),
	}, nil
}

func (manager *RoomManager) EntryTurnDetails(roomID, entryID, turnID string) (map[string]any, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	room, err := manager.store.Get(manager.roomIDLocked(roomID))
	if err != nil {
		return nil, err
	}
	_, member, source, err := manager.roomSourceLocked(room, entryID)
	if err != nil {
		return nil, err
	}
	messages := []map[string]any{}
	for _, item := range source {
		if item.TurnID != turnID {
			continue
		}
		copy := cloneMap(item.Message)
		copy["turnId"] = turnID
		delete(copy, "agentText")
		delete(copy, "raw")
		messages = append(messages, copy)
	}
	if len(messages) == 0 {
		return nil, errors.New("source turn details are unavailable")
	}
	return map[string]any{"turnId": turnID, "memberId": member.ID, "memberName": member.DisplayName, "messages": messages}, nil
}

func (manager *RoomManager) roomSourceLocked(room RoomRecord, entryID string) (RoomEntryRecord, RoomMemberRecord, []roomSourceMessage, error) {
	var entry RoomEntryRecord
	found := false
	for _, candidate := range manager.projectRoomEntriesLocked(room) {
		if candidate.ID == entryID {
			entry, found = candidate, true
			break
		}
	}
	if !found || entry.MemberID == "" || entry.NativeTurnID == "" {
		return RoomEntryRecord{}, RoomMemberRecord{}, nil, errors.New("room entry has no source conversation")
	}
	var member RoomMemberRecord
	for _, candidate := range room.Members {
		if candidate.ID == entry.MemberID {
			member = candidate
			break
		}
	}
	if member.ID == "" {
		return RoomEntryRecord{}, RoomMemberRecord{}, nil, errors.New("source member is unavailable")
	}
	source, _, available := manager.roomMemberSourceMessages(member)
	if !available {
		return RoomEntryRecord{}, RoomMemberRecord{}, nil, errors.New("source session is unavailable")
	}
	return entry, member, source, nil
}

func roomConversationTurns(sourceMessages []roomSourceMessage) []roomContextTurn {
	turns := map[string]*roomContextTurn{}
	order := []string{}
	for _, source := range sourceMessages {
		message := source.Message
		turnID := source.TurnID
		if turnID == "" {
			continue
		}
		turn := turns[turnID]
		if turn == nil {
			turn = &roomContextTurn{TurnID: turnID, Status: "completed"}
			turns[turnID] = turn
			order = append(order, turnID)
		}
		createdAt := numberInt64(firstNonNil(message["createdAt"], message["startedAtMs"], message["completedAtMs"]))
		if turn.CreatedAt == 0 || createdAt > 0 && createdAt < turn.CreatedAt {
			turn.CreatedAt = createdAt
		}
		switch stringValue(message["kind"]) {
		case "user":
			text := strings.TrimSpace(stringValue(message["text"]))
			if visible, ok := roomTransportVisibleText(text); ok {
				text = visible
			}
			if text != "" {
				turn.UserText = text
			}
		case "assistant":
			if text := strings.TrimSpace(stringValue(message["text"])); text != "" {
				turn.AssistantText = text
			}
		case "turn-start":
		case "turn-end":
			turn.Status = firstNonEmpty(stringValue(message["status"]), stringValue(message["turnStatus"]), "completed")
		default:
			turn.HasDetails = true
		}
	}
	result := make([]roomContextTurn, 0, len(order))
	for _, turnID := range order {
		turn := *turns[turnID]
		if turn.UserText != "" || turn.AssistantText != "" {
			result = append(result, turn)
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].CreatedAt < result[j].CreatedAt })
	return result
}

func (manager *RoomManager) roomMemberSourceMessages(member RoomMemberRecord) ([]roomSourceMessage, string, bool) {
	if session := manager.sessions.Get(member.RuntimeSessionID); session != nil {
		session.mu.RLock()
		conversationID := firstNonEmpty(sessionNativeConversationID(session), member.NativeConversationID)
		messages := roomSourceMessages(session.Messages, conversationID)
		session.mu.RUnlock()
		return messages, conversationID, true
	}
	if member.NativeConversationID == "" {
		return nil, "", false
	}
	var messages []map[string]any
	var err error
	switch member.ToolKey {
	case "claude-code":
		messages, err = readClaudeTranscriptFile(member.WorkingDirectory, member.NativeConversationID)
	case "codex":
		messages, err = readCodexTranscriptFile(member.NativeConversationID)
	default:
		err = errors.New("provider history is unavailable")
	}
	if err != nil {
		return nil, member.NativeConversationID, false
	}
	return roomSourceMessages(messages, member.NativeConversationID), member.NativeConversationID, true
}

// Live providers publish the visible user message before Codex assigns its
// turn ID. Pair that orphan message with the following root turn-start so the
// dynamic room projection has one stable source turn after completion.
func roomSourceMessages(messages []map[string]any, conversationID string) []roomSourceMessage {
	rootThreads := map[string]bool{}
	if conversationID != "" {
		rootThreads[conversationID] = true
	}
	for _, message := range messages {
		kind := stringValue(message["kind"])
		if kind == "turn-end" && boolValue(message["isRootTurn"]) {
			if threadID := stringValue(message["threadId"]); threadID != "" {
				rootThreads[threadID] = true
			}
		}
	}
	result := []roomSourceMessage{}
	pendingUser := -1
	for _, message := range messages {
		if stringValue(message["parentToolUseId"]) != "" {
			continue
		}
		threadID := stringValue(message["threadId"])
		if threadID != "" && len(rootThreads) > 0 && !rootThreads[threadID] {
			continue
		}
		kind := stringValue(message["kind"])
		turnID := stringValue(message["turnId"])
		if kind == "turn-start" && turnID != "" && pendingUser >= 0 {
			result[pendingUser].TurnID = turnID
			result[pendingUser].ConversationID = firstNonEmpty(threadID, conversationID)
			pendingUser = -1
		}
		if turnID == "" {
			turnID = firstNonEmpty(stringValue(message["providerId"]), stringValue(message["id"]))
		}
		if turnID == "" {
			continue
		}
		result = append(result, roomSourceMessage{
			Message: message, TurnID: turnID, ConversationID: firstNonEmpty(threadID, conversationID),
		})
		if kind == "user" && stringValue(message["turnId"]) == "" {
			pendingUser = len(result) - 1
		} else if kind == "user" {
			pendingUser = -1
		}
	}
	return result
}

func (manager *RoomManager) AddSession(roomID, sessionID string) (RoomMemberRecord, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	room, err := manager.store.Get(manager.roomIDLocked(roomID))
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
	room.Draft = false
	room.UpdatedAt = millis()
	if err := manager.store.Save(room); err != nil {
		return RoomMemberRecord{}, err
	}
	manager.publishHistoryLocked(room.ID)
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
	input.ClientMessageID = strings.TrimSpace(input.ClientMessageID)
	if len(input.ClientMessageID) > 128 {
		return nil, errors.New("invalid message ID")
	}
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
	room, err := manager.store.Get(manager.roomIDLocked(roomID))
	if err != nil {
		manager.mu.Unlock()
		return nil, err
	}
	encoded, _ := json.Marshal(input)
	hash := sha256.Sum256(encoded)
	requestHash := hex.EncodeToString(hash[:])
	if input.ClientMessageID != "" {
		for _, entry := range room.Entries {
			if entry.Type == "user" && entry.ClientMessageID == input.ClientMessageID {
				manager.mu.Unlock()
				if entry.RequestHash != requestHash {
					return nil, errors.New("message ID was already used for different content")
				}
				return manager.GetPublic(roomID)
			}
		}
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
		if session := manager.sessions.Get(member.RuntimeSessionID); session == nil {
			manager.mu.Unlock()
			return nil, fmt.Errorf("room member is unavailable: %s", member.DisplayName)
		} else if ready, reason := sessionCanAccept(session); !ready {
			manager.mu.Unlock()
			return nil, fmt.Errorf("%s: %s", member.DisplayName, reason)
		}
		targets = append(targets, member)
	}
	projected := manager.projectRoomEntriesLocked(room)
	references, missing := manager.referenceTextLocked(room, projected, input.QuotedEntryIDs)
	now := millis()
	userEntry := RoomEntryRecord{
		ID: newUUID(), Sequence: room.NextSequence, Type: "user", UserText: input.Text,
		MentionedMemberIDs: input.MentionedMemberIDs, QuotedEntryIDs: input.QuotedEntryIDs,
		Status: "completed", CreatedAt: now, ClientMessageID: input.ClientMessageID, RequestHash: requestHash, SenderMemberID: input.SenderMemberID,
	}
	room.NextSequence++
	room.Entries = append(room.Entries, userEntry)
	replyIDs := map[string]string{}
	for _, member := range targets {
		entry := RoomEntryRecord{
			ID: newUUID(), Sequence: room.NextSequence, Type: "session", MemberID: member.ID,
			SourceSessionID:      member.RuntimeSessionID,
			NativeConversationID: member.NativeConversationID,
			ClientMessageID:      newRoomClientID(room.ID), OriginRoomID: room.ID,
			Status: "pending", CreatedAt: now,
		}
		room.NextSequence++
		replyIDs[member.ID] = entry.ID
		room.Entries = append(room.Entries, entry)
	}
	room.UpdatedAt = now
	room.Draft = false
	if err := manager.store.Save(room); err != nil {
		manager.mu.Unlock()
		return nil, err
	}
	manager.publishHistoryLocked(room.ID)
	manager.mu.Unlock()

	agentText := buildRoomAgentTextForRoom(room.ID, input.Text, references, missing)
	var wait sync.WaitGroup
	for _, target := range targets {
		target := target
		wait.Add(1)
		go func() {
			defer wait.Done()
			manager.dispatch(ctx, room.ID, replyIDs[target.ID], target, input.Text, agentText, input.Attachments[target.ID], input.Source)
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
	source *SupervisorSource,
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
	err = sendSessionControlledLocked(ctx, session, ProviderInput{
		ClientMessageID: clientID, Text: displayText, AgentText: supervisorAgentText(source, providerText), Source: source,
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
	_ = manager.mutateHistory(roomID, func(room *RoomRecord) error {
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
	_ = manager.mutateHistory(roomID, func(room *RoomRecord) error {
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
	return manager.updateRoom(roomID, update, false)
}

func (manager *RoomManager) mutateHistory(roomID string, update func(*RoomRecord) error) error {
	return manager.updateRoom(roomID, update, true)
}

func (manager *RoomManager) updateRoom(roomID string, update func(*RoomRecord) error, history bool) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if !history {
		roomID = manager.roomIDLocked(roomID)
	}
	room, err := manager.store.Get(roomID)
	if err != nil {
		return err
	}
	if err := update(&room); err != nil {
		return err
	}
	room.UpdatedAt = millis()
	if err := manager.store.Save(room); err != nil {
		return err
	}
	manager.publishHistoryLocked(room.ID)
	return nil
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
		"createdAt":            entry.CreatedAt,
		"historical":           entry.Historical,
		"senderMemberId":       nilIfEmpty(entry.SenderMemberID),
		"hasContext":           entry.NativeTurnID != "" && entry.MemberID != "",
		"sourceTurnId":         nilIfEmpty(entry.NativeTurnID),
		"sourceConversationId": nilIfEmpty(entry.NativeConversationID),
		"originRoomId":         nilIfEmpty(entry.OriginRoomID),
	}
	if entry.Type == "user" {
		result["text"] = entry.UserText
		return result
	}
	if entry.ResolvedText != "" {
		result["text"] = entry.ResolvedText
		result["turnId"] = nilIfEmpty(entry.NativeTurnID)
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

func (manager *RoomManager) referenceTextLocked(room RoomRecord, projected []RoomEntryRecord, ids []string) ([]string, []string) {
	entries := map[string]RoomEntryRecord{}
	members := map[string]RoomMemberRecord{}
	for _, entry := range projected {
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
			if entry.ResolvedText != "" {
				text = entry.ResolvedText
			} else if view, available := manager.resolver.Resolve(member, entry); available {
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
	return buildRoomAgentTextForRoom("", text, references, missing)
}

func buildRoomAgentTextForRoom(roomID, text string, references, missing []string) string {
	parts := []string{
		"You are being addressed as a member of a Glad group chat. Only the explicitly quoted messages below are shared context; do not assume you can see the rest of the room.",
	}
	if roomID != "" {
		parts = append(parts, "<glad_group_origin>\n"+roomID+"\n</glad_group_origin>")
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

// RequestDispatchFailure reports a synchronous rejection by every mentioned
// member. A later failed agent turn was already accepted and is not a send error.
func (manager *RoomManager) RequestDispatchFailure(id, clientID string) string {
	room, err := manager.GetRecord(id)
	if err != nil {
		return err.Error()
	}
	start := -1
	for index := len(room.Entries) - 1; index >= 0; index-- {
		entry := room.Entries[index]
		if entry.Type == "user" && (clientID == "" || entry.ClientMessageID == clientID) {
			start = index
			break
		}
	}
	if start < 0 {
		return ""
	}
	attempted := 0
	failures := []string{}
	for _, entry := range room.Entries[start+1:] {
		if entry.Type == "user" {
			break
		}
		if entry.Type != "session" {
			continue
		}
		attempted++
		if entry.Status == "failed" && entry.Error != "" {
			failures = append(failures, entry.Error)
		}
	}
	if attempted > 0 && len(failures) == attempted {
		return strings.Join(uniqueStrings(failures), "; ")
	}
	return ""
}
