package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"
)

func managedTestServer(t *testing.T) *Server {
	t.Helper()
	store, err := OpenRoomStoreAt(filepath.Join(t.TempDir(), "rooms"))
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(t.TempDir())
	return &Server{sessions: sessions, rooms: NewRoomManager(store, sessions, NewAttachmentStore())}
}

func TestManagedRuntimeInactiveAndRoomWorkAreExplicit(t *testing.T) {
	server := managedTestServer(t)
	session := newSession(newUUID(), "original", "codex-structured", ToolInfo{Key: "codex"}, server.sessions.baseDir)
	provider := NewCodexProvider(session, nil)
	provider.threadID = "existing-thread"
	session.Provider = provider
	server.sessions.sessions[session.ID] = session
	clients, err := server.managedRuntimeClients()
	if err != nil || len(clients) != 1 || clients[0].ShouldRestore || clients[0].ProcessID != 0 {
		t.Fatal("inactive client was lost or forced", err)
	}
	room, err := server.rooms.Create("original")
	if err != nil {
		t.Fatal(err)
	}
	server.rooms.mu.Lock()
	server.rooms.runtimeLocked(room.ID).operation = "resume"
	server.rooms.mu.Unlock()
	if _, err := server.managedRuntimeClients(); err == nil {
		t.Fatal("room operation was ignored")
	}
}

func TestManagedRuntimeWrongMemberAndExpiredBudgetDoNotCreate(t *testing.T) {
	server := managedTestServer(t)
	for _, body := range []map[string]any{
		{"deadline": time.Now().Add(-time.Second), "clients": []managedRuntimeClient{}},
		{"deadline": time.Now().Add(time.Minute), "clients": []managedRuntimeClient{{SessionID: "old", ToolKey: "codex", WorkingDirectory: server.sessions.baseDir, ShouldRestore: true, RoomBindings: []managedRuntimeRoom{{MemberID: "foreign", RoomHistoryID: "missing", RoomRuntimeID: "unknown"}}, SessionOptions: map[string]any{}}}},
	} {
		raw, _ := json.Marshal(body)
		r := httptest.NewRecorder()
		server.resumeManagedRuntime(r, httptest.NewRequest("POST", "/api/managed-runtime/resume", bytes.NewReader(raw)))
		if r.Code == 200 || len(server.sessions.sessions) != 0 {
			t.Fatal("unknown member or deadline authorized create")
		}
	}
}

// 仅显式本地fixture启用：真实原生CLI、原wrapper和生产Hub，不调用模型。
func TestManagedRuntimeNativeColdExistingRoom(t *testing.T) {
	binary := os.Getenv("D211_NATIVE_CODEX")
	wrapper := os.Getenv("D211_NATIVE_WRAPPER")
	if binary == "" || wrapper == "" {
		t.Skip("requires fixed local native inputs")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	bin := filepath.Join(root, "bin")
	codexHome := filepath.Join(root, "codex-home")
	for _, p := range []string{home, bin, codexHome} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	// 独立补核：合成原配置有明确默认值，恢复须保持原配置文件字节。
	originalConfig := []byte("model_reasoning_effort = \"low\"\napproval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\n")
	configPath := filepath.Join(codexHome, "config.toml")
	if err := os.WriteFile(configPath, originalConfig, 0600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("BOTLINK_CODEX_BIN", binary)
	launcher := "#!/bin/sh\nexec node '" + wrapper + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(launcher), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("RUST_LOG", "off")
	beforeTools := supportedTools
	supportedTools = []ToolInfo{{Key: "codex", Command: "codex", DisplayName: "Codex"}}
	defer func() { supportedTools = beforeTools }()
	server := managedTestServer(t)
	server.rooms.Start(context.Background())
	defer func() { server.rooms.Stop() }()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	session, err := server.sessions.Create(ctx, CreateSessionRequest{ID: newUUID(), ToolKey: "codex", WorkingDirectory: server.sessions.baseDir})
	if err != nil {
		t.Fatal("native original create", err)
	}
	provider := session.Provider.(*CodexProvider)
	// 原客户端采用非默认模型/策略，防仅比较Go缓存掩盖native设置漂移。
	provider.mu.Lock()
	originalModel := stringValue(provider.options["model"])
	for _, candidate := range provider.models {
		if id := stringValue(candidate["id"]); id != "" && id != originalModel {
			originalModel = id
			break
		}
	}
	provider.options["model"] = originalModel
	provider.options["effort"] = "high"
	provider.options["permissionMode"] = "never"
	provider.options["sandboxMode"] = "read-only"
	provider.mu.Unlock()
	startParams := map[string]any{"cwd": session.WorkingDirectory, "ephemeral": false, "model": originalModel, "approvalPolicy": "never", "sandbox": "read-only", "config": map[string]any{"tools.update_plan.enabled": true, "model_reasoning_effort": "high"}}
	result, err := provider.rpc(ctx, "thread/start", startParams)
	if err != nil {
		t.Fatal("synthetic original fixture", err)
	}
	native := stringValue(mapValue(result["thread"])["id"])
	// 合成已持久原历史仅作测试输入，真实CLI读取/恢复；零模型turn请求。
	rollout := stringValue(mapValue(result["thread"])["path"])
	if rollout == "" {
		t.Fatal("original native rollout path missing")
	}
	directory := filepath.Dir(rollout)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(rollout, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(file)
	turnID := newUUID()
	for _, row := range []map[string]any{
		{"timestamp": "2026-10-14T00:00:00Z", "type": "session_meta", "payload": map[string]any{"id": native, "timestamp": "2026-10-14T00:00:00Z", "cwd": session.WorkingDirectory, "originator": "codex_cli_rs", "cli_version": "test", "source": "cli", "model_provider": "openai"}},
		{"timestamp": "2026-10-14T00:00:01Z", "type": "event_msg", "payload": map[string]any{"type": "task_started", "turn_id": turnID}},
		{"timestamp": "2026-10-14T00:00:02Z", "type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "synthetic historical request"}}}},
		{"timestamp": "2026-10-14T00:00:02Z", "type": "event_msg", "payload": map[string]any{"type": "user_message", "message": "synthetic historical request", "images": []any{}, "local_images": []any{}, "text_elements": []any{}}},
		{"timestamp": "2026-10-14T00:00:02Z", "type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "synthetic historical completion"}}}},
		{"timestamp": "2026-10-14T00:00:03Z", "type": "event_msg", "payload": map[string]any{"type": "task_complete", "turn_id": turnID, "last_agent_message": "synthetic historical completion"}},
	} {
		if err := encoder.Encode(row); err != nil {
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	originalRollout, _ := os.ReadFile(rollout)
	userFile := filepath.Join(server.sessions.baseDir, "user-document.txt")
	userBytes := []byte("synthetic original user document")
	if err := os.WriteFile(userFile, userBytes, 0600); err != nil {
		t.Fatal(err)
	}
	provider.mu.Lock()
	provider.threadID = native
	provider.mu.Unlock()
	provider.updatePublicState("idle")
	room, err := server.rooms.Create("original")
	if err != nil {
		t.Fatal(err)
	}
	secondRoom, err := server.rooms.Create("original-second")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.rooms.AddSession(secondRoom.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	member, err := server.rooms.AddSession(room.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if member.NativeConversationID != native {
		t.Fatal("original fixture native association missing")
	}
	clients, err := server.managedRuntimeClients()
	if err != nil || len(clients) != 1 || !clients[0].ShouldRestore {
		t.Fatal("native capture", err)
	}
	originalFile := filepath.Join(server.rooms.store.(*FileRoomStore).directory, room.ID+".json")
	originalBytes, _ := os.ReadFile(originalFile)
	secondFile := filepath.Join(server.rooms.store.(*FileRoomStore).directory, secondRoom.ID+".json")
	secondBytes, _ := os.ReadFile(secondFile)
	closeOriginalRuntime := func() {
		if !server.sessions.Delete(ctx, session.ID) {
			t.Error("original native close")
		}
		if stopped, err := os.ReadFile(rollout); err != nil || !bytes.Equal(stopped, originalRollout) {
			t.Error("original sealed history changed before resume")
		}
		server.sessions = NewSessionManager(server.sessions.baseDir)
		server.rooms.Stop()
		server.rooms = NewRoomManager(server.rooms.store, server.sessions, NewAttachmentStore())
		server.rooms.Start(context.Background())
		if os.Getenv("D211_NATIVE_CASE") == "missing-history" {
			_ = os.Remove(rollout)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("local fixture port", err)
	}
	mux := http.NewServeMux()
	server.registerManagedRuntimeRoutes(mux)
	mux.HandleFunc("POST /_fixture/stop-original", func(w http.ResponseWriter, r *http.Request) { closeOriginalRuntime(); w.WriteHeader(204) })
	httpServer := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, r)
		if recorder.Code >= 400 {
			t.Logf("managed fixture response: %d %s", recorder.Code, recorder.Body.String())
		}
		for key, values := range recorder.Header() {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
	})}
	go httpServer.Serve(listener)
	defer httpServer.Close()
	input, _ := json.Marshal(clients)
	exe, _ := os.Executable()
	script := os.Getenv("D211_NATIVE_RESUMER")
	// 测试只替换固定本地端口，保生产PID/exe/FD及原身份校验，不占已有3000服务。
	port := listener.Addr().(*net.TCPAddr).Port
	loader := "const f=require('fs'),v=require('vm');const s=f.readFileSync(process.argv[1],'utf8');if(!s.includes('port=3000'))throw Error('source differs');v.runInThisContext(s.replace('.catch(()=>{process.stderr.write', '.catch(e=>{console.error(e.message);process.stderr.write').replace('port=3000','port=" + strconv.Itoa(port) + "'),{filename:process.argv[1]});"
	var command *exec.Cmd
	if bridge := os.Getenv("D211_NATIVE_SDK_BRIDGE"); bridge != "" {
		command = exec.CommandContext(ctx, os.Getenv("D211_NATIVE_PYTHON"), "-B", bridge, os.Getenv("D211_NATIVE_MODULE"), strconv.Itoa(port), os.Getenv("D211_NATIVE_CASE"))
	} else {
		closeOriginalRuntime()
		command = exec.CommandContext(ctx, "node", "-e", loader, script, "resume", "20")
		command.Stdin = bytes.NewReader(input)
	}
	command.Env = append(os.Environ(), "BOTLINK_GLAD_BIN="+exe)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("real cold resume failed: %s", output)
	}
	if os.Getenv("D211_NATIVE_CASE") == "missing-history" {
		if current := server.sessions.Get(session.ID); current != nil && !current.Provider.(*CodexProvider).managedResumeRejected {
			t.Fatal("missing original history escaped blocked")
		}
		t.Logf("actual SDK original Grant blocked on missing original history: %s", output)
		return
	}
	t.Log("actual original SDK/Glad result received")
	defer server.sessions.Delete(context.Background(), session.ID)
	current := server.sessions.Get(session.ID)
	if current == nil || current.NameManual != session.NameManual || current.Name != session.Name || sessionConversationID(current) != native || (!server.rooms.IsActive(room.ID) || !server.rooms.IsActive(secondRoom.ID)) {
		t.Fatal("original runtime/native/room not restored")
	}
	if after, _ := os.ReadFile(originalFile); !bytes.Equal(originalBytes, after) {
		t.Fatal("original room data changed")
	}
	if after, _ := os.ReadFile(secondFile); !bytes.Equal(secondBytes, after) {
		t.Fatal("second original room data changed")
	}
	current.mu.RLock()
	historyLoaded := false
	for _, message := range current.Messages {
		if message["kind"] == "user" && message["text"] == "synthetic historical request" {
			historyLoaded = true
		}
	}
	current.mu.RUnlock()
	if !historyLoaded {
		t.Fatal("actual original history was not loaded")
	}
	restoredProvider := current.Provider.(*CodexProvider)
	if after, err := os.ReadFile(userFile); err != nil || !bytes.Equal(after, userBytes) {
		t.Fatal("original user file changed")
	}
	seal, err := sealManagedHistory(ctx, rollout)
	if err != nil {
		t.Fatal("original history observation", err)
	}
	_ = seal
	after, err := os.ReadFile(rollout)
	if err != nil || !bytes.HasPrefix(after, originalRollout) {
		t.Fatal("original history prefix changed")
	}
	metadata := restoredProvider.managedResumeMetadata
	if !metadata.PrefixPreserved || metadata.OriginalBytes != int64(len(originalRollout)) || metadata.AppendedRecords != 1 || metadata.AppendedBytes != int64(len(after)-len(originalRollout)) {
		t.Fatal("restore metadata fee/count unconfirmed")
	}
	for _, key := range []string{"model", "modelProvider", "reasoningEffort", "approvalPolicy", "sandbox", "cwd"} {
		if !reflect.DeepEqual(result[key], restoredProvider.managedResumeSettings[key]) {
			t.Fatal("actual native original settings changed:", key)
		}
	}
	t.Logf("A320 original prefix/user files/native settings preserved; settings records=%d bytes=%d within original Grant", metadata.AppendedRecords, metadata.AppendedBytes)
	if after, err := os.ReadFile(configPath); err != nil || !bytes.Equal(after, originalConfig) {
		t.Fatal("original native config file bytes changed")
	}
	t.Log("independent original config.toml byte equality confirmed")
	if restoredProvider.titles.diagnostics()["attempts"] != 0 {
		t.Fatal("managed restore scheduled a title task")
	}
	// 实际缓存/鉴权仍由原wrapper的生产只读观察核；失败不可用health代签。
	observe := exec.CommandContext(ctx, "node", os.Getenv("D211_NATIVE_OBSERVER"))
	if data, err := observe.CombinedOutput(); err != nil {
		t.Fatalf("actual client use unconfirmed: %s", data)
	}
	t.Log("real native cold original SID/member/thread, unchanged room data, Hub use confirmed, no title task")
}

func TestManagedHistoryOnlyOriginalPrefixAndSettingsAppend(t *testing.T) {
	for _, fault := range []string{"none", "prefix", "task", "truncated", "twice", "oversize", "expired", "replace"} {
		t.Run(fault, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "original.jsonl")
			original := []byte("{\"type\":\"session_meta\"}\n")
			if err := os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			seal, err := sealManagedHistory(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			tail := []byte("{\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_settings_applied\",\"thread_id\":\"native\"}}\n")
			switch fault {
			case "prefix":
				original[0] = 'x'
			case "task":
				tail = bytes.ReplaceAll(tail, []byte("thread_settings_applied"), []byte("task_started"))
			case "truncated":
				tail = tail[:len(tail)-1]
			case "twice":
				tail = append(tail, tail...)
			case "oversize":
				tail = bytes.Repeat([]byte{'x'}, managedResumeMetadataLimit+1)
			case "replace":
				if err := os.Rename(path, path+".old"); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(path, append(original, tail...), 0600); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			if fault == "expired" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			metrics, err := seal.observe(ctx, "native")
			if fault == "none" {
				if err != nil || !metrics.PrefixPreserved || metrics.AppendedRecords != 1 || metrics.AppendedBytes != int64(len(tail)) {
					t.Fatal("authorized settings append rejected", err)
				}
			} else if err == nil {
				t.Fatal("unauthorized mutation accepted")
			}
		})
	}
}

func TestManagedRuntimeActiveChildIsNotIdle(t *testing.T) {
	server := managedTestServer(t)
	session := newSession(newUUID(), "original", "codex-structured", ToolInfo{Key: "codex"}, server.sessions.baseDir)
	provider := NewCodexProvider(session, nil)
	session.Provider = provider
	server.sessions.sessions[session.ID] = session
	provider.handleNotification("turn/started", map[string]any{"threadId": "child", "turn": map[string]any{"id": "child-turn"}})
	if _, err := server.managedRuntimeClients(); err == nil {
		t.Fatal("active child accepted as idle")
	}
}

// 独立合成：原生恢复写入非法尾部后失败，重入须继续拒绝同原客户端。
func TestManagedRejectedAppendCannotBecomeExistingSuccess(t *testing.T) {
	server := managedTestServer(t)
	session := newSession(newUUID(), "original", "codex-structured", ToolInfo{Key: "codex"}, server.sessions.baseDir)
	provider := NewCodexProvider(session, nil)
	session.Provider = provider
	server.sessions.sessions[session.ID] = session
	provider.threadID = "native-original"
	provider.updatePublicState("idle")
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	provider.cmd = cmd
	writes := make(chan []byte, 8)
	provider.stdin = &channelWriteCloser{writes: writes}
	rollout := filepath.Join(t.TempDir(), "original.jsonl")
	original := []byte("{\"type\":\"session_meta\"}\n")
	if err := os.WriteFile(rollout, original, 0600); err != nil {
		t.Fatal(err)
	}
	clients, err := server.managedRuntimeClients()
	if err != nil || len(clients) != 1 {
		t.Fatal("fixture capture", err)
	}
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), managedRuntimeResumeKey{}, true), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- provider.Resume(ctx, "native-original") }()
	for _, method := range []string{"thread/read", "thread/resume"} {
		select {
		case raw := <-writes:
			var request map[string]any
			if err := json.Unmarshal(raw, &request); err != nil {
				t.Fatal(err)
			}
			if request["method"] != method {
				t.Fatal("unexpected fixture RPC", request["method"])
			}
			if method == "thread/resume" {
				tail := []byte("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n")
				if err := os.WriteFile(rollout, append(original, tail...), 0600); err != nil {
					t.Fatal(err)
				}
			}
			provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"thread": map[string]any{"id": "native-original", "path": rollout}}})
		case <-ctx.Done():
			t.Fatal("fixture timed out")
		}
	}
	if err := <-done; err == nil {
		t.Fatal("first restore should reject unauthorized append")
	}
	provider.mu.Lock()
	needsResume, live := provider.needsThreadResume, provider.cmd != nil
	provider.mu.Unlock()
	if !needsResume || !live {
		t.Fatal("unexpected failed restore state")
	}
	raw, _ := json.Marshal(map[string]any{"deadline": time.Now().Add(time.Second), "clients": clients})
	recorder := httptest.NewRecorder()
	server.resumeManagedRuntime(recorder, httptest.NewRequest("POST", "/api/managed-runtime/resume", bytes.NewReader(raw)))
	if recorder.Code == 200 {
		t.Fatal("rejected native append became restored success because existing live cmd skipped original resume guard")
	}
}

// 合成app-server进程：首轮追加未授权事件，第二轮追加合法设置；不调用模型。
func TestIndependentManagedNativePeer(t *testing.T) {
	root := os.Getenv("D211_REVIEW_PEER_ROOT")
	if root == "" {
		t.Skip("synthetic child only")
	}
	decoder, encoder := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var req map[string]any
		if decoder.Decode(&req) != nil {
			return
		}
		if req["id"] == nil {
			continue
		}
		result := map[string]any{}
		switch req["method"] {
		case "config/read":
			result["config"] = map[string]any{}
		case "model/list":
			result["data"] = []any{}
		case "thread/read", "thread/resume":
			path := filepath.Join(root, "rollout.jsonl")
			if req["method"] == "thread/resume" {
				event := "task_started"
				if _, err := os.Stat(filepath.Join(root, "attempted")); err == nil {
					event = "thread_settings_applied"
				}
				file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					return
				}
				_ = json.NewEncoder(file).Encode(map[string]any{"type": "event_msg", "payload": map[string]any{"type": event, "thread_id": "native-original"}})
				_ = file.Close()
				_ = os.WriteFile(filepath.Join(root, "attempted"), []byte("1"), 0600)
			}
			turn := map[string]any{"id": "old-turn", "items": []any{map[string]any{"id": "old-user", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "synthetic original content"}}}}}
			result = map[string]any{"cwd": os.Getenv("D211_REVIEW_PEER_CWD"), "thread": map[string]any{"id": "native-original", "path": path, "turns": []any{turn}}, "initialTurnsPage": map[string]any{"data": []any{turn}, "nextCursor": nil}}
		}
		if encoder.Encode(map[string]any{"id": req["id"], "result": result}) != nil {
			return
		}
	}
}

func TestIndependentManagedRejectedNewSIDCannotResealBadTail(t *testing.T) {
	root := t.TempDir()
	server := managedTestServer(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "codex")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec '"+exe+"' -test.run=^TestIndependentManagedNativePeer$\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("D211_REVIEW_PEER_ROOT", root)
	t.Setenv("D211_REVIEW_PEER_CWD", server.sessions.baseDir)
	before := supportedTools
	supportedTools = []ToolInfo{{Key: "codex", Command: script, DisplayName: "Codex"}}
	defer func() { supportedTools = before }()
	if err := os.WriteFile(filepath.Join(root, "rollout.jsonl"), []byte("{\"type\":\"session_meta\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	id := newUUID()
	clients := []managedRuntimeClient{{SessionID: id, ToolKey: "codex", NativeConversationID: "native-original", WorkingDirectory: server.sessions.baseDir, RoomBindings: []managedRuntimeRoom{}, SessionName: "original", SessionNameManual: true, ShouldRestore: true, ProcessID: 1, SessionOptions: map[string]any{"serviceTier": "default"}}}
	defer server.sessions.Delete(context.Background(), id)
	for attempt := 1; attempt <= 2; attempt++ {
		raw, _ := json.Marshal(map[string]any{"deadline": time.Now().Add(4 * time.Second), "clients": clients})
		recorder := httptest.NewRecorder()
		server.resumeManagedRuntime(recorder, httptest.NewRequest("POST", "/api/managed-runtime/resume", bytes.NewReader(raw)))
		t.Logf("attempt %d HTTP %d; session_exists=%v", attempt, recorder.Code, server.sessions.Get(id) != nil)
		if recorder.Code == 200 {
			t.Fatal("cold new SID discarded rejection on cleanup and resealed previously rejected tail as original prefix")
		}
	}
}

func TestIndependentCostPeer(t *testing.T) {
	root := os.Getenv("D211_REVIEW_COST_ROOT")
	if root == "" {
		t.Skip("synthetic child only")
	}
	decoder, encoder := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var req map[string]any
		if decoder.Decode(&req) != nil {
			return
		}
		if req["id"] == nil {
			continue
		}
		result := map[string]any{}
		switch req["method"] {
		case "config/read":
			result["config"] = map[string]any{}
		case "model/list":
			result["data"] = []any{}
		case "thread/read", "thread/resume":
			native := stringValue(mapValue(req["params"])["threadId"])
			path := filepath.Join(root, native+".jsonl")
			if req["method"] == "thread/resume" {
				file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					return
				}
				_ = json.NewEncoder(file).Encode(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "thread_settings_applied", "thread_id": native}})
				_ = file.Close()
			}
			turn := map[string]any{"id": "old-turn", "items": []any{map[string]any{"id": "old-user", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "synthetic original content"}}}}}
			result = map[string]any{"cwd": os.Getenv("D211_REVIEW_COST_CWD"), "thread": map[string]any{"id": native, "path": path, "turns": []any{turn}}, "initialTurnsPage": map[string]any{"data": []any{turn}, "nextCursor": nil}}
		}
		if encoder.Encode(map[string]any{"id": req["id"], "result": result}) != nil {
			return
		}
	}
}

// 部分客户端先成功，后一个缺历史；真实追加须保归首attempt。
func TestIndependentManagedPartialFailureKeepsEarlierCosts(t *testing.T) {
	root := t.TempDir()
	server := managedTestServer(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "codex")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec '"+exe+"' -test.run=^TestIndependentCostPeer$\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("D211_REVIEW_COST_ROOT", root)
	t.Setenv("D211_REVIEW_COST_CWD", server.sessions.baseDir)
	before := supportedTools
	supportedTools = []ToolInfo{{Key: "codex", Command: script, DisplayName: "Codex"}}
	defer func() { supportedTools = before }()
	original := []byte("{\"type\":\"session_meta\"}\n")
	first := filepath.Join(root, "first.jsonl")
	if err := os.WriteFile(first, original, 0600); err != nil {
		t.Fatal(err)
	}
	clients := []managedRuntimeClient{}
	for _, native := range []string{"first", "second"} {
		id := newUUID()
		defer server.sessions.Delete(context.Background(), id)
		clients = append(clients, managedRuntimeClient{SessionID: id, ToolKey: "codex", NativeConversationID: native, WorkingDirectory: server.sessions.baseDir, RoomBindings: []managedRuntimeRoom{}, SessionName: "original", SessionNameManual: true, ShouldRestore: true, ProcessID: 1, SessionOptions: map[string]any{"serviceTier": "default"}})
	}
	raw, _ := json.Marshal(map[string]any{"deadline": time.Now().Add(4 * time.Second), "clients": clients})
	recorder := httptest.NewRecorder()
	server.resumeManagedRuntime(recorder, httptest.NewRequest("POST", "/api/managed-runtime/resume", bytes.NewReader(raw)))
	if recorder.Code != 409 {
		t.Fatal("expected second client's missing history to fail")
	}
	after, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) <= len(original) {
		t.Fatal("fixture did not append first native settings")
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	t.Logf("partial failure HTTP %d; first client appended bytes=%d; metadata_present=%v", recorder.Code, len(after)-len(original), response["resume_metadata"] != nil)
	if response["resume_metadata"] == nil {
		t.Fatal("earlier successful native settings append disappeared from failed-attempt response")
	}
}
