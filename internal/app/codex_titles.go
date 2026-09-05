package app

// Mirrors Codex CLI rust-v0.153.0's thread_title.rs and
// temporary_structured_request.rs, using the existing app-server connection.
import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"
)

const codexTitleModel = "gpt-5.6-luna"
const codexTitleTimeout = 30 * time.Second

type codexTitleResult struct {
	text string
	err  error
}
type codexTitleResponse struct {
	ctx      context.Context
	done     chan codexTitleResult
	text     string // only accessed by the stdout reader
	finished bool
}

type codexTitles struct {
	provider  *CodexProvider
	mu        sync.Mutex
	writeMu   sync.Mutex // serialize automatic and manual name writes, not model work
	enabled   bool
	threadID  string
	revision  uint64
	cancel    context.CancelFunc
	starting  map[int64]*codexTitleResponse
	hidden    map[string]*codexTitleResponse
	status    string
	stage     string
	lastError string
	attempts  int
}

func newCodexTitles(provider *CodexProvider) *codexTitles {
	return &codexTitles{provider: provider, starting: map[int64]*codexTitleResponse{}, hidden: map[string]*codexTitleResponse{}}
}

func (titles *codexTitles) reset() {
	titles.mu.Lock()
	defer titles.mu.Unlock()
	if titles.cancel != nil {
		titles.cancel()
		titles.cancel = nil
	}
	titles.revision++
	titles.threadID = ""
	titles.status, titles.stage, titles.lastError, titles.attempts = "", "", "", 0
	titles.starting = map[int64]*codexTitleResponse{}
	titles.hidden = map[string]*codexTitleResponse{}
}

func (titles *codexTitles) cancelGeneration() {
	titles.mu.Lock()
	defer titles.mu.Unlock()
	if titles.cancel != nil {
		titles.cancel()
		titles.cancel = nil
	}
	if titles.status == "running" {
		titles.status = "cancelled"
	}
	titles.revision++
}

func (titles *codexTitles) schedule(threadID, firstMessage string, recent bool) {
	if threadID == "" {
		return
	}
	titles.mu.Lock()
	if !titles.enabled || (titles.threadID == threadID && (titles.status != "failed" || titles.attempts >= 2)) {
		titles.mu.Unlock()
		return
	}
	if titles.cancel != nil {
		titles.cancel()
	}
	ctx, cancel := context.WithCancel(titles.provider.session.ctx)
	titles.cancel = cancel
	if titles.threadID != threadID {
		titles.attempts = 0
	}
	titles.threadID = threadID
	titles.attempts++
	titles.status, titles.stage, titles.lastError = "running", "reading-name", ""
	titles.revision++
	revision := titles.revision
	titles.mu.Unlock()
	go func() {
		defer cancel()
		err := titles.run(ctx, threadID, revision, firstMessage, recent)
		var failureStage, failureMessage string
		titles.mu.Lock()
		if titles.revision == revision {
			titles.status = "completed"
			if err != nil {
				titles.status = "failed"
				titles.lastError = titleBound(err.Error(), 500)
				if ctx.Err() != nil || errors.Is(err, context.Canceled) {
					titles.status = "cancelled"
				}
				if titles.status == "failed" {
					failureStage, failureMessage = titles.stage, titles.lastError
				}
			}
		}
		titles.mu.Unlock()
		// Logging may block; never hold the routing mutex while writing logs.
		if failureMessage != "" {
			log.Printf("[codex-title] session=%s stage=%s: %s", titles.provider.session.ID, failureStage, failureMessage)
		}
	}()
}

func (titles *codexTitles) setStage(revision uint64, stage string) {
	titles.mu.Lock()
	defer titles.mu.Unlock()
	if titles.revision == revision {
		titles.stage = stage
	}
}

func (titles *codexTitles) diagnostics() map[string]any {
	titles.mu.Lock()
	defer titles.mu.Unlock()
	return map[string]any{"enabled": titles.enabled, "threadId": titles.threadID,
		"status": titles.status, "stage": titles.stage, "error": titles.lastError, "attempts": titles.attempts}
}

func (titles *codexTitles) current(ctx context.Context, id string, revision uint64) bool {
	if ctx.Err() != nil {
		return false
	}
	titles.mu.Lock()
	valid := titles.threadID == id && titles.revision == revision
	titles.mu.Unlock()
	titles.provider.mu.Lock()
	valid = valid && !titles.provider.closed && titles.provider.threadID == id
	titles.provider.mu.Unlock()
	return valid
}

func (titles *codexTitles) rpc(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, codexTitleTimeout)
	defer cancel()
	return titles.provider.rpc(ctx, method, params)
}

func (titles *codexTitles) run(ctx context.Context, id string, revision uint64, first string, recent bool) error {
	if !titles.current(ctx, id, revision) {
		return nil
	}
	metadata, err := titles.rpc(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false})
	if err != nil {
		return err
	}
	name := strings.TrimSpace(stringValue(mapValue(metadata["thread"])["name"]))
	if name != "" {
		if titles.current(ctx, id, revision) {
			titles.provider.session.setAutomaticName(name)
		}
		return nil
	}
	titles.provider.session.mu.RLock()
	manual, manualName := titles.provider.session.NameManual, titles.provider.session.Name
	titles.provider.session.mu.RUnlock()
	if manual {
		// An explicitly named Glad window creates an explicitly named thread.
		// Never rename the source of a Resume/Fork just to match its window.
		if !recent {
			titles.writeMu.Lock()
			defer titles.writeMu.Unlock()
			if !titles.current(ctx, id, revision) {
				return nil
			}
			_, err := titles.rpc(ctx, "thread/name/set", map[string]any{"threadId": id, "name": manualName})
			return err
		}
		return nil
	}
	prompt := codexFirstTitlePrompt(first)
	provisional := codexTitleText(first)
	if recent {
		titles.setStage(revision, "reading-recent-messages")
		page, err := titles.rpc(ctx, "thread/turns/list", map[string]any{
			"threadId": id, "limit": 4, "sortDirection": "desc", "itemsView": "summary",
		})
		if err != nil {
			return err
		}
		prompt, provisional = codexRecentTitlePrompt(sliceValue(page["data"]))
	}
	if provisional == "" {
		return nil
	}
	titles.setStage(revision, "writing-provisional-name")
	if err := titles.writeAutomaticName(ctx, id, revision, "", provisional); err != nil {
		return err
	}
	if !titles.current(ctx, id, revision) {
		return nil
	}
	titles.setStage(revision, "generating-title")
	result, err := titles.generate(ctx, prompt)
	if err != nil {
		return err
	}
	name, err = parseCodexTitle(result)
	if err != nil {
		return err
	}
	titles.setStage(revision, "writing-generated-name")
	return titles.writeAutomaticName(ctx, id, revision, provisional, name)
}

func (titles *codexTitles) writeAutomaticName(ctx context.Context, id string, revision uint64, expected, name string) error {
	titles.writeMu.Lock()
	defer titles.writeMu.Unlock()
	if !titles.current(ctx, id, revision) {
		return context.Canceled
	}
	titles.provider.session.mu.RLock()
	manual := titles.provider.session.NameManual
	titles.provider.session.mu.RUnlock()
	if manual {
		return context.Canceled
	}
	// Check persisted metadata too, so edits made in another client while the
	// hidden model turn was running are respected.
	metadata, err := titles.rpc(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false})
	if err != nil {
		return err
	}
	if stringValue(mapValue(metadata["thread"])["name"]) != expected {
		return context.Canceled
	}
	if !titles.current(ctx, id, revision) {
		return context.Canceled
	}
	_, err = titles.rpc(ctx, "thread/name/set", map[string]any{"threadId": id, "name": name})
	if err == nil && titles.current(ctx, id, revision) {
		titles.provider.session.setAutomaticName(name)
	}
	return err
}

func (titles *codexTitles) rename(ctx context.Context, name string) error {
	titles.cancelGeneration()
	titles.writeMu.Lock()
	defer titles.writeMu.Unlock()
	titles.provider.mu.Lock()
	id := titles.provider.threadID
	titles.provider.mu.Unlock()
	if id == "" {
		// The first accepted user message will persist the explicit window name.
		return nil
	}
	_, err := titles.rpc(ctx, "thread/name/set", map[string]any{"threadId": id, "name": name})
	return err
}

func (titles *codexTitles) generate(ctx context.Context, prompt string) (string, error) {
	configResult, err := titles.rpc(ctx, "config/read", map[string]any{"cwd": titles.provider.session.WorkingDirectory, "includeLayers": false})
	if err != nil {
		return "", err
	}
	config := mapValue(configResult["config"])
	titles.provider.mu.Lock()
	model := stringValue(titles.provider.options["model"])
	models := append([]map[string]any(nil), titles.provider.models...)
	titles.provider.mu.Unlock()
	if model == "" {
		model = stringValue(config["model"])
	}
	modelProvider := firstNonEmpty(stringValue(config["model_provider"]), "openai")
	account, _ := titles.rpc(ctx, "account/read", map[string]any{"refreshToken": false})
	if modelProvider == "openai" && stringValue(mapValue(account["account"])["type"]) == "chatgpt" {
		for _, item := range models {
			if stringValue(item["id"]) == codexTitleModel {
				model = codexTitleModel
				break
			}
		}
	}
	params := codexTitleThreadParams(config, model, modelProvider, titles.provider.session.WorkingDirectory)
	response := &codexTitleResponse{done: make(chan codexTitleResult, 1)}
	startCtx, cancel := context.WithTimeout(ctx, codexTitleTimeout)
	titles.provider.mu.Lock()
	result, err := titles.provider.requestLockedTracked(startCtx, "thread/start", params, response)
	titles.provider.mu.Unlock()
	cancel()
	if err != nil {
		return "", err
	}
	id := stringValue(mapValue(result["thread"])["id"])
	if id == "" {
		return "", errors.New("title thread has no ID")
	}
	defer titles.cleanup(id)
	if profile := stringValue(params["permissions"]); profile != "" {
		if stringValue(mapValue(result["activePermissionProfile"])["id"]) != profile {
			return "", errors.New("title thread permission profile mismatch")
		}
	} else if stringValue(mapValue(result["sandbox"])["type"]) != "readOnly" {
		return "", errors.New("title thread is not read-only")
	}
	turnCtx, turnCancel := context.WithTimeout(ctx, codexTitleTimeout)
	defer turnCancel()
	turnParams := map[string]any{
		"threadId": id, "input": []any{map[string]any{"type": "text", "text": prompt}},
		"outputSchema": map[string]any{"type": "object", "properties": map[string]any{
			"title": map[string]any{"type": "string", "minLength": 1, "maxLength": codexTitleLimit},
		}, "required": []string{"title"}, "additionalProperties": false},
	}
	if model == codexTitleModel {
		turnParams["effort"] = "low"
	}
	if _, err := titles.provider.rpc(turnCtx, "turn/start", turnParams); err != nil {
		return "", err
	}
	select {
	case result := <-response.done:
		return result.text, result.err
	case <-turnCtx.Done():
		return "", turnCtx.Err()
	}
}

func codexTitleThreadParams(config map[string]any, model, provider, cwd string) map[string]any {
	overrides := map[string]any{}
	for _, feature := range []string{"apps", "code_mode", "code_mode_only", "context_management", "current_time_reminder", "deferred_executor", "enable_fanout", "goals", "hooks", "image_generation", "memories", "multi_agent", "multi_agent_v2", "plugins", "request_permissions_tool", "shell_snapshot", "shell_tool", "standalone_web_search", "token_budget", "tool_suggest", "unified_exec", "view_image"} {
		overrides["features."+feature] = false
	}
	for _, key := range []string{"orchestrator.skills.enabled", "skills.include_instructions", "token_budget.use_history_notes_extension", "tools.experimental_request_user_input.enabled", "tools.update_plan.enabled"} {
		overrides[key] = false
	}
	overrides["web_search"] = "disabled"
	mcp := map[string]any{}
	for name := range mapValue(config["mcp_servers"]) {
		mcp[name] = map[string]any{"enabled": false}
	}
	overrides["mcp_servers"] = mcp
	params := map[string]any{
		"model": model, "modelProvider": provider, "cwd": cwd, "approvalPolicy": "never",
		"sandbox": "read-only", "runtimeWorkspaceRoots": []any{}, "ephemeral": true,
		"threadSource": "system", "environments": []any{},
		"dynamicTools": []any{}, "selectedCapabilityRoots": []any{}, "config": overrides,
	}
	if profile := stringValue(config["permissions"]); profile != "" && !strings.HasPrefix(profile, ":") {
		delete(params, "sandbox")
		params["permissions"] = profile
	}
	return params
}

func (titles *codexTitles) cleanup(id string) {
	// Generation cancellation must not cancel its best-effort detach request.
	_, err := titles.rpc(titles.provider.session.ctx, "thread/unsubscribe", map[string]any{"threadId": id})
	if err == nil {
		titles.mu.Lock()
		delete(titles.hidden, id)
		titles.mu.Unlock()
	}
}

// Register before delivering thread/start's response to the requesting goroutine:
// the following notification can arrive before that goroutine is scheduled.
func (titles *codexTitles) receivedResponse(id int64, result map[string]any, abandoned bool) {
	titles.mu.Lock()
	response, ok := titles.starting[id]
	delete(titles.starting, id)
	threadID := stringValue(mapValue(result["thread"])["id"])
	if ok && threadID != "" {
		titles.hidden[threadID] = response
	}
	titles.mu.Unlock()
	if ok && threadID != "" && (abandoned || (response.ctx != nil && response.ctx.Err() != nil)) {
		go titles.cleanup(threadID)
	}
}

func (titles *codexTitles) abandon(response *codexTitleResponse) {
	if response == nil {
		return
	}
	titles.mu.Lock()
	ids := []string{}
	for id, candidate := range titles.hidden {
		if candidate == response {
			ids = append(ids, id)
		}
	}
	titles.mu.Unlock()
	for _, id := range ids {
		go titles.cleanup(id)
	}
}

func (titles *codexTitles) route(message map[string]any) bool {
	params := mapValue(message["params"])
	id := firstNonEmpty(stringValue(params["threadId"]), stringValue(mapValue(params["thread"])["id"]))
	titles.mu.Lock()
	response, hidden := titles.hidden[id]
	// thread/started can precede its RPC response. No turn is submitted until
	// after the response, so swallowing this metadata event is sufficient.
	if !hidden && id != "" && stringValue(message["method"]) == "thread/started" && boolValue(mapValue(params["thread"])["ephemeral"]) {
		titles.hidden[id] = nil
		hidden = true
	}
	titles.mu.Unlock()
	if !hidden {
		return false
	}
	if message["id"] != nil {
		titles.provider.mu.Lock()
		_ = titles.provider.writeLocked(map[string]any{"id": message["id"], "error": map[string]any{"code": -32601, "message": "Tools are disabled for title generation"}})
		titles.provider.mu.Unlock()
		return true
	}
	if response != nil {
		response.accept(stringValue(message["method"]), params)
	}
	return true
}

func (response *codexTitleResponse) accept(method string, params map[string]any) {
	if response.finished {
		return
	}
	var err error
	if method == "item/completed" {
		item := mapValue(params["item"])
		if stringValue(item["type"]) == "agentMessage" {
			text := stringValue(item["text"])
			if len(text) > 8*1024 {
				err = errors.New("title response exceeds 8 KiB")
			} else {
				response.text = text
			}
		}
	}
	if method == "turn/completed" {
		if stringValue(mapValue(params["turn"])["status"]) != "completed" || response.text == "" {
			err = errors.New("title turn did not complete with text")
		}
	}
	if err != nil || method == "turn/completed" {
		response.finished = true
		response.done <- codexTitleResult{text: response.text, err: err}
	}
}
