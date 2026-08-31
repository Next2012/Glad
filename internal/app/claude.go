package app

import (
	"bufio"
	"context"
	"encoding/base64"
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
	"time"
)

const claudeDenyMessage = "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed."

type claudeTurn struct {
	ID      string
	Started int64
}
type claudePending struct {
	RequestID string
	ToolUseID string
	ToolName  string
	Input     map[string]any
}

type ClaudeProvider struct {
	mu              sync.Mutex
	session         *Session
	options         map[string]any
	cmd             *exec.Cmd
	stdin           io.WriteCloser
	pending         map[string]chan map[string]any
	permissions     map[string]claudePending
	expectedStops   map[*exec.Cmd]struct{}
	turns           []claudeTurn
	closed          bool
	initialized     bool
	resumeID        string
	claudeSessionID string
	allowedTools    map[string]bool
	localCommand    string
}

func NewClaudeProvider(session *Session, options map[string]any) *ClaudeProvider {
	if options == nil {
		options = map[string]any{}
	}
	return &ClaudeProvider{
		session:       session,
		options:       options,
		pending:       map[string]chan map[string]any{},
		permissions:   map[string]claudePending{},
		expectedStops: map[*exec.Cmd]struct{}{},
		allowedTools:  map[string]bool{},
		resumeID:      stringValue(options["resume"]),
	}
}

func claudeRuntimeConfig() map[string]any {
	defaultModel := strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))
	models := []map[string]any{
		{"value": "default", "label": "Default", "resolved": nil, "source": "Claude default"},
	}
	if defaultModel != "" {
		models = append(models, map[string]any{
			"value": defaultModel, "label": "Environment (" + defaultModel + ")", "resolved": defaultModel, "source": "ANTHROPIC_MODEL",
		})
	}
	for _, item := range []struct {
		value, label, environment string
	}{
		{value: "sonnet", label: "Sonnet", environment: "ANTHROPIC_DEFAULT_SONNET_MODEL"},
		{value: "opus", label: "Opus", environment: "ANTHROPIC_DEFAULT_OPUS_MODEL"},
		{value: "haiku", label: "Haiku", environment: "ANTHROPIC_DEFAULT_HAIKU_MODEL"},
	} {
		resolved := firstNonEmpty(strings.TrimSpace(os.Getenv(item.environment)), item.value)
		models = append(models, map[string]any{
			"value": item.value, "label": item.label, "resolved": resolved, "source": item.environment,
		})
	}
	return map[string]any{
		"defaultModel":  firstNonEmpty(defaultModel, "default"),
		"defaultEffort": os.Getenv("CLAUDE_CODE_EFFORT_LEVEL"),
		"models":        models,
		"efforts":       []string{"low", "medium", "high", "xhigh"},
	}
}

func (provider *ClaudeProvider) Start(ctx context.Context) error {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return provider.startLocked(ctx, false)
}

func (provider *ClaudeProvider) startLocked(ctx context.Context, fork bool) error {
	if provider.cmd != nil {
		return nil
	}
	args := []string{
		"--print",
		"--output-format",
		"stream-json",
		"--verbose",
		"--input-format",
		"stream-json",
		"--permission-prompt-tool",
		"stdio",
	}
	mode := stringValue(provider.options["permissionMode"])
	if mode == "" || mode == "default" || mode == "bypassPermissions" {
		mode = "manual"
	}
	args = append(args, "--permission-mode", mode)
	if model := stringValue(provider.options["model"]); model != "" && model != "default" {
		args = append(args, "--model", model)
	}
	if effort := stringValue(provider.options["effort"]); effort != "" {
		args = append(args, "--effort", effort)
	}
	if provider.resumeID != "" {
		args = append(args, "--resume", provider.resumeID)
		if fork {
			args = append(args, "--fork-session")
		}
	}
	command := exec.Command(provider.session.Tool.Command, args...)
	configureProcess(command)
	command.Dir = provider.session.WorkingDirectory
	command.Env = append(os.Environ(), "CLAUDE_CODE_ENTRYPOINT=sdk-go", "CLAUDE_AGENT_SDK_CLIENT_APP=glad-web")
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
	response, err := provider.controlRequestLocked(initCtx, map[string]any{"subtype": "initialize"})
	if err != nil {
		killProcessTree(command)
		provider.cmd = nil
		provider.stdin = nil
		return fmt.Errorf("initialize Claude protocol: %w", err)
	}
	provider.initialized = true
	provider.session.setState(
		map[string]any{
			"permissionMode":         optionDefault(provider.options, "permissionMode", "default"),
			"model":                  optionDefault(provider.options, "model", "default"),
			"effort":                 optionDefault(provider.options, "effort", "high"),
			"status":                 "idle",
			"claudeSessionId":        nilIfEmpty(provider.claudeSessionID),
			"resumeSessionId":        nilIfEmpty(provider.resumeID),
			"canAbort":               false,
			"pendingPermissionCount": 0,
			"commands":               response["commands"],
			"models":                 response["models"],
		},
	)
	return nil
}

func (provider *ClaudeProvider) Send(ctx context.Context, input ProviderInput) error {
	provider.mu.Lock()
	if provider.closed {
		provider.mu.Unlock()
		return errors.New("Claude session is closed")
	}
	if provider.cmd == nil {
		if err := provider.startLocked(ctx, false); err != nil {
			provider.mu.Unlock()
			return err
		}
	}
	turn := claudeTurn{ID: newUUID(), Started: millis()}
	blocks := []any{}
	if strings.TrimSpace(input.AgentText) != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": input.AgentText})
	}
	attachments := []map[string]any{}
	for _, image := range input.Images {
		data, err := os.ReadFile(image.Path)
		if err != nil {
			provider.mu.Unlock()
			return err
		}
		blocks = append(
			blocks,
			map[string]any{
				"type": "image",
				"source": map[string]any{
					"type":       "base64",
					"media_type": image.MediaType,
					"data":       base64.StdEncoding.EncodeToString(data),
				},
			},
		)
		attachments = append(attachments, map[string]any{"id": image.ID, "name": image.Name, "size": image.Size})
	}
	for _, file := range input.Files {
		attachments = append(
			attachments,
			map[string]any{"id": file.ID, "name": file.Name, "size": file.Size, "kind": "file"},
		)
	}
	var content any = input.AgentText
	if len(input.Images) > 0 {
		content = blocks
	}
	message := map[string]any{
		"type":               "user",
		"parent_tool_use_id": nil,
		"session_id":         "",
		"message":            map[string]any{"role": "user", "content": content},
	}
	if err := provider.writeLocked(message); err != nil {
		provider.mu.Unlock()
		return err
	}
	provider.turns = append(provider.turns, turn)
	provider.session.appendMessage(
		map[string]any{
			"kind": "turn-start", "turnId": turn.ID, "createdAt": turn.Started,
			"clientMessageId": input.ClientMessageID,
		},
	)
	provider.session.appendMessage(
		map[string]any{
			"kind": "user", "text": input.Text, "agentText": input.AgentText,
			"attachments": attachments, "turnId": turn.ID, "createdAt": turn.Started,
			"clientMessageId": input.ClientMessageID,
		},
	)
	provider.session.setState(map[string]any{"status": "thinking", "canAbort": true})
	provider.mu.Unlock()
	return nil
}

func (provider *ClaudeProvider) readStdout(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		var message map[string]any
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		switch stringValue(message["type"]) {
		case "control_response":
			provider.handleControlResponse(mapValue(message["response"]))
		case "control_request":
			go provider.handleControlRequest(message)
		case "control_cancel_request":
			provider.cancelControlRequest(stringValue(message["request_id"]))
		case "keep_alive", "transcript_mirror":
		default:
			provider.handleMessage(message)
		}
	}
}

func (provider *ClaudeProvider) readStderr(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			logDebug("[claude] %s", line)
		}
	}
}

func (provider *ClaudeProvider) wait(command *exec.Cmd) {
	provider.handleProcessExit(command, command.Wait())
}

func (provider *ClaudeProvider) handleProcessExit(command *exec.Cmd, err error) {
	provider.mu.Lock()
	_, expected := provider.expectedStops[command]
	delete(provider.expectedStops, command)
	if provider.cmd == command {
		provider.cmd = nil
		provider.stdin = nil
		provider.initialized = false
	}
	closed := provider.closed
	provider.mu.Unlock()
	if !closed && !expected && err != nil {
		provider.session.appendMessage(
			map[string]any{"kind": "event", "level": "error", "text": "Claude session error: " + err.Error()},
		)
		provider.session.setState(map[string]any{"status": "error", "canAbort": false})
	}
}

func (provider *ClaudeProvider) handleControlResponse(response map[string]any) {
	id := stringValue(response["request_id"])
	provider.mu.Lock()
	channel := provider.pending[id]
	if channel != nil {
		delete(provider.pending, id)
	}
	provider.mu.Unlock()
	if channel != nil {
		channel <- response
		close(channel)
	}
}

func (provider *ClaudeProvider) handleControlRequest(message map[string]any) {
	requestID := stringValue(message["request_id"])
	request := mapValue(message["request"])
	if stringValue(request["subtype"]) != "can_use_tool" {
		provider.sendControlError(requestID, "Unsupported control request subtype")
		return
	}
	toolName, toolUseID := stringValue(request["tool_name"]), stringValue(request["tool_use_id"])
	input := mapValue(request["input"])
	if provider.shouldAutoAllow(toolName, input) {
		provider.sendPermissionResponse(requestID, toolUseID, true, input, nil)
		return
	}
	id := newUUID()
	pending := claudePending{RequestID: requestID, ToolUseID: toolUseID, ToolName: toolName, Input: input}
	provider.mu.Lock()
	provider.permissions[id] = pending
	provider.mu.Unlock()
	permission := Permission{
		ID:          id,
		Status:      "pending",
		Title:       firstNonEmpty(stringValue(request["title"]), toolName+" requires approval"),
		ToolName:    toolName,
		DisplayName: stringValue(request["display_name"]),
		Description: stringValue(request["description"]),
		Reason:      firstNonEmpty(stringValue(request["decision_reason"]), stringValue(request["description"])),
		BlockedPath: stringValue(request["blocked_path"]),
		CanAllowTool: toolName != "Edit" && toolName != "Write" && toolName != "NotebookEdit" &&
			toolName != "ExitPlanMode",
		CanAllowEdit: toolName == "Edit" || toolName == "Write" || toolName == "NotebookEdit" ||
			toolName == "ExitPlanMode",
		CanBypass: toolName == "ExitPlanMode",
		Input:     input,
		ToolUseID: toolUseID,
		CreatedAt: millis(),
	}
	provider.session.addPermission(permission)
}

func (provider *ClaudeProvider) cancelControlRequest(requestID string) {
	provider.mu.Lock()
	for id, pending := range provider.permissions {
		if pending.RequestID == requestID {
			delete(provider.permissions, id)
			provider.session.finishPermission(id, "denied", "cancel")
		}
	}
	provider.mu.Unlock()
}

func (provider *ClaudeProvider) Approve(ctx context.Context, id, decision string, payload map[string]any) error {
	provider.mu.Lock()
	pending, ok := provider.permissions[id]
	if ok {
		delete(provider.permissions, id)
	}
	provider.mu.Unlock()
	if !ok {
		return errors.New("permission request not found")
	}
	action := decision
	allowed := decision != "" && decision != "denied" && decision != "deny" && decision != "abort"
	if action == "approved" {
		action = "allow-once"
	}
	updates := []any{}
	if action == "allow-tool" {
		provider.mu.Lock()
		provider.allowedTools[pending.ToolName] = true
		provider.mu.Unlock()
		updates = append(
			updates,
			map[string]any{
				"type":        "addRules",
				"rules":       []any{map[string]any{"toolName": pending.ToolName}},
				"behavior":    "allow",
				"destination": "session",
			},
		)
	}
	if action == "allow-edits" {
		provider.options["permissionMode"] = "acceptEdits"
		updates = append(
			updates,
			map[string]any{
				"type": "addRules",
				"rules": []any{
					map[string]any{"toolName": "Edit"},
					map[string]any{"toolName": "Write"},
					map[string]any{"toolName": "NotebookEdit"},
				},
				"behavior":    "allow",
				"destination": "session",
			},
		)
	}
	if action == "bypass" {
		provider.options["permissionMode"] = "bypassPermissions"
	}
	provider.session.finishPermission(id, map[bool]string{true: "approved", false: "denied"}[allowed], action)
	if allowed {
		provider.sendPermissionResponse(pending.RequestID, pending.ToolUseID, true, pending.Input, updates)
	} else {
		provider.sendPermissionResponse(pending.RequestID, pending.ToolUseID, false, pending.Input, nil)
	}
	provider.session.setState(
		map[string]any{
			"permissionMode":         optionDefault(provider.options, "permissionMode", "default"),
			"pendingPermissionCount": len(provider.permissions),
		},
	)
	return nil
}

func (provider *ClaudeProvider) sendPermissionResponse(
	requestID, toolUseID string,
	allowed bool,
	input map[string]any,
	updates []any,
) {
	response := map[string]any{
		"behavior":               "deny",
		"message":                claudeDenyMessage,
		"interrupt":              true,
		"toolUseID":              toolUseID,
		"decisionClassification": "user_reject",
	}
	if allowed {
		response = map[string]any{
			"behavior":               "allow",
			"updatedInput":           input,
			"toolUseID":              toolUseID,
			"decisionClassification": "user_temporary",
		}
		if len(updates) > 0 {
			response["updatedPermissions"] = updates
		}
	}
	provider.sendControl(requestID, map[string]any{"subtype": "success", "request_id": requestID, "response": response})
}

func (provider *ClaudeProvider) sendControlError(requestID, text string) {
	provider.sendControl(requestID, map[string]any{"subtype": "error", "request_id": requestID, "error": text})
}
func (provider *ClaudeProvider) sendControl(requestID string, response map[string]any) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	_ = provider.writeLocked(map[string]any{"type": "control_response", "response": response})
}

func (provider *ClaudeProvider) handleMessage(message map[string]any) {
	typeName := stringValue(message["type"])
	if typeName == "system" && stringValue(message["subtype"]) == "local_command_output" {
		provider.mu.Lock()
		command := provider.localCommand
		provider.localCommand = ""
		provider.mu.Unlock()
		provider.appendLocalCommand(command, stringValue(message["content"]), nil)
		return
	}
	if typeName == "system" && stringValue(message["subtype"]) == "init" {
		provider.mu.Lock()
		provider.claudeSessionID = stringValue(message["session_id"])
		provider.resumeID = provider.claudeSessionID
		provider.mu.Unlock()
		provider.session.appendMessage(
			map[string]any{
				"kind":  "event",
				"level": "info",
				"text":  "Claude ready" + modelSuffix(stringValue(message["model"])),
			},
		)
		provider.session.setState(
			map[string]any{
				"claudeSessionId": nilIfEmpty(provider.claudeSessionID),
				"resumeSessionId": nilIfEmpty(provider.resumeID),
				"model":           message["model"],
			},
		)
		return
	}
	provider.mu.Lock()
	var turn *claudeTurn
	if len(provider.turns) > 0 {
		copy := provider.turns[0]
		turn = &copy
	}
	provider.mu.Unlock()
	turnID := ""
	if turn != nil {
		turnID = turn.ID
	}
	if typeName == "assistant" {
		content := sliceValue(mapValue(message["message"])["content"])
		text := textFromClaudeContent(content)
		if strings.TrimSpace(text) != "" {
			provider.session.appendMessage(
				map[string]any{
					"kind":   "assistant",
					"text":   strings.TrimSpace(text),
					"raw":    message,
					"turnId": nilIfEmpty(turnID),
				},
			)
		}
		for _, blockValue := range content {
			block := mapValue(blockValue)
			if stringValue(block["type"]) != "tool_use" {
				continue
			}
			provider.session.appendMessage(
				map[string]any{
					"kind":        "tool",
					"name":        firstNonEmpty(stringValue(block["name"]), "tool"),
					"summary":     summarizeToolInput(mapValue(block["input"])),
					"input":       block["input"],
					"toolUseId":   block["id"],
					"turnId":      nilIfEmpty(turnID),
					"startedAtMs": millis(),
				},
			)
		}
		provider.session.setState(map[string]any{"status": "thinking", "canAbort": true})
		return
	}
	if typeName == "user" {
		for _, blockValue := range sliceValue(mapValue(message["message"])["content"]) {
			block := mapValue(blockValue)
			if stringValue(block["type"]) == "tool_result" {
				provider.session.appendMessage(
					map[string]any{
						"kind":          "tool-result",
						"toolUseId":     block["tool_use_id"],
						"text":          strings.TrimSpace(textFromClaudeContent([]any{block})),
						"isError":       boolValue(block["is_error"]),
						"turnId":        nilIfEmpty(turnID),
						"completedAtMs": millis(),
					},
				)
			}
		}
		return
	}
	if typeName == "result" {
		provider.mu.Lock()
		localCommand := provider.localCommand
		if localCommand != "" {
			provider.localCommand = ""
		}
		provider.mu.Unlock()
		if localCommand != "" {
			output := stringValue(message["result"])
			if output == "" {
				output = "Claude command returned no output"
			}
			provider.appendLocalCommand(localCommand, output, nil)
			provider.session.setState(map[string]any{"status": "idle", "canAbort": false})
			return
		}
		provider.mu.Lock()
		if len(provider.turns) > 0 {
			completed := provider.turns[0]
			provider.turns = provider.turns[1:]
			turn = &completed
		}
		provider.mu.Unlock()
		if turn != nil {
			status := "completed"
			if boolValue(message["is_error"]) || stringValue(message["subtype"]) != "success" {
				status = "failed"
			}
			duration := numberInt64(message["duration_ms"])
			if duration == 0 {
				duration = millis() - turn.Started
			}
			provider.session.appendMessage(
				map[string]any{"kind": "turn-end", "turnId": turn.ID, "turnStatus": status, "durationMs": duration},
			)
		}
		provider.session.mu.Lock()
		provider.session.HasUnreadCompletion = true
		provider.session.mu.Unlock()
		provider.session.setState(map[string]any{"status": "idle", "canAbort": false})
		return
	}
}

func (provider *ClaudeProvider) controlRequestLocked(
	ctx context.Context,
	request map[string]any,
) (map[string]any, error) {
	id := newUUID()
	channel := make(chan map[string]any, 1)
	provider.pending[id] = channel
	if err := provider.writeLocked(map[string]any{"request_id": id, "type": "control_request", "request": request}); err != nil {
		delete(provider.pending, id)
		return nil, err
	}
	provider.mu.Unlock()
	defer provider.mu.Lock()
	select {
	case response := <-channel:
		if stringValue(response["subtype"]) != "success" {
			return nil, errors.New(stringValue(response["error"]))
		}
		return mapValue(response["response"]), nil
	case <-ctx.Done():
		provider.mu.Lock()
		delete(provider.pending, id)
		provider.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (provider *ClaudeProvider) writeLocked(value any) error {
	if provider.stdin == nil {
		return errors.New("Claude process is not running")
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return err
	}
	bytes = append(bytes, '\n')
	_, err = provider.stdin.Write(bytes)
	return err
}

func (provider *ClaudeProvider) UpdateSettings(ctx context.Context, settings map[string]any) error {
	provider.mu.Lock()
	previousEffort := stringValue(provider.options["effort"])
	for key, value := range settings {
		provider.options[key] = value
	}
	mode := stringValue(settings["permissionMode"])
	if mode == "bypassPermissions" {
		mode = "default"
	}
	if mode != "" && provider.cmd != nil {
		_, _ = provider.controlRequestLocked(ctx, map[string]any{"subtype": "set_permission_mode", "mode": mode})
	}
	if model := stringValue(settings["model"]); model != "" && model != "default" && provider.cmd != nil {
		_, _ = provider.controlRequestLocked(ctx, map[string]any{"subtype": "set_model", "model": model})
	}
	if effort := stringValue(settings["effort"]); effort != "" && effort != previousEffort &&
		provider.session.StatusValue == "idle" &&
		provider.cmd != nil {
		provider.stopLocked()
		_ = provider.startLocked(ctx, false)
	}
	provider.mu.Unlock()
	provider.session.setState(
		map[string]any{
			"permissionMode": optionDefault(provider.options, "permissionMode", "default"),
			"model":          optionDefault(provider.options, "model", "default"),
			"effort":         optionDefault(provider.options, "effort", "high"),
		},
	)
	return nil
}

func (provider *ClaudeProvider) Interrupt(ctx context.Context) error {
	provider.mu.Lock()
	if provider.cmd == nil {
		provider.mu.Unlock()
		return nil
	}
	_, err := provider.controlRequestLocked(ctx, map[string]any{"subtype": "interrupt"})
	provider.mu.Unlock()
	provider.session.setState(map[string]any{"status": "idle", "canAbort": false})
	provider.session.appendMessage(map[string]any{"kind": "event", "level": "info", "text": "Aborted by user"})
	return err
}
func (provider *ClaudeProvider) Resume(ctx context.Context, id string) error {
	provider.mu.Lock()
	provider.resumeID = strings.TrimSpace(id)
	provider.stopLocked()
	err := provider.startLocked(ctx, false)
	provider.mu.Unlock()
	if err == nil {
		provider.session.appendMessage(
			map[string]any{"kind": "event", "level": "info", "text": "Resume target selected: " + id},
		)
	}
	return err
}
func (provider *ClaudeProvider) Fork(ctx context.Context, id string) (string, error) {
	provider.mu.Lock()
	provider.resumeID = strings.TrimSpace(id)
	provider.stopLocked()
	err := provider.startLocked(ctx, true)
	provider.mu.Unlock()
	return provider.claudeSessionID, err
}
func (provider *ClaudeProvider) Compact(context.Context) error {
	return errors.New("Claude compact is managed automatically")
}
func (provider *ClaudeProvider) Status(ctx context.Context) error {
	return provider.RunLocalCommand(ctx, "/usage")
}

func (provider *ClaudeProvider) RunLocalCommand(ctx context.Context, command string) error {
	provider.mu.Lock()
	if provider.cmd == nil {
		if err := provider.startLocked(ctx, false); err != nil {
			provider.mu.Unlock()
			return err
		}
	}
	if provider.localCommand != "" {
		provider.mu.Unlock()
		return errors.New("Another Claude local command is already running")
	}
	provider.localCommand = command
	err := provider.writeLocked(
		map[string]any{
			"type":               "user",
			"parent_tool_use_id": nil,
			"session_id":         "",
			"message":            map[string]any{"role": "user", "content": command},
		},
	)
	provider.mu.Unlock()
	return err
}

func (provider *ClaudeProvider) appendLocalCommand(command, output string, commandErr error) {
	message := map[string]any{"title": "Claude " + strings.TrimPrefix(command, "/")}
	if commandErr != nil {
		message["error"] = commandErr.Error()
	} else if command == "/context" {
		parsed, err := parseClaudeContext(output)
		if err != nil {
			message["error"] = err.Error()
		} else {
			message["context"] = parsed
		}
	} else {
		parsed, err := parseClaudeUsage(output)
		if err != nil {
			message["error"] = err.Error()
		} else {
			message["usage"] = map[string]any{"source": "claude-cli-command", "session": parsed, "fetchedAt": millis()}
		}
	}
	if command == "/context" {
		message["kind"] = "context"
		message["title"] = "Claude context"
	} else {
		message["kind"] = "usage"
		message["title"] = "Claude usage"
	}
	provider.session.appendMessage(message)
}

var ansiPattern = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

func parseTokenCount(value string) any {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), ",", "")
	match := regexp.MustCompile(`(?i)^([\d.]+)\s*([kmb])?$`).FindStringSubmatch(normalized)
	if len(match) < 2 {
		return nil
	}
	amount, _ := strconv.ParseFloat(match[1], 64)
	multiplier := 1.0
	if len(match) > 2 {
		switch strings.ToLower(match[2]) {
		case "k":
			multiplier = 1e3
		case "m":
			multiplier = 1e6
		case "b":
			multiplier = 1e9
		}
	}
	return int64(amount*multiplier + .5)
}
func parseClaudeUsage(output string) (map[string]any, error) {
	text := strings.ReplaceAll(ansiPattern.ReplaceAllString(output, ""), "\r", "")
	patterns := map[string]*regexp.Regexp{
		"cost":    regexp.MustCompile(`(?i)Total cost:\s*\$([\d,.]+)`),
		"api":     regexp.MustCompile(`(?i)Total duration \(API\):\s*([^\n]+)`),
		"wall":    regexp.MustCompile(`(?i)Total duration \(wall\):\s*([^\n]+)`),
		"changes": regexp.MustCompile(`(?i)Total code changes:\s*([\d,]+) lines added,\s*([\d,]+) lines removed`),
		"tokens": regexp.MustCompile(
			`(?i)Usage:\s*([\d,.kmb]+) input,\s*([\d,.kmb]+) output,\s*([\d,.kmb]+) cache read,\s*([\d,.kmb]+) cache write`,
		),
	}
	matches := map[string][]string{}
	for key, pattern := range patterns {
		matches[key] = pattern.FindStringSubmatch(text)
	}
	if len(matches["cost"])+len(matches["api"])+len(matches["tokens"]) == 0 {
		return nil, errors.New("Claude CLI returned an unrecognized /usage response")
	}
	result := map[string]any{
		"totalCostUsd":     nil,
		"apiDuration":      nil,
		"wallDuration":     nil,
		"linesAdded":       nil,
		"linesRemoved":     nil,
		"inputTokens":      nil,
		"outputTokens":     nil,
		"cacheReadTokens":  nil,
		"cacheWriteTokens": nil,
		"models":           []any{},
	}
	if len(matches["cost"]) > 1 {
		result["totalCostUsd"] = numberString(matches["cost"][1])
	}
	if len(matches["api"]) > 1 {
		result["apiDuration"] = strings.TrimSpace(matches["api"][1])
	}
	if len(matches["wall"]) > 1 {
		result["wallDuration"] = strings.TrimSpace(matches["wall"][1])
	}
	if len(matches["changes"]) > 2 {
		result["linesAdded"] = numberIntString(matches["changes"][1])
		result["linesRemoved"] = numberIntString(matches["changes"][2])
	}
	if len(matches["tokens"]) > 4 {
		result["inputTokens"] = parseTokenCount(matches["tokens"][1])
		result["outputTokens"] = parseTokenCount(matches["tokens"][2])
		result["cacheReadTokens"] = parseTokenCount(matches["tokens"][3])
		result["cacheWriteTokens"] = parseTokenCount(matches["tokens"][4])
	}
	return result, nil
}
func parseClaudeContext(output string) (map[string]any, error) {
	text := strings.ReplaceAll(ansiPattern.ReplaceAllString(output, ""), "\r", "")
	tokens := regexp.MustCompile(`(?im)^\*\*Tokens:\*\*\s*([\d,.]+\s*[kmb]?)\s*/\s*([\d,.]+\s*[kmb]?)\s*\(([\d.]+)%\)`).
		FindStringSubmatch(text)
	if len(tokens) < 4 {
		return nil, errors.New("Claude CLI returned an unrecognized /context response")
	}
	used, max := parseTokenCount(tokens[1]), parseTokenCount(tokens[2])
	usedNumber, maxNumber := numberInt64(used), numberInt64(max)
	percent, _ := strconv.ParseFloat(tokens[3], 64)
	model := ""
	if match := regexp.MustCompile(`(?im)^\*\*Model:\*\*\s*(.+?)\s*$`).FindStringSubmatch(text); len(match) > 1 {
		model = strings.TrimSpace(match[1])
	}
	return map[string]any{
		"model":           nilIfEmpty(model),
		"usedTokens":      used,
		"maxTokens":       max,
		"usedPercent":     percent,
		"remainingTokens": max64(0, maxNumber-usedNumber),
		"categories":      []any{},
	}, nil
}
func numberString(value string) float64 {
	number, _ := strconv.ParseFloat(strings.ReplaceAll(value, ",", ""), 64)
	return number
}
func numberIntString(value string) int64 {
	number, _ := strconv.ParseInt(strings.ReplaceAll(value, ",", ""), 10, 64)
	return number
}
func (provider *ClaudeProvider) Close(context.Context) error {
	provider.mu.Lock()
	provider.closed = true
	provider.stopLocked()
	provider.mu.Unlock()
	return nil
}
func (provider *ClaudeProvider) stopLocked() {
	if provider.cmd != nil {
		provider.expectedStops[provider.cmd] = struct{}{}
	}
	if provider.stdin != nil {
		_ = provider.stdin.Close()
	}
	if provider.cmd != nil && provider.cmd.Process != nil {
		_ = provider.cmd.Process.Signal(os.Interrupt)
		time.Sleep(50 * time.Millisecond)
		killProcessTree(provider.cmd)
	}
	provider.cmd = nil
	provider.stdin = nil
	provider.initialized = false
}

func (provider *ClaudeProvider) shouldAutoAllow(tool string, input map[string]any) bool {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if provider.allowedTools[tool] {
		return true
	}
	mode := stringValue(provider.options["permissionMode"])
	if mode == "bypassPermissions" && tool != "ExitPlanMode" {
		return true
	}
	if mode == "acceptEdits" && (tool == "Edit" || tool == "Write" || tool == "NotebookEdit") {
		return true
	}
	if mode == "plan" && tool != "Bash" && tool != "Edit" && tool != "Write" && tool != "NotebookEdit" &&
		tool != "ExitPlanMode" {
		return true
	}
	return false
}
func textFromClaudeContent(content []any) string {
	parts := []string{}
	for _, itemValue := range content {
		item := mapValue(itemValue)
		switch stringValue(item["type"]) {
		case "text":
			parts = append(parts, stringValue(item["text"]))
		case "tool_result":
			if text, ok := item["content"].(string); ok {
				parts = append(parts, text)
			} else {
				parts = append(parts, textFromClaudeContent(sliceValue(item["content"])))
			}
		}
	}
	return strings.Join(parts, "\n")
}
func summarizeToolInput(input map[string]any) string {
	for _, key := range []string{"command", "file_path", "path"} {
		if text := stringValue(input[key]); text != "" {
			return text
		}
	}
	bytes, _ := json.Marshal(input)
	if len(bytes) > 240 {
		bytes = append(bytes[:240], '.', '.', '.')
	}
	return string(bytes)
}
func optionDefault(options map[string]any, key string, fallback any) any {
	if value := options[key]; value != nil && stringValue(value) != "" {
		return value
	}
	return fallback
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
func modelSuffix(model string) string {
	if model == "" {
		return ""
	}
	return " (" + model + ")"
}
func numberInt64(value any) int64 {
	switch n := value.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	}
	return 0
}
func logDebug(format string, args ...any) {
	if os.Getenv("DEBUG") == "1" || os.Getenv("GLAD_DEBUG") == "1" {
		fmt.Fprintf(os.Stderr, format+"\n", args...)
	}
}
