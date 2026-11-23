package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const sessionWSReadBytes = 8 << 20
const sessionWSCommandBytes = 8 << 20

// A disclosure can request several tool details at once. Keep that normal burst
// small and bounded, with the active command included in both limits.
const sessionWSCommandCount = 32

var errWSCommandCount = errors.New("command count limit")
var errWSCommandBytes = errors.New("command byte limit")
var errWSResponseQueue = errors.New("response queue limit")
var errWSCommandPanic = errors.New("command panic")

type sessionWSCommands struct {
	mu           sync.Mutex
	items        chan []byte
	count, bytes int
	closed       bool
}

func newSessionWSCommands() *sessionWSCommands {
	return &sessionWSCommands{items: make(chan []byte, sessionWSCommandCount)}
}

func (queue *sessionWSCommands) enqueue(data []byte) error {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if queue.closed {
		return context.Canceled
	}
	if queue.count >= sessionWSCommandCount {
		return errWSCommandCount
	}
	if len(data) > sessionWSCommandBytes-queue.bytes {
		return errWSCommandBytes
	}
	queue.count++
	queue.bytes += len(data)
	select {
	case queue.items <- data:
		return nil // capacity includes the in-flight reservation
	default:
		queue.count--
		queue.bytes -= len(data)
		return errWSCommandCount
	}
}

func (queue *sessionWSCommands) release(size int) {
	queue.mu.Lock()
	queue.count--
	queue.bytes -= size
	queue.mu.Unlock()
}

func (queue *sessionWSCommands) stats() (int, int) {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	return queue.count, queue.bytes
}

func (queue *sessionWSCommands) stop() {
	queue.mu.Lock()
	queue.closed = true
	queue.mu.Unlock()
	for {
		select {
		case data := <-queue.items:
			queue.release(len(data))
		default:
			return
		}
	}
}

func (queue *sessionWSCommands) run(ctx context.Context, handle func([]byte)) {
	for {
		select {
		case <-ctx.Done():
			return
		case data := <-queue.items:
			func() {
				defer queue.release(len(data))
				if ctx.Err() == nil {
					handle(data)
				}
			}()
		}
	}
}

func sessionWSRequestType(value string) string {
	switch value {
	case "claude-input", "codex-input", "antigravity-input", "claude-permission", "codex-permission", "antigravity-permission",
		"claude-user-input", "antigravity-user-input", "claude-settings", "codex-settings", "antigravity-settings",
		"claude-abort", "codex-abort", "antigravity-abort", "claude-resume", "codex-status", "antigravity-status", "claude-status",
		"claude-usage", "claude-context", "codex-compact", "antigravity-compact", "claude-compact", "codex-detail-request", "antigravity-detail-request":
		return value
	default:
		return "unknown"
	}
}

func sessionWSCorrelation(value any) string {
	text, ok := value.(string)
	if !ok || len(text) == 0 || len(text) > 128 || strings.TrimSpace(text) != text || !utf8.ValidString(text) {
		return ""
	}
	for _, char := range text {
		if char < 0x20 || char == 0x7f {
			return ""
		}
	}
	return text
}

func sessionWSRejected(data []byte, reason string) map[string]any {
	var envelope struct {
		Type            string          `json:"type"`
		ClientMessageID string          `json:"clientMessageId"`
		RequestID       json.RawMessage `json:"requestId"`
	}
	_ = json.Unmarshal(data, &envelope)
	kind := sessionWSRequestType(envelope.Type)
	if kind == "claude-input" || kind == "codex-input" || kind == "antigravity-input" {
		if id := sessionWSCorrelation(strings.TrimSpace(envelope.ClientMessageID)); id != "" {
			return map[string]any{"type": "send-result", "clientMessageId": id, "accepted": false, "error": reason}
		}
	}
	result := map[string]any{"type": "error", "commandRejected": true, "requestType": kind, "message": reason, "error": reason}
	var requestID string
	if json.Unmarshal(envelope.RequestID, &requestID) == nil {
		if id := sessionWSCorrelation(requestID); id != "" {
			result["requestId"] = id
		}
	}
	return result
}

type sessionWSTransport struct {
	cancel        context.CancelFunc
	queue         *sessionWSCommands
	session, tool string
	closeOnce     sync.Once
	closeLogOnce  sync.Once
	closeRecord   *sessionWSDiagnostic
	rejections    atomic.Uint64
	refresh       chan struct{}
	diagnostics   chan sessionWSDiagnostic
}

type sessionWSDiagnostic struct {
	source, cause                  string
	code, frameBytes, count, bytes int
	rejections                     uint64
}

func newSessionWSTransport(session *Session, queue *sessionWSCommands, cancel context.CancelFunc) *sessionWSTransport {
	sum := sha256.Sum256([]byte(session.ID))
	tool := session.Tool.Key
	if tool != "codex" && tool != "claude-code" && tool != "antigravity" {
		tool = "unknown"
	}
	return &sessionWSTransport{cancel: cancel, queue: queue, session: fmt.Sprintf("%x", sum[:6]), tool: tool, refresh: make(chan struct{}, 1), diagnostics: make(chan sessionWSDiagnostic, 1)}
}

func (transport *sessionWSTransport) refreshControlState(kind string) {
	switch kind {
	case "claude-abort", "codex-abort", "antigravity-abort", "claude-compact", "codex-compact", "antigravity-compact",
		"claude-settings", "codex-settings", "antigravity-settings", "claude-resume":
		select {
		case transport.refresh <- struct{}{}:
		default:
		}
	}
}

func (transport *sessionWSTransport) runStateRefresh(ctx context.Context, session *Session) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-transport.refresh:
			if ctx.Err() == nil {
				session.setState(nil)
			}
		case record := <-transport.diagnostics:
			log.Printf("[ws-transport] event=reject source=queue session_hash=%s tool=%s cause=%s frame_bytes=%d commands=%d command_bytes=%d rejects=%d", transport.session, transport.tool, record.cause, record.frameBytes, record.count, record.bytes, record.rejections)
		}
	}
}

func (transport *sessionWSTransport) runCommands(ctx context.Context, handle func([]byte)) {
	defer func() {
		if recover() != nil {
			// A command runs outside net/http's recovery boundary. Keep provider
			// panics local to this connection without retaining their contents.
			transport.close("command", errWSCommandPanic, 0)
		}
	}()
	transport.queue.run(ctx, handle)
}

func sessionWSCause(err error) string {
	switch {
	case errors.Is(err, websocket.ErrMessageTooBig):
		return "read-limit"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, errWSCommandCount):
		return "command-count"
	case errors.Is(err, errWSCommandBytes):
		return "command-bytes"
	case errors.Is(err, errWSResponseQueue):
		return "response-queue"
	case errors.Is(err, errWSCommandPanic):
		return "panic"
	case err == nil:
		return "ended"
	case websocket.CloseStatus(err) != -1:
		return "peer-close"
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "deadline"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "io"
	}
	var valueError *json.UnsupportedValueError
	var typeError *json.UnsupportedTypeError
	if errors.As(err, &valueError) || errors.As(err, &typeError) {
		return "json"
	}
	return "io"
}

func writeSessionWSJSON(ctx context.Context, connection *websocket.Conn, value any) (int, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return 0, err
	}
	return len(data), connection.Write(ctx, websocket.MessageText, data)
}

func (transport *sessionWSTransport) close(source string, err error, frameBytes int) {
	transport.closeOnce.Do(func() {
		count, bytes := transport.queue.stats()
		transport.closeRecord = &sessionWSDiagnostic{source: source, cause: sessionWSCause(err), code: int(websocket.CloseStatus(err)), frameBytes: frameBytes, count: count, bytes: bytes}
		transport.cancel()
	})
}

func (transport *sessionWSTransport) logClose() {
	transport.closeLogOnce.Do(func() {
		if record := transport.closeRecord; record != nil {
			// Called after the socket has closed. Untrusted error text and peer
			// reasons are neither retained in the record nor passed to the logger.
			log.Printf("[ws-transport] event=close source=%s session_hash=%s tool=%s code=%d cause=%s frame_bytes=%d commands=%d command_bytes=%d", record.source, transport.session, transport.tool, record.code, record.cause, record.frameBytes, record.count, record.bytes)
		}
	})
}

func (transport *sessionWSTransport) rejected(err error, frameBytes int) {
	count := transport.rejections.Add(1)
	if count != 1 && count%64 != 0 {
		return
	}
	queued, bytes := transport.queue.stats()
	select {
	case transport.diagnostics <- sessionWSDiagnostic{cause: sessionWSCause(err), frameBytes: frameBytes, count: queued, bytes: bytes, rejections: count}:
	default:
	}
}
