package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func historyTestProvider(t *testing.T) (*CodexProvider, chan []byte, *http.ServeMux) {
	t.Helper()
	manager := NewSessionManager(t.TempDir())
	session := newSession("history-test", "Codex", "codex-structured", ToolInfo{Key: "codex"}, manager.baseDir)
	provider := NewCodexProvider(session, nil)
	writes := make(chan []byte, 4)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID = "current"
	session.Provider = provider
	manager.sessions[session.ID] = session
	server := &Server{sessions: manager}
	mux := http.NewServeMux()
	server.registerProviderRoutes(mux)
	return provider, writes, mux
}

func historyTestRequest(t *testing.T, writes chan []byte) map[string]any {
	t.Helper()
	select {
	case data := <-writes:
		var request map[string]any
		if err := json.Unmarshal(data, &request); err != nil {
			t.Fatal(err)
		}
		return request
	case <-time.After(time.Second):
		t.Fatal("history RPC was not sent")
		return nil
	}
}

func TestCodexHistoryListFiltersAndCursor(t *testing.T) {
	provider, writes, mux := historyTestProvider(t)
	for _, test := range []struct {
		query, sort, cursor, search string
		all                         bool
	}{
		{"", "updated_at", "", "", false},
		{"?scope=all&sort=created_at&cursor=opaque%2Bpage&search=%20needle%20", "created_at", "opaque+page", "needle", true},
	} {
		recorder := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			mux.ServeHTTP(recorder, httptest.NewRequest("GET", "/api/sessions/history-test/codex-resume-threads"+test.query, nil))
			close(done)
		}()
		request := historyTestRequest(t, writes)
		params := mapValue(request["params"])
		if request["method"] != "thread/list" || params["limit"] != float64(40) || params["sortKey"] != test.sort ||
			stringValue(params["cursor"]) != test.cursor || stringValue(params["searchTerm"]) != test.search || params["archived"] != false {
			t.Fatalf("incorrect history query: %#v", request)
		}
		_, hasCwd := params["cwd"]
		if hasCwd == test.all || (!test.all && params["cwd"] != provider.session.WorkingDirectory) {
			t.Fatalf("incorrect directory scope: %#v", params)
		}
		provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{
			"nextCursor": "next-page", "data": []any{
				map[string]any{"id": "current", "name": "Named thread", "preview": strings.Repeat("中文", 1000), "createdAt": 1700000000, "updatedAt": 1700000010, "cwd": "/project", "gitInfo": map[string]any{"branch": "main"}},
				map[string]any{"id": "child", "parentThreadId": "current"},
			},
		}})
		<-done
		var body map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || recorder.Code != 200 {
			t.Fatalf("invalid history response: %s", recorder.Body.String())
		}
		items := sliceValue(body["items"])
		if len(items) != 1 || body["nextCursor"] != "next-page" {
			t.Fatalf("lost pagination/filtering: %#v", body)
		}
		item := mapValue(items[0])
		if item["title"] != "Named thread" || item["current"] != true || item["branch"] != "main" || item["createdAt"] != float64(1700000000000) || len(stringValue(item["preview"])) > 603 {
			t.Fatalf("invalid metadata: %#v", item)
		}
	}
}

func TestCodexHistoryPreviewIsBoundedAndReadOnly(t *testing.T) {
	provider, writes, mux := historyTestProvider(t)
	provider.session.appendMessage(map[string]any{"kind": "assistant", "text": "preserve me"})
	subscription := provider.session.events.Subscribe(provider.session.ID, 4)
	defer subscription.Close()
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		mux.ServeHTTP(recorder, httptest.NewRequest("GET", "/api/sessions/history-test/codex-thread-preview?threadId=other", nil))
		close(done)
	}()
	request := historyTestRequest(t, writes)
	params := mapValue(request["params"])
	if request["method"] != "thread/turns/list" || params["threadId"] != "other" || params["limit"] != float64(3) || params["itemsView"] != "summary" || params["sortDirection"] != "desc" {
		t.Fatalf("preview must request bounded summaries, not resume: %#v", request)
	}
	turns := []any{}
	for turn := 0; turn < 3; turn++ {
		items := []any{map[string]any{"type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "user question"}}}}
		for i := 0; i < 4; i++ {
			items = append(items, map[string]any{"type": "agentMessage", "text": strings.Repeat("中文", 10000)})
		}
		items = append(items, map[string]any{"type": "commandExecution", "aggregatedOutput": strings.Repeat("do not send tool output", 10000)})
		turns = append(turns, map[string]any{"items": items})
	}
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"data": turns, "nextCursor": "must-not-follow"}})
	<-done
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || recorder.Code != 200 {
		t.Fatalf("invalid preview response: %s", recorder.Body.String())
	}
	messages := sliceValue(body["messages"])
	if len(messages) != 12 || recorder.Body.Len() > 26000 || strings.Contains(recorder.Body.String(), "do not send tool output") {
		t.Fatalf("preview is not bounded: count=%d bytes=%d", len(messages), recorder.Body.Len())
	}
	for _, value := range messages {
		text := stringValue(mapValue(value)["text"])
		if len(text) > 2003 || !utf8.ValidString(text) {
			t.Fatal("invalid truncated text")
		}
	}
	if provider.threadID != "current" || len(provider.session.Messages) != 1 || provider.session.Messages[0]["text"] != "preserve me" {
		t.Fatal("preview changed the active conversation")
	}
	select {
	case event := <-subscription.Events():
		t.Fatalf("preview broadcast an event: %#v", event)
	default:
	}
	select {
	case <-writes:
		t.Fatal("preview requested more history")
	default:
	}
}

func TestCodexHistoryPreviewCancellationAndMissingID(t *testing.T) {
	provider, writes, mux := historyTestProvider(t)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest("GET", "/api/sessions/history-test/codex-thread-preview", nil))
	if recorder.Code != 400 {
		t.Fatalf("missing ID returned %d", recorder.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := provider.previewThread(ctx, "other"); done <- err }()
	historyTestRequest(t, writes)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("wrong cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled preview remained blocked")
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if len(provider.pending) != 0 {
		t.Fatal("cancelled preview leaked a pending RPC")
	}
}
