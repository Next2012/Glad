package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type blockedTransportProvider struct {
	entered    chan struct{}
	release    chan struct{}
	cancelled  chan struct{}
	once       sync.Once
	cancelOnce sync.Once
	mu         sync.Mutex
	inputs     []ProviderInput
}

func (provider *blockedTransportProvider) Start(context.Context) error { return nil }
func (provider *blockedTransportProvider) Close(context.Context) error { return nil }
func (provider *blockedTransportProvider) Send(ctx context.Context, input ProviderInput) error {
	provider.mu.Lock()
	provider.inputs = append(provider.inputs, input)
	provider.mu.Unlock()
	provider.once.Do(func() { close(provider.entered) })
	select {
	case <-provider.release:
		return nil
	case <-ctx.Done():
		provider.cancelOnce.Do(func() { close(provider.cancelled) })
		return ctx.Err()
	}
}

type transportFixture struct {
	session    *Session
	connection *websocket.Conn
	messages   chan map[string]any
	closed     chan error
	provider   *blockedTransportProvider
}

func newTransportFixture(t *testing.T) *transportFixture {
	t.Helper()
	session := newSession("transport-test", "Transport test", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	session.State["threadId"] = "native-transport"
	session.State["aborting"] = false
	provider := &blockedTransportProvider{entered: make(chan struct{}), release: make(chan struct{}), cancelled: make(chan struct{})}
	session.Provider = provider
	manager := NewSessionManager(t.TempDir())
	manager.sessions[session.ID] = session
	server := &Server{sessions: manager, attachments: NewAttachmentStore()}
	handlerDone := make(chan struct{})
	host := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer close(handlerDone)
		server.websocket(writer, request)
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(host.URL, "http")+"?sessionId="+session.ID+"&history=tail", &websocket.DialOptions{CompressionMode: websocket.CompressionNoContextTakeover})
	if err != nil {
		cancel()
		host.Close()
		t.Fatal(err)
	}
	connection.SetReadLimit(16 << 20)
	fixture := &transportFixture{session: session, provider: provider, connection: connection, messages: make(chan map[string]any, 128), closed: make(chan error, 1)}
	go func() {
		for {
			_, data, err := connection.Read(ctx)
			if err != nil {
				fixture.closed <- err
				return
			}
			var message map[string]any
			if json.Unmarshal(data, &message) == nil {
				fixture.messages <- message
			}
		}
	}()
	t.Cleanup(func() {
		select {
		case <-provider.release:
		default:
			close(provider.release)
		}
		connection.CloseNow()
		cancel()
		select {
		case <-handlerDone:
		case <-time.After(3 * time.Second):
			t.Error("hijacked transport handler did not finish cleanup")
		}
		host.Close()
		session.cancel()
	})
	select {
	case message := <-fixture.messages:
		if message["type"] != "codex-snapshot" {
			t.Fatal("missing initial snapshot")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("initial snapshot did not arrive")
	}
	return fixture
}

func transportWrite(t *testing.T, connection *websocket.Conn, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}

func TestSessionTransportBlockedCommandKeepsControlFramesReadable(t *testing.T) {
	fixture := newTransportFixture(t)
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "blocked-input", "text": "Fixture input"})
	select {
	case <-fixture.provider.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("provider did not receive the command")
	}
	pingCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := fixture.connection.Ping(pingCtx); err != nil {
		t.Fatalf("control frames blocked behind provider Send: %v", err)
	}
	select {
	case message := <-fixture.messages:
		t.Fatalf("unexpected acceptance before provider returned: %v", message["type"])
	default:
	}
	close(fixture.provider.release)
	select {
	case message := <-fixture.messages:
		if message["type"] != "send-result" || message["clientMessageId"] != "blocked-input" || message["accepted"] != true {
			t.Fatal("accepted command did not receive its correlated acknowledgement")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("send acknowledgement did not arrive")
	}
}

func transportMessage(t *testing.T, fixture *transportFixture, match func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case message := <-fixture.messages:
			if match(message) {
				return message
			}
		case err := <-fixture.closed:
			t.Fatalf("connection closed before expected response: code=%d", websocket.CloseStatus(err))
		case <-deadline.C:
			t.Fatal("expected transport response did not arrive")
		}
	}
}

func TestSessionTransportLongCompressedUTF8InputIsAccepted(t *testing.T) {
	fixture := newTransportFixture(t)
	close(fixture.provider.release)
	text := strings.Repeat("长消息🌙", 10000)
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "long-utf8", "text": text})
	message := transportMessage(t, fixture, func(message map[string]any) bool { return message["type"] == "send-result" })
	if message["accepted"] != true {
		t.Fatal("valid long UTF-8 command was rejected")
	}
	fixture.provider.mu.Lock()
	defer fixture.provider.mu.Unlock()
	if len(fixture.provider.inputs) != 1 || fixture.provider.inputs[0].Text != text {
		t.Fatal("UTF-8 input was truncated or changed")
	}
}

func TestSessionTransportQueuePreservesOrderAndRejectsOverloadWithoutLosingPongs(t *testing.T) {
	fixture := newTransportFixture(t)
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "ordered-00", "text": "Blocked fixture input"})
	select {
	case <-fixture.provider.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("provider was not entered")
	}
	for index := 1; index < sessionWSCommandCount; index++ {
		transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": fmt.Sprintf("ordered-%02d", index), "text": "Queued fixture input"})
	}
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "rejected-input", "text": "Overloaded fixture input"})
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-detail-request", "requestId": "rejected-detail", "ids": []string{"fixture-detail"}})
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-abort"})
	seen := map[string]bool{}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for len(seen) < 4 {
		select {
		case message := <-fixture.messages:
			switch {
			case message["type"] == "send-result" && message["clientMessageId"] == "rejected-input":
				if message["accepted"] != false {
					t.Fatal("overloaded input was accepted")
				}
				seen["input"] = true
			case message["type"] == "error" && message["requestId"] == "rejected-detail":
				if message["commandRejected"] != true || message["requestType"] != "codex-detail-request" {
					t.Fatal("detail rejection lost its correlation")
				}
				seen["detail"] = true
			case message["type"] == "error" && message["requestType"] == "codex-abort":
				seen["control"] = true
			case message["type"] == "codex-event" && mapValue(message["event"])["type"] == "state":
				if mapValue(mapValue(message["event"])["state"])["aborting"] != false {
					t.Fatal("control rejection did not refresh canonical state")
				}
				seen["state"] = true
			default:
				t.Fatalf("queued provider command ran before its predecessor returned: %v", message["type"])
			}
		case <-deadline.C:
			t.Fatal("queue rejection or canonical control refresh was missing")
		}
	}
	pingCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := fixture.connection.Ping(pingCtx); err != nil {
		t.Fatal("full command queue blocked control frames")
	}
	close(fixture.provider.release)
	for index := 0; index < sessionWSCommandCount; index++ {
		message := transportMessage(t, fixture, func(message map[string]any) bool { return message["type"] == "send-result" })
		if message["accepted"] != true || message["clientMessageId"] != fmt.Sprintf("ordered-%02d", index) {
			t.Fatal("connection command order was not preserved")
		}
	}
}

func TestSessionTransportAggregateBytesIncludeBlockedCommandAndRemainBounded(t *testing.T) {
	fixture := newTransportFixture(t)
	text := strings.Repeat("汉🌙", 500000)
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "bytes-active", "text": text})
	select {
	case <-fixture.provider.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("provider was not entered")
	}
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "bytes-pending", "text": text})
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "bytes-rejected", "text": text})
	message := transportMessage(t, fixture, func(message map[string]any) bool { return message["clientMessageId"] == "bytes-rejected" })
	if message["accepted"] != false {
		t.Fatal("aggregate byte limit excluded the in-flight command")
	}
	pingCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := fixture.connection.Ping(pingCtx); err != nil {
		t.Fatal("byte overload blocked control frames")
	}
}

func TestSessionTransportDisconnectCancelsActiveAndQueuedCommands(t *testing.T) {
	fixture := newTransportFixture(t)
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "cancel-active", "text": "Blocked fixture input"})
	select {
	case <-fixture.provider.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("provider was not entered")
	}
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": "cancel-queued", "text": "Queued fixture input"})
	pingCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := fixture.connection.Ping(pingCtx); err != nil {
		t.Fatal(err)
	}
	fixture.connection.CloseNow()
	select {
	case <-fixture.provider.cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect did not cancel the active provider context")
	}
	fixture.provider.mu.Lock()
	defer fixture.provider.mu.Unlock()
	if len(fixture.provider.inputs) != 1 {
		t.Fatal("queued command ran after disconnect")
	}
}

func TestSessionTransportReadLimitStillRejectsOversizedCompressedFrame(t *testing.T) {
	fixture := newTransportFixture(t)
	data, _ := json.Marshal(map[string]any{"type": "codex-input", "clientMessageId": "too-large", "text": strings.Repeat("x", sessionWSReadBytes)})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = fixture.connection.Write(ctx, websocket.MessageText, data)
	select {
	case err := <-fixture.closed:
		if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
			t.Fatalf("oversized input did not close with 1009: %d", websocket.CloseStatus(err))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("oversized frame was not bounded")
	}
	select {
	case <-fixture.provider.entered:
		t.Fatal("oversized frame reached the provider")
	default:
	}
}

func TestSessionTransportInvalidLargeCorrelationIDsAreNotCachedOrEchoed(t *testing.T) {
	fixture := newTransportFixture(t)
	secret := "PRIVATE_CORRELATION_VALUE"
	for _, payload := range []map[string]any{
		{"type": "codex-input", "clientMessageId": strings.Repeat(secret, 20000), "text": "Fixture input"},
		{"type": "antigravity-input", "clientMessageId": strings.Repeat(secret, 20000), "text": "Wrong provider"},
		{"type": "codex-input", "clientMessageId": strings.Repeat(secret, 20000), "text": "Wrong delivery", "delivery": map[string]any{"invalid": true}},
		{"type": "codex-input", "clientMessageId": map[string]any{"private": secret}, "text": "Wrong ID type"},
		{"type": "codex-detail-request", "requestId": map[string]any{"private": strings.Repeat(secret, 20000)}},
		{"type": "codex-detail-request", "requestId": strings.Repeat(secret, 20000)},
	} {
		transportWrite(t, fixture.connection, payload)
		message := transportMessage(t, fixture, func(message map[string]any) bool { return message["type"] == "error" })
		encoded, _ := json.Marshal(message)
		if len(encoded) > 512 || strings.Contains(string(encoded), secret) || message["clientMessageId"] != nil || message["requestId"] != nil {
			t.Fatal("invalid correlation ID amplified or leaked into its response")
		}
	}
	fixture.session.mu.RLock()
	defer fixture.session.mu.RUnlock()
	if len(fixture.session.sendResults) != 0 || len(fixture.session.controlHashes) != 0 {
		t.Fatal("invalid correlation IDs were retained in a message cache")
	}
	select {
	case <-fixture.provider.entered:
		t.Fatal("invalid correlation ID reached provider")
	default:
	}
}

func TestSessionTransportPreservesLegacyTrimmedMessageID(t *testing.T) {
	fixture := newTransportFixture(t)
	close(fixture.provider.release)
	transportWrite(t, fixture.connection, map[string]any{"type": "codex-input", "clientMessageId": " \ttrimmed-id \n", "text": "Fixture input"})
	message := transportMessage(t, fixture, func(message map[string]any) bool { return message["type"] == "send-result" })
	if message["accepted"] != true || message["clientMessageId"] != "trimmed-id" {
		t.Fatal("legacy message ID normalization changed")
	}
}

func TestSessionTransportQueueReleasesPendingBytesWhenStopped(t *testing.T) {
	queue := newSessionWSCommands()
	if err := queue.enqueue(make([]byte, sessionWSCommandBytes)); err != nil {
		t.Fatal(err)
	}
	data := <-queue.items // reservation remains held while a command is active
	if err := queue.enqueue([]byte("x")); !errors.Is(err, errWSCommandBytes) {
		t.Fatal("active bytes were not counted")
	}
	queue.release(len(data))
	if err := queue.enqueue([]byte("pending")); err != nil {
		t.Fatal(err)
	}
	queue.stop()
	if count, bytes := queue.stats(); count != 0 || bytes != 0 {
		t.Fatal("cancelled pending bytes were retained")
	}
	if !errors.Is(queue.enqueue([]byte("closed")), context.Canceled) {
		t.Fatal("stopped queue accepted a command")
	}
}

func TestSessionTransportErrorsAndLogsNeverEchoUntrustedReasons(t *testing.T) {
	secret := "PRIVATE_REASON_OR_AUTH"
	data, _ := json.Marshal(map[string]any{"type": strings.Repeat(secret, 100), "requestId": map[string]any{"secret": secret}})
	encoded, _ := json.Marshal(sessionWSRejected(data, "Connection busy"))
	if len(encoded) > 512 || strings.Contains(string(encoded), secret) || !strings.Contains(string(encoded), `"requestType":"unknown"`) {
		t.Fatal("queue rejection echoed an arbitrary request type or object")
	}
	var output transportLogBuffer
	original := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(original)
	session := newSession(secret, "not logged", "codex-structured", ToolInfo{Key: secret}, t.TempDir())
	defer session.cancel()
	transport := newSessionWSTransport(session, newSessionWSCommands(), func() {})
	transport.close("read", websocket.CloseError{Code: websocket.StatusNormalClosure, Reason: secret}, 123)
	transport.logClose()
	if strings.Contains(output.String(), secret) || !strings.Contains(output.String(), "cause=peer-close") || !strings.Contains(output.String(), "tool=unknown") {
		t.Fatal("transport close log exposed a private reason or identifier")
	}
}

type transportLogBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *transportLogBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.Write(data)
}
func (buffer *transportLogBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String()
}

type blockedTransportLog struct{ release chan struct{} }

func (writer *blockedTransportLog) Write(data []byte) (int, error) {
	<-writer.release
	return len(data), nil
}

func TestSessionTransportQueueDiagnosticsDoNotBlockReaderOnLoggerBackpressure(t *testing.T) {
	original := log.Writer()
	release := make(chan struct{})
	log.SetOutput(&blockedTransportLog{release: release})
	defer func() { close(release); log.SetOutput(original) }()
	session := newSession("diagnostic-test", "not logged", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	defer session.cancel()
	transport := newSessionWSTransport(session, newSessionWSCommands(), func() {})
	done := make(chan struct{})
	go func() { transport.rejected(errWSCommandCount, 100); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("queue rejection synchronously waited for the logger")
	}
	if len(transport.diagnostics) != 1 {
		t.Fatal("queue rejection did not enter the bounded diagnostics channel")
	}
}
