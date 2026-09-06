package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	sessioncore "glad-web/internal/session"
)

type Provider interface {
	Start(context.Context) error
	Send(context.Context, ProviderInput) error
	Close(context.Context) error
}

type ApprovalProvider interface {
	Approve(context.Context, string, string, map[string]any) error
}

type SettingsProvider interface {
	UpdateSettings(context.Context, map[string]any) error
}

type CodexGlobalSettingsProvider interface {
	WriteGlobalDefaults(context.Context) (map[string]any, error)
}

type InterruptProvider interface {
	Interrupt(context.Context) error
}

type ResumeProvider interface {
	Resume(context.Context, string) error
}

type ForkProvider interface {
	Fork(context.Context, string) (string, error)
}

type CompactProvider interface {
	Compact(context.Context) error
}

type StatusProvider interface {
	Status(context.Context) error
}

type ProviderInput struct {
	ClientMessageID string
	Text            string
	AgentText       string
	Images          []Attachment
	Files           []Attachment
	Skills          []map[string]any
}

type Attachment struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path,omitempty"`
	Size      int64  `json:"size"`
	MediaType string `json:"mediaType,omitempty"`
}

type Permission struct {
	ID           string         `json:"id"`
	Status       string         `json:"status"`
	Title        string         `json:"title"`
	ToolName     string         `json:"toolName"`
	DisplayName  string         `json:"displayName,omitempty"`
	Description  string         `json:"description,omitempty"`
	Reason       string         `json:"reason,omitempty"`
	BlockedPath  string         `json:"blockedPath,omitempty"`
	CanAllowTool bool           `json:"canAllowTool"`
	CanAllowEdit bool           `json:"canAllowEdits,omitempty"`
	CanBypass    bool           `json:"canBypass,omitempty"`
	Input        map[string]any `json:"input"`
	ToolUseID    string         `json:"toolUseId,omitempty"`
	CreatedAt    int64          `json:"createdAt"`
}

type TimedInput struct {
	ID        string      `json:"id"`
	Text      string      `json:"text"`
	SendAt    int64       `json:"sendAt"`
	CreatedAt int64       `json:"createdAt"`
	Status    string      `json:"status"`
	Error     string      `json:"error,omitempty"`
	Timer     *time.Timer `json:"-"`
	revision  string
}

type sendResult struct {
	Accepted bool
	Error    string
}

type Session struct {
	mu                            sync.RWMutex
	commandMu                     sync.Mutex
	ctx                           context.Context
	cancel                        context.CancelFunc
	closeOnce                     sync.Once
	closed                        bool
	ID                            string
	Name                          string
	NameManual                    bool
	Kind                          string
	Tool                          ToolInfo
	WorkingDirectory              string
	StartTime                     int64
	StatusValue                   string
	State                         map[string]any
	Messages                      []map[string]any
	Permissions                   map[string]Permission
	CompletedPermissions          []Permission
	HasUnreadCompletion           bool
	ServerChanNotificationEnabled bool
	TimedInputs                   map[string]*TimedInput
	Attachments                   map[string]Attachment
	Uploads                       map[string]*ChunkUpload
	Provider                      Provider
	dispose                       func()
	events                        *sessioncore.EventHub
	sendResults                   map[string]sendResult
}

func newSession(id, name, kind string, tool ToolInfo, workingDirectory string) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{
		ctx: ctx, cancel: cancel,
		ID: id, Name: name, Kind: kind, Tool: tool, WorkingDirectory: workingDirectory,
		StartTime: millis(), StatusValue: "idle", State: map[string]any{"status": "idle"},
		Messages: []map[string]any{}, Permissions: map[string]Permission{},
		CompletedPermissions: []Permission{}, TimedInputs: map[string]*TimedInput{},
		Attachments: map[string]Attachment{}, Uploads: map[string]*ChunkUpload{},
		events:      sessioncore.NewEventHub(),
		sendResults: map[string]sendResult{},
	}
}

func (session *Session) setAutomaticName(name string) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || session.NameManual || name == "" || session.Name == name {
		return
	}
	session.Name = name
	session.publishLocked(map[string]any{"type": "session-renamed", "name": name})
}

func (session *Session) listItem() map[string]any {
	session.mu.RLock()
	defer session.mu.RUnlock()
	timed := 0
	for _, item := range session.TimedInputs {
		if item.SendAt > millis() || item.Status == "failed" {
			timed++
		}
	}
	return map[string]any{
		"id": session.ID, "name": session.Name, "tool": session.Tool.DisplayName,
		"startTime": session.StartTime, "toolKey": session.Tool.Key, "status": session.StatusValue,
		"workingDirectory": session.WorkingDirectory, "mode": "structured",
		"hasUnreadCompletion":           session.HasUnreadCompletion,
		"serverChanNotificationEnabled": session.ServerChanNotificationEnabled,
		"timedInputCount":               timed,
	}
}

func (session *Session) snapshot() map[string]any {
	session.mu.RLock()
	defer session.mu.RUnlock()
	return session.snapshotLocked()
}

func (session *Session) snapshotLocked() map[string]any {
	messages := make([]map[string]any, len(session.Messages))
	for index, message := range session.Messages {
		messages[index] = publicMessage(message, session.Kind)
	}
	permissions := make([]Permission, 0, len(session.CompletedPermissions)+len(session.Permissions))
	permissions = append(permissions, session.CompletedPermissions...)
	for _, item := range session.Permissions {
		permissions = append(permissions, item)
	}
	return map[string]any{
		"id": session.ID, "name": session.Name, "tool": session.Tool.DisplayName,
		"toolKey": session.Tool.Key, "status": session.StatusValue,
		"state": cloneMap(session.State), "messages": messages,
		"pendingPermissions": permissions,
	}
}

func (session *Session) subscribeWithSnapshot(capacity int) (*sessioncore.Subscription, map[string]any) {
	session.mu.RLock()
	defer session.mu.RUnlock()
	subscription := session.events.Subscribe(session.ID, capacity)
	return subscription, session.snapshotLocked()
}

func publicMessage(message map[string]any, kind string) map[string]any {
	copy := cloneMap(message)
	delete(copy, "agentText")
	hasDetail := false
	if kind == "codex-structured" {
		if copy["kind"] == "tool" {
			for _, key := range []string{"result", "input", "changes", "error", "agentsStates"} {
				if copy[key] != nil && stringValue(copy[key]) != "" {
					hasDetail = true
				}
				delete(copy, key)
			}
		}
		if copy["kind"] == "reasoning" {
			hasDetail = stringValue(copy["text"]) != ""
			delete(copy, "text")
		}
		copy["hasDetail"] = hasDetail
		copy["detailRevision"] = copy["updatedAt"]
		if copy["detailRevision"] == nil {
			copy["detailRevision"] = copy["createdAt"]
		}
	}
	return copy
}

func (session *Session) removeMessagesByClientMessageID(id string) {
	if id == "" {
		return
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	kept := session.Messages[:0]
	removed := false
	for _, message := range session.Messages {
		if stringValue(message["clientMessageId"]) == id {
			removed = true
			continue
		}
		kept = append(kept, message)
	}
	session.Messages = kept
	messages := make([]map[string]any, len(session.Messages))
	for index, message := range session.Messages {
		messages[index] = publicMessage(message, session.Kind)
	}
	if removed {
		session.publishLocked(map[string]any{"type": "history-reset", "messages": messages})
	}
	session.mu.Unlock()
}

func (session *Session) appendMessage(message map[string]any) map[string]any {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil
	}
	if message["id"] == nil {
		message["id"] = newUUID()
	}
	if message["createdAt"] == nil {
		message["createdAt"] = millis()
	}
	session.Messages = append(session.Messages, message)
	public := publicMessage(message, session.Kind)
	session.publishLocked(map[string]any{"type": "message", "message": public})
	session.mu.Unlock()
	return message
}

func (session *Session) replaceMessages(messages []map[string]any) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return false
	}
	public := make([]map[string]any, len(messages))
	for index, message := range messages {
		public[index] = publicMessage(message, session.Kind)
	}
	session.Messages = messages
	session.publishLocked(map[string]any{"type": "history-reset", "messages": public})
	return true
}

func (session *Session) patchMessage(id string, patch map[string]any) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	var public map[string]any
	for _, message := range session.Messages {
		if stringValue(message["id"]) != id {
			continue
		}
		for key, value := range patch {
			message[key] = value
		}
		message["updatedAt"] = millis()
		public = publicMessage(message, session.Kind)
		break
	}
	if public != nil {
		session.publishLocked(map[string]any{"type": "message-updated", "message": public})
	}
	session.mu.Unlock()
}

func (session *Session) setState(patch map[string]any) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	for key, value := range patch {
		session.State[key] = value
	}
	if status := stringValue(patch["status"]); status != "" {
		session.StatusValue = status
	}
	state := cloneMap(session.State)
	session.publishLocked(map[string]any{"type": "state", "state": state})
	session.mu.Unlock()
}

func (session *Session) addPermission(permission Permission) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.Permissions[permission.ID] = permission
	session.StatusValue = "waiting_approval"
	session.State["status"] = "waiting_approval"
	session.State["pendingPermissionCount"] = len(session.Permissions)
	state := cloneMap(session.State)
	session.publishLocked(map[string]any{"type": "permission-request", "request": permission, "state": state})
	session.mu.Unlock()
}

func (session *Session) finishPermission(id, status, decision string) (Permission, bool) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return Permission{}, false
	}
	permission, ok := session.Permissions[id]
	if ok {
		delete(session.Permissions, id)
		permission.Status = status
		encoded := map[string]any{}
		bytes, _ := jsonMarshal(permission)
		_ = jsonUnmarshal(bytes, &encoded)
		encoded["decision"] = decision
		bytes, _ = jsonMarshal(encoded)
		_ = jsonUnmarshal(bytes, &permission)
		session.CompletedPermissions = append(session.CompletedPermissions, permission)
		if len(session.CompletedPermissions) > 50 {
			session.CompletedPermissions = session.CompletedPermissions[len(session.CompletedPermissions)-50:]
		}
		session.State["pendingPermissionCount"] = len(session.Permissions)
	}
	if ok {
		state := cloneMap(session.State)
		session.publishLocked(map[string]any{"type": "permission-updated", "request": permission, "state": state})
	}
	session.mu.Unlock()
	return permission, ok
}

func (session *Session) publishLocked(event map[string]any) {
	session.events.Publish(sessioncore.Event{SessionID: session.ID, Kind: session.Kind, Payload: event})
}

func (session *Session) emit(event map[string]any) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if !session.closed {
		session.publishLocked(event)
	}
}

func (session *Session) detail(ids []string, threadID string) map[string]any {
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	items := []map[string]any{}
	for _, message := range session.Messages {
		if wanted[stringValue(message["id"])] || (threadID != "" && stringValue(message["threadId"]) == threadID) {
			copy := cloneMap(message)
			copy["detailLoaded"] = true
			items = append(items, copy)
		}
	}
	return map[string]any{"messages": items, "threadId": nilIfEmpty(threadID)}
}

type SessionManager struct {
	mu       sync.RWMutex
	baseDir  string
	config   *ConfigStore
	sessions map[string]*Session
	creating map[string]struct{}
	events   *sessioncore.EventHub
}

func NewSessionManager(baseDir string) *SessionManager {
	return &SessionManager{
		baseDir: baseDir, sessions: map[string]*Session{}, creating: map[string]struct{}{},
		events: sessioncore.NewEventHub(),
	}
}

func (manager *SessionManager) Events() *sessioncore.EventHub { return manager.events }

func (manager *SessionManager) List() []map[string]any {
	manager.mu.RLock()
	items := make([]*Session, 0, len(manager.sessions))
	for _, session := range manager.sessions {
		items = append(items, session)
	}
	manager.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].StartTime < items[j].StartTime })
	result := make([]map[string]any, 0, len(items))
	for _, session := range items {
		result = append(result, session.listItem())
	}
	return result
}

func (manager *SessionManager) Get(id string) *Session {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	return manager.sessions[id]
}

func (manager *SessionManager) Create(ctx context.Context, request CreateSessionRequest) (*Session, error) {
	tool, ok := toolByKey(request.ToolKey)
	if !ok || !tool.Installed {
		return nil, fmt.Errorf("%s is not installed", request.ToolKey)
	}
	directory := manager.baseDir
	if strings.TrimSpace(request.WorkingDirectory) != "" {
		if filepath.IsAbs(request.WorkingDirectory) {
			directory = filepath.Clean(request.WorkingDirectory)
		} else {
			directory = filepath.Join(manager.baseDir, request.WorkingDirectory)
		}
	}
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("directory does not exist: %s", directory)
	}
	id := request.ID
	if id == "" {
		id = newUUID()
	}
	manager.mu.Lock()
	if manager.sessions[id] != nil {
		manager.mu.Unlock()
		return nil, fmt.Errorf("session already exists: %s", id)
	}
	if _, exists := manager.creating[id]; exists {
		manager.mu.Unlock()
		return nil, fmt.Errorf("session is already being created: %s", id)
	}
	manager.creating[id] = struct{}{}
	manager.mu.Unlock()
	defer func() {
		manager.mu.Lock()
		delete(manager.creating, id)
		manager.mu.Unlock()
	}()
	kind := request.ToolKey + "-structured"
	if request.ToolKey == "claude-code" {
		kind = "claude-structured"
	}
	name := request.Name
	if name == "" {
		name = tool.DisplayName
	}
	session := newSession(id, name, kind, tool, directory)
	session.NameManual = strings.TrimSpace(request.Name) != ""
	session.events = manager.events
	if request.ToolKey == "codex" {
		options := manager.codexOptions(request.CodexOptions)
		provider := NewCodexProvider(session, options)
		provider.defaultsStore = manager.config
		session.Provider = provider
	} else {
		session.Provider = NewClaudeProvider(session, request.ClaudeOptions)
	}
	if err := session.Provider.Start(ctx); err != nil {
		_ = session.Provider.Close(context.Background())
		session.cancel()
		return nil, err
	}
	manager.mu.Lock()
	manager.sessions[id] = session
	manager.mu.Unlock()
	return session, nil
}

func (manager *SessionManager) codexOptions(overrides map[string]any) map[string]any {
	options := map[string]any{}
	if manager.config != nil {
		for key, value := range mapValue(manager.config.Get("codexDefaults")) {
			if normalized, err := normalizeCodexSettings(map[string]any{key: value}); err == nil {
				options[key] = normalized[key]
			}
		}
	}
	for key, value := range overrides {
		options[key] = value
	}
	return options
}

func (manager *SessionManager) Delete(ctx context.Context, id string) bool {
	manager.mu.Lock()
	session := manager.sessions[id]
	delete(manager.sessions, id)
	manager.mu.Unlock()
	if session == nil {
		return false
	}
	session.closeOnce.Do(func() {
		session.mu.Lock()
		session.closed = true
		for _, item := range session.TimedInputs {
			if item.Timer != nil {
				item.Timer.Stop()
			}
		}
		session.mu.Unlock()
		session.cancel()
		_ = session.Provider.Close(ctx)
		if session.dispose != nil {
			session.dispose()
		}
	})
	manager.events.Publish(sessioncore.Event{
		SessionID: session.ID, Kind: session.Kind, Payload: map[string]any{"type": "session-closed"},
	})
	manager.events.CloseSession(id)
	cleanupSessionAttachments(session)
	return true
}

func (manager *SessionManager) Close(ctx context.Context) {
	manager.mu.RLock()
	ids := make([]string, 0, len(manager.sessions))
	for id := range manager.sessions {
		ids = append(ids, id)
	}
	manager.mu.RUnlock()
	for _, id := range ids {
		manager.Delete(ctx, id)
	}
}

type CreateSessionRequest struct {
	ID               string         `json:"-"`
	ToolKey          string         `json:"toolKey"`
	WorkingDirectory string         `json:"workingDirectory"`
	Name             string         `json:"name"`
	ClaudeOptions    map[string]any `json:"claudeOptions"`
	CodexOptions     map[string]any `json:"codexOptions"`
}

func cloneMap(source map[string]any) map[string]any {
	result := make(map[string]any, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
func nilIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func jsonMarshal(value any) ([]byte, error)       { return json.Marshal(value) }
func jsonUnmarshal(bytes []byte, value any) error { return json.Unmarshal(bytes, value) }
