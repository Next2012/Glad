package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func resourceDownloadReceipt(uri string) map[string]any {
	return map[string]any{"ok": true, "data": map[string]any{
		"status": "completed", "result": map[string]any{
			"resource_uri": uri, "media_type": "application/pdf", "size": 40,
			"sha256": strings.Repeat("a", 64),
		},
	}}
}

func TestResourceDownloadIndependentOfModelLink(t *testing.T) {
	for _, backend := range []string{"codex", "claude"} {
		for _, final := range []string{"[PDF](sandbox:/mnt/data/wrong.pdf)", "PDF 已生成。"} {
			t.Run(backend+"/"+final, func(t *testing.T) {
				root := t.TempDir()
				pdf := []byte("%PDF-1.7\n本次原始PDF\n%%EOF\n")
				uri := "botlink-hub://resource/software/pdf-instance/" + base64.RawURLEncoding.EncodeToString([]byte("botlink://markdown-pdf/tasks/build-original/document.pdf"))
				owner := strings.Repeat("test-owner-", 4)
				hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer "+owner {
						t.Error("download changed the resource owner")
						w.WriteHeader(403)
						return
					}
					var request map[string]any
					_ = json.NewDecoder(r.Body).Decode(&request)
					if request["method"] != "resources/read" || mapValue(request["params"])["uri"] != uri {
						t.Error("download did not read the receipt URI")
						w.WriteHeader(400)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{
						"contents": []any{map[string]any{"uri": uri, "mimeType": "application/pdf", "blob": base64.StdEncoding.EncodeToString(pdf)}},
					}})
				}))
				defer hub.Close()
				tokenFile := filepath.Join(root, "owner.token")
				_ = os.WriteFile(tokenFile, []byte(owner), 0600)
				session := newSession("pdf-turn", "PDF", backend+"-structured", ToolInfo{Key: backend}, root)
				session.environment = []string{"GLAD_WORKBENCH_MCP_URL=" + hub.URL, "GLAD_WORKBENCH_MCP_TOKEN_FILE=" + tokenFile}
				completeDownloadTurn(session, backend, "turn-1", resourceDownloadReceipt(uri), final)
				var text string
				for _, message := range session.Messages {
					if message["kind"] == "assistant" {
						text += stringValue(message["text"])
					}
				}
				prefix := "/api/sessions/pdf-turn/mcp-resource?uri="
				if !strings.Contains(text, prefix) {
					t.Fatalf("model link is not a download contract; receipt entry missing: %q", text)
				}
				manager := NewSessionManager(root)
				manager.sessions[session.ID] = session
				server := &Server{sessions: manager}
				mux := http.NewServeMux()
				server.registerWorkspaceRoutes(mux)
				response := httptest.NewRecorder()
				mux.ServeHTTP(response, httptest.NewRequest("GET", prefix+url.QueryEscape(uri), nil))
				if response.Code != 200 || response.Body.String() != string(pdf) || response.Header().Get("Content-Type") != "application/pdf" {
					t.Fatalf("receipt download failed: %d %q", response.Code, response.Body.String())
				}
			})
		}
	}
}

func testPDFURI(name string) string {
	return "botlink-hub://resource/software/pdf-instance/" + base64.RawURLEncoding.EncodeToString([]byte("botlink://markdown-pdf/tasks/build-original/"+name))
}

func TestResourceDownloadsOnlySuccessfulReceipts(t *testing.T) {
	uri := testPDFURI("document.pdf")
	for _, receipt := range []any{
		map[string]any{"isError": true, "structuredContent": resourceDownloadReceipt(uri)},
		map[string]any{"ok": false, "data": resourceDownloadReceipt(uri)},
		map[string]any{"status": "accepted", "data": resourceDownloadReceipt(uri)},
		map[string]any{"arguments": resourceDownloadReceipt(uri)},
		resourceDownloadReceipt("sandbox:/mnt/data/file.pdf"),
		resourceDownloadReceipt("botlink-hub://resource/software/../invalid"),
		resourceDownloadReceipt(uri + "?credential=never"),
		resourceDownloadReceipt(uri + "#fragment"),
	} {
		if values := mcpDownloads(receipt); len(values) != 0 {
			t.Fatalf("non-receipt input created downloads: %#v", values)
		}
	}
	session := newSession("one", "PDF", "codex-structured", ToolInfo{}, t.TempDir())
	completeDownloadTurn(session, "codex", "turn-1", nil, stringValue(resourceDownloadReceipt(uri)))
	for _, message := range session.Messages {
		if strings.HasPrefix(stringValue(message["id"]), "mcp-downloads-") {
			t.Fatal("assistant text was treated as a receipt")
		}
	}
}

func TestResourceDownloadsDeduplicateAndStayInTheirTurn(t *testing.T) {
	uri := testPDFURI("first.pdf")
	receipt := resourceDownloadReceipt(uri)
	wrapped := map[string]any{"structuredContent": receipt, "content": []any{map[string]any{"type": "text", "text": stringValue(receipt)}}}
	session := newSession("one", "PDF", "codex-structured", ToolInfo{}, t.TempDir())
	completeDownloadTurn(session, "codex", "turn-1", wrapped, "[PDF](sandbox:/mnt/data/not-first.pdf)")
	session.appendMessage(map[string]any{"kind": "turn-end", "threadId": "thread-1", "turnId": "turn-1"})
	completeDownloadTurn(session, "codex", "turn-2", nil, "没有本轮文件。")
	count := 0
	for _, message := range session.Messages {
		if strings.HasPrefix(stringValue(message["id"]), "mcp-downloads-") {
			count++
			if message["turnId"] != "turn-1" || strings.Count(stringValue(message["text"]), "/mcp-resource?") != 1 {
				t.Fatal("duplicate receipt or prior turn leaked into a new turn")
			}
		}
		if publicMessage(message, session.Kind)[resourceDownloadsKey] != nil {
			t.Fatal("private receipt metadata changed public message protocol")
		}
	}
	if count != 1 {
		t.Fatalf("download group count = %d", count)
	}
}

func TestResourceDownloadsHistoryAndLargeResult(t *testing.T) {
	uri := testPDFURI("history.pdf")
	receipt := resourceDownloadReceipt(uri)
	result := map[string]any{"structuredContent": receipt, "content": []any{map[string]any{"type": "text", "text": strings.Repeat("large output", 100000)}}}
	messages, err := buildCodexHistoryMessages(context.Background(), "thread-old", []any{map[string]any{
		"id": "old-turn", "status": "completed", "items": []any{
			map[string]any{"id": "old-tool", "type": "mcpToolCall", "status": "completed", "result": result},
			map[string]any{"id": "old-answer", "type": "agentMessage", "text": "[PDF](sandbox:/mnt/data/old.pdf)"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	session := newSession("restored", "PDF", "codex-structured", ToolInfo{}, t.TempDir())
	session.replaceMessages(messages)
	assertDownloadGroup(t, session, "old-turn", uri)
	session.replaceMessages(session.Messages)
	assertDownloadGroup(t, session, "old-turn", uri)

	// CLI 原生输出包装及 Claude 历史同样从未截断的回执提取资源。
	output := []any{map[string]any{"type": "input_text", "text": "Script completed\nOutput:"}, map[string]any{"type": "input_text", "text": stringValue(receipt)}}
	rollout := strings.Join([]string{
		stringValue(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "task_started", "turn_id": "native-turn"}}),
		stringValue(map[string]any{"type": "response_item", "payload": map[string]any{"type": "custom_tool_call_output", "call_id": "native-tool", "output": output}}),
		stringValue(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "task_complete", "turn_id": "native-turn"}}),
	}, "\n")
	messages, err = readCodexTranscriptReader(strings.NewReader(rollout), "native-thread")
	if err != nil {
		t.Fatal(err)
	}
	session.replaceMessages(messages)
	assertDownloadGroup(t, session, "native-turn", uri)

	claude := strings.Join([]string{
		stringValue(map[string]any{"type": "user", "uuid": "claude-turn", "message": map[string]any{"content": "请生成PDF"}}),
		stringValue(map[string]any{"type": "user", "uuid": "result", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "tool", "content": stringValue(result)}}}}),
		stringValue(map[string]any{"type": "assistant", "uuid": "answer", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "已完成。"}}}}),
	}, "\n")
	messages, err = readClaudeTranscriptReader(strings.NewReader(claude))
	if err != nil {
		t.Fatal(err)
	}
	session.replaceClaudeConversation(messages)
	assertDownloadGroup(t, session, "claude-turn", uri)
}

func assertDownloadGroup(t *testing.T, session *Session, turn, uri string) {
	t.Helper()
	count := 0
	for _, message := range session.Messages {
		if message["kind"] == "assistant" && strings.Contains(stringValue(message["text"]), "/mcp-resource?") {
			count++
			if message["turnId"] != turn || !strings.Contains(stringValue(message["text"]), url.QueryEscape(uri)) ||
				!strings.Contains(stringValue(message["text"]), "/api/sessions/"+session.ID+"/mcp-resource?") {
				t.Fatalf("download belongs to wrong resource or session: %#v", message)
			}
		}
	}
	if count != 1 {
		t.Fatalf("expected one receipt download group, got %d", count)
	}
}

func TestResourceDownloadsPreserveRoomReplyAndLateHistory(t *testing.T) {
	uri := testPDFURI("document.pdf")
	session := newSession("room", "PDF", "codex-structured", ToolInfo{}, t.TempDir())
	completeDownloadTurn(session, "codex", "turn", resourceDownloadReceipt(uri), "原模型答复和业务结论。")
	text, _, _ := resolveSessionTurn(session, RoomEntryRecord{NativeTurnID: "turn"})
	if !strings.Contains(text, "原模型答复和业务结论。") || !strings.Contains(text, "/mcp-resource?") {
		t.Fatalf("room projection lost original reply: %q", text)
	}

	late := newSession("late", "PDF", "codex-structured", ToolInfo{}, t.TempDir())
	provider := NewCodexProvider(late, nil)
	provider.threadID = "thread"
	late.appendMessage(map[string]any{"kind": "assistant", "turnId": "turn", "threadId": "thread", "text": "本轮答复"})
	late.appendMessage(map[string]any{"kind": "turn-end", "turnId": "turn", "threadId": "thread"})
	provider.applyItem(map[string]any{"id": "late-tool", "type": "mcpToolCall", "turnId": "turn", "threadId": "thread", "result": resourceDownloadReceipt(uri)}, "completed")
	late.replaceMessages(late.Messages)
	assertDownloadGroup(t, late, "turn", uri)
}

func TestResourceDownloadsNativeOutputShapes(t *testing.T) {
	uri := testPDFURI("native.pdf")
	receipt := resourceDownloadReceipt(uri)
	for _, raw := range []map[string]any{
		{"id": "dynamic", "type": "dynamicToolCall", "tool": "exec", "success": true, "contentItems": []any{map[string]any{"type": "inputText", "text": stringValue(receipt)}}},
		{"id": "command", "type": "commandExecution", "command": "mcp-client", "exitCode": 0, "aggregatedOutput": "MCP result\n" + stringValue(receipt)},
	} {
		session := newSession("native", "PDF", "codex-structured", ToolInfo{}, t.TempDir())
		provider := NewCodexProvider(session, nil)
		provider.threadID, provider.turnID = "thread", "turn"
		provider.applyItem(raw, "completed")
		session.appendMessage(map[string]any{"kind": "turn-end", "threadId": "thread", "turnId": "turn"})
		assertDownloadGroup(t, session, "turn", uri)
	}
	session := newSession("claude", "PDF", "claude-structured", ToolInfo{}, t.TempDir())
	provider := NewClaudeProvider(session, nil)
	provider.turns = []claudeTurn{{ID: "turn"}}
	provider.handleMessage(map[string]any{"type": "user", "tool_use_result": receipt, "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "tool", "content": "PDF generated"}}}})
	provider.handleMessage(map[string]any{"type": "result", "subtype": "success"})
	assertDownloadGroup(t, session, "turn", uri)
}

func TestResourceDownloadsLateAndMultipleReceipts(t *testing.T) {
	session := newSession("late", "PDF", "codex-structured", ToolInfo{}, t.TempDir())
	provider := NewCodexProvider(session, nil)
	provider.threadID = "thread"
	session.appendMessage(map[string]any{"kind": "turn-end", "threadId": "thread", "turnId": "turn", "isRootTurn": true})
	for _, name := range []string{"one.pdf", "two.pdf"} {
		uri := testPDFURI(name)
		provider.applyItem(map[string]any{"id": name, "type": "mcpToolCall", "threadId": "thread", "turnId": "turn", "result": resourceDownloadReceipt(uri)}, "completed")
	}
	count := 0
	for _, message := range session.Messages {
		if strings.HasPrefix(stringValue(message["id"]), "mcp-downloads-") {
			count++
			if strings.Count(stringValue(message["text"]), "/mcp-resource?") != 2 {
				t.Fatal("late receipt did not update the same download group")
			}
		}
	}
	if count != 1 {
		t.Fatalf("late receipts duplicated the group: %d", count)
	}
}

func completeDownloadTurn(session *Session, backend, turn string, receipt any, final string) {
	if backend == "codex" {
		provider := NewCodexProvider(session, nil)
		provider.threadID, provider.turnID = "thread-1", turn
		provider.applyItem(map[string]any{"id": "tool-" + turn, "type": "mcpToolCall", "threadId": "thread-1", "turnId": turn, "server": "botlink", "tool": "get_task", "result": receipt}, "completed")
		provider.applyItem(map[string]any{"id": "answer-" + turn, "type": "agentMessage", "threadId": "thread-1", "turnId": turn, "text": final}, "completed")
		provider.handleNotification("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]any{"id": turn, "status": "completed"}})
		return
	}
	provider := NewClaudeProvider(session, nil)
	provider.turns = []claudeTurn{{ID: turn, Started: millis()}}
	provider.handleMessage(map[string]any{"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "tool-" + turn, "content": stringValue(receipt)}}}})
	provider.handleMessage(map[string]any{"type": "assistant", "uuid": "answer-" + turn, "message": map[string]any{"id": "answer-" + turn, "content": []any{map[string]any{"type": "text", "text": final}}}})
	provider.handleMessage(map[string]any{"type": "result", "subtype": "success"})
}
