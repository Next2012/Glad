package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"reflect"
	"sort"
	"time"
)

// 仅投影现有运行期身份；冻结/授权/预算由BotLink原pause/resume记录持有。
type managedRuntimeClient struct {
	SessionID            string               `json:"session_id"`
	ToolKey              string               `json:"tool_key"`
	NativeConversationID string               `json:"native_conversation_id"`
	WorkingDirectory     string               `json:"working_directory"`
	RoomBindings         []managedRuntimeRoom `json:"room_bindings"`
	SessionName          string               `json:"session_name"`
	SessionNameManual    bool                 `json:"session_name_manual"`
	ProcessID            int                  `json:"process_id"`
	ShouldRestore        bool                 `json:"should_restore"`
	SessionOptions       map[string]any       `json:"session_options"`
}

type managedRuntimeRoom struct {
	RoomRuntimeID string `json:"room_runtime_id"`
	RoomHistoryID string `json:"room_history_id"`
	MemberID      string `json:"member_id"`
}

type managedRuntimeResumeKey struct{}

// 冻结真正影响原客户端行为的已有选项；派生速度标识和启动resume参数不复制。
func managedRuntimeOptions(provider *CodexProvider) map[string]any {
	options := map[string]any{}
	for _, key := range []string{"model", "effort", "serviceTier", "permissionMode", "sandboxMode", "developerInstructions"} {
		if value, ok := provider.options[key].(string); ok {
			options[key] = value
		}
	}
	for key, inherited := range map[string]string{"permissionMode": "configPermissionMode", "sandboxMode": "configSandboxMode"} {
		if options[key] == nil || options[key] == "default" {
			if value, ok := provider.options[inherited].(string); ok {
				options[key] = value
			}
		}
	}
	return options
}

func (server *Server) managedRuntimeClients() ([]managedRuntimeClient, error) {
	rooms, err := server.rooms.List()
	if err != nil {
		return nil, err
	}
	server.rooms.mu.Lock()
	for _, runtime := range server.rooms.runtimes {
		if len(runtime.timers) != 0 || runtime.operation != "" || runtime.aborting {
			server.rooms.mu.Unlock()
			return nil, errors.New("original room has pending work")
		}
	}
	server.rooms.mu.Unlock()
	memberships := map[string][]managedRuntimeRoom{}
	for _, row := range rooms {
		room, err := server.rooms.GetRecord(stringValue(row["id"]))
		if err != nil {
			return nil, err
		}
		for _, member := range room.Members {
			if member.LeftAt != 0 {
				continue
			}
			if member.RuntimeSessionID != "" {
				memberships[member.RuntimeSessionID] = append(memberships[member.RuntimeSessionID], managedRuntimeRoom{RoomRuntimeID: stringValue(row["id"]), RoomHistoryID: room.ID, MemberID: member.ID})
			}
		}
	}
	server.sessions.mu.RLock()
	sessions := make([]*Session, 0, len(server.sessions.sessions))
	for _, session := range server.sessions.sessions {
		sessions = append(sessions, session)
	}
	server.sessions.mu.RUnlock()
	clients := []managedRuntimeClient{}
	for _, session := range sessions {
		provider, ok := session.Provider.(*CodexProvider)
		if !ok {
			return nil, errors.New("running provider has no managed resume capability")
		}
		provider.mu.Lock()
		if provider.managedResumeRejected || provider.sending || provider.turnID != "" || len(provider.activeTurns) != 0 || provider.resumeInFlight || provider.aborting || provider.forking || provider.capacityRetryTimer != nil || len(provider.permissions) != 0 || len(provider.userInputs) != 0 {
			provider.mu.Unlock()
			return nil, errors.New("original client is busy")
		}
		native, pid := provider.threadID, 0
		options := managedRuntimeOptions(provider)
		if provider.cmd != nil && provider.cmd.Process != nil {
			pid = provider.cmd.Process.Pid
		}
		provider.mu.Unlock()
		provider.titles.mu.Lock()
		titleBusy := provider.titles.status == "running"
		provider.titles.mu.Unlock()
		if titleBusy {
			return nil, errors.New("original title operation is busy")
		}
		session.mu.RLock()
		closed, status, name, nameManual, questions := session.closed, session.StatusValue, session.Name, session.NameManual, len(session.Permissions)+int(numberInt64(session.State["pendingQuestionCount"]))
		for _, timed := range session.TimedInputs {
			if timed.Timer != nil || timed.Status == "pending" {
				questions++
			}
		}
		session.mu.RUnlock()
		if closed {
			continue
		}
		if status == "running" || status == "thinking" || status == "waiting_approval" || status == "waiting_input" || questions != 0 {
			return nil, errors.New("original client is busy")
		}
		client := managedRuntimeClient{RoomBindings: memberships[session.ID]}
		if client.RoomBindings == nil {
			client.RoomBindings = []managedRuntimeRoom{}
		}
		sort.Slice(client.RoomBindings, func(i, j int) bool {
			return client.RoomBindings[i].RoomRuntimeID < client.RoomBindings[j].RoomRuntimeID
		})
		client.SessionName = name
		client.SessionNameManual = nameManual
		client.SessionID = session.ID
		client.ToolKey = session.Tool.Key
		client.NativeConversationID = native
		client.WorkingDirectory = session.WorkingDirectory
		client.ProcessID = pid
		client.ShouldRestore = pid > 0
		client.SessionOptions = options
		for _, binding := range client.RoomBindings {
			room, err := server.rooms.GetHistoryRecord(binding.RoomHistoryID)
			if err != nil {
				return nil, err
			}
			found := false
			for _, member := range room.Members {
				if member.ID == binding.MemberID && member.LeftAt == 0 && member.NativeConversationID == native && member.RuntimeSessionID == session.ID {
					found = true
				}
			}
			if !found {
				return nil, errors.New("original room/native binding differs")
			}
		}
		clients = append(clients, client)
	}
	sort.Slice(clients, func(i, j int) bool { return clients[i].SessionID < clients[j].SessionID })
	return clients, nil
}

func (server *Server) registerManagedRuntimeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/managed-runtime/clients", func(w http.ResponseWriter, r *http.Request) {
		clients, err := server.managedRuntimeClients()
		if err != nil {
			respondError(w, http.StatusConflict, errors.New("original client state unavailable"))
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{"schema": "glad.managed-runtime-clients/v1", "process_id": os.Getpid(), "clients": clients})
	})
	mux.HandleFunc("POST /api/managed-runtime/resume", server.resumeManagedRuntime)
}

func (server *Server) resumeManagedRuntime(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Deadline time.Time              `json:"deadline"`
		Clients  []managedRuntimeClient `json:"clients"`
	}
	if err := decodeJSON(r, &input); err != nil || input.Deadline.IsZero() || len(input.Clients) > 64 {
		respondError(w, http.StatusBadRequest, errors.New("invalid original client restore input"))
		return
	}
	if !time.Now().Before(input.Deadline) || input.Deadline.Sub(time.Now()) > 5*time.Minute {
		respondError(w, http.StatusConflict, errors.New("original restore deadline expired or differs"))
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), input.Deadline)
	defer cancel()
	ctx = context.WithValue(ctx, managedRuntimeResumeKey{}, true)
	metadata := map[string]managedResumeMetadata{}
	unknown := map[string]bool{}
	account := func(id string, session *Session) {
		if session == nil {
			metadata[id] = managedResumeMetadata{}
			return
		}
		provider := session.Provider.(*CodexProvider)
		provider.mu.Lock()
		defer provider.mu.Unlock()
		if provider.managedResumeInvoked && !provider.managedResumeMetadataValid {
			unknown[id] = true
		} else {
			metadata[id] = provider.managedResumeMetadata
		}
	}
	blockedWithCosts := func(message string) {
		unconfirmed, unsent := []string{}, []string{}
		for _, client := range input.Clients {
			if unknown[client.SessionID] {
				unconfirmed = append(unconfirmed, client.SessionID)
			} else if _, known := metadata[client.SessionID]; !known {
				unsent = append(unsent, client.SessionID)
			}
		}
		respondJSON(w, http.StatusConflict, map[string]any{"schema": "glad.managed-runtime-clients/v1", "process_id": os.Getpid(), "state": "blocked", "error": message, "clients": []managedRuntimeClient{}, "resume_metadata": metadata, "unconfirmed_clients": unconfirmed, "unattempted_clients": unsent})
	}
	seen := map[string]bool{}
	// 全部原来源先核同，避免先创建一部分再发现foreign成员。
	for _, client := range input.Clients {
		if !client.ShouldRestore {
			respondError(w, http.StatusConflict, errors.New("inactive original client must stay inactive"))
			return
		}
		if client.SessionID == "" || seen[client.SessionID] || client.ToolKey != "codex" || client.WorkingDirectory == "" {
			respondError(w, http.StatusConflict, errors.New("original client identity is invalid"))
			return
		}
		seen[client.SessionID] = true
		if client.RoomBindings == nil || len(client.RoomBindings) > 64 {
			respondError(w, http.StatusConflict, errors.New("original room bindings missing or exceed bound"))
			return
		}
		if client.SessionOptions == nil {
			respondError(w, http.StatusConflict, errors.New("original client options are missing"))
			return
		}

		if session := server.sessions.Get(client.SessionID); session != nil {
			provider, ok := session.Provider.(*CodexProvider)
			if !ok {
				respondError(w, http.StatusConflict, errors.New("existing provider differs"))
				return
			}
			provider.mu.Lock()
			valid := !provider.closed && !provider.managedResumeRejected && !provider.sending && provider.turnID == "" && len(provider.activeTurns) == 0 && !provider.resumeInFlight && !provider.aborting && !provider.forking && provider.capacityRetryTimer == nil && reflect.DeepEqual(managedRuntimeOptions(provider), client.SessionOptions)
			provider.mu.Unlock()
			if !valid || sessionConversationID(session) != client.NativeConversationID || session.WorkingDirectory != client.WorkingDirectory {
				respondError(w, http.StatusConflict, errors.New("existing original client differs"))
				return
			}
		}
		for _, binding := range client.RoomBindings {
			if binding.RoomRuntimeID == "" || binding.RoomHistoryID == "" || binding.MemberID == "" {
				respondError(w, http.StatusConflict, errors.New("original room mapping incomplete"))
				return
			}
			server.rooms.mu.Lock()
			previous := server.rooms.activeIDs[binding.RoomRuntimeID]
			server.rooms.mu.Unlock()
			if previous != "" && previous != binding.RoomHistoryID {
				respondError(w, http.StatusConflict, errors.New("original room routing differs"))
				return
			}
			room, err := server.rooms.GetHistoryRecord(binding.RoomHistoryID)
			if err != nil {
				respondError(w, http.StatusConflict, errors.New("original room is missing"))
				return
			}
			found := false
			for _, member := range room.Members {
				if member.ID == binding.MemberID && member.LeftAt == 0 && member.ToolKey == client.ToolKey && member.NativeConversationID == client.NativeConversationID && member.WorkingDirectory == client.WorkingDirectory && member.RuntimeSessionID == client.SessionID {
					found = true
				}
			}
			if !found {
				respondError(w, http.StatusConflict, errors.New("original room member differs"))
				return
			}
		}
	}
	for _, client := range input.Clients {
		if ctx.Err() != nil {
			blockedWithCosts("original restore deadline expired")
			return
		}
		session := server.sessions.Get(client.SessionID)
		if session != nil {
			if sessionConversationID(session) != client.NativeConversationID || session.WorkingDirectory != client.WorkingDirectory {
				respondError(w, http.StatusConflict, errors.New("existing client differs"))
				return
			}
			provider := session.Provider.(*CodexProvider)
			provider.mu.Lock()
			resumeRequired := provider.cmd == nil || provider.needsThreadResume
			if provider.managedResumeRejected {
				provider.mu.Unlock()
				respondError(w, http.StatusConflict, errors.New("original client has an unconfirmed prior resume"))
				return
			}
			provider.mu.Unlock()
			if resumeRequired {
				var err error
				if client.NativeConversationID == "" {
					err = provider.Start(ctx)
				} else {
					err = provider.Resume(ctx, client.NativeConversationID)
				}
				if err != nil {
					account(client.SessionID, session)
					_ = provider.Close(ctx)
					blockedWithCosts("original client transport resume failed")
					return
				}
			}
			provider.mu.Lock()
			metadata[client.SessionID] = managedResumeMetadata{}
			if resumeRequired {
				metadata[client.SessionID] = provider.managedResumeMetadata
			}
			provider.mu.Unlock()
			for _, binding := range client.RoomBindings {
				server.rooms.mu.Lock()
				server.rooms.activeIDs[binding.RoomRuntimeID] = binding.RoomHistoryID
				server.rooms.runtimeLocked(binding.RoomRuntimeID)
				server.rooms.mu.Unlock()
			}
			continue
		}
		request := CreateSessionRequest{ID: client.SessionID, Name: client.SessionName, ToolKey: client.ToolKey, WorkingDirectory: client.WorkingDirectory, CodexOptions: cloneMap(client.SessionOptions)}
		session, err := server.sessions.Create(ctx, request)
		if err == nil {
			// Create把显式名称视作手动命名，受管续接须恢复原标志。
			session.mu.Lock()
			session.NameManual = client.SessionNameManual
			session.mu.Unlock()
		}
		if err == nil && client.NativeConversationID != "" {
			provider, ok := session.Provider.(ResumeProvider)
			if !ok {
				err = errors.New("original provider has no resume capability")
			} else {
				err = provider.Resume(ctx, client.NativeConversationID)
			}
			if err == nil && sessionConversationID(session) != client.NativeConversationID {
				err = errors.New("native conversation changed")
			}
		}
		if err != nil {
			account(client.SessionID, session)
			if session != nil {
				provider := session.Provider.(*CodexProvider)
				// 保原SID的拒绝状态，避免下次把已拒尾部重新封成原历史。
				_ = provider.Close(ctx)
			}
			blockedWithCosts("original native client resume failed")
			return
		}
		provider := session.Provider.(*CodexProvider)
		provider.mu.Lock()
		metadata[client.SessionID] = provider.managedResumeMetadata
		provider.mu.Unlock()
		for _, binding := range client.RoomBindings {
			// 只重建原运行期路由；原持久room/member/native数据不新增或改ID。
			server.rooms.mu.Lock()
			if previous := server.rooms.activeIDs[binding.RoomRuntimeID]; previous != "" && previous != binding.RoomHistoryID {
				server.rooms.mu.Unlock()
				respondError(w, http.StatusConflict, errors.New("original room routing differs"))
				return
			}
			server.rooms.activeIDs[binding.RoomRuntimeID] = binding.RoomHistoryID
			server.rooms.runtimeLocked(binding.RoomRuntimeID)
			server.rooms.mu.Unlock()
		}
	}
	clients, err := server.managedRuntimeClients()
	if err != nil || ctx.Err() != nil {
		blockedWithCosts("restored client observation failed")
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"schema": "glad.managed-runtime-clients/v1", "process_id": os.Getpid(), "clients": clients, "resume_metadata": metadata})
}
