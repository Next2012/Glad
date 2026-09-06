package app

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestParseWebArgsAcceptsDirectoryBeforePort(t *testing.T) {
	directory, port, err := parseWebArgs([]string{".", "--port", "3001"})
	if err != nil || directory != "." || port != 3001 {
		t.Fatalf("unexpected parse: %q %d %v", directory, port, err)
	}
}

func TestEmbeddedFrontendIsServed(t *testing.T) {
	recorder := httptest.NewRecorder()
	server := &Server{assets: os.DirFS("../..")}
	server.serveEmbedded(recorder, "lib/web/index.html")
	if recorder.Code != 200 || !bytes.Contains(recorder.Body.Bytes(), []byte("Glad - AI Sessions")) {
		t.Fatalf("frontend response is invalid: %d", recorder.Code)
	}
}

func TestWebSocketRoutesAcceptCanonicalAndLegacyPaths(t *testing.T) {
	manager := NewSessionManager(t.TempDir())
	session := newSession(
		"ws-contract",
		"Codex",
		"codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"},
		manager.baseDir,
	)
	session.events = manager.events
	manager.sessions[session.ID] = session
	server := &Server{sessions: manager, assets: os.DirFS("../..")}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", server.websocket)
	mux.HandleFunc("GET /", server.serveRoot)
	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)

	for _, route := range []string{"/ws", "/"} {
		t.Run(route, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			address := "ws" + strings.TrimPrefix(httpServer.URL, "http") + route + "?sessionId=" + session.ID
			connection, _, err := websocket.Dial(ctx, address, nil)
			if err != nil {
				t.Fatalf("connect to %s: %v", route, err)
			}
			defer connection.Close(websocket.StatusNormalClosure, "")
			_, payload, err := connection.Read(ctx)
			if err != nil {
				t.Fatalf("read snapshot from %s: %v", route, err)
			}
			var snapshot map[string]any
			if err := json.Unmarshal(payload, &snapshot); err != nil {
				t.Fatal(err)
			}
			if snapshot["type"] != "codex-snapshot" {
				t.Fatalf("unexpected snapshot from %s: %#v", route, snapshot)
			}
			session.appendMessage(map[string]any{"kind": "assistant", "text": "event stream"})
			_, payload, err = connection.Read(ctx)
			if err != nil {
				t.Fatalf("read event from %s: %v", route, err)
			}
			var event map[string]any
			if err := json.Unmarshal(payload, &event); err != nil {
				t.Fatal(err)
			}
			if event["type"] != "codex-event" || stringValue(mapValue(event["event"])["type"]) != "message" {
				t.Fatalf("unexpected event from %s: %#v", route, event)
			}
		})
	}
}

func TestImageTypeAndFilenameSanitization(t *testing.T) {
	extension, media := imageType([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
	if extension != "png" || media != "image/png" {
		t.Fatalf("unexpected image type: %s %s", extension, media)
	}
	if name := safeFileName("../unsafe%3Aname.txt"); name != "unsafe_name.txt" {
		t.Fatalf("unexpected safe filename: %s", name)
	}
}

func TestWorkspaceDoesNotFollowOutsideSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := resolveInside(root, "link"); err == nil {
		t.Fatal("outside symlink was accepted")
	}
}

func TestParsersMatchFrontendContracts(t *testing.T) {
	files := parseGitStatus(" M one.txt\x00R  new.txt\x00old.txt\x00")
	if len(files) != 2 || files[1]["originalPath"] != "old.txt" {
		t.Fatalf("unexpected git status: %#v", files)
	}
	usage, err := parseClaudeUsage(
		"Total cost: $1.25\nTotal duration (API): 2s\nUsage: 1k input, 2k output, 3k cache read, 4k cache write",
	)
	if err != nil || numberInt64(usage["inputTokens"]) != 1000 {
		t.Fatalf("unexpected usage: %#v %v", usage, err)
	}
	context, err := parseClaudeContext("**Model:** sonnet\n**Tokens:** 45,000 / 200,000 (22.5%)")
	if err != nil || numberInt64(context["remainingTokens"]) != 155000 {
		t.Fatalf("unexpected context: %#v %v", context, err)
	}
}

func TestProviderModelConfigMatchesFrontendContract(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "claude-custom-model")
	t.Setenv("ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-sonnet-custom")
	config := claudeRuntimeConfig()
	models, ok := config["models"].([]map[string]any)
	if !ok || config["defaultModel"] != "claude-custom-model" || len(models) != 5 {
		t.Fatalf("unexpected Claude model config: %#v", config)
	}
	if models[1]["value"] != "claude-custom-model" || models[1]["resolved"] != "claude-custom-model" {
		t.Fatalf("environment model was not preserved: %#v", models[1])
	}
	if models[2]["value"] != "sonnet" || models[2]["resolved"] != "claude-sonnet-custom" {
		t.Fatalf("Sonnet alias was not resolved: %#v", models[2])
	}

	efforts := codexReasoningEfforts([]any{
		map[string]any{"reasoningEffort": "low"},
		map[string]any{"reasoning_effort": "high"},
		"xhigh",
	})
	if strings.Join(efforts, ",") != "low,high,xhigh" {
		t.Fatalf("unexpected Codex efforts: %#v", efforts)
	}
}

func TestCodexPublicMessagesKeepDetailsLazy(t *testing.T) {
	message := publicMessage(
		map[string]any{
			"kind":      "tool",
			"id":        "1",
			"input":     map[string]any{"command": "pwd"},
			"result":    "ok",
			"createdAt": int64(1),
		},
		"codex-structured",
	)
	if message["input"] != nil || message["result"] != nil || message["hasDetail"] != true {
		t.Fatalf("details leaked into snapshot: %#v", message)
	}
}

func TestScheduleAndNotificationValidation(t *testing.T) {
	now := int64(1_800_000_000_000)
	next := computeNextRun(
		map[string]any{
			"time":     "09:30",
			"weekdays": []any{float64(0), float64(1), float64(2), float64(3), float64(4), float64(5), float64(6)},
		},
		now,
	)
	if numberInt64(next) <= now {
		t.Fatalf("invalid next run: %#v", next)
	}
	settings, err := validateServerChan(
		map[string]any{"sendKey": "SCT_12345678", "clientType": "pushdeer"},
		ServerChanSettings{},
	)
	if err != nil || settings.ClientType != "pushdeer" {
		t.Fatalf("unexpected ServerChan validation: %#v %v", settings, err)
	}
}

func TestVerifiedSkillBundleExtraction(t *testing.T) {
	content := []byte("---\nname: demo-skill\n---\n")
	digest := fmt.Sprintf("%x", sha256.Sum256(content))
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, _ := writer.Create("bundle/SKILL.md")
	_, _ = entry.Write(content)
	_ = writer.Close()
	destination := filepath.Join(t.TempDir(), "skill")
	if err := extractSkillBundle(buffer.Bytes(), []skillManifestFile{{Path: "SKILL.md", Size: int64(len(content)), SHA256: digest}}, destination); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(destination, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
}

func TestSkillHubEncryptionKeepsLegacyEnvelopeShape(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte("01234567890123456789012345678901"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GLAD_SKILLHUB_KEY_FILE", keyFile)
	service := &SkillHubService{}
	envelope, err := service.encrypt("token-value-1234")
	if err != nil || envelope["authTag"] == nil {
		t.Fatalf("invalid envelope: %#v %v", envelope, err)
	}
	plain, err := service.decrypt(envelope)
	if err != nil || plain != "token-value-1234" {
		t.Fatalf("decrypt failed: %q %v", plain, err)
	}
}

func TestSkillHubEncryptionCreatesAndReusesDefaultKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GLAD_SKILLHUB_KEY_FILE", "")
	service := &SkillHubService{}

	first, err := service.encryptionKey()
	if err != nil || len(first) != 32 {
		t.Fatalf("default key generation failed: %d bytes, %v", len(first), err)
	}
	filename := filepath.Join(home, ".glad", "skillhub.key")
	stored, err := os.ReadFile(filename)
	if err != nil {
		t.Fatalf("default key was not saved: %v", err)
	}
	parsed, err := parseSkillHubEncryptionKey(stored)
	if err != nil || !bytes.Equal(parsed, first) {
		t.Fatalf("saved key does not match generated key: %v", err)
	}
	info, err := os.Stat(filename)
	if err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("default key permissions are not private: %v %v", info, err)
	}

	second, err := service.encryptionKey()
	if err != nil || !bytes.Equal(second, first) {
		t.Fatalf("default key was not reused: %v", err)
	}
	envelope, err := service.encrypt("token-value-1234")
	if err != nil {
		t.Fatalf("encrypt with default key failed: %v", err)
	}
	plain, err := service.decrypt(envelope)
	if err != nil || plain != "token-value-1234" {
		t.Fatalf("decrypt with default key failed: %q %v", plain, err)
	}
}

func TestSkillHubEncryptionDoesNotReplaceExplicitMissingKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GLAD_SKILLHUB_KEY_FILE", filepath.Join(home, "missing-key"))
	service := &SkillHubService{}
	if _, err := service.encryptionKey(); err == nil || !strings.Contains(err.Error(), "无法读取") {
		t.Fatalf("explicit missing key should fail without fallback: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".glad", "skillhub.key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected default key created for explicit path: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestServerChanTransportErrorsNeverExposeSendKey(t *testing.T) {
	secret := "SCT_SECRET_123456"
	service := &NotificationService{
		client: &http.Client{
			Transport: roundTripFunc(
				func(request *http.Request) (*http.Response, error) { return nil, errors.New(request.URL.String()) },
			),
		},
	}
	err := service.Send(ServerChanSettings{SendKey: secret, ClientType: "wechat"}, "test", "")
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("secret leaked through transport error: %v", err)
	}
}

type bufferWriteCloser struct{ bytes.Buffer }

func (buffer *bufferWriteCloser) Close() error { return nil }

type channelWriteCloser struct{ writes chan []byte }

func (writer *channelWriteCloser) Write(value []byte) (int, error) {
	copyValue := append([]byte(nil), value...)
	writer.writes <- copyValue
	return len(value), nil
}

func (writer *channelWriteCloser) Close() error { return nil }

type failingWriteCloser struct{}

func (failingWriteCloser) Write([]byte) (int, error) { return 0, errors.New("forced write failure") }
func (failingWriteCloser) Close() error              { return nil }

type stubProvider struct {
	sendErr error
	inputs  []ProviderInput
}

func (provider *stubProvider) Start(context.Context) error { return nil }
func (provider *stubProvider) Send(_ context.Context, input ProviderInput) error {
	provider.inputs = append(provider.inputs, input)
	return provider.sendErr
}
func (provider *stubProvider) Approve(context.Context, string, string, map[string]any) error {
	return nil
}
func (provider *stubProvider) UpdateSettings(context.Context, map[string]any) error { return nil }
func (provider *stubProvider) Interrupt(context.Context) error                      { return nil }
func (provider *stubProvider) Resume(context.Context, string) error                 { return nil }
func (provider *stubProvider) Fork(context.Context, string) (string, error)         { return "", nil }
func (provider *stubProvider) Compact(context.Context) error                        { return nil }
func (provider *stubProvider) Status(context.Context) error                         { return nil }
func (provider *stubProvider) Close(context.Context) error                          { return nil }

func TestClaudeControlApprovalRoundTrip(t *testing.T) {
	session := newSession(
		"session",
		"Claude",
		"claude-structured",
		ToolInfo{Key: "claude-code", DisplayName: "Claude"},
		t.TempDir(),
	)
	provider := NewClaudeProvider(session, map[string]any{"permissionMode": "default"})
	output := &bufferWriteCloser{}
	provider.stdin = output
	provider.handleControlRequest(map[string]any{
		"request_id": "control-1",
		"request": map[string]any{
			"subtype":     "can_use_tool",
			"tool_name":   "Bash",
			"tool_use_id": "tool-1",
			"input":       map[string]any{"command": "touch probe"},
		},
	})
	if len(session.Permissions) != 1 {
		t.Fatalf("permission was not surfaced: %#v", session.Permissions)
	}
	var permissionID string
	for id := range session.Permissions {
		permissionID = id
	}
	if err := provider.Approve(context.Background(), permissionID, "allow-once", nil); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
		t.Fatal(err)
	}
	decision := mapValue(mapValue(response["response"])["response"])
	if decision["behavior"] != "allow" || decision["toolUseID"] != "tool-1" {
		t.Fatalf("unexpected Claude approval response: %#v", response)
	}
}

func TestClaudeExpectedProcessStopDoesNotSurfaceSessionError(t *testing.T) {
	session := newSession(
		"session",
		"Claude",
		"claude-structured",
		ToolInfo{Key: "claude-code", DisplayName: "Claude"},
		t.TempDir(),
	)
	provider := NewClaudeProvider(session, nil)
	command := exec.Command("claude")
	provider.cmd = command
	provider.expectedStops[command] = struct{}{}

	provider.handleProcessExit(command, errors.New("signal: killed"))

	if len(session.Messages) != 0 || session.StatusValue != "idle" {
		t.Fatalf("expected stop surfaced as an error: status=%s messages=%#v", session.StatusValue, session.Messages)
	}
	if len(provider.expectedStops) != 0 {
		t.Fatalf("expected stop marker was not cleared: %#v", provider.expectedStops)
	}
}

func TestClaudeUnexpectedProcessExitStillSurfacesSessionError(t *testing.T) {
	session := newSession(
		"session",
		"Claude",
		"claude-structured",
		ToolInfo{Key: "claude-code", DisplayName: "Claude"},
		t.TempDir(),
	)
	provider := NewClaudeProvider(session, nil)
	command := exec.Command("claude")
	provider.cmd = command

	provider.handleProcessExit(command, errors.New("signal: killed"))

	if session.StatusValue != "error" || len(session.Messages) != 1 ||
		stringValue(session.Messages[0]["text"]) != "Claude session error: signal: killed" {
		t.Fatalf("unexpected process exit was not surfaced: status=%s messages=%#v", session.StatusValue, session.Messages)
	}
}

func TestClaudeRejectedWriteDoesNotRecordAcceptedMessage(t *testing.T) {
	session := newSession(
		"session",
		"Claude",
		"claude-structured",
		ToolInfo{Key: "claude-code", DisplayName: "Claude"},
		t.TempDir(),
	)
	provider := NewClaudeProvider(session, nil)
	provider.cmd = exec.Command("claude")
	provider.stdin = failingWriteCloser{}
	err := provider.Send(
		context.Background(),
		ProviderInput{ClientMessageID: "client-1", Text: "keep me", AgentText: "keep me"},
	)
	if err == nil || len(session.Messages) != 0 || len(provider.turns) != 0 || session.StatusValue != "idle" {
		t.Fatalf(
			"failed write mutated the session: err=%v messages=%#v turns=%#v status=%s",
			err,
			session.Messages,
			provider.turns,
			session.StatusValue,
		)
	}
}

func TestCodexUserEchoMatchesProviderTextWithoutDuplicating(t *testing.T) {
	session := newSession(
		"session",
		"Codex",
		"codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"},
		t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	agentText := "Review this\n\nThe user attached the following local files. Read them if relevant:\n- notes.txt: /tmp/notes.txt"
	session.appendMessage(
		map[string]any{
			"kind": "user", "text": "Review this", "agentText": agentText,
			"clientMessageId": "client-1", "attachments": []map[string]any{{"name": "notes.txt"}},
		},
	)
	provider.applyItem(
		map[string]any{
			"id": "provider-user-1", "type": "userMessage",
			"content": []any{map[string]any{"type": "text", "text": agentText}},
		},
		"completed",
	)
	if len(session.Messages) != 1 || session.Messages[0]["providerId"] != "provider-user-1" ||
		session.Messages[0]["text"] != "Review this" {
		t.Fatalf("Codex user echo was duplicated or changed: %#v", session.Messages)
	}
	if publicMessage(session.Messages[0], session.Kind)["agentText"] != nil {
		t.Fatalf("provider-only prompt leaked to the browser: %#v", session.Messages[0])
	}
}

func TestCodexStopsAfterFourthReconnectAttemptOnce(t *testing.T) {
	session := newSession(
		"session",
		"Codex",
		"codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"},
		t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	writes := make(chan []byte, 4)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID = "thread-reconnect"
	provider.turnID = "turn-reconnect"

	provider.handleNotification("error", map[string]any{
		"threadId":  "thread-reconnect",
		"turnId":    "turn-reconnect",
		"error":     map[string]any{"message": "Reconnecting... 4/5"},
		"willRetry": true,
	})

	var request map[string]any
	select {
	case encoded := <-writes:
		if err := json.Unmarshal(bytes.TrimSpace(encoded), &request); err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("automatic turn/interrupt was not sent")
	}
	if request["method"] != "turn/interrupt" ||
		stringValue(mapValue(request["params"])["threadId"]) != "thread-reconnect" ||
		stringValue(mapValue(request["params"])["turnId"]) != "turn-reconnect" {
		t.Fatalf("unexpected automatic interrupt: %#v", request)
	}
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{}})

	provider.handleNotification("error", map[string]any{
		"threadId":  "thread-reconnect",
		"turnId":    "turn-reconnect",
		"error":     map[string]any{"message": "Reconnecting... 4/5"},
		"willRetry": true,
	})
	select {
	case duplicate := <-writes:
		t.Fatalf("automatic interrupt was sent twice: %s", duplicate)
	case <-time.After(50 * time.Millisecond):
	}

	reasonCount := 0
	for _, message := range session.Messages {
		if stringValue(message["text"]) == "Aborted after Codex reconnect attempt 4/5." {
			reasonCount++
		}
	}
	if reasonCount != 1 {
		t.Fatalf("expected one automatic-abort message, got %d: %#v", reasonCount, session.Messages)
	}
}

func TestCodexStatusIncludesCurrentChatGPTRateLimits(t *testing.T) {
	session := newSession(
		"session",
		"Codex",
		"codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"},
		t.TempDir(),
	)
	provider := NewCodexProvider(session, map[string]any{"model": "gpt-test", "effort": "high"})
	writes := make(chan []byte, 4)
	provider.stdin = &channelWriteCloser{writes: writes}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- provider.Status(ctx) }()

	readRequest := func(method string) map[string]any {
		t.Helper()
		select {
		case encoded := <-writes:
			var request map[string]any
			if err := json.Unmarshal(bytes.TrimSpace(encoded), &request); err != nil {
				t.Fatal(err)
			}
			if request["method"] != method {
				t.Fatalf("expected %s, got %#v", method, request)
			}
			return request
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s", method)
			return nil
		}
	}

	accountRequest := readRequest("account/read")
	provider.handleRPC(map[string]any{
		"id": accountRequest["id"],
		"result": map[string]any{"account": map[string]any{
			"type": "chatgpt", "email": "user@example.com", "planType": "plus",
		}},
	})
	rateLimitRequest := readRequest("account/rateLimits/read")
	provider.handleRPC(map[string]any{
		"id": rateLimitRequest["id"],
		"result": map[string]any{
			"rateLimits": map[string]any{
				"limitId": "codex",
				"primary": map[string]any{"usedPercent": float64(48), "windowDurationMins": float64(10080), "resetsAt": float64(100)},
			},
			"rateLimitsByLimitId": map[string]any{
				"codex": map[string]any{
					"limitId": "codex",
					"primary": map[string]any{"usedPercent": float64(48), "windowDurationMins": float64(10080), "resetsAt": float64(100)},
				},
				"codex_spark": map[string]any{
					"limitId":   "codex_spark",
					"limitName": "GPT-Codex-Spark",
					"primary":   map[string]any{"usedPercent": float64(20), "windowDurationMins": float64(300), "resetsAt": float64(150)},
					"secondary": map[string]any{"usedPercent": float64(10), "windowDurationMins": float64(10080), "resetsAt": float64(200)},
				},
			},
		},
	})
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	var status map[string]any
	for _, message := range session.Messages {
		if message["kind"] == "status" {
			status = message
		}
	}
	limits := mapValue(status["rateLimits"])
	buckets := mapValue(status["rateLimitsByLimitId"])
	if mapValue(limits["primary"])["windowDurationMins"] != float64(10080) ||
		mapValue(mapValue(buckets["codex_spark"])["primary"])["windowDurationMins"] != float64(300) ||
		mapValue(mapValue(buckets["codex_spark"])["secondary"])["windowDurationMins"] != float64(10080) {
		t.Fatalf("current Codex rate-limit shape was not preserved: %#v", status)
	}
}

func TestTimedInputFailureRemainsVisible(t *testing.T) {
	session := newSession(
		"session",
		"Codex",
		"codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"},
		t.TempDir(),
	)
	provider := &stubProvider{sendErr: errors.New("provider busy")}
	session.Provider = provider
	item, err := scheduleTimed(
		session,
		"",
		map[string]any{"text": "later", "sendAt": time.Now().Add(50 * time.Millisecond).UnixMilli()},
	)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		session.mu.RLock()
		current := session.TimedInputs[item.ID]
		failed := current != nil && current.Status == "failed" && current.Error == "provider busy"
		session.mu.RUnlock()
		if failed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	session.mu.RLock()
	current := session.TimedInputs[item.ID]
	session.mu.RUnlock()
	if current == nil || current.Status != "failed" || len(provider.inputs) != 1 {
		t.Fatalf("timed failure disappeared: item=%#v inputs=%#v", current, provider.inputs)
	}
}

func TestCodexApprovalAndTurnLifecycle(t *testing.T) {
	session := newSession(
		"session",
		"Codex",
		"codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"},
		t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	output := &bufferWriteCloser{}
	provider.stdin = output
	provider.permissions["approval-1"] = codexPendingPermission{
		RPCID:  float64(9),
		Method: "item/commandExecution/requestApproval",
		Params: map[string]any{},
	}
	session.Permissions["approval-1"] = Permission{ID: "approval-1", Status: "pending"}
	if err := provider.Approve(context.Background(), "approval-1", "approved", nil); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
		t.Fatal(err)
	}
	if mapValue(response["result"])["decision"] != "accept" {
		t.Fatalf("unexpected Codex decision: %#v", response)
	}

	provider.threadID = "thread-1"
	provider.handleNotification(
		"turn/started",
		map[string]any{"threadId": "thread-1", "turn": map[string]any{"id": "turn-1"}},
	)
	provider.handleNotification(
		"item/agentMessage/delta",
		map[string]any{"threadId": "thread-1", "turnId": "turn-1", "itemId": "agent-1", "delta": "hello"},
	)
	provider.handleNotification(
		"turn/completed",
		map[string]any{"threadId": "thread-1", "turn": map[string]any{"id": "turn-1", "status": "completed"}},
	)
	if !session.HasUnreadCompletion || session.StatusValue != "idle" {
		t.Fatalf("turn did not settle: unread=%v status=%s", session.HasUnreadCompletion, session.StatusValue)
	}
	foundAssistant, foundEnd := false, false
	for _, message := range session.Messages {
		if message["kind"] == "assistant" && message["text"] == "hello" {
			foundAssistant = true
		}
		if message["kind"] == "turn-end" && message["status"] == "completed" {
			foundEnd = true
		}
	}
	if !foundAssistant || !foundEnd {
		t.Fatalf("normalized lifecycle is incomplete: %#v", session.Messages)
	}
}

func TestCodexTracksSubagentsWithoutSettlingRootTurn(t *testing.T) {
	session := newSession(
		"session",
		"Codex",
		"codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"},
		t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	provider.threadID = "root-thread"

	provider.handleNotification(
		"turn/started",
		map[string]any{"threadId": "root-thread", "turn": map[string]any{"id": "root-turn"}},
	)
	provider.handleNotification(
		"turn/started",
		map[string]any{
			"threadId": "child-thread",
			"turn":     map[string]any{"id": "child-turn", "startedAt": int64(1)},
		},
	)
	session.mu.RLock()
	activeSubagents := numberInt64(session.State["activeSubagentCount"])
	session.mu.RUnlock()
	if activeSubagents != 1 {
		t.Fatalf("active subagent count after child start = %d, want 1", activeSubagents)
	}
	provider.handleNotification(
		"thread/status/changed",
		map[string]any{"threadId": "child-thread", "status": map[string]any{"type": "idle"}},
	)
	provider.handleNotification(
		"error",
		map[string]any{
			"threadId": "child-thread", "turnId": "child-turn", "willRetry": false,
			"error": map[string]any{"message": "child failed"},
		},
	)
	provider.handleNotification(
		"turn/completed",
		map[string]any{
			"threadId": "child-thread",
			"turn": map[string]any{
				"id": "child-turn", "status": "failed", "startedAt": int64(1), "completedAt": int64(2),
			},
		},
	)
	provider.handleNotification(
		"thread/status/changed",
		map[string]any{"threadId": "root-thread", "status": map[string]any{"type": "idle"}},
	)

	provider.mu.Lock()
	turnID := provider.turnID
	provider.mu.Unlock()
	session.mu.RLock()
	status := session.StatusValue
	canAbort := boolValue(session.State["canAbort"])
	unread := session.HasUnreadCompletion
	activeSubagents = numberInt64(session.State["activeSubagentCount"])
	session.mu.RUnlock()
	if turnID != "root-turn" || status != "running" || !canAbort || unread || activeSubagents != 0 {
		t.Fatalf(
			"child lifecycle settled root turn: turn=%s status=%s canAbort=%v unread=%v subagents=%d",
			turnID, status, canAbort, unread, activeSubagents,
		)
	}

	childEnd := false
	for _, message := range session.Messages {
		if stringValue(message["kind"]) == "turn-end" && stringValue(message["turnId"]) == "child-turn" {
			childEnd = true
			if numberInt64(message["durationMs"]) != 1000 || message["context"] != nil {
				t.Fatalf("child completion metadata was not scoped: %#v", message)
			}
		}
	}
	if !childEnd {
		t.Fatal("child completion was omitted from conversation history")
	}

	provider.handleNotification(
		"turn/completed",
		map[string]any{
			"threadId": "root-thread",
			"turn":     map[string]any{"id": "root-turn", "status": "completed"},
		},
	)
	provider.mu.Lock()
	turnID = provider.turnID
	provider.mu.Unlock()
	session.mu.RLock()
	status, unread = session.StatusValue, session.HasUnreadCompletion
	canAbort = boolValue(session.State["canAbort"])
	session.mu.RUnlock()
	if turnID != "" || status != "idle" || canAbort || !unread {
		t.Fatalf(
			"root completion did not settle turn: turn=%s status=%s canAbort=%v unread=%v",
			turnID, status, canAbort, unread,
		)
	}
}

func TestUsageNormalizationOnlyPricesCodexGPTModels(t *testing.T) {
	agent := map[string]any{"modelBreakdowns": []any{
		map[string]any{
			"modelName":    "gpt-test",
			"inputTokens":  float64(10),
			"outputTokens": float64(5),
			"cost":         float64(1.25),
		},
		map[string]any{
			"modelName":    "claude-test",
			"inputTokens":  float64(10),
			"outputTokens": float64(5),
			"cost":         float64(2.5),
		},
	}}
	models := normalizeUsageModels("codex", agent)
	if models[0].Cost == nil && models[1].Cost == nil {
		t.Fatal("Codex GPT cost was not preserved")
	}
	for _, model := range models {
		if model.ModelName == "claude-test" && model.Cost != nil {
			t.Fatalf("non-GPT cost leaked: %#v", model)
		}
	}
}

func TestSessionManagerRejectsDuplicateIDBeforeReplacingSession(t *testing.T) {
	fixtureDirectory, err := filepath.Abs(filepath.Join("..", "..", "tests", "e2e", "fixtures", "bin"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fixtureDirectory+string(os.PathListSeparator)+os.Getenv("PATH"))
	manager := NewSessionManager(t.TempDir())
	existing := newSession(
		"duplicate", "Existing", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, manager.baseDir,
	)
	manager.sessions[existing.ID] = existing

	_, err = manager.Create(
		context.Background(),
		CreateSessionRequest{ID: existing.ID, ToolKey: "codex"},
	)
	if err == nil || manager.Get(existing.ID) != existing {
		t.Fatalf("duplicate session replaced the live session: err=%v current=%p", err, manager.Get(existing.ID))
	}
}

func TestConfigStoreRejectsCorruptionAndClonesValues(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	directory := filepath.Join(home, ".glad")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(directory, "config.json")
	if err := os.WriteFile(filename, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenConfigStore(); err == nil {
		t.Fatal("corrupt configuration was silently accepted")
	}
	if err := os.WriteFile(filename, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenConfigStore()
	if err != nil {
		t.Fatal(err)
	}
	value := map[string]any{"nested": map[string]any{"enabled": true}}
	if err := store.Set("feature", value); err != nil {
		t.Fatal(err)
	}
	value["nested"].(map[string]any)["enabled"] = false
	stored := mapValue(store.Get("feature"))
	if !boolValue(mapValue(stored["nested"])["enabled"]) {
		t.Fatal("caller mutation leaked into persisted configuration")
	}
}

func TestLimitedCommandBufferEnforcesBound(t *testing.T) {
	buffer := &limitedCommandBuffer{limit: 4}
	if _, err := buffer.Write([]byte("12345")); err == nil || !buffer.exceeded || buffer.String() != "1234" {
		t.Fatalf("command output limit was not enforced: exceeded=%v value=%q err=%v", buffer.exceeded, buffer.String(), err)
	}
}

func TestSessionSnapshotSubscriptionStartsAfterSnapshotState(t *testing.T) {
	manager := NewSessionManager(t.TempDir())
	session := newSession(
		"snapshot-order", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, manager.baseDir,
	)
	session.events = manager.events
	session.appendMessage(map[string]any{"kind": "assistant", "text": "before"})
	subscription, snapshot := session.subscribeWithSnapshot(2)
	defer subscription.Close()

	messages, ok := snapshot["messages"].([]map[string]any)
	if !ok || len(messages) != 1 || stringValue(messages[0]["text"]) != "before" {
		t.Fatalf("snapshot did not include existing state: %#v", snapshot)
	}
	select {
	case event := <-subscription.Events():
		t.Fatalf("pre-snapshot event leaked into incremental stream: %#v", event)
	default:
	}
	session.appendMessage(map[string]any{"kind": "assistant", "text": "after"})
	select {
	case event := <-subscription.Events():
		message := mapValue(event.Payload["message"])
		if stringValue(message["text"]) != "after" {
			t.Fatalf("unexpected incremental event: %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("post-snapshot event was not delivered")
	}
}

func TestPermissionEventsCarryAuthoritativeSessionState(t *testing.T) {
	session := newSession(
		"permission-state", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	subscription := session.events.Subscribe(session.ID, 2)
	defer subscription.Close()
	permission := Permission{ID: "approval-1", Status: "pending", Title: "Command execution"}
	session.addPermission(permission)

	requestEvent := <-subscription.Events()
	requestState := mapValue(requestEvent.Payload["state"])
	if stringValue(requestEvent.Payload["type"]) != "permission-request" ||
		stringValue(requestState["status"]) != "waiting_approval" || numberInt64(requestState["pendingPermissionCount"]) != 1 {
		t.Fatalf("permission request omitted authoritative state: %#v", requestEvent.Payload)
	}
	if _, ok := session.finishPermission(permission.ID, "approved", "approved"); !ok {
		t.Fatal("permission was not completed")
	}
	updatedEvent := <-subscription.Events()
	updatedState := mapValue(updatedEvent.Payload["state"])
	if stringValue(updatedEvent.Payload["type"]) != "permission-updated" || numberInt64(updatedState["pendingPermissionCount"]) != 0 {
		t.Fatalf("permission update omitted authoritative count: %#v", updatedEvent.Payload)
	}
}

func TestCodexLargeCommandOutputDoesNotBlockTurnCompletion(t *testing.T) {
	session := newSession(
		"large-output", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	session.Provider = provider
	slow := session.events.Subscribe(session.ID, 1)
	defer slow.Close()

	provider.threadID = "thread-large"
	provider.handleNotification(
		"turn/started",
		map[string]any{"threadId": "thread-large", "turn": map[string]any{"id": "turn-large"}},
	)
	provider.handleNotification(
		"item/started",
		map[string]any{
			"threadId": "thread-large", "turnId": "turn-large",
			"item": map[string]any{
				"id": "command-large", "type": "commandExecution", "command": "large-output",
			},
		},
	)
	chunk := strings.Repeat("x", 256<<10)
	for index := 0; index < 64; index++ {
		provider.handleNotification(
			"item/commandExecution/outputDelta",
			map[string]any{"itemId": "command-large", "delta": chunk},
		)
	}
	provider.handleNotification(
		"turn/completed",
		map[string]any{
			"threadId": "thread-large",
			"turn":     map[string]any{"id": "turn-large", "status": "completed"},
		},
	)

	select {
	case <-slow.Done():
	case <-time.After(time.Second):
		t.Fatal("slow subscriber was not disconnected during large output")
	}
	session.mu.RLock()
	status := session.StatusValue
	result := ""
	foundTurnEnd := false
	for _, message := range session.Messages {
		if stringValue(message["providerId"]) == "command-large" {
			result = stringValue(message["result"])
		}
		if stringValue(message["kind"]) == "turn-end" && stringValue(message["turnId"]) == "turn-large" {
			foundTurnEnd = true
		}
	}
	session.mu.RUnlock()
	provider.streamMu.Lock()
	remainingStreams := len(provider.streams)
	provider.streamMu.Unlock()
	if status != "idle" || !foundTurnEnd {
		t.Fatalf("large output prevented completion: status=%s turnEnd=%v", status, foundTurnEnd)
	}
	if len(result) > maxCodexToolOutputBytes+len(codexOutputTruncatedMarker) ||
		!strings.Contains(result, codexOutputTruncatedMarker) {
		t.Fatalf("large output was not bounded: bytes=%d", len(result))
	}
	if remainingStreams != 0 {
		t.Fatalf("completed turn retained %d delta streams", remainingStreams)
	}
}

func BenchmarkCodexAssistantDeltaAccumulation(b *testing.B) {
	chunk := strings.Repeat("x", 4096)
	for iteration := 0; iteration < b.N; iteration++ {
		session := newSession(
			"benchmark", "Codex", "codex-structured",
			ToolInfo{Key: "codex", DisplayName: "Codex"}, ".",
		)
		provider := NewCodexProvider(session, nil)
		for index := 0; index < 256; index++ {
			provider.appendDelta(
				"item/agentMessage/delta",
				map[string]any{"itemId": "assistant", "delta": chunk},
			)
		}
	}
}

func TestCodexAbortWatchdogRecoversWhenInterruptNeverCompletes(t *testing.T) {
	session := newSession(
		"abort-watchdog", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	provider.cmd = exec.Command("codex")
	writes := make(chan []byte, 2)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID = "thread-abort"
	provider.turnID = "turn-abort"
	provider.turnStarted = millis() - 1000
	provider.abortGrace = 20 * time.Millisecond
	session.Provider = provider
	session.setState(map[string]any{"status": "running", "canAbort": true})

	done := make(chan error, 1)
	go func() { done <- provider.Interrupt(context.Background()) }()
	select {
	case encoded := <-writes:
		var request map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(encoded), &request); err != nil {
			t.Fatal(err)
		}
		if request["method"] != "turn/interrupt" {
			t.Fatalf("unexpected interrupt request: %#v", request)
		}
	case <-time.After(time.Second):
		t.Fatal("interrupt request was not sent")
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "stopped") {
			t.Fatalf("watchdog did not fail the pending interrupt: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("interrupt remained blocked after watchdog")
	}

	provider.mu.Lock()
	turnID, aborting, needsResume := provider.turnID, provider.aborting, provider.needsThreadResume
	provider.mu.Unlock()
	session.mu.RLock()
	status := session.StatusValue
	foundCancelled := false
	for _, message := range session.Messages {
		if stringValue(message["kind"]) == "turn-end" && stringValue(message["status"]) == "cancelled" {
			foundCancelled = true
		}
	}
	session.mu.RUnlock()
	if turnID != "" || aborting || !needsResume || status != "idle" || !foundCancelled {
		t.Fatalf(
			"watchdog recovery incomplete: turn=%q aborting=%v resume=%v status=%s cancelled=%v",
			turnID, aborting, needsResume, status, foundCancelled,
		)
	}
}

func TestCodexResumeAbortStopsProcessWithoutTurnID(t *testing.T) {
	session := newSession(
		"resume-abort", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	provider.cmd = exec.Command("codex")
	writes := make(chan []byte, 2)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID = "thread-before-resume"
	session.Provider = provider

	done := make(chan error, 1)
	go func() { done <- provider.Resume(context.Background(), "thread-stuck-resume") }()
	select {
	case encoded := <-writes:
		var request map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(encoded), &request); err != nil {
			t.Fatal(err)
		}
		if request["method"] != "thread/resume" || !boolValue(mapValue(request["params"])["excludeTurns"]) {
			t.Fatalf("unexpected resume request: %#v", request)
		}
	case <-time.After(time.Second):
		t.Fatal("resume request was not sent")
	}
	if err := provider.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "resume aborted") {
			t.Fatalf("resume did not report user abort: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("resume remained blocked after abort")
	}
	provider.mu.Lock()
	resuming, aborting, needsResume := provider.resuming, provider.aborting, provider.needsThreadResume
	provider.mu.Unlock()
	if resuming || aborting || !needsResume || session.StatusValue != "idle" {
		t.Fatalf("resume abort did not recover state: resuming=%v aborting=%v needsResume=%v status=%s", resuming, aborting, needsResume, session.StatusValue)
	}
}

func TestCodexForkIsSingleFlightAcrossProviderOperations(t *testing.T) {
	session := newSession(
		"fork-single-flight", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	provider.cmd = exec.Command("codex")
	writes := make(chan []byte, 4)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID = "thread-before-fork"
	session.Provider = provider

	type forkResult struct {
		id  string
		err error
	}
	done := make(chan forkResult, 1)
	go func() {
		id, err := provider.Fork(context.Background(), "thread-source")
		done <- forkResult{id: id, err: err}
	}()
	encoded := <-writes
	var request map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(encoded), &request); err != nil {
		t.Fatal(err)
	}
	if request["method"] != "thread/fork" {
		t.Fatalf("unexpected fork request: %#v", request)
	}
	if _, err := provider.Fork(context.Background(), "second-source"); err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatalf("concurrent fork was not rejected: %v", err)
	}
	if err := provider.Resume(context.Background(), "resume-source"); err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatalf("concurrent resume was not rejected: %v", err)
	}
	if err := provider.Send(context.Background(), ProviderInput{Text: "must not send"}); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("send during fork was not rejected: %v", err)
	}
	select {
	case extra := <-writes:
		t.Fatalf("busy operation wrote another RPC: %s", extra)
	default:
	}
	provider.handleRPC(map[string]any{
		"id": request["id"],
		"result": map[string]any{
			"thread":           map[string]any{"id": "thread-forked", "turns": []any{}},
			"initialTurnsPage": map[string]any{"data": []any{}, "nextCursor": nil},
		},
	})
	select {
	case result := <-done:
		if result.err != nil || result.id != "thread-forked" {
			t.Fatalf("fork failed: id=%q err=%v", result.id, result.err)
		}
	case <-time.After(time.Second):
		t.Fatal("fork did not finish")
	}
	provider.mu.Lock()
	threadID, inFlight, forking := provider.threadID, provider.resumeInFlight, provider.forking
	provider.mu.Unlock()
	if threadID != "thread-forked" || inFlight || forking || session.StatusValue != "idle" {
		t.Fatalf("fork lifecycle did not settle: thread=%q inFlight=%v forking=%v status=%s", threadID, inFlight, forking, session.StatusValue)
	}
}

func TestCodexCancelledForkPreservesHistoryAndRecyclesProcess(t *testing.T) {
	session := newSession(
		"fork-cancel", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	session.appendMessage(map[string]any{"kind": "assistant", "text": "keep existing history"})
	provider := NewCodexProvider(session, nil)
	provider.cmd = exec.Command("codex")
	writes := make(chan []byte, 2)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID = "thread-existing"
	session.Provider = provider
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := provider.Fork(ctx, "thread-source")
		done <- err
	}()
	select {
	case <-writes:
		cancel()
	case <-time.After(time.Second):
		t.Fatal("fork request was not sent")
	}
	select {
	case err := <-done:
		if err == nil || !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled fork returned the wrong error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled fork did not return")
	}
	session.mu.RLock()
	preserved := len(session.Messages) >= 1 && stringValue(session.Messages[0]["text"]) == "keep existing history"
	status := session.StatusValue
	session.mu.RUnlock()
	provider.mu.Lock()
	needsResume, command := provider.needsThreadResume, provider.cmd
	inFlight, forking := provider.resumeInFlight, provider.forking
	provider.mu.Unlock()
	if !preserved || status != "idle" || !needsResume || command != nil || inFlight || forking {
		t.Fatalf("cancelled fork damaged state: preserved=%v status=%s needsResume=%v command=%v inFlight=%v forking=%v", preserved, status, needsResume, command, inFlight, forking)
	}
}

func TestCodexHistoryPaginationPublishesOneAtomicReset(t *testing.T) {
	session := newSession(
		"history-pages", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	provider := NewCodexProvider(session, nil)
	provider.cmd = exec.Command("codex")
	writes := make(chan []byte, 2)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID = "thread-pages"
	session.Provider = provider
	subscription := session.events.Subscribe(session.ID, 2)
	defer subscription.Close()
	turn := func(id, text string) map[string]any {
		return map[string]any{
			"id": id, "status": "completed", "createdAt": float64(100), "completedAt": float64(101),
			"items": []any{map[string]any{"id": "item-" + id, "type": "agentMessage", "text": text}},
		}
	}
	result := map[string]any{
		"thread": map[string]any{"id": "thread-pages", "turns": []any{}},
		"initialTurnsPage": map[string]any{
			"data": []any{turn("turn-3", "three"), turn("turn-2", "two")}, "nextCursor": "older",
		},
	}

	done := make(chan error, 1)
	go func() { done <- provider.hydrateThread(context.Background(), result) }()
	select {
	case encoded := <-writes:
		var request map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(encoded), &request); err != nil {
			t.Fatal(err)
		}
		params := mapValue(request["params"])
		if request["method"] != "thread/turns/list" || stringValue(params["cursor"]) != "older" ||
			stringValue(params["itemsView"]) != "full" {
			t.Fatalf("unexpected history page request: %#v", request)
		}
		provider.handleRPC(map[string]any{
			"id":     request["id"],
			"result": map[string]any{"data": []any{turn("turn-1", "one")}, "nextCursor": nil},
		})
	case <-time.After(time.Second):
		t.Fatal("second history page was not requested")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	select {
	case event := <-subscription.Events():
		if stringValue(event.Payload["type"]) != "history-reset" {
			t.Fatalf("unexpected hydration event: %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("history reset was not published")
	}
	select {
	case event := <-subscription.Events():
		t.Fatalf("hydration published more than one event: %#v", event)
	default:
	}
	select {
	case <-subscription.Done():
		t.Fatal("healthy history subscriber was disconnected")
	default:
	}
	session.mu.RLock()
	texts := []string{}
	for _, message := range session.Messages {
		if stringValue(message["kind"]) == "assistant" {
			texts = append(texts, stringValue(message["text"]))
		}
	}
	session.mu.RUnlock()
	if strings.Join(texts, ",") != "one,two,three" {
		t.Fatalf("history pages were not restored oldest-first: %#v", texts)
	}
}

func TestCodexCancelledResumePreservesHistoryAndRecyclesProcess(t *testing.T) {
	session := newSession(
		"resume-cancel", "Codex", "codex-structured",
		ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir(),
	)
	session.appendMessage(map[string]any{"kind": "assistant", "text": "keep existing history"})
	provider := NewCodexProvider(session, nil)
	provider.cmd = exec.Command("codex")
	writes := make(chan []byte, 2)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID = "thread-existing"
	session.Provider = provider
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- provider.Resume(ctx, "thread-cancelled") }()
	select {
	case <-writes:
		cancel()
	case <-time.After(time.Second):
		t.Fatal("resume request was not sent")
	}
	select {
	case err := <-done:
		if err == nil || !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled resume returned the wrong error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled resume did not return")
	}
	session.mu.RLock()
	preserved := false
	for _, message := range session.Messages {
		if stringValue(message["text"]) == "keep existing history" {
			preserved = true
			break
		}
	}
	status := session.StatusValue
	session.mu.RUnlock()
	provider.mu.Lock()
	needsResume, command := provider.needsThreadResume, provider.cmd
	provider.mu.Unlock()
	if !preserved || status != "idle" || !needsResume || command != nil {
		t.Fatalf("cancelled resume damaged live state: preserved=%v status=%s needsResume=%v command=%v", preserved, status, needsResume, command)
	}
}
