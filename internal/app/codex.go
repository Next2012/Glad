package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

type codexRPCResult struct {
	Result map[string]any
	Err    error
}
type codexPendingPermission struct {
	RPCID  any
	Method string
	Params map[string]any
}
type codexActiveTurn struct {
	ID        string
	StartedAt int64
}

const maxCodexToolOutputBytes = 8 << 20
const defaultCodexAbortGrace = 5 * time.Second
const codexHealthInterval = 15 * time.Second
const codexHealthTimeout = 5 * time.Second
const codexHistoryOperationTimeout = 2 * time.Minute
const maxCodexHistoryPages = 100000

const codexOutputTruncatedMarker = "\n… output truncated by Glad …\n"

type codexDeltaStream struct {
	messageID string
	builder   strings.Builder
	limit     int
	truncated bool
}

func (stream *codexDeltaStream) append(delta string) bool {
	if delta == "" || stream.truncated {
		return false
	}
	if stream.limit <= 0 || stream.builder.Len()+len(delta) <= stream.limit {
		stream.builder.WriteString(delta)
		return true
	}
	available := stream.limit - stream.builder.Len() - len(codexOutputTruncatedMarker)
	if available > len(delta) {
		available = len(delta)
	}
	for available > 0 && !utf8.ValidString(delta[:available]) {
		available--
	}
	if available > 0 {
		stream.builder.WriteString(delta[:available])
	}
	stream.builder.WriteString(codexOutputTruncatedMarker)
	stream.truncated = true
	return true
}

func (stream *codexDeltaStream) text() string { return stream.builder.String() }

type CodexProvider struct {
	titles            *codexTitles
	mu                sync.Mutex
	eventMu           sync.Mutex
	streamMu          sync.Mutex
	session           *Session
	options           map[string]any
	defaultsStore     *ConfigStore
	cmd               *exec.Cmd
	stdin             io.WriteCloser
	pending           map[int64]chan codexRPCResult
	permissions       map[string]codexPendingPermission
	userInputs        map[string]codexPendingUserInput
	requestID         atomic.Int64
	threadID          string
	turnID            string
	turnStarted       int64
	activeTurns       map[string]codexActiveTurn
	models            []map[string]any
	tokenUsage        map[string]any
	streams           map[string]*codexDeltaStream
	expectedStops     map[*exec.Cmd]struct{}
	resumeCancel      context.CancelFunc
	resuming          bool
	forking           bool
	resumeInFlight    bool
	resumeAborted     bool
	aborting          bool
	needsThreadResume bool
	abortSequence     uint64
	abortGrace        time.Duration
	closed            bool
}

func NewCodexProvider(session *Session, options map[string]any) *CodexProvider {
	if options == nil {
		options = map[string]any{}
	}
	provider := &CodexProvider{
		session:       session,
		options:       options,
		pending:       map[int64]chan codexRPCResult{},
		permissions:   map[string]codexPendingPermission{},
		userInputs:    map[string]codexPendingUserInput{},
		activeTurns:   map[string]codexActiveTurn{},
		streams:       map[string]*codexDeltaStream{},
		expectedStops: map[*exec.Cmd]struct{}{},
		threadID:      stringValue(options["resume"]),
		abortGrace:    defaultCodexAbortGrace,
	}
	provider.titles = newCodexTitles(provider)
	return provider
}

func (provider *CodexProvider) Start(ctx context.Context) error {
	provider.mu.Lock()
	err := provider.startLocked(ctx)
	provider.mu.Unlock()
	if err != nil {
		return err
	}
	provider.updatePublicState("idle")
	return nil
}

func (provider *CodexProvider) startLocked(ctx context.Context) error {
	if provider.closed {
		return errors.New("Codex session is closed")
	}
	if provider.aborting {
		return errors.New("Codex session is stopping")
	}
	if provider.cmd != nil {
		return nil
	}
	command := exec.Command(provider.session.Tool.Command, "app-server", "--stdio")
	configureProcess(command)
	command.Dir = provider.session.WorkingDirectory
	command.Env = os.Environ()
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := enlargeCodexOutputPipe(stdout); err != nil {
		logDebug("[codex] could not enlarge app-server output pipe: %v", err)
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	provider.cmd, provider.stdin = command, stdin
	done := make(chan struct{})
	go provider.readStdout(command, stdout)
	go provider.readStderr(stderr)
	go func() {
		defer close(done)
		provider.wait(command)
	}()
	go provider.monitorTransport(command, done, codexHealthInterval, codexHealthTimeout)
	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	initializeParams := map[string]any{
		"clientInfo":   map[string]any{"name": "glad-web", "title": "Glad", "version": buildVersion},
		"capabilities": map[string]any{"experimentalApi": true},
	}
	if _, err := provider.requestLocked(initCtx, "initialize", initializeParams); err != nil {
		provider.expectedStops[command] = struct{}{}
		killProcessTree(command)
		if provider.cmd == command {
			provider.cmd = nil
			provider.stdin = nil
		}
		return err
	}
	_ = provider.notifyLocked("initialized", map[string]any{})
	config, _ := provider.requestLocked(
		initCtx,
		"config/read",
		map[string]any{"cwd": provider.session.WorkingDirectory, "includeLayers": false},
	)
	provider.applyConfig(mapValue(config["config"]))
	_ = provider.refreshModelsLocked(initCtx)
	if provider.cmd != command {
		return errors.New("Codex connection closed during initialization")
	}
	provider.titles.mu.Lock()
	provider.titles.enabled = true
	provider.titles.mu.Unlock()
	return nil
}

func (provider *CodexProvider) Send(ctx context.Context, input ProviderInput) error {
	provider.mu.Lock()
	if provider.closed || provider.resumeInFlight || provider.aborting {
		provider.mu.Unlock()
		return errors.New("Codex session is unavailable")
	}
	if provider.cmd == nil {
		if err := provider.startLocked(ctx); err != nil {
			provider.mu.Unlock()
			return err
		}
	}
	if provider.turnID != "" {
		provider.mu.Unlock()
		return errors.New("Codex session is busy")
	}
	if provider.threadID == "" {
		params := map[string]any{"cwd": provider.session.WorkingDirectory}
		provider.applyThreadOptions(params)
		started, err := provider.requestLocked(ctx, "thread/start", params)
		if err != nil {
			provider.mu.Unlock()
			return err
		}
		provider.threadID = stringValue(mapValue(started["thread"])["id"])
		if provider.threadID == "" {
			provider.threadID = stringValue(started["threadId"])
		}
		provider.needsThreadResume = false
	} else if provider.needsThreadResume {
		params := map[string]any{
			"threadId": provider.threadID, "cwd": provider.session.WorkingDirectory, "excludeTurns": true,
			"config": codexPlanConfig(),
		}
		provider.applyDeveloperInstructions(params)
		_, err := provider.requestLocked(
			ctx,
			"thread/resume",
			params,
		)
		if err != nil {
			provider.mu.Unlock()
			return fmt.Errorf("resume Codex after restart: %w", err)
		}
		provider.needsThreadResume = false
	}
	items := []any{}
	for _, skill := range input.Skills {
		if stringValue(skill["name"]) != "" && stringValue(skill["path"]) != "" {
			items = append(items, map[string]any{"type": "skill", "name": skill["name"], "path": skill["path"]})
		}
	}
	if strings.TrimSpace(input.AgentText) != "" {
		items = append(items, map[string]any{"type": "text", "text": input.AgentText})
	}
	attachments := []map[string]any{}
	for _, image := range input.Images {
		items = append(items, map[string]any{"type": "localImage", "path": image.Path})
		attachments = append(attachments, map[string]any{"id": image.ID, "name": image.Name})
	}
	for _, file := range input.Files {
		attachments = append(
			attachments,
			map[string]any{"id": file.ID, "name": file.Name, "size": file.Size, "kind": "file"},
		)
	}
	if len(items) > 0 {
		provider.session.appendMessage(
			map[string]any{
				"kind": "user", "text": input.Text, "agentText": input.AgentText,
				"attachments": attachments, "skills": input.Skills, "clientMessageId": input.ClientMessageID,
			},
		)
	}
	params := map[string]any{
		"threadId": provider.threadID,
		"input":    items,
		"cwd":      provider.session.WorkingDirectory,
		"summary":  "auto",
	}
	provider.applyTurnOptions(params)
	started, err := provider.requestLocked(ctx, "turn/start", params)
	if err != nil {
		provider.mu.Unlock()
		provider.session.removeMessagesByClientMessageID(input.ClientMessageID)
		provider.session.appendMessage(
			map[string]any{"kind": "event", "level": "error", "text": "Unable to send message: " + err.Error()},
		)
		return err
	}
	provider.session.clearUnreadCompletion()
	provider.turnID = firstNonEmpty(stringValue(mapValue(started["turn"])["id"]), stringValue(started["turnId"]))
	provider.turnStarted = millis()
	provider.updatePublicStateLocked("running")
	provider.mu.Unlock()
	return nil
}

func (provider *CodexProvider) readStdout(command *exec.Cmd, reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		logDebug("[codex-rpc] %s", scanner.Text())
		var message map[string]any
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		provider.handleProcessRPC(command, message)
	}
	// 输出关闭也代表通信结束，不能继续等仍然存活的主进程退出。
	err := scanner.Err()
	if err == nil {
		err = io.EOF
	}
	provider.transportFailed(command, fmt.Errorf("Codex output stream closed: %w", err))
}

// 消息分发和进程清理串行，防止旧 stdout 中残留的通知污染重启后的会话。
func (provider *CodexProvider) handleProcessRPC(command *exec.Cmd, message map[string]any) {
	provider.eventMu.Lock()
	defer provider.eventMu.Unlock()
	provider.mu.Lock()
	current := provider.cmd == command && !provider.closed
	provider.mu.Unlock()
	if current {
		provider.handleRPC(message)
	}
}

func (provider *CodexProvider) readStderr(reader io.Reader) {
	// 按有界片段持续排空，超长日志不能让 stderr 读取停止并堵住子进程。
	buffer := bufio.NewReaderSize(reader, 64*1024)
	for {
		part, err := buffer.ReadSlice('\n')
		if line := strings.TrimSpace(string(part)); line != "" {
			logDebug("[codex] %s", line)
		}
		if err != nil && err != bufio.ErrBufferFull {
			if err != io.EOF {
				logDebug("[codex] stderr read failed: %v", err)
			}
			return
		}
	}
}

func (provider *CodexProvider) wait(command *exec.Cmd) {
	err := command.Wait()
	if err == nil {
		err = errors.New("Codex app-server exited")
	}
	provider.transportFailed(command, err)
	provider.mu.Lock()
	delete(provider.expectedStops, command)
	provider.mu.Unlock()
}

func (provider *CodexProvider) transportFailed(command *exec.Cmd, err error) {
	provider.mu.Lock()
	// 旧进程的 EOF、探活和退出回调均不能修改新进程的会话状态。
	if provider.closed || provider.cmd != command || command == nil {
		provider.mu.Unlock()
		return
	}
	provider.aborting = true
	provider.abortSequence++
	sequence := provider.abortSequence
	provider.mu.Unlock()
	provider.stopRuntime(sequence, "Codex connection lost: "+err.Error(), "failed")
}

func (provider *CodexProvider) monitorTransport(command *exec.Cmd, done <-chan struct{}, interval, timeout time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-provider.session.ctx.Done():
			return
		case <-ticker.C:
		}
		provider.mu.Lock()
		if provider.cmd != command || provider.closed {
			provider.mu.Unlock()
			return
		}
		// app-server 可能串行处理恢复和分叉 RPC，此时发送探活会把正常慢请求误判为失联。
		// 其他 pending RPC 仍需探活，避免请求超时后遗留一个永久卡死的空闲进程。
		if provider.aborting || provider.resuming || provider.forking || (provider.turnID == "" && len(provider.pending) == 0) {
			provider.mu.Unlock()
			continue
		}
		ctx, cancel := context.WithTimeout(provider.session.ctx, timeout)
		_, err := provider.requestLocked(ctx, "thread/loaded/list", map[string]any{})
		provider.mu.Unlock()
		cancel()
		// RPC 返回错误也说明通信仍通畅；只有探活超时才回收无响应进程。
		if errors.Is(err, context.DeadlineExceeded) {
			provider.transportFailed(command, errors.New("Codex app-server did not respond to a connection check"))
			return
		}
	}
}

func (provider *CodexProvider) failPendingLocked(err error) {
	failCodexRequests(provider.takePendingLocked(), err)
}

func (provider *CodexProvider) takePendingLocked() []chan codexRPCResult {
	channels := make([]chan codexRPCResult, 0, len(provider.pending))
	for id, channel := range provider.pending {
		delete(provider.pending, id)
		channels = append(channels, channel)
	}
	return channels
}

func failCodexRequests(channels []chan codexRPCResult, err error) {
	for _, channel := range channels {
		channel <- codexRPCResult{Err: err}
		close(channel)
	}
}

func (provider *CodexProvider) handleRPC(message map[string]any) {
	if message["id"] != nil && message["method"] == nil {
		id := numberInt64(message["id"])
		provider.mu.Lock()
		channel := provider.pending[id]
		if channel != nil {
			delete(provider.pending, id)
		}
		provider.mu.Unlock()
		provider.titles.receivedResponse(id, mapValue(message["result"]), channel == nil)
		if channel != nil {
			if rawError := mapValue(message["error"]); len(rawError) > 0 {
				channel <- codexRPCResult{Err: errors.New(stringValue(rawError["message"]))}
			} else {
				channel <- codexRPCResult{Result: mapValue(message["result"])}
			}
			close(channel)
		}
		return
	}
	if provider.titles.route(message) {
		return
	}
	if message["id"] != nil && message["method"] != nil {
		provider.handleServerRequest(message)
		return
	}
	if method := stringValue(message["method"]); method != "" {
		provider.handleNotification(method, mapValue(message["params"]))
	}
}

func (provider *CodexProvider) handleServerRequest(message map[string]any) {
	method, params := stringValue(message["method"]), mapValue(message["params"])
	id := stringValue(message["id"])
	if method == "item/tool/requestUserInput" {
		provider.addUserInput(message["id"], params, false)
		return
	}
	if method != "mcpServer/elicitation/request" && method != "item/commandExecution/requestApproval" &&
		method != "item/fileChange/requestApproval" &&
		method != "item/permissions/requestApproval" {
		provider.respondRPC(message["id"], nil)
		return
	}
	permissionID := firstNonEmpty(
		stringValue(params["itemId"]),
		stringValue(params["callId"]),
		stringValue(params["approvalId"]),
		id,
	)
	name := "Command execution"
	if strings.Contains(method, "fileChange") {
		name = "File change"
	}
	if strings.Contains(method, "permissions") {
		name = "Permission request"
	}
	if strings.Contains(method, "elicitation") {
		name = firstNonEmpty(stringValue(params["serverName"]), "MCP tool")
	}
	provider.mu.Lock()
	threadID := firstNonEmpty(stringValue(params["threadId"]), provider.threadID)
	turnID := firstNonEmpty(stringValue(params["turnId"]), provider.turnID)
	provider.permissions[permissionID] = codexPendingPermission{RPCID: message["id"], Method: method, Params: params}
	provider.mu.Unlock()
	provider.session.addPermission(
		Permission{
			ID:           permissionID,
			Status:       "pending",
			Title:        name,
			ToolName:     name,
			ThreadID:     threadID,
			TurnID:       turnID,
			Input:        params,
			Reason:       stringValue(params["reason"]),
			CanAllowTool: strings.Contains(method, "elicitation"),
			CreatedAt:    millis(),
		},
	)
}

func (provider *CodexProvider) handleNotification(method string, params map[string]any) {
	provider.mu.Lock()
	currentThreadID, currentTurnID := provider.threadID, provider.turnID
	provider.mu.Unlock()
	threadID := firstNonEmpty(stringValue(params["threadId"]), currentThreadID)
	turn := mapValue(params["turn"])
	turnID := firstNonEmpty(stringValue(turn["id"]), stringValue(params["turnId"]), currentTurnID)
	switch method {
	case "serverRequest/resolved":
		provider.resolveUserInput(params)
	case "thread/name/updated":
		provider.mu.Lock()
		current := threadID == provider.threadID
		provider.mu.Unlock()
		if current {
			provider.session.setAutomaticName(stringValue(params["threadName"]))
		}
	case "thread/tokenUsage/updated":
		provider.mu.Lock()
		provider.tokenUsage = mapValue(params["tokenUsage"])
		if len(provider.tokenUsage) == 0 {
			provider.tokenUsage = mapValue(params["usage"])
		}
		provider.mu.Unlock()
	case "turn/started":
		provider.mu.Lock()
		rootTurn := threadID != "" && threadID == provider.threadID
		started := timestampMillis(turn["startedAt"])
		if started == 0 {
			started = millis()
		}
		if rootTurn {
			provider.turnID = turnID
			provider.turnStarted = started
		}
		if threadID != "" && turnID != "" {
			provider.activeTurns[threadID] = codexActiveTurn{ID: turnID, StartedAt: started}
		}
		provider.mu.Unlock()
		provider.session.appendMessage(
			map[string]any{"kind": "turn-start", "threadId": threadID, "turnId": turnID, "createdAt": started},
		)
		if rootTurn {
			provider.updatePublicState("running")
		} else {
			provider.refreshPublicState()
		}
	case "turn/plan/updated":
		provider.updatePlan(threadID, turnID, params)
	case "turn/completed":
		provider.mu.Lock()
		rootThread := threadID != "" && threadID == provider.threadID
		rootTurn := rootThread && turnID != "" && turnID == provider.turnID
		started := timestampMillis(turn["startedAt"])
		if tracked, ok := provider.activeTurns[threadID]; ok && tracked.ID == turnID {
			if tracked.StartedAt > 0 {
				started = tracked.StartedAt
			}
			delete(provider.activeTurns, threadID)
		}
		if rootTurn {
			provider.cancelUserInputsLocked("", "", stringValue(turn["status"]) == "completed" && turn["error"] == nil)
			if provider.turnStarted > 0 {
				started = provider.turnStarted
			}
			provider.turnID = ""
			provider.turnStarted = 0
			provider.permissions = map[string]codexPendingPermission{}
			provider.aborting = false
			provider.activeTurns = map[string]codexActiveTurn{}
			provider.abortSequence++
		} else {
			provider.cancelUserInputsLocked(threadID, turnID, false)
		}
		provider.mu.Unlock()
		status := "completed"
		if stringValue(turn["status"]) == "failed" || turn["error"] != nil {
			status = "failed"
		}
		if stringValue(turn["status"]) == "interrupted" {
			status = "cancelled"
		}
		provider.finishPlans(threadID, turnID, status)
		if rootTurn {
			provider.finishPlans("", "", "cancelled")
		}
		completed := timestampMillis(turn["completedAt"])
		if completed == 0 {
			completed = millis()
		}
		duration := numberInt64(turn["durationMs"])
		if duration <= 0 && started > 0 {
			duration = max64(0, completed-started)
		}
		message := map[string]any{
			// 通知资格在事件产生时确定，子任务和旧轮次只保留历史展示。
			"isRootTurn": rootTurn,
			"kind":       "turn-end",
			"threadId":   threadID,
			"turnId":     turnID,
			"status":     status,
			"durationMs": duration,
			"createdAt":  completed,
		}
		if rootTurn {
			message["context"] = provider.contextStatus()
		}
		provider.session.appendMessage(message)
		if rootTurn {
			provider.session.mu.Lock()
			provider.session.Permissions = map[string]Permission{}
			provider.session.mu.Unlock()
			provider.session.markCompletionUnread()
			provider.updatePublicState("idle")
			provider.clearDeltaStreams()
		} else {
			provider.refreshPublicState()
		}
	case "thread/compacted":
		provider.applyItem(
			map[string]any{
				"id":       "compaction-" + turnID,
				"type":     "contextCompaction",
				"threadId": threadID,
				"turnId":   turnID,
			},
			"completed",
		)
	case "thread/started", "thread/resumed":
		provider.mu.Lock()
		if provider.threadID == "" {
			provider.threadID = firstNonEmpty(stringValue(mapValue(params["thread"])["id"]), threadID)
		}
		provider.mu.Unlock()
		provider.updatePublicState(provider.session.StatusValue)
	case "thread/status/changed":
		if stringValue(mapValue(params["status"])["type"]) == "idle" {
			provider.mu.Lock()
			rootThread := threadID != "" && threadID == provider.threadID
			busy := provider.turnID != "" || provider.resumeInFlight || provider.aborting
			provider.mu.Unlock()
			if rootThread && !busy {
				provider.updatePublicState("idle")
			}
		}
	case "thread/settings/updated":
		settings := mapValue(params["threadSettings"])
		provider.mu.Lock()
		for _, key := range []string{"model", "effort", "approvalPolicy", "sandboxPolicy"} {
			if settings[key] != nil {
				provider.options[key] = settings[key]
			}
		}
		provider.mu.Unlock()
		provider.updatePublicState(provider.session.StatusValue)
	case "error":
		text := firstNonEmpty(stringValue(mapValue(params["error"])["message"]), "Codex reported an error.")
		provider.session.appendMessage(map[string]any{"kind": "event", "level": "error", "text": text})
		provider.mu.Lock()
		rootThread := threadID != "" && threadID == provider.threadID
		busy := provider.turnID != "" || provider.resumeInFlight || provider.aborting
		provider.mu.Unlock()
		// Codex owns retry limits and HTTP fallback. Keep active turns running
		// until turn/completed reports the final result.
		if rootThread && !busy && !boolValue(params["willRetry"]) {
			provider.updatePublicState("idle")
		}
	case "warning", "guardianWarning":
		provider.session.appendMessage(
			map[string]any{
				"kind":  "event",
				"level": "warning",
				"text": firstNonEmpty(
					stringValue(params["message"]),
					stringValue(params["warning"]),
					"Codex warning.",
				),
			},
		)
	case "item/commandExecution/outputDelta", "item/fileChange/outputDelta":
		provider.patchProviderItem(stringValue(params["itemId"]), stringValue(params["delta"]))
	default:
		if strings.Contains(method, "agentMessage/delta") || strings.Contains(method, "reasoning/textDelta") ||
			strings.Contains(method, "reasoning/summaryTextDelta") ||
			method == "item/plan/delta" {
			provider.appendDelta(method, params)
			return
		}
		if strings.HasPrefix(method, "item/") {
			status := ""
			if method == "item/started" {
				status = "running"
			}
			if method == "item/completed" {
				status = "completed"
			}
			item := mapValue(params["item"])
			if item["threadId"] == nil {
				item["threadId"] = threadID
			}
			if item["turnId"] == nil {
				item["turnId"] = turnID
			}
			provider.applyItem(item, status)
			if method == "item/completed" && stringValue(item["type"]) == "userMessage" {
				// Match the CLI: start only after Codex has accepted the user
				// item, not immediately after the asynchronous turn/start reply.
				provider.session.mu.RLock()
				text := ""
				for i := len(provider.session.Messages) - 1; i >= 0; i-- {
					if provider.session.Messages[i]["kind"] == "user" {
						text = stringValue(provider.session.Messages[i]["text"])
						break
					}
				}
				provider.session.mu.RUnlock()
				provider.titles.schedule(threadID, text, false)
			}
		}
	}
}

func (provider *CodexProvider) applyItem(raw map[string]any, inferred string) {
	if raw["type"] == "agentMessage" && raw["delivery"] == "async" && len(sliceValue(raw["questions"])) > 0 {
		provider.addUserInput(nil, raw, true)
		return
	}
	itemType, providerID := stringValue(raw["type"]), stringValue(raw["id"])
	threadID := firstNonEmpty(stringValue(raw["threadId"]), provider.threadID)
	turnID := firstNonEmpty(stringValue(raw["turnId"]), provider.turnID)
	kind := ""
	switch itemType {
	case "userMessage":
		kind = "user"
	case "agentMessage":
		kind = "assistant"
	case "reasoning", "plan":
		kind = "reasoning"
	case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall":
		kind = "tool"
	case "contextCompaction":
		kind = "compaction"
	}
	if kind == "" {
		return
	}
	patch := map[string]any{
		"kind":       kind,
		"providerId": providerID,
		"threadId":   nilIfEmpty(threadID),
		"turnId":     nilIfEmpty(turnID),
		"streaming":  false,
	}
	if kind == "user" {
		patch["text"] = textFromCodexInput(raw["content"])
	}
	if kind == "assistant" {
		patch["text"] = stringValue(raw["text"])
	}
	if kind == "reasoning" {
		patch["text"] = firstNonEmpty(stringValue(raw["text"]), strings.Join(stringsFromAny(raw["summary"]), "\n"))
	}
	if kind == "compaction" {
		patch["compactionStatus"] = firstNonEmpty(inferred, stringValue(raw["status"]), "running")
	}
	if kind == "tool" {
		for key, value := range codexToolDetails(raw) {
			patch[key] = value
		}
		if result := stringValue(patch["result"]); result != "" {
			patch["result"] = limitCodexToolOutput(result)
		}
		patch["toolStatus"] = firstNonEmpty(inferred, stringValue(raw["status"]), "running")
		patch["startedAtMs"] = millis()
	}
	streamKind := ""
	if kind == "assistant" || kind == "reasoning" {
		streamKind = kind
	} else if kind == "tool" {
		streamKind = "tool-output"
	}
	streamText, streamMessageID := "", ""
	if streamKind != "" {
		streamText, streamMessageID = provider.deltaStreamSnapshot(streamKind, providerID, inferred == "completed")
	}
	if streamText != "" {
		field := "text"
		if kind == "tool" {
			field = "result"
		}
		if stringValue(patch[field]) == "" {
			patch[field] = streamText
		}
	}
	provider.session.mu.RLock()
	existingID := streamMessageID
	preserveUserText := false
	if existingID == "" {
		for _, message := range provider.session.Messages {
			if stringValue(message["providerId"]) == providerID && providerID != "" {
				existingID = stringValue(message["id"])
				preserveUserText = kind == "user" &&
					(stringValue(message["clientMessageId"]) != "" || stringValue(message["agentText"]) != "")
				break
			}
		}
	}
	provider.session.mu.RUnlock()
	if existingID == "" && kind == "user" {
		provider.session.mu.RLock()
		for index := len(provider.session.Messages) - 1; index >= 0; index-- {
			message := provider.session.Messages[index]
			if stringValue(message["kind"]) == "user" && message["providerId"] == nil &&
				(stringValue(message["text"]) == stringValue(patch["text"]) ||
					stringValue(message["agentText"]) == stringValue(patch["text"])) {
				existingID = stringValue(message["id"])
				preserveUserText = true
				break
			}
		}
		provider.session.mu.RUnlock()
	}
	if existingID != "" {
		if preserveUserText {
			delete(patch, "text")
		}
		provider.session.patchMessage(existingID, patch)
	} else {
		message := provider.session.appendMessage(patch)
		if message != nil && streamKind != "" {
			provider.bindDeltaStream(streamKind, providerID, stringValue(message["id"]))
		}
	}
}

func codexToolDetails(raw map[string]any) map[string]any {
	switch stringValue(raw["type"]) {
	case "commandExecution":
		return map[string]any{
			"name":     "CodexBash",
			"title":    "Command",
			"command":  stringValue(raw["command"]),
			"cwd":      stringValue(raw["cwd"]),
			"input":    map[string]any{"command": raw["command"], "cwd": raw["cwd"]},
			"result":   stringValue(raw["aggregatedOutput"]),
			"exitCode": raw["exitCode"],
		}
	case "fileChange":
		return map[string]any{
			"name":    "CodexPatch",
			"title":   "Apply patch",
			"changes": raw["changes"],
			"input":   map[string]any{"changes": raw["changes"]},
			"result":  "",
		}
	case "mcpToolCall":
		return map[string]any{
			"name":   "McpTool",
			"title":  firstNonEmpty(stringValue(raw["server"])+"."+stringValue(raw["tool"]), "MCP tool"),
			"server": raw["server"],
			"tool":   raw["tool"],
			"input":  raw["arguments"],
			"result": stringValue(raw["result"]),
			"error":  raw["error"],
		}
	default:
		return map[string]any{
			"name":   firstNonEmpty(stringValue(raw["tool"]), stringValue(raw["type"]), "Tool"),
			"title":  firstNonEmpty(stringValue(raw["tool"]), stringValue(raw["type"]), "Tool"),
			"input":  firstNonNil(raw["arguments"], raw["input"], raw),
			"result": stringValue(raw["result"]),
			"error":  raw["error"],
		}
	}
}

func (provider *CodexProvider) appendDelta(method string, params map[string]any) {
	kind := "reasoning"
	if strings.Contains(method, "agentMessage") {
		kind = "assistant"
	}
	providerID := firstNonEmpty(stringValue(params["itemId"]), stringValue(params["id"]))
	delta := stringValue(params["delta"])
	stream := provider.deltaStream(kind, providerID, 0)
	if !stream.append(delta) {
		provider.streamMu.Unlock()
		return
	}
	patch := map[string]any{
		"text":     stream.text(),
		"threadId": params["threadId"],
		"turnId":   firstNonNil(params["turnId"], provider.turnID),
	}
	if stream.messageID != "" {
		provider.session.patchMessage(stream.messageID, patch)
	} else {
		patch["kind"] = kind
		patch["providerId"] = providerID
		patch["streaming"] = true
		message := provider.session.appendMessage(patch)
		if message != nil {
			stream.messageID = stringValue(message["id"])
		}
	}
	provider.streamMu.Unlock()
}
func (provider *CodexProvider) patchProviderItem(id, delta string) {
	stream := provider.deltaStream("tool-output", id, maxCodexToolOutputBytes)
	if !stream.append(delta) {
		provider.streamMu.Unlock()
		return
	}
	if stream.messageID != "" {
		provider.session.patchMessage(stream.messageID, map[string]any{"result": stream.text()})
	}
	provider.streamMu.Unlock()
}

// deltaStream returns a locked accumulator. Callers must unlock streamMu after
// updating the corresponding Session message so stream contents and IDs stay
// ordered with provider notifications.
func (provider *CodexProvider) deltaStream(kind, providerID string, limit int) *codexDeltaStream {
	provider.streamMu.Lock()
	key := kind + "\x00" + providerID
	stream := provider.streams[key]
	if stream == nil {
		stream = &codexDeltaStream{limit: limit}
		provider.session.mu.RLock()
		for _, message := range provider.session.Messages {
			if stringValue(message["providerId"]) != providerID {
				continue
			}
			if kind != "tool-output" && stringValue(message["kind"]) != kind {
				continue
			}
			stream.messageID = stringValue(message["id"])
			field := "text"
			if kind == "tool-output" {
				field = "result"
			}
			stream.append(stringValue(message[field]))
			break
		}
		provider.session.mu.RUnlock()
		provider.streams[key] = stream
	}
	return stream
}

func (provider *CodexProvider) deltaStreamSnapshot(kind, providerID string, remove bool) (string, string) {
	provider.streamMu.Lock()
	defer provider.streamMu.Unlock()
	key := kind + "\x00" + providerID
	stream := provider.streams[key]
	if stream == nil {
		return "", ""
	}
	if remove {
		delete(provider.streams, key)
	}
	return stream.text(), stream.messageID
}

func (provider *CodexProvider) bindDeltaStream(kind, providerID, messageID string) {
	provider.streamMu.Lock()
	if stream := provider.streams[kind+"\x00"+providerID]; stream != nil && stream.messageID == "" {
		stream.messageID = messageID
	}
	provider.streamMu.Unlock()
}

func (provider *CodexProvider) clearDeltaStreams() {
	provider.streamMu.Lock()
	provider.streams = map[string]*codexDeltaStream{}
	provider.streamMu.Unlock()
}

func limitCodexToolOutput(value string) string {
	if len(value) <= maxCodexToolOutputBytes {
		return value
	}
	available := maxCodexToolOutputBytes - len(codexOutputTruncatedMarker)
	for available > 0 && !utf8.ValidString(value[:available]) {
		available--
	}
	return value[:available] + codexOutputTruncatedMarker
}

func (provider *CodexProvider) requestLocked(
	ctx context.Context,
	method string,
	params map[string]any,
) (map[string]any, error) {
	return provider.requestLockedTracked(ctx, method, params, nil)
}

func (provider *CodexProvider) requestLockedTracked(ctx context.Context, method string, params map[string]any, hidden *codexTitleResponse) (result map[string]any, err error) {
	command := provider.cmd
	id := provider.requestID.Add(1)
	channel := make(chan codexRPCResult, 1)
	if hidden != nil {
		hidden.ctx = ctx
		provider.titles.mu.Lock()
		if len(provider.titles.starting)+len(provider.titles.hidden) >= 8 {
			provider.titles.mu.Unlock()
			return nil, errors.New("too many unfinished title threads")
		}
		provider.titles.starting[id] = hidden
		provider.titles.mu.Unlock()
	}
	provider.pending[id] = channel
	if err := provider.writeLocked(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		delete(provider.pending, id)
		provider.titles.receivedResponse(id, nil, false)
		return nil, err
	}
	provider.mu.Unlock()
	defer func() {
		provider.mu.Lock()
		// 响应入队后进程仍可能断开；旧成功结果不能把已清理的会话改回 running。
		if err == nil && (provider.cmd != command || provider.closed) {
			result = nil
			err = errors.New("Codex connection closed before the request completed")
		}
	}()
	select {
	case response := <-channel:
		return response.Result, response.Err
	case <-ctx.Done():
		provider.mu.Lock()
		delete(provider.pending, id)
		provider.mu.Unlock()
		provider.titles.abandon(hidden)
		return nil, ctx.Err()
	}
}
func (provider *CodexProvider) notifyLocked(method string, params map[string]any) error {
	return provider.writeLocked(map[string]any{"method": method, "params": params})
}
func (provider *CodexProvider) writeLocked(value any) error {
	if provider.stdin == nil {
		return errors.New("Codex app-server is not running")
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return err
	}
	bytes = append(bytes, '\n')
	// 管道写入也必须有上限，否则持锁 Write 会阻塞探活和中止操作。
	if pipe, ok := provider.stdin.(*os.File); ok {
		if err := pipe.SetWriteDeadline(time.Now().Add(codexHealthTimeout)); err != nil {
			return err
		}
		defer pipe.SetWriteDeadline(time.Time{})
	}
	_, err = provider.stdin.Write(bytes)
	if err != nil {
		command := provider.cmd
		go provider.transportFailed(command, fmt.Errorf("Codex input write failed: %w", err))
	}
	return err
}
func (provider *CodexProvider) respondRPC(id any, result any) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	_ = provider.writeLocked(map[string]any{"id": id, "result": result})
}

func (provider *CodexProvider) Approve(ctx context.Context, id, decision string, payload map[string]any) error {
	provider.mu.Lock()
	pending, ok := provider.permissions[id]
	if ok {
		delete(provider.permissions, id)
	}
	provider.mu.Unlock()
	if !ok {
		return errors.New("permission request not found")
	}
	approved := decision == "approved" || decision == "approved_for_session" || decision == "accept"
	var result any
	if pending.Method == "mcpServer/elicitation/request" {
		action := "decline"
		if approved {
			action = "accept"
		}
		if decision == "abort" {
			action = "cancel"
		}
		result = map[string]any{"action": action, "content": nil, "_meta": nil}
	} else if pending.Method == "item/permissions/requestApproval" {
		permissions := map[string]any{}
		if approved {
			permissions = mapValue(pending.Params["permissions"])
		}
		scope := "turn"
		if decision == "approved_for_session" {
			scope = "session"
		}
		result = map[string]any{"permissions": permissions, "scope": scope}
	} else {
		wire := "decline"
		if decision == "approved" {
			wire = "accept"
		}
		if decision == "approved_for_session" {
			wire = "acceptForSession"
		}
		if decision == "abort" {
			wire = "cancel"
		}
		result = map[string]any{"decision": wire}
	}
	provider.respondRPC(pending.RPCID, result)
	provider.session.finishPermission(id, map[bool]string{true: "approved", false: "denied"}[approved], decision)
	provider.updatePublicState("running")
	return nil
}

func (provider *CodexProvider) Interrupt(ctx context.Context) error {
	provider.titles.cancelGeneration()
	provider.mu.Lock()
	if provider.closed {
		provider.mu.Unlock()
		return errors.New("Codex session is closed")
	}
	if provider.aborting {
		provider.mu.Unlock()
		return nil
	}
	provider.aborting = true
	provider.abortSequence++
	sequence := provider.abortSequence
	if provider.resumeInFlight {
		forking := provider.forking
		provider.resumeAborted = true
		cancelResume := provider.resumeCancel
		provider.mu.Unlock()
		provider.updatePublicState("idle")
		if cancelResume != nil {
			cancelResume()
		}
		reason := "Codex resume was stopped."
		if forking {
			reason = "Codex fork was stopped."
		}
		provider.forceAbort(sequence, reason)
		return nil
	}
	threadID, turnID := provider.threadID, provider.turnID
	if threadID == "" || turnID == "" {
		if provider.cmd != nil {
			provider.mu.Unlock()
			provider.updatePublicState("running")
			provider.forceAbort(sequence, "Codex had no interruptible turn id and its app-server was stopped.")
			return nil
		}
		provider.aborting = false
		provider.mu.Unlock()
		provider.updatePublicState("idle")
		return nil
	}
	provider.mu.Unlock()
	provider.updatePublicState("running")
	go provider.abortWatchdog(sequence)

	provider.mu.Lock()
	if !provider.aborting || provider.abortSequence != sequence || provider.stdin == nil {
		provider.mu.Unlock()
		return nil
	}
	_, err := provider.requestLocked(
		ctx,
		"turn/interrupt",
		map[string]any{"threadId": threadID, "turnId": turnID},
	)
	provider.mu.Unlock()
	return err
}

func (provider *CodexProvider) abortWatchdog(sequence uint64) {
	provider.mu.Lock()
	grace := provider.abortGrace
	provider.mu.Unlock()
	if grace <= 0 {
		grace = defaultCodexAbortGrace
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-timer.C:
		provider.forceAbort(sequence, fmt.Sprintf("Codex did not stop within %s.", grace.Round(time.Millisecond)))
	case <-provider.session.ctx.Done():
	}
}

func (provider *CodexProvider) forceAbort(sequence uint64, reason string) bool {
	return provider.stopRuntime(sequence, reason, "cancelled")
}

func (provider *CodexProvider) stopRuntime(sequence uint64, reason, status string) bool {
	provider.eventMu.Lock()
	defer provider.eventMu.Unlock()
	provider.mu.Lock()
	if provider.closed || !provider.aborting || provider.abortSequence != sequence {
		provider.mu.Unlock()
		return false
	}
	command := provider.cmd
	if command != nil {
		provider.expectedStops[command] = struct{}{}
	}
	if provider.stdin != nil {
		_ = provider.stdin.Close()
	}
	threadID, turnID, started := provider.threadID, provider.turnID, provider.turnStarted
	provider.titles.reset()
	if provider.resumeCancel != nil {
		provider.resumeCancel()
	}
	provider.cmd = nil
	provider.stdin = nil
	provider.turnID = ""
	provider.turnStarted = 0
	provider.activeTurns = map[string]codexActiveTurn{}
	provider.permissions = map[string]codexPendingPermission{}
	provider.cancelUserInputsLocked("", "", false)
	provider.needsThreadResume = provider.threadID != ""
	provider.resuming = false
	provider.forking = false
	provider.resumeCancel = nil
	// 清理完成前保持 stopping，新的 Send/Resume 不能越过此处。
	provider.abortSequence++
	pending := provider.takePendingLocked()
	provider.mu.Unlock()

	if command != nil {
		killProcessTree(command)
	}
	provider.settleStoppedTurn(threadID, turnID, started, reason, status)
	provider.clearDeltaStreams()
	provider.mu.Lock()
	provider.aborting = false
	provider.updatePublicStateLocked("idle")
	provider.mu.Unlock()
	failure := errors.New("Codex app-server was stopped")
	if status == "failed" {
		failure = errors.New(reason)
	}
	failCodexRequests(pending, failure)
	return true
}

func (provider *CodexProvider) settleStoppedTurn(threadID, turnID string, started int64, reason, status string) {
	provider.finishPlans("", "", status)
	provider.session.appendMessage(map[string]any{"kind": "event", "level": "warning", "text": reason})
	if turnID != "" {
		exists := false
		runningTools := []string{}
		provider.session.mu.RLock()
		for _, message := range provider.session.Messages {
			if stringValue(message["kind"]) == "turn-end" && stringValue(message["turnId"]) == turnID {
				exists = true
			}
			if stringValue(message["kind"]) == "tool" && stringValue(message["turnId"]) == turnID &&
				(stringValue(message["toolStatus"]) == "running" || stringValue(message["toolStatus"]) == "inProgress") {
				runningTools = append(runningTools, stringValue(message["id"]))
			}
		}
		provider.session.mu.RUnlock()
		for _, id := range runningTools {
			provider.session.patchMessage(id, map[string]any{"toolStatus": status, "completedAtMs": millis()})
		}
		if !exists {
			message := map[string]any{
				"kind": "turn-end", "threadId": threadID, "turnId": turnID, "status": status, "isRootTurn": true,
				"createdAt": millis(),
			}
			if started > 0 {
				message["durationMs"] = max64(0, millis()-started)
			}
			provider.session.appendMessage(message)
		}
	}
	provider.session.mu.Lock()
	provider.session.Permissions = map[string]Permission{}
	provider.session.mu.Unlock()
	provider.session.markCompletionUnread()
	provider.session.appendMessage(map[string]any{
		"kind": "event", "level": "info",
		"text": "Codex app-server stopped. It will restart before the next message.",
	})
}

func (provider *CodexProvider) Resume(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("Codex thread is unavailable")
	}
	resumeCtx, cancelResume := context.WithTimeout(ctx, codexHistoryOperationTimeout)
	defer cancelResume()
	provider.mu.Lock()
	if provider.closed || provider.resumeInFlight || provider.aborting || provider.turnID != "" {
		provider.mu.Unlock()
		return errors.New("Codex session is busy")
	}
	if provider.cmd == nil {
		if err := provider.startLocked(resumeCtx); err != nil {
			provider.mu.Unlock()
			return err
		}
	}
	provider.cancelUserInputsLocked("", "", false)
	provider.resuming = true
	provider.resumeInFlight = true
	provider.resumeAborted = false
	provider.resumeCancel = cancelResume
	provider.mu.Unlock()
	provider.updatePublicState("running")

	params := map[string]any{
		"threadId": id, "cwd": provider.session.WorkingDirectory,
		"excludeTurns": true, "initialTurnsPage": codexInitialTurnsPageParams(),
		"config": codexPlanConfig(),
	}
	provider.applyDeveloperInstructions(params)
	result, err := provider.rpc(
		resumeCtx,
		"thread/resume",
		params,
	)
	if err == nil {
		provider.mu.Lock()
		provider.threadID = firstNonEmpty(stringValue(mapValue(result["thread"])["id"]), id)
		provider.needsThreadResume = false
		provider.mu.Unlock()
		err = provider.hydrateThread(resumeCtx, result)
	}
	if err != nil && resumeCtx.Err() != nil {
		provider.mu.Lock()
		if !provider.resumeAborted && !provider.aborting && provider.cmd != nil {
			provider.aborting = true
			provider.abortSequence++
			sequence := provider.abortSequence
			provider.mu.Unlock()
			provider.forceAbort(sequence, "Codex resume was cancelled before it completed.")
		} else {
			provider.mu.Unlock()
		}
	}
	provider.mu.Lock()
	aborted := provider.resumeAborted
	provider.resumeAborted = false
	provider.resuming = false
	provider.resumeCancel = nil
	provider.mu.Unlock()
	provider.updatePublicState("idle")
	provider.mu.Lock()
	provider.resumeInFlight = false
	provider.mu.Unlock()
	if aborted {
		return errors.New("resume aborted")
	}
	if err == nil {
		provider.titles.schedule(id, "", true)
	}
	return err
}
func (provider *CodexProvider) Fork(ctx context.Context, id string) (string, error) {
	forkCtx, cancelFork := context.WithTimeout(ctx, codexHistoryOperationTimeout)
	defer cancelFork()
	provider.mu.Lock()
	id = firstNonEmpty(strings.TrimSpace(id), provider.threadID)
	if id == "" {
		provider.mu.Unlock()
		return "", errors.New("Codex thread is unavailable")
	}
	if provider.closed || provider.resumeInFlight || provider.aborting || provider.turnID != "" {
		provider.mu.Unlock()
		return "", errors.New("Codex session is busy")
	}
	if provider.cmd == nil {
		if err := provider.startLocked(forkCtx); err != nil {
			provider.mu.Unlock()
			return "", err
		}
	}
	provider.cancelUserInputsLocked("", "", false)
	provider.forking = true
	provider.resumeInFlight = true
	provider.resumeAborted = false
	provider.resumeCancel = cancelFork
	provider.mu.Unlock()
	provider.updatePublicState("running")

	result, err := provider.rpc(
		forkCtx,
		"thread/fork",
		map[string]any{
			"threadId": id, "cwd": provider.session.WorkingDirectory, "ephemeral": false,
			"excludeTurns": true, "initialTurnsPage": codexInitialTurnsPageParams(),
			"config": codexPlanConfig(),
		},
	)
	newID := stringValue(mapValue(result["thread"])["id"])
	if err == nil && newID == "" {
		err = errors.New("forked Codex thread is unavailable")
	}
	if err == nil {
		provider.mu.Lock()
		provider.threadID = newID
		provider.needsThreadResume = false
		provider.mu.Unlock()
		err = provider.hydrateThread(forkCtx, result)
	}
	if err != nil && forkCtx.Err() != nil {
		provider.mu.Lock()
		if !provider.resumeAborted && !provider.aborting && provider.cmd != nil {
			provider.aborting = true
			provider.abortSequence++
			sequence := provider.abortSequence
			provider.mu.Unlock()
			provider.forceAbort(sequence, "Codex fork was cancelled before it completed.")
		} else {
			provider.mu.Unlock()
		}
	}
	provider.mu.Lock()
	aborted := provider.resumeAborted
	provider.resumeAborted = false
	provider.forking = false
	provider.resumeCancel = nil
	provider.mu.Unlock()
	provider.updatePublicState("idle")
	provider.mu.Lock()
	provider.resumeInFlight = false
	provider.mu.Unlock()
	if aborted {
		return "", errors.New("fork aborted")
	}
	if err == nil {
		provider.titles.schedule(newID, "", true)
	}
	return newID, err
}

func codexInitialTurnsPageParams() map[string]any {
	// Codex 会把一页历史编码为单条 JSONL。完整工具输出可能超过 stdout 管道容量，
	// 因此按单个 turn 读取消息摘要；会话继续使用原始 thread，不改写持久化历史。
	return map[string]any{"limit": 1, "sortDirection": "desc", "itemsView": "summary"}
}

func (provider *CodexProvider) hydrateThread(ctx context.Context, result map[string]any) error {
	provider.clearDeltaStreams()
	thread := mapValue(result["thread"])
	threadID := firstNonEmpty(stringValue(thread["id"]), provider.threadID)
	if threadID == "" {
		return errors.New("Codex thread is unavailable")
	}
	turns, err := provider.loadThreadTurns(ctx, threadID, mapValue(result["initialTurnsPage"]), sliceValue(thread["turns"]))
	if err != nil {
		return err
	}
	messages, err := buildCodexHistoryMessages(ctx, threadID, turns)
	if err != nil {
		return err
	}
	historicalPlans, planErr := readCodexPlanHistory(ctx, stringValue(thread["path"]), threadID)
	if err := ctx.Err(); err != nil {
		return err
	}
	if planErr != nil {
		// Task history is optional; an unavailable local rollout must not block
		// opening the conversation returned by Codex's history API.
		logDebug("[codex-plan-history] %v", planErr)
	}
	for turnID, plan := range historicalPlans {
		plan["threadId"], plan["turnId"] = threadID, turnID
	}
	messages = provider.retainPlans(messages, historicalPlans)
	if !provider.session.replaceMessages(messages) {
		return errors.New("Codex session is closed")
	}
	return nil
}

func (provider *CodexProvider) loadThreadTurns(
	ctx context.Context,
	threadID string,
	initialPage map[string]any,
	legacyTurns []any,
) ([]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(initialPage) == 0 && len(legacyTurns) > 0 {
		return legacyTurns, nil
	}
	descending := []any{}
	page := initialPage
	cursor := ""
	seenCursors := map[string]bool{}
	for pageNumber := 0; ; pageNumber++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if pageNumber > maxCodexHistoryPages {
			return nil, fmt.Errorf("Codex history pagination exceeded %d pages", maxCodexHistoryPages)
		}
		if len(page) == 0 {
			params := codexInitialTurnsPageParams()
			params["threadId"] = threadID
			params["cursor"] = nilIfEmpty(cursor)
			result, err := provider.rpc(ctx, "thread/turns/list", params)
			if err != nil {
				return nil, err
			}
			page = result
		}
		descending = append(descending, sliceValue(page["data"])...)
		next := strings.TrimSpace(stringValue(page["nextCursor"]))
		if next == "" {
			break
		}
		if seenCursors[next] {
			return nil, errors.New("Codex history pagination repeated a cursor")
		}
		seenCursors[next] = true
		cursor = next
		page = nil
	}
	turns := make([]any, len(descending))
	for index, value := range descending {
		turns[len(descending)-1-index] = value
	}
	return turns, nil
}

func buildCodexHistoryMessages(ctx context.Context, threadID string, turns []any) ([]map[string]any, error) {
	messages := make([]map[string]any, 0, len(turns)*4)
	for _, value := range turns {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		turn := mapValue(value)
		turnID := stringValue(turn["id"])
		started := timestampMillis(firstNonNil(turn["startedAt"], turn["createdAt"]))
		completed := timestampMillis(firstNonNil(turn["completedAt"], turn["updatedAt"]))
		if started == 0 {
			started = millis()
		}
		messages = append(messages, codexHistoryMessage(map[string]any{
			"kind": "turn-start", "threadId": threadID, "turnId": turnID, "createdAt": started,
		}))
		status := "completed"
		if stringValue(turn["status"]) == "failed" {
			status = "failed"
		}
		if stringValue(turn["status"]) == "interrupted" {
			status = "cancelled"
		}
		for _, itemValue := range sliceValue(turn["items"]) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			item := cloneMap(mapValue(itemValue))
			item["threadId"] = threadID
			item["turnId"] = turnID
			if message := codexHistoryItem(item); message != nil {
				messages = append(messages, codexHistoryMessage(message))
			}
		}
		messages = append(messages, codexHistoryMessage(
			map[string]any{
				"kind":       "turn-end",
				"threadId":   threadID,
				"turnId":     turnID,
				"status":     status,
				"durationMs": max64(0, completed-started),
				"createdAt":  completed,
			},
		))
	}
	return messages, nil
}

func codexHistoryMessage(message map[string]any) map[string]any {
	if message["id"] == nil {
		message["id"] = newUUID()
	}
	if message["createdAt"] == nil {
		message["createdAt"] = millis()
	}
	return message
}

func codexHistoryItem(raw map[string]any) map[string]any {
	itemType := stringValue(raw["type"])
	kind := ""
	switch itemType {
	case "userMessage":
		kind = "user"
	case "agentMessage":
		kind = "assistant"
	case "reasoning", "plan":
		kind = "reasoning"
	case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall":
		kind = "tool"
	case "contextCompaction":
		kind = "compaction"
	default:
		return nil
	}
	message := map[string]any{
		"kind": kind, "providerId": raw["id"], "threadId": raw["threadId"], "turnId": raw["turnId"],
		"streaming": false,
	}
	switch kind {
	case "user":
		message["text"] = textFromCodexInput(raw["content"])
	case "assistant":
		message["text"] = stringValue(raw["text"])
		if raw["delivery"] == "async" && len(sliceValue(raw["questions"])) > 0 {
			message["kind"] = "question"
			message["questions"] = codexInputQuestions(raw["questions"], true)
			message["delivery"] = "async"
			// Persisted history does not say whether a question has been answered.
			message["questionStatus"] = "historical"
		}
	case "reasoning":
		message["text"] = firstNonEmpty(stringValue(raw["text"]), strings.Join(stringsFromAny(raw["summary"]), "\n"))
	case "compaction":
		message["compactionStatus"] = firstNonEmpty(stringValue(raw["status"]), "completed")
	case "tool":
		for key, value := range codexToolDetails(raw) {
			message[key] = value
		}
		if result := stringValue(message["result"]); result != "" {
			message["result"] = limitCodexToolOutput(result)
		}
		message["toolStatus"] = firstNonEmpty(stringValue(raw["status"]), "completed")
		message["startedAtMs"] = timestampMillis(firstNonNil(raw["startedAt"], raw["createdAt"]))
	}
	return message
}
func (provider *CodexProvider) Compact(ctx context.Context) error {
	provider.mu.Lock()
	if provider.threadID == "" {
		provider.mu.Unlock()
		return errors.New("Codex thread is unavailable")
	}
	_, err := provider.requestLocked(ctx, "thread/compact/start", map[string]any{"threadId": provider.threadID})
	provider.mu.Unlock()
	return err
}
func (provider *CodexProvider) Status(ctx context.Context) error {
	provider.mu.Lock()
	account, err := provider.requestLocked(ctx, "account/read", map[string]any{"refreshToken": false})
	provider.mu.Unlock()
	if err != nil {
		return err
	}
	accountDetails := mapValue(account["account"])
	var rateLimits any
	var rateLimitsByLimitID any
	if stringValue(accountDetails["type"]) == "chatgpt" {
		provider.mu.Lock()
		result, rateLimitErr := provider.requestLocked(ctx, "account/rateLimits/read", map[string]any{})
		provider.mu.Unlock()
		if rateLimitErr != nil {
			logDebug("[codex-app-server] account/rateLimits/read failed: %v", rateLimitErr)
		} else if limits := mapValue(result["rateLimits"]); len(limits) > 0 {
			rateLimits = limits
		}
		if buckets := mapValue(result["rateLimitsByLimitId"]); len(buckets) > 0 {
			rateLimitsByLimitID = buckets
		}
	}
	provider.session.appendMessage(
		map[string]any{
			"kind":                "status",
			"title":               "Codex status",
			"model":               provider.options["model"],
			"effort":              provider.options["effort"],
			"account":             accountDetails,
			"rateLimits":          rateLimits,
			"rateLimitsByLimitId": rateLimitsByLimitID,
			"context":             provider.contextStatus(),
		},
	)
	return nil
}
func (provider *CodexProvider) Close(context.Context) error {
	provider.eventMu.Lock()
	defer provider.eventMu.Unlock()
	provider.mu.Lock()
	provider.titles.reset()
	provider.closed = true
	if provider.resumeCancel != nil {
		provider.resumeCancel()
	}
	provider.resumeCancel = nil
	provider.resuming = false
	provider.forking = false
	provider.resumeInFlight = false
	provider.aborting = false
	provider.abortSequence++
	if provider.stdin != nil {
		_ = provider.stdin.Close()
	}
	if provider.cmd != nil && provider.cmd.Process != nil {
		provider.expectedStops[provider.cmd] = struct{}{}
		killProcessTree(provider.cmd)
	}
	provider.cmd = nil
	provider.stdin = nil
	provider.failPendingLocked(errors.New("Codex session is closed"))
	provider.mu.Unlock()
	provider.clearDeltaStreams()
	return nil
}

func (provider *CodexProvider) refreshModelsLocked(ctx context.Context) error {
	result, err := provider.requestLocked(
		ctx,
		"model/list",
		map[string]any{"cursor": nil, "limit": 100, "includeHidden": false},
	)
	if err != nil {
		return err
	}
	provider.models = nil
	for _, value := range sliceValue(result["data"]) {
		item := mapValue(value)
		provider.models = append(provider.models, map[string]any{
			"id": firstNonEmpty(stringValue(item["id"]), stringValue(item["model"])),
			"label": firstNonEmpty(
				stringValue(item["displayName"]),
				stringValue(item["model"]),
				stringValue(item["id"]),
			),
			"isDefault":     boolValue(item["isDefault"]),
			"contextWindow": item["contextWindow"],
			"efforts":       codexReasoningEfforts(item["supportedReasoningEfforts"]),
			"defaultEffort": stringValue(item["defaultReasoningEffort"]),
		})
	}
	if provider.options["model"] == nil {
		for _, item := range provider.models {
			if boolValue(item["isDefault"]) {
				provider.options["model"] = item["id"]
				break
			}
		}
	}
	return nil
}

func codexReasoningEfforts(value any) []string {
	efforts := []string{}
	for _, raw := range sliceValue(value) {
		effort := ""
		if item, ok := raw.(map[string]any); ok {
			effort = firstNonEmpty(
				stringValue(item["reasoningEffort"]),
				stringValue(item["reasoning_effort"]),
				stringValue(item["value"]),
				stringValue(item["id"]),
			)
		} else {
			effort = stringValue(raw)
		}
		if effort != "" {
			efforts = append(efforts, effort)
		}
	}
	return efforts
}
func (provider *CodexProvider) applyConfig(config map[string]any) {
	if provider.options["model"] == nil {
		provider.options["model"] = config["model"]
	}
	if provider.options["effort"] == nil {
		provider.options["effort"] = config["model_reasoning_effort"]
	}
	provider.options["configPermissionMode"] = config["approval_policy"]
	provider.options["configSandboxMode"] = config["sandbox_mode"]
}
func (provider *CodexProvider) applyThreadOptions(params map[string]any) {
	params["config"] = codexPlanConfig()
	provider.applyDeveloperInstructions(params)
	if value := stringValue(provider.options["model"]); value != "" {
		params["model"] = value
	}
	if value := stringValue(provider.options["permissionMode"]); value != "" && value != "default" {
		params["approvalPolicy"] = value
	}
	if value := stringValue(provider.options["sandboxMode"]); value != "" && value != "default" {
		params["sandbox"] = value
	}
}

func (provider *CodexProvider) applyDeveloperInstructions(params map[string]any) {
	if instructions := stringValue(provider.options["developerInstructions"]); instructions != "" {
		params["developerInstructions"] = instructions
	}
}

func (provider *CodexProvider) UpdateInstructions(ctx context.Context, instructions string) error {
	provider.mu.Lock()
	if provider.closed || provider.turnID != "" || provider.resumeInFlight || provider.aborting {
		provider.mu.Unlock()
		return errors.New("Codex session is busy")
	}
	previous := provider.options["developerInstructions"]
	provider.options["developerInstructions"] = instructions
	threadID := provider.threadID
	provider.mu.Unlock()
	if threadID == "" {
		return nil
	}
	// 已启动的 thread 需要显式恢复，新的开发指令才会应用到后续轮次。
	if err := provider.Resume(ctx, threadID); err != nil {
		provider.mu.Lock()
		provider.options["developerInstructions"] = previous
		provider.mu.Unlock()
		return err
	}
	return nil
}
func (provider *CodexProvider) applyTurnOptions(params map[string]any) {
	if value := stringValue(provider.options["model"]); value != "" {
		params["model"] = value
	}
	if value := stringValue(provider.options["permissionMode"]); value != "" && value != "default" {
		params["approvalPolicy"] = value
	}
	if value := stringValue(provider.options["sandboxMode"]); value != "" && value != "default" {
		params["sandboxPolicy"] = codexSandboxPolicy(value, provider.session.WorkingDirectory)
	}
	if value := stringValue(provider.options["effort"]); value != "" {
		params["effort"] = value
	}
}

func codexSandboxPolicy(mode, workingDirectory string) any {
	switch mode {
	case "danger-full-access":
		return map[string]any{"type": "dangerFullAccess"}
	case "read-only":
		return map[string]any{"type": "readOnly", "networkAccess": false}
	case "workspace-write":
		return map[string]any{
			"type":                "workspaceWrite",
			"writableRoots":       []string{workingDirectory},
			"networkAccess":       false,
			"excludeTmpdirEnvVar": false,
			"excludeSlashTmp":     false,
		}
	default:
		return nil
	}
}
func (provider *CodexProvider) updatePublicState(status string) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.updatePublicStateLocked(status)
}

func (provider *CodexProvider) updatePublicStateLocked(status string) {
	resuming, forking, aborting := provider.resuming, provider.forking, provider.aborting
	if status == "running" || status == "waiting_input" || status == "waiting_approval" {
		status = "running"
		for _, input := range provider.userInputs {
			if input.Blocking {
				status = "waiting_input"
				break
			}
		}
		if len(provider.permissions) > 0 {
			status = "waiting_approval"
		}
	}
	type activeSubagent struct {
		threadID  string
		startedAt int64
	}
	activeSubagents := []activeSubagent{}
	for threadID, turn := range provider.activeTurns {
		if threadID != provider.threadID {
			activeSubagents = append(activeSubagents, activeSubagent{threadID: threadID, startedAt: turn.StartedAt})
		}
	}
	sort.Slice(activeSubagents, func(i, j int) bool {
		if activeSubagents[i].startedAt == activeSubagents[j].startedAt {
			return activeSubagents[i].threadID < activeSubagents[j].threadID
		}
		return activeSubagents[i].startedAt < activeSubagents[j].startedAt
	})
	activeSubagentThreadIDs := make([]string, len(activeSubagents))
	for index, subagent := range activeSubagents {
		activeSubagentThreadIDs[index] = subagent.threadID
	}
	state := map[string]any{
		"permissionMode": firstNonEmpty(stringValue(provider.options["permissionMode"]), "default"),
		"sandboxMode":    firstNonEmpty(stringValue(provider.options["sandboxMode"]), "default"),
		"effectivePermissionMode": firstNonNil(
			provider.options["permissionMode"],
			provider.options["configPermissionMode"],
		),
		"effectiveSandboxMode":    firstNonNil(provider.options["sandboxMode"], provider.options["configSandboxMode"]),
		"model":                   provider.options["model"],
		"effort":                  provider.options["effort"],
		"status":                  status,
		"threadId":                nilIfEmpty(provider.threadID),
		"aborting":                aborting,
		"resuming":                resuming,
		"forking":                 forking,
		"canAbort":                (status != "idle" || resuming || forking) && !aborting,
		"canCompact":              status == "idle" && !resuming && !forking && !aborting && provider.threadID != "",
		"compacting":              false,
		"pendingPermissionCount":  len(provider.permissions),
		"pendingQuestionCount":    len(provider.userInputs),
		"activeSubagentCount":     len(activeSubagentThreadIDs),
		"activeSubagentThreadIds": activeSubagentThreadIDs,
		"models":                  provider.models,
	}
	provider.session.setState(state)
}

func (provider *CodexProvider) refreshPublicState() {
	provider.session.mu.RLock()
	status := provider.session.StatusValue
	provider.session.mu.RUnlock()
	provider.updatePublicState(status)
}
func (provider *CodexProvider) contextStatus() any {
	provider.mu.Lock()
	usage := cloneMap(provider.tokenUsage)
	provider.mu.Unlock()
	if len(usage) == 0 {
		return nil
	}
	window := numberInt64(firstNonNil(usage["modelContextWindow"], usage["contextWindow"]))
	last := mapValue(firstNonNil(usage["last"], usage["lastTokenUsage"]))
	used := numberInt64(firstNonNil(last["totalTokens"], usage["contextTokens"]))
	if window == 0 {
		return nil
	}
	remaining := max64(0, window-used)
	return map[string]any{
		"usedTokens":       used,
		"contextWindow":    window,
		"remainingTokens":  remaining,
		"remainingPercent": remaining * 100 / window,
	}
}
func textFromCodexInput(value any) string {
	parts := []string{}
	for _, entry := range sliceValue(value) {
		item := mapValue(entry)
		if stringValue(item["type"]) == "text" {
			parts = append(parts, stringValue(item["text"]))
		}
	}
	return strings.Join(parts, "\n")
}
func timestampMillis(value any) int64 {
	number := numberInt64(value)
	if number > 0 && number < 100000000000 {
		return number * 1000
	}
	return number
}
func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

var _ = fmt.Sprintf
