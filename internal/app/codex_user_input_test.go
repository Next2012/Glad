package app

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func questionTestProvider(t *testing.T) (*CodexProvider, chan []byte) {
	t.Helper()
	session := newSession("questions", "Codex", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	provider := NewCodexProvider(session, nil)
	session.Provider = provider
	provider.cmd = exec.Command("unused-question-peer")
	provider.threadID, provider.turnID = "root", "turn"
	writes := make(chan []byte, 16)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.updatePublicState("running")
	t.Cleanup(func() { session.cancel(); _ = provider.Close(context.Background()) })
	return provider, writes
}

func addTestQuestion(provider *CodexProvider, async bool) string {
	questions := []any{
		map[string]any{"id": "count", "question": "How many samples?", "title": "How many samples?", "options": nil},
		map[string]any{"id": "people", "question": "How many people?", "title": "How many people?", "options": nil},
	}
	params := map[string]any{"threadId": "root", "turnId": "turn", "itemId": "question-item", "questions": questions}
	if async {
		params["id"], params["type"], params["delivery"] = "question-item", "agentMessage", "async"
		provider.applyItem(params, "completed")
	} else {
		provider.handleRPC(map[string]any{"id": "rpc-question", "method": "item/tool/requestUserInput", "params": params})
	}
	for id := range provider.userInputs {
		return id
	}
	return ""
}

func questionMessage(provider *CodexProvider, id string) map[string]any {
	provider.session.mu.RLock()
	defer provider.session.mu.RUnlock()
	for _, message := range provider.session.Messages {
		if message["id"] == id {
			return cloneMap(message)
		}
	}
	return nil
}

func TestCodexBlockingQuestionWaitsForExplicitCompleteAnswer(t *testing.T) {
	provider, writes := questionTestProvider(t)
	id := addTestQuestion(provider, false)
	if id == "" || len(writes) != 0 || provider.session.StatusValue != "waiting_input" {
		t.Fatal("question did not wait for user input")
	}
	if err := provider.AnswerUserInput(context.Background(), id, "answer", map[string]string{"count": "1000"}, nil); err == nil || len(writes) != 0 {
		t.Fatal("incomplete answer released the request")
	}
	answers := map[string]string{"count": "1000", "people": "2"}
	if err := provider.AnswerUserInput(context.Background(), id, "answer", answers, nil); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	_ = json.Unmarshal(<-writes, &response)
	wire := mapValue(mapValue(response["result"])["answers"])
	if response["id"] != "rpc-question" || stringsFromAny(mapValue(wire["count"])["answers"])[0] != "1000" {
		t.Fatalf("wrong RPC answer: %v", response)
	}
	if provider.session.StatusValue != "running" || questionMessage(provider, id)["questionStatus"] != "answered" {
		t.Fatal("answer did not settle the waiting state")
	}
	if err := provider.AnswerUserInput(context.Background(), id, "answer", answers, nil); err != nil || len(writes) != 0 {
		t.Fatal("retry was not idempotent")
	}
	if err := provider.AnswerUserInput(context.Background(), id, "different-client", answers, nil); err == nil {
		t.Fatal("another client answered an already resolved question")
	}
}

func TestCodexAsyncQuestionSteersAndPreservesIdleCompletion(t *testing.T) {
	provider, writes := questionTestProvider(t)
	id := addTestQuestion(provider, true)
	image := Attachment{ID: "screenshot", Name: "screen.png", Path: "/tmp/screen.png", MediaType: "image/png"}
	if provider.session.StatusValue != "running" || len(writes) != 0 {
		t.Fatal("async question should allow work to continue")
	}
	result := make(chan error, 1)
	go func() {
		result <- provider.AnswerUserInput(context.Background(), id, "answer", map[string]string{"q1": "1000", "q2": "2"}, []Attachment{image})
	}()
	var request map[string]any
	select {
	case raw := <-writes:
		_ = json.Unmarshal(raw, &request)
	case <-time.After(time.Second):
		t.Fatal("answer did not reach Codex")
	}
	params := mapValue(request["params"])
	if request["method"] != "turn/steer" || params["expectedTurnId"] != "turn" || params["threadId"] != "root" || params["model"] != nil {
		t.Fatalf("wrong steering request: %v", request)
	}
	items := sliceValue(params["input"])
	if len(items) != 2 || mapValue(items[1])["type"] != "localImage" || mapValue(items[1])["path"] != image.Path {
		t.Fatalf("screenshot was not steered with the answer: %v", params["input"])
	}
	// Echo and completion may arrive before the RPC response. Neither may
	// duplicate the visible answer or leave the composer stuck running.
	provider.applyItem(map[string]any{"type": "userMessage", "id": "echo", "threadId": "root", "content": params["input"]}, "completed")
	provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "turn", "status": "completed"}})
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turnId": "turn"}})
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if provider.session.StatusValue != "idle" || questionMessage(provider, id)["questionStatus"] != "answered" {
		t.Fatal("late answer response revived a completed turn")
	}
	users := 0
	for _, message := range provider.session.Messages {
		if message["kind"] == "user" {
			users++
			if users == 1 && len(message["attachments"].([]map[string]any)) != 1 {
				t.Fatal("screenshot is missing from the visible answer")
			}
		}
	}
	if users != 1 || len(writes) != 0 {
		t.Fatalf("answer was duplicated: users=%d writes=%d", users, len(writes))
	}
	addTestQuestion(provider, true)
	if len(provider.userInputs) != 0 {
		t.Fatal("duplicate item notification reopened an answered question")
	}
}

func TestCodexAsyncQuestionCanBeAnsweredAfterTurnEnds(t *testing.T) {
	provider, writes := questionTestProvider(t)
	id := addTestQuestion(provider, true)
	provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "turn", "status": "completed"}})
	if questionMessage(provider, id)["questionStatus"] != "pending" {
		t.Fatal("completion discarded an unanswered async question")
	}
	result := make(chan error, 1)
	go func() {
		result <- provider.AnswerUserInput(context.Background(), id, "late-answer", map[string]string{"q1": "1000", "q2": "2"}, nil)
	}()
	var request map[string]any
	select {
	case raw := <-writes:
		_ = json.Unmarshal(raw, &request)
	case <-time.After(time.Second):
		t.Fatal("late answer did not start a turn")
	}
	if request["method"] != "turn/start" {
		t.Fatalf("late answer used %v", request["method"])
	}
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turn": map[string]any{"id": "next"}}})
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestCodexNewTurnClearsSupersededAsyncQuestion(t *testing.T) {
	provider, writes := questionTestProvider(t)
	id := addTestQuestion(provider, true)
	provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "turn", "status": "completed"}})
	if questionMessage(provider, id)["questionStatus"] != "pending" {
		t.Fatal("async question should remain answerable after its turn ends")
	}
	for attempt := 0; attempt < 2; attempt++ {
		result := make(chan error, 1)
		go func() {
			result <- provider.Send(context.Background(), ProviderInput{ClientMessageID: "new-message", Text: "New request", AgentText: "New request"})
		}()
		var request map[string]any
		select {
		case raw := <-writes:
			if err := json.Unmarshal(raw, &request); err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("new turn request did not reach Codex")
		}
		if request["method"] != "turn/start" {
			t.Fatalf("unexpected request: %v", request)
		}
		if attempt == 0 {
			provider.handleRPC(map[string]any{"id": request["id"], "error": map[string]any{"message": "turn rejected"}})
			if err := <-result; err == nil || questionMessage(provider, id)["questionStatus"] != "pending" {
				t.Fatal("failed new turn cancelled an answerable question")
			}
			continue
		}
		provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turn": map[string]any{"id": "new-turn"}}})
		if err := <-result; err != nil {
			t.Fatal(err)
		}
	}
	if len(provider.userInputs) != 0 || questionMessage(provider, id)["questionStatus"] != "cancelled" ||
		numberInt64(provider.session.State["pendingQuestionCount"]) != 0 {
		t.Fatal("new turn left a superseded question pending")
	}
}

func TestCodexNewTurnPreservesQuestionsReceivedBeforeStartResponse(t *testing.T) {
	for _, async := range []bool{true, false} {
		name := "blocking"
		if async {
			name = "async"
		}
		t.Run(name, func(t *testing.T) {
			provider, writes := questionTestProvider(t)
			oldID := addTestQuestion(provider, true)
			provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "turn", "status": "completed"}})
			result := make(chan error, 1)
			go func() {
				result <- provider.Send(context.Background(), ProviderInput{ClientMessageID: "new", Text: "New request", AgentText: "New request"})
			}()
			var request map[string]any
			select {
			case raw := <-writes:
				if err := json.Unmarshal(raw, &request); err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("turn/start was not sent")
			}
			// The event reader can process notifications before Send resumes.
			provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "new-turn"}})
			provider.addUserInput("fresh-rpc", map[string]any{
				"threadId": "root", "turnId": "new-turn", "itemId": "fresh-question",
				"questions": []any{map[string]any{"id": "q1", "question": "New question?", "title": "New question?"}},
			}, async)
			freshID := ""
			for id := range provider.userInputs {
				if id != oldID {
					freshID = id
				}
			}
			provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turn": map[string]any{"id": "new-turn"}}})
			if err := <-result; err != nil {
				t.Fatal(err)
			}
			if questionMessage(provider, oldID)["questionStatus"] != "cancelled" ||
				questionMessage(provider, freshID)["questionStatus"] != "pending" ||
				len(provider.userInputs) != 1 || numberInt64(provider.session.State["pendingQuestionCount"]) != 1 {
				t.Fatal("new turn must cancel only the old question and keep the fresh question answerable")
			}
			if !async {
				if provider.session.StatusValue != "waiting_input" {
					t.Fatal("new blocking question lost its waiting state")
				}
				if err := provider.AnswerUserInput(context.Background(), freshID, "fresh-answer", map[string]string{"q1": "Yes"}, nil); err != nil {
					t.Fatal(err)
				}
				var response map[string]any
				_ = json.Unmarshal(<-writes, &response)
				if response["id"] != "fresh-rpc" || response["result"] == nil {
					t.Fatal("fresh blocking request was not released by the answer")
				}
			}
		})
	}
}

func TestCodexQuestionCancellationAndHistory(t *testing.T) {
	for _, reason := range []string{"interrupt", "transport", "resolved"} {
		t.Run(reason, func(t *testing.T) {
			provider, writes := questionTestProvider(t)
			id := addTestQuestion(provider, false)
			switch reason {
			case "interrupt":
				provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "turn", "status": "interrupted"}})
			case "transport":
				provider.transportFailed(provider.cmd, context.Canceled)
			case "resolved":
				provider.handleNotification("serverRequest/resolved", map[string]any{"threadId": "root", "requestId": "rpc-question"})
			}
			if len(provider.userInputs) != 0 || questionMessage(provider, id)["questionStatus"] != "cancelled" {
				t.Fatal("stale question remains answerable")
			}
			if err := provider.AnswerUserInput(context.Background(), id, "late", map[string]string{"count": "1000", "people": "2"}, nil); err == nil || len(writes) != 0 {
				t.Fatal("answer was sent to a closed request")
			}
		})
	}
	history := codexHistoryItem(map[string]any{"type": "agentMessage", "delivery": "async", "questions": []any{map[string]any{"title": "Which one?", "options": []string{"A", "B"}}}})
	if history["kind"] != "question" || history["questionStatus"] != "historical" || len(history["questions"].([]map[string]any)) != 1 {
		t.Fatalf("history lost the question: %v", history)
	}
}

func TestCodexSecretAnswerIsOnlySentToProvider(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.addUserInput(123, map[string]any{"itemId": "secret", "questions": []any{map[string]any{"id": "secret", "question": "Secret?", "isSecret": true}}}, false)
	var id string
	for key := range provider.userInputs {
		id = key
	}
	if err := provider.AnswerUserInput(context.Background(), id, "secret-answer", map[string]string{"secret": "private-value"}, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(<-writes), "private-value") {
		t.Fatal("provider did not get the secret")
	}
	public, _ := json.Marshal(provider.session.snapshot())
	if strings.Contains(string(public), "private-value") || !strings.Contains(string(public), "[hidden]") {
		t.Fatal("secret answer leaked into the public snapshot")
	}
}
