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
	"regexp"
	"strconv"
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
	titles               *codexTitles
	mu                   sync.Mutex
	streamMu             sync.Mutex
	session              *Session
	options              map[string]any
	defaultsStore        *ConfigStore
	cmd                  *exec.Cmd
	stdin                io.WriteCloser
	pending              map[int64]chan codexRPCResult
	permissions          map[string]codexPendingPermission
	requestID            atomic.Int64
	threadID             string
	turnID               string
	turnStarted          int64
	activeTurns          map[string]codexActiveTurn
	models               []map[string]any
	tokenUsage           map[string]any
	reconnectAbortTurnID string
	streams              map[string]*codexDeltaStream
	expectedStops        map[*exec.Cmd]struct{}
	resumeCancel         context.CancelFunc
	resuming             bool
	forking              bool
	resumeInFlight       bool
	resumeAborted        bool
	aborting             bool
	needsThreadResume    bool
	abortSequence        uint64
	abortGrace           time.Duration
	closed               bool
}

var codexReconnectPattern = regexp.MustCompile(`(?i)\bReconnecting(?:\.\.\.)?\s*(\d+)\s*/\s*(\d+)\b`)

func NewCodexProvider(session *Session, options map[string]any) *CodexProvider {
	if options == nil {
		options = map[string]any{}
	}
	provider := &CodexProvider{
		session:       session,
		options:       options,
		pending:       map[int64]chan codexRPCResult{},
		permissions:   map[string]codexPendingPermission{},
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
	stderr, err := command.StderrPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	provider.cmd, provider.stdin = command, stdin
	go provider.readStdout(stdout)
	go provider.readStderr(stderr)
	go provider.wait(command)
	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	initializeParams := map[string]any{
		"clientInfo":   map[string]any{"name": "glad-web", "title": "Glad", "version": buildVersion},
		"capabilities": map[string]any{"experimentalApi": true},
	}
	if _, err := provider.requestLocked(initCtx, "initialize", initializeParams); err != nil {
		provider.expectedStops[command] = struct{}{}
		killProcessTree(command)
		provider.cmd = nil
		provider.stdin = nil
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
		_, err := provider.requestLocked(
			ctx,
			"thread/resume",
			map[string]any{
				"threadId": provider.threadID, "cwd": provider.session.WorkingDirectory, "excludeTurns": true,
			},
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
	provider.session.appendMessage(
		map[string]any{
			"kind": "user", "text": input.Text, "agentText": input.AgentText,
			"attachments": attachments, "skills": input.Skills, "clientMessageId": input.ClientMessageID,
		},
	)
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
	provider.turnID = firstNonEmpty(stringValue(mapValue(started["turn"])["id"]), stringValue(started["turnId"]))
	provider.turnStarted = millis()
	provider.mu.Unlock()
	provider.updatePublicState("running")
	return nil
}

func (provider *CodexProvider) readStdout(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		logDebug("[codex-rpc] %s", scanner.Text())
		var message map[string]any
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		provider.handleRPC(message)
	}
}
func (provider *CodexProvider) readStderr(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			logDebug("[codex] %s", line)
		}
	}
}
func (provider *CodexProvider) wait(command *exec.Cmd) {
	err := command.Wait()
	provider.mu.Lock()
	_, expected := provider.expectedStops[command]
	delete(provider.expectedStops, command)
	current := provider.cmd == command
	if current {
		provider.titles.reset()
		provider.cmd = nil
		provider.stdin = nil
		if provider.resumeCancel != nil {
			provider.resumeCancel()
		}
		provider.resumeCancel = nil
		provider.resuming = false
		provider.forking = false
		provider.resumeInFlight = false
		provider.aborting = false
		provider.activeTurns = map[string]codexActiveTurn{}
		provider.abortSequence++
		if !provider.closed && provider.threadID != "" {
			provider.needsThreadResume = true
		}
		provider.failPendingLocked(errors.New("Codex app-server exited"))
	}
	closed := provider.closed
	provider.mu.Unlock()
	if current {
		provider.clearDeltaStreams()
	}
	if !closed && !expected {
		text := "Codex app-server exited."
		if err != nil {
			text += " " + err.Error()
		}
		provider.session.appendMessage(map[string]any{"kind": "event", "level": "error", "text": text})
		provider.updatePublicState("idle")
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
		provider.respondRPC(message["id"], map[string]any{"answers": map[string]any{}})
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
	provider.permissions[permissionID] = codexPendingPermission{RPCID: message["id"], Method: method, Params: params}
	provider.mu.Unlock()
	provider.session.addPermission(
		Permission{
			ID:           permissionID,
			Status:       "pending",
			Title:        name,
			ToolName:     name,
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
			if provider.turnStarted > 0 {
				started = provider.turnStarted
			}
			provider.turnID = ""
			provider.turnStarted = 0
			provider.permissions = map[string]codexPendingPermission{}
			provider.aborting = false
			provider.activeTurns = map[string]codexActiveTurn{}
			provider.abortSequence++
		}
		provider.mu.Unlock()
		status := "completed"
		if stringValue(turn["status"]) == "failed" || turn["error"] != nil {
			status = "failed"
		}
		if stringValue(turn["status"]) == "interrupted" {
			status = "cancelled"
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
			provider.session.HasUnreadCompletion = true
			provider.session.Permissions = map[string]Permission{}
			provider.session.mu.Unlock()
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
		attempt, maximum := codexReconnectProgress(text)
		if rootThread && boolValue(params["willRetry"]) && attempt == 4 && maximum == 5 {
			provider.abortAfterReconnect(threadID, turnID)
		}
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

func (provider *CodexProvider) requestLockedTracked(ctx context.Context, method string, params map[string]any, hidden *codexTitleResponse) (map[string]any, error) {
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
	defer provider.mu.Lock()
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
	_, err = provider.stdin.Write(bytes)
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
	provider.cmd = nil
	provider.stdin = nil
	provider.turnID = ""
	provider.turnStarted = 0
	provider.activeTurns = map[string]codexActiveTurn{}
	provider.permissions = map[string]codexPendingPermission{}
	provider.needsThreadResume = provider.threadID != ""
	provider.resuming = false
	provider.forking = false
	provider.resumeCancel = nil
	provider.aborting = false
	provider.abortSequence++
	pending := provider.takePendingLocked()
	provider.mu.Unlock()

	if command != nil {
		killProcessTree(command)
	}
	provider.settleForcedAbort(threadID, turnID, started, reason)
	provider.clearDeltaStreams()
	provider.updatePublicState("idle")
	failCodexRequests(pending, errors.New("Codex app-server was stopped"))
	return true
}

func (provider *CodexProvider) settleForcedAbort(threadID, turnID string, started int64, reason string) {
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
			provider.session.patchMessage(id, map[string]any{"toolStatus": "cancelled", "completedAtMs": millis()})
		}
		if !exists {
			message := map[string]any{
				"kind": "turn-end", "threadId": threadID, "turnId": turnID, "status": "cancelled",
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
	provider.session.HasUnreadCompletion = true
	provider.session.mu.Unlock()
	provider.session.appendMessage(map[string]any{
		"kind": "event", "level": "info",
		"text": "Codex app-server stopped. It will restart before the next message.",
	})
}

func codexReconnectProgress(message string) (int, int) {
	match := codexReconnectPattern.FindStringSubmatch(message)
	if len(match) != 3 {
		return 0, 0
	}
	attempt, attemptErr := strconv.Atoi(match[1])
	maximum, maximumErr := strconv.Atoi(match[2])
	if attemptErr != nil || maximumErr != nil {
		return 0, 0
	}
	return attempt, maximum
}

func (provider *CodexProvider) abortAfterReconnect(threadID, turnID string) {
	provider.mu.Lock()
	threadID = firstNonEmpty(threadID, provider.threadID)
	turnID = firstNonEmpty(turnID, provider.turnID)
	if threadID == "" || turnID == "" || provider.reconnectAbortTurnID == turnID {
		provider.mu.Unlock()
		return
	}
	provider.reconnectAbortTurnID = turnID
	provider.mu.Unlock()

	const reason = "Aborted after Codex reconnect attempt 4/5."
	provider.session.appendMessage(map[string]any{"kind": "event", "level": "info", "text": reason})
	provider.session.emit(map[string]any{"type": "runtime-disconnected", "activeTurn": true, "turnId": turnID})

	// Notifications are read on the same goroutine that resolves JSON-RPC
	// responses, so the interrupt must wait for its response asynchronously.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := provider.Interrupt(ctx)
		if err != nil {
			logDebug("[codex-app-server] automatic turn/interrupt failed for %s/%s: %v", threadID, turnID, err)
		}
	}()
}
func (provider *CodexProvider) Resume(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("Codex thread is unavailable")
	}
	resumeCtx, cancelResume := context.WithCancel(ctx)
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
	provider.resuming = true
	provider.resumeInFlight = true
	provider.resumeAborted = false
	provider.resumeCancel = cancelResume
	provider.mu.Unlock()
	provider.updatePublicState("running")

	result, err := provider.rpc(
		resumeCtx,
		"thread/resume",
		map[string]any{
			"threadId": id, "cwd": provider.session.WorkingDirectory,
			"excludeTurns": true, "initialTurnsPage": codexInitialTurnsPageParams(),
		},
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
	forkCtx, cancelFork := context.WithCancel(ctx)
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
	return map[string]any{"limit": 50, "sortDirection": "desc", "itemsView": "full"}
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
		if pageNumber > 1000 {
			return nil, errors.New("Codex history pagination exceeded 1000 pages")
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
	resuming, forking, aborting := provider.resuming, provider.forking, provider.aborting
	activeSubagentCount := 0
	for threadID := range provider.activeTurns {
		if threadID != provider.threadID {
			activeSubagentCount++
		}
	}
	state := map[string]any{
		"permissionMode": firstNonEmpty(stringValue(provider.options["permissionMode"]), "default"),
		"sandboxMode":    firstNonEmpty(stringValue(provider.options["sandboxMode"]), "default"),
		"effectivePermissionMode": firstNonNil(
			provider.options["permissionMode"],
			provider.options["configPermissionMode"],
		),
		"effectiveSandboxMode":   firstNonNil(provider.options["sandboxMode"], provider.options["configSandboxMode"]),
		"model":                  provider.options["model"],
		"effort":                 provider.options["effort"],
		"status":                 status,
		"threadId":               nilIfEmpty(provider.threadID),
		"aborting":               aborting,
		"resuming":               resuming,
		"forking":                forking,
		"canAbort":               (status != "idle" || resuming || forking) && !aborting,
		"canCompact":             status == "idle" && !resuming && !forking && !aborting && provider.threadID != "",
		"compacting":             false,
		"pendingPermissionCount": len(provider.permissions),
		"activeSubagentCount":    activeSubagentCount,
		"models":                 provider.models,
	}
	provider.mu.Unlock()
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
