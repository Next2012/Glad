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

	"github.com/coder/websocket"
)

type Provider interface {
	Start(context.Context) error
	Send(context.Context, ProviderInput) error
	Approve(context.Context, string, string, map[string]any) error
	UpdateSettings(context.Context, map[string]any) error
	Interrupt(context.Context) error
	Resume(context.Context, string) error
	Fork(context.Context, string) (string, error)
	Compact(context.Context) error
	Status(context.Context) error
	Close(context.Context) error
}

type ProviderInput struct {
	Text      string
	AgentText string
	Images    []Attachment
	Files     []Attachment
	Skills    []map[string]any
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
	Timer     *time.Timer `json:"-"`
}

type Session struct {
	mu                            sync.RWMutex
	ID                            string
	Name                          string
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
	Clients                       map[*websocket.Conn]struct{}
	Provider                      Provider
	dispose                       func()
	eventHook                     func(*Session, map[string]any)
}

func newSession(id, name, kind string, tool ToolInfo, workingDirectory string) *Session {
	return &Session{
		ID: id, Name: name, Kind: kind, Tool: tool, WorkingDirectory: workingDirectory,
		StartTime: millis(), StatusValue: "idle", State: map[string]any{"status": "idle"},
		Messages: []map[string]any{}, Permissions: map[string]Permission{},
		CompletedPermissions: []Permission{}, TimedInputs: map[string]*TimedInput{},
		Attachments: map[string]Attachment{}, Uploads: map[string]*ChunkUpload{},
		Clients: map[*websocket.Conn]struct{}{},
	}
}

func (session *Session) listItem() map[string]any {
	session.mu.RLock()
	defer session.mu.RUnlock()
	timed := 0
	for _, item := range session.TimedInputs {
		if item.SendAt > millis() {
			timed++
		}
	}
	return map[string]any{
		"id": session.ID, "name": session.Name, "tool": session.Tool.DisplayName,
		"startTime": session.StartTime, "toolKey": session.Tool.Key,
		"workingDirectory": session.WorkingDirectory, "mode": "structured",
		"hasUnreadCompletion":           session.HasUnreadCompletion,
		"serverChanNotificationEnabled": session.ServerChanNotificationEnabled,
		"timedInputCount":               timed,
	}
}

func (session *Session) snapshot() map[string]any {
	session.mu.RLock()
	defer session.mu.RUnlock()
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

func publicMessage(message map[string]any, kind string) map[string]any {
	copy := cloneMap(message)
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

func (session *Session) appendMessage(message map[string]any) map[string]any {
	session.mu.Lock()
	if message["id"] == nil {
		message["id"] = newUUID()
	}
	if message["createdAt"] == nil {
		message["createdAt"] = millis()
	}
	session.Messages = append(session.Messages, message)
	public := publicMessage(message, session.Kind)
	session.mu.Unlock()
	session.emit(map[string]any{"type": "message", "message": public})
	return message
}

func (session *Session) patchMessage(id string, patch map[string]any) {
	session.mu.Lock()
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
	session.mu.Unlock()
	if public != nil {
		session.emit(map[string]any{"type": "message-updated", "message": public})
	}
}

func (session *Session) setState(patch map[string]any) {
	session.mu.Lock()
	for key, value := range patch {
		session.State[key] = value
	}
	if status := stringValue(patch["status"]); status != "" {
		session.StatusValue = status
	}
	state := cloneMap(session.State)
	session.mu.Unlock()
	session.emit(map[string]any{"type": "state", "state": state})
}

func (session *Session) addPermission(permission Permission) {
	session.mu.Lock()
	session.Permissions[permission.ID] = permission
	session.StatusValue = "waiting_approval"
	session.State["status"] = "waiting_approval"
	session.State["pendingPermissionCount"] = len(session.Permissions)
	session.mu.Unlock()
	session.emit(map[string]any{"type": "permission-request", "request": permission})
}

func (session *Session) finishPermission(id, status, decision string) (Permission, bool) {
	session.mu.Lock()
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
	session.mu.Unlock()
	if ok {
		session.emit(map[string]any{"type": "permission-updated", "request": permission})
	}
	return permission, ok
}

func (session *Session) emit(event map[string]any) {
	typeName := "claude-event"
	if session.Kind == "codex-structured" {
		typeName = "codex-event"
	}
	session.broadcast(map[string]any{"type": typeName, "event": event})
	if session.eventHook != nil {
		go session.eventHook(session, event)
	}
}

func (session *Session) broadcast(message map[string]any) {
	session.mu.RLock()
	clients := make([]*websocket.Conn, 0, len(session.Clients))
	for client := range session.Clients {
		clients = append(clients, client)
	}
	session.mu.RUnlock()
	for _, client := range clients {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = writeWSJSON(ctx, client, message)
		cancel()
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
	mu        sync.RWMutex
	baseDir   string
	sessions  map[string]*Session
	eventHook func(*Session, map[string]any)
}

func NewSessionManager(baseDir string) *SessionManager {
	return &SessionManager{baseDir: baseDir, sessions: map[string]*Session{}}
}

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
	kind := request.ToolKey + "-structured"
	if request.ToolKey == "claude-code" {
		kind = "claude-structured"
	}
	name := request.Name
	if name == "" {
		name = tool.DisplayName
	}
	session := newSession(id, name, kind, tool, directory)
	session.eventHook = manager.eventHook
	if request.ToolKey == "codex" {
		session.Provider = NewCodexProvider(session, request.CodexOptions)
	} else {
		session.Provider = NewClaudeProvider(session, request.ClaudeOptions)
	}
	manager.mu.Lock()
	manager.sessions[id] = session
	manager.mu.Unlock()
	if err := session.Provider.Start(ctx); err != nil {
		manager.mu.Lock()
		delete(manager.sessions, id)
		manager.mu.Unlock()
		return nil, err
	}
	return session, nil
}

func (manager *SessionManager) Delete(ctx context.Context, id string) bool {
	manager.mu.Lock()
	session := manager.sessions[id]
	delete(manager.sessions, id)
	manager.mu.Unlock()
	if session == nil {
		return false
	}
	for _, item := range session.TimedInputs {
		item.Timer.Stop()
	}
	_ = session.Provider.Close(ctx)
	if session.dispose != nil {
		session.dispose()
	}
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
	ID               string         `json:"id"`
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
