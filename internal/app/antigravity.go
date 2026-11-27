package app

// Antigravity owns its ACP transport and lifecycle. ACP session/prompt is a
// long-lived RPC, so no command or provider lock is held while inference runs.
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
	"strings"
	"sync"
	"time"
)

type antigravityReply struct {
	result map[string]any
	err    error
}
type antigravityRequest struct {
	generation uint64
	reply      chan antigravityReply
}
type antigravityInteraction struct {
	rpcID      any
	generation uint64
	params     map[string]any
}
type antigravityStream struct {
	id          string
	text        strings.Builder
	completedAt int64
	replayed    map[string]any
}
type antigravityReplay struct {
	sessionID     string
	title         string
	messages      []map[string]any
	streams       map[string]*antigravityStream
	tools         map[string]map[string]any
	turnID        string
	updated       time.Time
	configOptions []map[string]any
	commands      []map[string]any
	modes         map[string]any
	sequence      uint64
}
type AntigravityProvider struct {
	subagentsMu         sync.Mutex
	subagents           *antigravitySubagentReader
	opMu                sync.Mutex // serializes process startup, settings and conversation changes
	mu                  sync.Mutex
	writeMu             sync.Mutex
	session             *Session
	options             map[string]any
	cmd                 *exec.Cmd
	stdin               io.WriteCloser
	generation          uint64
	sequence            uint64
	pending             map[string]antigravityRequest
	permissions         map[string]antigravityInteraction
	questions           map[string]antigravityInteraction
	streams             map[string]*antigravityStream
	tools               map[string]map[string]any
	capabilities        map[string]any
	metadata            map[string]any
	previewIDs          map[string]uint64 // IDs returned by authenticated native listing, scoped to generation
	configOptions       []map[string]any
	modes               map[string]any
	commands            []map[string]any
	nativeID            string
	turnID              string
	started             int64
	wirePrompts         int
	deferred            bool
	deferredTools       bool
	compacting          bool
	compactionMessageID string
	followupSettled     bool
	stopping            bool
	switching           bool
	switchCancel        context.CancelFunc
	closed              bool
	ready               bool
	turnError           error
	turnCancelled       bool
	settleTimer         *time.Timer
	replay              *antigravityReplay
	usage               map[string]any
	quota               map[string]any
	quotaTime           time.Time
	quotaPending        bool

	permissionDir          string
	permissionSettings     map[string]any
	permissionOverrides    map[string]any
	permissionApplying     bool
	permissionSessionRules agyRuleDocument
	sandboxWarning         string
	modeInherited          bool
	processDone            chan struct{}
}

func NewAntigravityProvider(session *Session, options map[string]any) *AntigravityProvider {
	if options == nil {
		options = map[string]any{}
	}
	return &AntigravityProvider{session: session, options: cloneMap(options), pending: map[string]antigravityRequest{}, permissions: map[string]antigravityInteraction{}, questions: map[string]antigravityInteraction{}, streams: map[string]*antigravityStream{}, tools: map[string]map[string]any{}, capabilities: map[string]any{}, metadata: map[string]any{}, modes: map[string]any{}, usage: map[string]any{}}
}

func (p *AntigravityProvider) Start(ctx context.Context) error {
	p.opMu.Lock()
	defer p.opMu.Unlock()
	return p.start(ctx)
}
func (p *AntigravityProvider) start(ctx context.Context) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return errors.New("Antigravity session is closed")
	}
	if p.cmd != nil && p.ready {
		p.mu.Unlock()
		return nil
	}
	if err := p.preparePermissionProfileLocked(); err != nil {
		p.mu.Unlock()
		return err
	}
	restore := firstNonEmpty(p.nativeID, stringValue(p.options["resume"]))
	p.generation++
	generation := p.generation
	args := []string{"acp", "--disable-telemetry"}
	if p.permissionDir != "" {
		args = append(args, "--cli_dir_name", p.permissionDir)
	}
	command := exec.Command(p.session.Tool.Command, args...)
	configureProcess(command)
	command.Dir = p.session.WorkingDirectory
	command.Env = append(os.Environ(), p.session.environment...)
	stdin, err := command.StdinPipe()
	if err != nil {
		p.mu.Unlock()
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		p.mu.Unlock()
		return err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		p.mu.Unlock()
		return err
	}
	if err = command.Start(); err != nil {
		_ = stdin.Close()
		p.mu.Unlock()
		return err
	}
	done := make(chan struct{})
	p.cmd, p.stdin, p.processDone = command, stdin, done
	p.mu.Unlock()
	go p.read(stdout, command, generation)
	go func() { _, _ = io.Copy(io.Discard, stderr) }()
	go func() {
		err := command.Wait()
		close(done)
		if err == nil {
			err = errors.New("Antigravity ACP exited")
		}
		p.transportFailed(command, generation, err)
	}()
	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	initialized, err := p.rpc(initCtx, "initialize", map[string]any{
		"protocolVersion": 1, "clientInfo": map[string]any{"name": "glad", "version": buildVersion},
		"clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": false, "elicitation": map[string]any{"form": map[string]any{}}},
	})
	if err != nil {
		p.recycle(generation)
		return fmt.Errorf("initialize Antigravity ACP: %w", err)
	}
	p.mu.Lock()
	p.capabilities = mapValue(initialized["agentCapabilities"])
	p.metadata = mapValue(firstNonNil(p.capabilities["_meta"], initialized["_meta"]))
	p.mu.Unlock()
	params, err := p.openParams(restore)
	if err != nil {
		p.recycle(generation)
		return err
	}
	p.mu.Lock()
	p.replay = newAntigravityReplay(restore)
	p.mu.Unlock()
	method := "session/new"
	if restore != "" {
		p.mu.Lock()
		supported := boolValue(p.capabilities["loadSession"])
		p.replay = newAntigravityReplay(restore)
		p.mu.Unlock()
		if !supported {
			p.recycle(generation)
			return errors.New("Antigravity does not support loading saved sessions")
		}
		method = "session/load"
	}
	response, err := p.rpc(initCtx, method, params)
	if err == nil && restore != "" {
		err = p.waitReplay(initCtx, generation)
	}
	p.mu.Lock()
	replay := p.replay
	p.replay = nil
	if err == nil && p.generation == generation {
		p.nativeID = firstNonEmpty(stringValue(response["sessionId"]), restore)
		if p.nativeID == "" {
			err = errors.New("Antigravity returned no session id")
		} else {
			p.applyOpenLocked(response)
			if replay != nil && replay.commands != nil {
				p.commands = replay.commands
			}
			p.ready = true
			if replay != nil && restore != "" {
				p.session.mu.RLock()
				empty := len(p.session.Messages) == 0
				p.session.mu.RUnlock()
				if empty {
					p.session.replaceMessagesWithState(p.finishReplayWithTimesLocked(replay), p.historyIdentityLocked())
				}
			}
			p.publishStateLocked()
			if replay != nil && replay.title != "" {
				p.session.setAutomaticName(replay.title)
			}
		}
	}
	settings := map[string]any{}
	for _, key := range []string{"model", "effort", "mode"} {
		if value := stringValue(p.options[key]); value != "" && (value != "default" || key == "mode") {
			if key == "mode" && p.modeInherited && !p.supportsModeLocked(value) {
				continue
			}
			settings[key] = value
		}
	}
	p.mu.Unlock()
	if err != nil {
		p.recycle(generation)
		return err
	}
	if len(settings) > 0 {
		if err = p.updateSettings(ctx, settings); err != nil {
			p.recycle(generation)
			return err
		}
	}
	return nil
}
func (p *AntigravityProvider) openParams(id string) (map[string]any, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	servers := []any{}
	if p.session.mcpURL != "" && p.session.mcpExecutable != "" {
		config := supervisorMCPConfig(p.session)
		env := []any{}
		for _, key := range []string{"GLAD_SUPERVISOR_URL", "GLAD_SUPERVISOR_TOKEN", "GLAD_SUPERVISOR_SESSION"} {
			env = append(env, map[string]any{"name": key, "value": config["env"].(map[string]string)[key]})
		}
		servers = append(servers, map[string]any{"name": "glad", "command": config["command"], "args": config["args"], "env": env})
	}
	params := map[string]any{"cwd": p.session.WorkingDirectory, "mcpServers": servers}
	if id != "" {
		params["sessionId"] = id
	}
	if instructions := stringValue(p.options["developerInstructions"]); instructions != "" {
		if !boolValue(mapValue(mapValue(p.metadata["antigravity"])["systemPrompt"])["append"]) {
			return nil, errors.New("Antigravity ACP does not advertise session system instructions")
		}
		params["_meta"] = map[string]any{"antigravity": map[string]any{"systemPrompt": map[string]any{"append": instructions}}}
	}
	return params, nil
}
func (p *AntigravityProvider) applyOpenLocked(response map[string]any) {
	if response["configOptions"] != nil {
		p.configOptions = mapsFromAny(response["configOptions"])
	}
	if response["modes"] != nil {
		p.modes = mapValue(response["modes"])
	}
}

// Caller owns p.mu. Only the short JSON write is synchronous.
func (p *AntigravityProvider) requestLocked(method string, params map[string]any) (string, chan antigravityReply, error) {
	if p.closed || p.stdin == nil {
		return "", nil, errors.New("Antigravity ACP is disconnected")
	}
	p.sequence++
	id := fmt.Sprintf("glad-%d-%d", p.generation, p.sequence)
	reply := make(chan antigravityReply, 1)
	p.pending[id] = antigravityRequest{p.generation, reply}
	if err := p.writeLocked(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		delete(p.pending, id)
		return "", nil, err
	}
	return id, reply, nil
}
func (p *AntigravityProvider) writeLocked(message map[string]any) error {
	if p.stdin == nil {
		return errors.New("Antigravity ACP is disconnected")
	}
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if writer, ok := p.stdin.(interface{ SetWriteDeadline(time.Time) error }); ok {
		_ = writer.SetWriteDeadline(time.Now().Add(5 * time.Second))
		defer writer.SetWriteDeadline(time.Time{})
	}
	_, err = p.stdin.Write(append(data, '\n'))
	return err
}
func (p *AntigravityProvider) rpc(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	p.mu.Lock()
	id, reply, err := p.requestLocked(method, params)
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case response := <-reply:
		return response.result, response.err
	case <-ctx.Done():
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		return nil, ctx.Err()
	}
}
func (p *AntigravityProvider) read(reader io.Reader, command *exec.Cmd, generation uint64) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		var message map[string]any
		decoder := json.NewDecoder(strings.NewReader(scanner.Text()))
		decoder.UseNumber()
		if decoder.Decode(&message) != nil {
			continue
		}
		p.mu.Lock()
		if p.generation != generation || p.cmd != command || p.closed {
			p.mu.Unlock()
			return
		}
		method := stringValue(message["method"])
		if method == "" {
			id := fmt.Sprint(message["id"])
			if request, ok := p.pending[id]; ok && request.generation == generation {
				delete(p.pending, id)
				response := antigravityReply{result: mapValue(message["result"])}
				if rpcError := mapValue(message["error"]); len(rpcError) > 0 {
					response.err = fmt.Errorf("Antigravity ACP: %s", stringValue(rpcError["message"]))
				}
				request.reply <- response
			}
		} else if message["id"] != nil {
			p.serverRequestLocked(message["id"], method, mapValue(message["params"]), generation)
		} else if method == "session/update" {
			p.updateLocked(mapValue(message["params"]))
		}
		p.mu.Unlock()
	}
	err := scanner.Err()
	if err == nil {
		err = io.EOF
	}
	p.transportFailed(command, generation, err)
}
func (p *AntigravityProvider) transportFailed(command *exec.Cmd, generation uint64, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.generation != generation || p.cmd != command {
		return
	}
	p.cmd = nil
	p.stdin = nil
	p.ready = false
	go killProcessTree(command)
	for id, request := range p.pending {
		delete(p.pending, id)
		request.reply <- antigravityReply{err: fmt.Errorf("Antigravity ACP disconnected: %w", err)}
	}
	if p.turnID != "" {
		status := "failed"
		if p.stopping {
			status = "cancelled"
		}
		p.finishTurnLocked(status, err)
	} else if !p.closed {
		p.publishStateLocked()
	}
}
func (p *AntigravityProvider) recycle(generation uint64) {
	p.mu.Lock()
	if p.generation != generation {
		p.mu.Unlock()
		return
	}
	command := p.cmd
	done := p.processDone
	p.cmd = nil
	p.stdin = nil
	p.ready = false
	p.generation++
	for id, request := range p.pending {
		delete(p.pending, id)
		request.reply <- antigravityReply{err: errors.New("Antigravity ACP restarted")}
	}
	p.mu.Unlock()
	if command != nil {
		killProcessTree(command)
		if done != nil {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
		}
	}
}

func (p *AntigravityProvider) promptContent(input ProviderInput) ([]any, error) {
	if len(input.Skills) > 0 && strings.TrimSpace(input.AgentText) == "" {
		return nil, errors.New("Antigravity skills must be resolved into prompt context")
	}
	content := []any{}
	if text := firstNonEmpty(input.AgentText, input.Text); text != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	p.mu.Lock()
	images := boolValue(mapValue(p.capabilities["promptCapabilities"])["image"])
	p.mu.Unlock()
	if len(input.Images) > 0 && !images {
		return nil, errors.New("Antigravity ACP does not support images")
	}
	for _, image := range input.Images {
		data, err := os.ReadFile(image.Path)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]any{"type": "image", "mimeType": firstNonEmpty(image.MediaType, "image/png"), "data": base64.StdEncoding.EncodeToString(data)})
	}
	if len(content) == 0 {
		return nil, errors.New("empty Antigravity prompt")
	}
	return content, nil
}
func (p *AntigravityProvider) Send(ctx context.Context, input ProviderInput) error {
	if input.Delivery == "steer" {
		return p.Steer(ctx, input, input.ExpectedTurnID)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	p.opMu.Lock()
	defer p.opMu.Unlock()
	if err := p.start(ctx); err != nil {
		return err
	}
	content, err := p.promptContent(input)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || !p.ready || p.turnID != "" || p.switching || p.stopping {
		return errors.New("Antigravity session is busy or unavailable")
	}
	_, reply, err := p.requestLocked("session/prompt", map[string]any{"sessionId": p.nativeID, "prompt": content})
	if err != nil {
		return err
	}
	p.session.beginInput(input)
	p.turnID = newUUID()
	p.started = millis()
	p.wirePrompts = 1
	p.deferred = false
	p.deferredTools = false
	p.followupSettled = false
	p.turnError = nil
	p.turnCancelled = false
	p.streams = map[string]*antigravityStream{}
	p.tools = map[string]map[string]any{}
	p.session.clearUnreadCompletion()
	p.appendLocked(map[string]any{"kind": "turn-start"})
	p.appendUserLocked(input, false)
	if p.session.speed != nil {
		p.session.speed.begin(p.nativeID, p.turnID, p.metricSettingLocked("model"), "antigravity-acp", p.metricSettingLocked("thought_level"), false)
	}
	if input.Internal && strings.TrimSpace(input.AgentText) == "/compact" {
		p.compacting = true
		p.compactionMessageID = newUUID()
		p.appendLocked(map[string]any{"id": p.compactionMessageID, "kind": "compaction", "compactionStatus": "in_progress", "trigger": "manual", "text": "Compacting Antigravity conversation"})
	}
	p.publishStateLocked()
	go p.awaitPrompt(reply, p.generation, p.turnID, false, "")
	return nil
}
func (p *AntigravityProvider) appendUserLocked(input ProviderInput, steering bool) string {
	if input.Internal {
		return ""
	}
	id := newUUID()
	attachments := []any{}
	for _, image := range input.Images {
		attachments = append(attachments, map[string]any{"id": image.ID, "name": image.Name, "size": image.Size, "mediaType": image.MediaType})
	}
	for _, file := range input.Files {
		attachments = append(attachments, map[string]any{"id": file.ID, "name": file.Name, "size": file.Size, "kind": "file"})
	}
	p.appendLocked(map[string]any{"id": id, "kind": "user", "text": input.Text, "clientMessageId": input.ClientMessageID, "attachments": attachments, "internal": input.Internal, "agentText": input.AgentText, "supervisorSource": input.Source.values(), "delivery": map[bool]string{true: "steer", false: "turn"}[steering]})
	return id
}
func (p *AntigravityProvider) awaitPrompt(reply chan antigravityReply, generation uint64, turn string, steering bool, userID string) {
	// The session owns inference. A websocket request ending must not abort it.
	var response antigravityReply
	select {
	case response = <-reply:
	case <-p.session.ctx.Done():
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.generation != generation || p.turnID != turn || p.closed {
		return
	}
	p.wirePrompts--
	if p.wirePrompts == 0 {
		p.completeStreamsLocked()
	}
	if response.err != nil {
		if steering {
			p.session.patchMessage(userID, map[string]any{"deliveryStatus": "failed", "error": response.err.Error()})
			p.appendLocked(map[string]any{"kind": "event", "level": "error", "text": "Antigravity steering failed: " + response.err.Error()})
		} else {
			p.turnError = response.err
		}
	}
	if stringValue(response.result["stopReason"]) == "cancelled" {
		p.turnCancelled = true
	}
	p.session.speed.antigravityUsage(mapValue(response.result["usage"]))
	if usage := mapValue(response.result["usage"]); len(usage) > 0 {
		merged := cloneMap(p.usage)
		for key, value := range usage {
			merged[key] = value
		}
		p.usage = merged
	}
	p.deferred = true
	if p.hasOpenToolsLocked() {
		p.deferredTools = true
		p.followupSettled = false
	} else if p.deferredTools && response.err == nil {
		p.followupSettled = true
	}
	p.scheduleSettleLocked()
	p.publishStateLocked()
}
func (p *AntigravityProvider) hasOpenToolsLocked() bool {
	for _, tool := range p.tools {
		status := stringValue(tool["status"])
		if (status == "pending" || status == "in_progress") && !boolValue(mapValue(tool["rawInput"])["IsDaemon"]) {
			return true
		}
	}
	return false
}
func (p *AntigravityProvider) canSteerLocked() bool {
	return p.ready && !p.closed && !p.stopping && !p.switching && !p.compacting && p.turnID != "" && len(p.permissions) == 0 && len(p.questions) == 0
}
func (p *AntigravityProvider) CanSteer() (bool, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.canSteerLocked() {
		return true, ""
	}
	return false, "Antigravity steering requires an active turn without pending interactions"
}
func (p *AntigravityProvider) Steer(ctx context.Context, input ProviderInput, expectedTurnID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	content, err := p.promptContent(input)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if expectedTurnID == "" || expectedTurnID != p.turnID {
		return errors.New("Antigravity turn changed; refresh before steering")
	}
	if !p.canSteerLocked() {
		return errors.New("Antigravity steering requires an active turn without pending interactions")
	}
	_, reply, err := p.requestLocked("session/prompt", map[string]any{"sessionId": p.nativeID, "prompt": content})
	if err != nil {
		return err
	}
	if p.settleTimer != nil {
		p.settleTimer.Stop()
		p.settleTimer = nil
	}
	p.completeStreamsLocked()
	p.streams = map[string]*antigravityStream{}
	p.wirePrompts++
	p.followupSettled = false
	userID := p.appendUserLocked(input, true)
	p.publishStateLocked()
	go p.awaitPrompt(reply, p.generation, p.turnID, true, userID)
	return nil
}
func (p *AntigravityProvider) scheduleSettleLocked() {
	if p.settleTimer != nil {
		p.settleTimer.Stop()
		p.settleTimer = nil
	}
	if p.turnID == "" || !p.deferred || p.wirePrompts > 0 {
		return
	}
	if !p.stopping && !p.turnCancelled && p.turnError == nil && (p.hasOpenToolsLocked() || len(p.permissions) > 0 || len(p.questions) > 0) {
		return
	}
	if p.stopping && !p.turnCancelled {
		return
	}
	delay := 500 * time.Millisecond
	if p.deferredTools && !p.followupSettled && !p.turnCancelled && p.turnError == nil {
		delay = 120 * time.Second
	}
	turn, generation := p.turnID, p.generation
	p.settleTimer = time.AfterFunc(delay, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.turnID != turn || p.generation != generation {
			return
		}
		status := "completed"
		if p.turnError != nil {
			status = "failed"
		}
		if p.stopping || p.turnCancelled {
			status = "cancelled"
		}
		p.finishTurnLocked(status, p.turnError)
	})
}
func (p *AntigravityProvider) finishTurnLocked(status string, err error) {
	if p.turnID == "" {
		return
	}
	if p.settleTimer != nil {
		p.settleTimer.Stop()
		p.settleTimer = nil
	}
	p.completeStreamsLocked()
	p.session.patchMessage("antigravity-plan-"+p.turnID, map[string]any{"planTurnStatus": status})
	if p.compacting {
		compactionStatus := "completed"
		if status != "completed" {
			compactionStatus = status
		}
		p.session.patchMessage(p.compactionMessageID, map[string]any{"compactionStatus": compactionStatus})
		p.compacting = false
	}
	for id := range p.permissions {
		p.session.finishPermission(id, "denied", "cancel")
		delete(p.permissions, id)
	}
	for id := range p.questions {
		p.session.patchMessage(id, map[string]any{"questionStatus": "cancelled"})
		delete(p.questions, id)
	}
	for id, tool := range p.tools {
		if stringValue(tool["status"]) == "in_progress" || stringValue(tool["status"]) == "pending" {
			if status != "completed" {
				p.session.patchMessage(id, map[string]any{"status": "cancelled", "toolStatus": "cancelled", "streaming": false})
			}
		}
	}
	message := map[string]any{"kind": "turn-end", "status": status, "turnStatus": status, "durationMs": millis() - p.started, "context": antigravityContext(p.usage)}
	if err != nil && status != "cancelled" {
		message["error"] = err.Error()
	}
	p.appendLocked(message)
	if sample := p.session.speed.finish(status, 0); sample != nil && p.session.antigravityUsage != nil {
		if persistErr := p.session.antigravityUsage.add(*sample); persistErr != nil {
			p.appendLocked(map[string]any{"kind": "event", "level": "error", "text": "Antigravity token usage could not be saved: " + persistErr.Error()})
		}
	}
	if status == "completed" {
		revision := p.session.markCompletionUnread()
		p.session.emit(map[string]any{"type": "completion", "completionRevision": revision})
	}
	p.turnID = ""
	p.wirePrompts = 0
	p.deferred = false
	p.stopping = false
	p.turnError = nil
	p.turnCancelled = false
	p.tools = map[string]map[string]any{}
	p.streams = map[string]*antigravityStream{}
	p.publishStateLocked()
}
func (p *AntigravityProvider) CanAccept() (bool, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed && !p.switching && !p.stopping && !p.permissionApplying && p.turnID == "" && len(p.permissions) == 0 && len(p.questions) == 0 {
		return true, ""
	}
	return false, "Antigravity session is busy or stopping"
}
func (p *AntigravityProvider) Interrupt(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	if p.switching {
		cancel := p.switchCancel
		generation := p.generation
		if cancel != nil {
			cancel()
		}
		p.mu.Unlock()
		p.recycle(generation)
		return nil
	}
	if p.turnID == "" {
		p.mu.Unlock()
		return nil
	}
	p.stopping = true
	turn, generation := p.turnID, p.generation
	err := p.writeLocked(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": p.nativeID}})
	p.publishStateLocked()
	p.mu.Unlock()
	// ACP has no cancellation response once a deferred prompt has resolved.
	// If it cannot acknowledge cancellation, recycle the complete process tree.
	go func() {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-p.session.ctx.Done():
			return
		}
		p.mu.Lock()
		if p.generation != generation || p.turnID != turn {
			p.mu.Unlock()
			return
		}
		p.mu.Unlock()
		p.recycle(generation)
		p.mu.Lock()
		if p.turnID == turn {
			p.finishTurnLocked("cancelled", nil)
		}
		p.mu.Unlock()
	}()
	return err
}
func (p *AntigravityProvider) Close(ctx context.Context) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	generation := p.generation
	if p.settleTimer != nil {
		p.settleTimer.Stop()
	}
	p.mu.Unlock()
	p.recycle(generation)
	return nil
}
func (p *AntigravityProvider) appendLocked(message map[string]any) {
	message["threadId"] = p.nativeID
	message["turnId"] = p.turnID
	message["isRootTurn"] = true
	message["timeSource"] = "observed"
	p.session.appendMessage(message)
}
func (p *AntigravityProvider) completeStreamsLocked() {
	for _, stream := range p.streams {
		if stream.completedAt == 0 {
			stream.completedAt = millis()
			p.session.patchMessage(stream.id, map[string]any{"streaming": false, "completedAtMs": stream.completedAt, "timeSource": "observed"})
		}
	}
}
func (p *AntigravityProvider) publishStateLocked() {
	status := "idle"
	if p.turnID != "" {
		status = "running"
	}
	if p.stopping {
		status = "stopping"
	} else if len(p.permissions) > 0 {
		status = "waiting_approval"
	} else if len(p.questions) > 0 {
		status = "waiting_input"
	} else if p.switching {
		status = "resuming"
	} else if p.permissionApplying {
		status = "connecting"
	}
	state := map[string]any{"status": status, "antigravitySessionId": nilIfEmpty(p.nativeID), "nativeConversationId": nilIfEmpty(p.nativeID), "threadId": nilIfEmpty(p.nativeID), "turnId": nilIfEmpty(p.turnID), "canAbort": (p.turnID != "" || p.switching) && !p.stopping, "canSteer": p.canSteerLocked(), "canCompact": p.hasCommandLocked("compact") && p.turnID == "" && !p.switching && !p.stopping, "compacting": p.compacting, "configOptions": p.configOptions, "modes": p.modes, "commands": p.commands, "pendingPermissionCount": len(p.permissions), "pendingQuestionCount": len(p.questions), "usage": p.usage, "context": antigravityContext(p.usage), "capabilities": map[string]any{"images": boolValue(mapValue(p.capabilities["promptCapabilities"])["image"]), "resume": boolValue(p.capabilities["loadSession"]), "list": mapValue(p.capabilities["sessionCapabilities"])["list"] != nil, "fork": false, "steer": true, "systemInstructions": boolValue(mapValue(mapValue(p.metadata["antigravity"])["systemPrompt"])["append"])}}
	for _, option := range p.configOptions {
		key := stringValue(option["id"])
		switch key {
		case "thought_level":
			key = "effort"
		case "model", "mode":
		default:
			continue
		}
		state[key] = option["currentValue"]
	}
	if state["mode"] == nil {
		state["mode"] = p.modes["currentModeId"]
	}
	if p.quota != nil {
		state["quota"] = p.quota
	}
	state["permissionPolicy"] = p.permissionStateLocked()
	p.session.setState(state)
}
