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
	"strings"
	"sync"
	"sync/atomic"
	"time"
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

type CodexProvider struct {
	mu          sync.Mutex
	session     *Session
	options     map[string]any
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	pending     map[int64]chan codexRPCResult
	permissions map[string]codexPendingPermission
	requestID   atomic.Int64
	threadID    string
	turnID      string
	turnStarted int64
	models      []map[string]any
	tokenUsage  map[string]any
	closed      bool
}

func NewCodexProvider(session *Session, options map[string]any) *CodexProvider {
	if options == nil {
		options = map[string]any{}
	}
	return &CodexProvider{
		session:     session,
		options:     options,
		pending:     map[int64]chan codexRPCResult{},
		permissions: map[string]codexPendingPermission{},
		threadID:    stringValue(options["resume"]),
	}
}

func (provider *CodexProvider) Start(ctx context.Context) error {
	provider.mu.Lock()
	if provider.cmd != nil {
		provider.mu.Unlock()
		return nil
	}
	command := exec.Command(provider.session.Tool.Command, "app-server", "--stdio")
	configureProcess(command)
	command.Dir = provider.session.WorkingDirectory
	command.Env = os.Environ()
	stdin, err := command.StdinPipe()
	if err != nil {
		provider.mu.Unlock()
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		provider.mu.Unlock()
		return err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		provider.mu.Unlock()
		return err
	}
	if err := command.Start(); err != nil {
		provider.mu.Unlock()
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
		killProcessTree(command)
		provider.cmd = nil
		provider.stdin = nil
		provider.mu.Unlock()
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
	provider.mu.Unlock()
	provider.updatePublicState("idle")
	return nil
}

func (provider *CodexProvider) Send(ctx context.Context, input ProviderInput) error {
	provider.mu.Lock()
	if provider.closed || provider.cmd == nil {
		provider.mu.Unlock()
		return errors.New("Codex session is unavailable")
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
	if provider.cmd == command {
		provider.cmd = nil
		provider.stdin = nil
	}
	closed := provider.closed
	provider.mu.Unlock()
	if !closed {
		text := "Codex app-server exited."
		if err != nil {
			text += " " + err.Error()
		}
		provider.session.appendMessage(map[string]any{"kind": "event", "level": "error", "text": text})
		provider.session.setState(map[string]any{"status": "idle", "canAbort": false})
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
	threadID := firstNonEmpty(stringValue(params["threadId"]), provider.threadID)
	turn := mapValue(params["turn"])
	turnID := firstNonEmpty(stringValue(turn["id"]), stringValue(params["turnId"]), provider.turnID)
	switch method {
	case "thread/tokenUsage/updated":
		provider.mu.Lock()
		provider.tokenUsage = mapValue(params["tokenUsage"])
		if len(provider.tokenUsage) == 0 {
			provider.tokenUsage = mapValue(params["usage"])
		}
		provider.mu.Unlock()
	case "turn/started":
		provider.mu.Lock()
		provider.turnID = turnID
		started := timestampMillis(turn["startedAt"])
		if started == 0 {
			started = millis()
		}
		provider.turnStarted = started
		provider.mu.Unlock()
		provider.session.appendMessage(
			map[string]any{"kind": "turn-start", "threadId": threadID, "turnId": turnID, "createdAt": started},
		)
		provider.updatePublicState("running")
	case "turn/completed":
		provider.mu.Lock()
		started := provider.turnStarted
		provider.turnID = ""
		provider.turnStarted = 0
		provider.permissions = map[string]codexPendingPermission{}
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
		provider.session.appendMessage(
			map[string]any{
				"kind":       "turn-end",
				"threadId":   threadID,
				"turnId":     turnID,
				"status":     status,
				"durationMs": max64(0, completed-started),
				"createdAt":  completed,
				"context":    provider.contextStatus(),
			},
		)
		provider.session.mu.Lock()
		provider.session.HasUnreadCompletion = true
		provider.session.Permissions = map[string]Permission{}
		provider.session.mu.Unlock()
		provider.updatePublicState("idle")
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
			provider.updatePublicState("idle")
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
		if !boolValue(params["willRetry"]) {
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
		patch["toolStatus"] = firstNonEmpty(inferred, stringValue(raw["status"]), "running")
		patch["startedAtMs"] = millis()
	}
	provider.session.mu.RLock()
	existingID := ""
	preserveUserText := false
	for _, message := range provider.session.Messages {
		if stringValue(message["providerId"]) == providerID && providerID != "" {
			existingID = stringValue(message["id"])
			preserveUserText = kind == "user" &&
				(stringValue(message["clientMessageId"]) != "" || stringValue(message["agentText"]) != "")
			break
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
		provider.session.appendMessage(patch)
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
	provider.session.mu.RLock()
	existingID := ""
	existingText := ""
	for _, m := range provider.session.Messages {
		if stringValue(m["providerId"]) == providerID && stringValue(m["kind"]) == kind {
			existingID = stringValue(m["id"])
			existingText = stringValue(m["text"])
			break
		}
	}
	provider.session.mu.RUnlock()
	patch := map[string]any{
		"text":     existingText + delta,
		"threadId": params["threadId"],
		"turnId":   firstNonNil(params["turnId"], provider.turnID),
	}
	if existingID != "" {
		provider.session.patchMessage(existingID, patch)
	} else {
		patch["kind"] = kind
		patch["providerId"] = providerID
		patch["streaming"] = true
		provider.session.appendMessage(patch)
	}
}
func (provider *CodexProvider) patchProviderItem(id, delta string) {
	provider.session.mu.RLock()
	targetID := ""
	result := ""
	for _, m := range provider.session.Messages {
		if stringValue(m["providerId"]) == id {
			targetID = stringValue(m["id"])
			result = stringValue(m["result"])
			break
		}
	}
	provider.session.mu.RUnlock()
	if targetID != "" {
		provider.session.patchMessage(targetID, map[string]any{"result": result + delta})
	}
}

func (provider *CodexProvider) requestLocked(
	ctx context.Context,
	method string,
	params map[string]any,
) (map[string]any, error) {
	id := provider.requestID.Add(1)
	channel := make(chan codexRPCResult, 1)
	provider.pending[id] = channel
	if err := provider.writeLocked(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		delete(provider.pending, id)
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

func (provider *CodexProvider) UpdateSettings(ctx context.Context, settings map[string]any) error {
	provider.mu.Lock()
	for key, value := range settings {
		provider.options[key] = value
	}
	if provider.threadID != "" {
		params := map[string]any{"threadId": provider.threadID}
		if value := settings["permissionMode"]; value != nil {
			params["approvalPolicy"] = value
		}
		if value := settings["sandboxMode"]; value != nil {
			params["sandboxPolicy"] = codexSandboxPolicy(stringValue(value), provider.session.WorkingDirectory)
		}
		if value := settings["model"]; value != nil {
			params["model"] = value
		}
		if value := settings["effort"]; value != nil {
			params["effort"] = value
		}
		_, err := provider.requestLocked(ctx, "thread/settings/update", params)
		provider.mu.Unlock()
		provider.updatePublicState(provider.session.StatusValue)
		return err
	}
	provider.mu.Unlock()
	provider.updatePublicState(provider.session.StatusValue)
	return nil
}
func (provider *CodexProvider) Interrupt(ctx context.Context) error {
	provider.mu.Lock()
	if provider.threadID == "" || provider.turnID == "" {
		provider.mu.Unlock()
		return nil
	}
	_, err := provider.requestLocked(
		ctx,
		"turn/interrupt",
		map[string]any{"threadId": provider.threadID, "turnId": provider.turnID},
	)
	provider.mu.Unlock()
	return err
}
func (provider *CodexProvider) Resume(ctx context.Context, id string) error {
	provider.mu.Lock()
	result, err := provider.requestLocked(
		ctx,
		"thread/resume",
		map[string]any{"threadId": id, "cwd": provider.session.WorkingDirectory},
	)
	if err == nil {
		provider.threadID = firstNonEmpty(stringValue(mapValue(result["thread"])["id"]), id)
	}
	provider.mu.Unlock()
	if err == nil {
		provider.hydrateThread(ctx, mapValue(result["thread"]))
	}
	provider.updatePublicState("idle")
	return err
}
func (provider *CodexProvider) Fork(ctx context.Context, id string) (string, error) {
	provider.mu.Lock()
	result, err := provider.requestLocked(
		ctx,
		"thread/fork",
		map[string]any{"threadId": id, "cwd": provider.session.WorkingDirectory, "ephemeral": false},
	)
	newID := stringValue(mapValue(result["thread"])["id"])
	if err == nil {
		provider.threadID = newID
	}
	provider.mu.Unlock()
	if err == nil {
		provider.hydrateThread(ctx, mapValue(result["thread"]))
	}
	provider.updatePublicState("idle")
	return newID, err
}

func (provider *CodexProvider) hydrateThread(ctx context.Context, thread map[string]any) {
	threadID := firstNonEmpty(stringValue(thread["id"]), provider.threadID)
	turns := sliceValue(thread["turns"])
	if len(turns) == 0 && threadID != "" {
		params := map[string]any{
			"threadId": threadID, "cursor": nil, "limit": 50,
			"sortDirection": "desc", "itemsView": "full",
		}
		if result, err := provider.rpc(ctx, "thread/turns/list", params); err == nil {
			newest := sliceValue(result["data"])
			for index := len(newest) - 1; index >= 0; index-- {
				turns = append(turns, newest[index])
			}
		}
	}
	provider.session.mu.Lock()
	provider.session.Messages = nil
	provider.session.mu.Unlock()
	for _, value := range turns {
		turn := mapValue(value)
		turnID := stringValue(turn["id"])
		started := timestampMillis(firstNonNil(turn["startedAt"], turn["createdAt"]))
		completed := timestampMillis(firstNonNil(turn["completedAt"], turn["updatedAt"]))
		if started == 0 {
			started = millis()
		}
		provider.session.appendMessage(
			map[string]any{"kind": "turn-start", "threadId": threadID, "turnId": turnID, "createdAt": started},
		)
		status := "completed"
		if stringValue(turn["status"]) == "failed" {
			status = "failed"
		}
		if stringValue(turn["status"]) == "interrupted" {
			status = "cancelled"
		}
		for _, itemValue := range sliceValue(turn["items"]) {
			item := mapValue(itemValue)
			item["threadId"] = threadID
			item["turnId"] = turnID
			provider.applyItem(item, "completed")
		}
		provider.session.appendMessage(
			map[string]any{
				"kind":       "turn-end",
				"threadId":   threadID,
				"turnId":     turnID,
				"status":     status,
				"durationMs": max64(0, completed-started),
				"createdAt":  completed,
			},
		)
	}
	provider.session.mu.RLock()
	messages := make([]map[string]any, len(provider.session.Messages))
	for index, item := range provider.session.Messages {
		messages[index] = publicMessage(item, provider.session.Kind)
	}
	provider.session.mu.RUnlock()
	provider.session.emit(map[string]any{"type": "history-reset", "messages": messages})
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
	provider.session.appendMessage(
		map[string]any{
			"kind":    "status",
			"title":   "Codex status",
			"model":   provider.options["model"],
			"effort":  provider.options["effort"],
			"account": account["account"],
			"context": provider.contextStatus(),
		},
	)
	return nil
}
func (provider *CodexProvider) Close(context.Context) error {
	provider.mu.Lock()
	provider.closed = true
	if provider.stdin != nil {
		_ = provider.stdin.Close()
	}
	if provider.cmd != nil && provider.cmd.Process != nil {
		killProcessTree(provider.cmd)
	}
	provider.cmd = nil
	provider.stdin = nil
	provider.mu.Unlock()
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
		"aborting":               false,
		"resuming":               false,
		"canAbort":               status != "idle",
		"canCompact":             status == "idle" && provider.threadID != "",
		"compacting":             false,
		"pendingPermissionCount": len(provider.permissions),
		"activeSubagentCount":    0,
		"models":                 provider.models,
	}
	provider.mu.Unlock()
	provider.session.setState(state)
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
