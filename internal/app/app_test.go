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
