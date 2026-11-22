package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func readSteeringRequest(t *testing.T, writes <-chan []byte) map[string]any {
	t.Helper()
	select {
	case raw := <-writes:
		var request map[string]any
		if err := json.Unmarshal(raw, &request); err != nil {
			t.Fatal(err)
		}
		return request
	case <-time.After(time.Second):
		t.Fatal("no steering request")
		return nil
	}
}

func steeringInput() ProviderInput {
	return ProviderInput{ClientMessageID: "steering-message", Delivery: "steer", ExpectedTurnID: "turn", Text: "Visible instruction", AgentText: "Agent instruction\nFile: /tmp/notes.txt"}
}

func TestCodexSteeringPreservesTurnAttachmentsAndDeduplicates(t *testing.T) {
	provider, writes := questionTestProvider(t)
	input := steeringInput()
	input.Images = []Attachment{{ID: "image", Name: "screen.png", Path: "/tmp/screen.png"}}
	input.Files = []Attachment{{ID: "file", Name: "notes.txt", Path: "/tmp/notes.txt", Size: 7}}
	input.Skills = []map[string]any{{"name": "review", "path": "/tmp/SKILL.md"}}
	input.Source = &SupervisorSource{Version: 1, TaskID: newUUID(), InvocationID: newUUID(), Kind: "command"}
	if ok, _ := provider.CanAccept(); ok {
		t.Fatal("steering broadened idle-only readiness")
	}
	var workers sync.WaitGroup
	results := make(chan error, 8)
	for index := 0; index < 8; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			results <- sendSessionControlled(context.Background(), provider.session, input)
		}()
	}
	request := readSteeringRequest(t, writes)
	params := mapValue(request["params"])
	items := sliceValue(params["input"])
	if request["method"] != "turn/steer" || params["threadId"] != "root" || params["expectedTurnId"] != "turn" || params["clientUserMessageId"] != input.ClientMessageID || len(params) != 4 || len(items) != 3 {
		t.Fatalf("wrong steering wire shape: %#v", request)
	}
	if mapValue(items[0])["type"] != "skill" || mapValue(items[1])["text"] != input.AgentText || mapValue(items[2])["path"] != "/tmp/screen.png" {
		t.Fatalf("lost steering modalities: %#v", items)
	}
	if ok, _ := provider.CanSteer(); ok {
		t.Fatal("accepted concurrent provider steering")
	}
	// The echo can precede the response and contain normalized text. The client
	// identifier must retain the original visible message and attachments.
	provider.applyItem(map[string]any{"id": "steer-echo", "type": "userMessage", "threadId": "root", "turnId": "turn", "clientUserMessageId": input.ClientMessageID,
		"content": []any{map[string]any{"type": "text", "text": "normalized provider text"}}}, "completed")
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turnId": "turn"}})
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(writes) != 0 || provider.turnID != "turn" || provider.session.StatusValue != "running" || !boolValue(provider.session.State["canSteer"]) || provider.session.State["turnId"] != "turn" {
		t.Fatal("steering changed the running lifecycle or duplicated dispatch")
	}
	provider.session.mu.RLock()
	messages := append([]map[string]any(nil), provider.session.Messages...)
	provider.session.mu.RUnlock()
	if len(messages) != 1 {
		t.Fatalf("steering echo duplicated the message: %#v", messages)
	}
	message := cloneMap(messages[0])
	attachments, _ := message["attachments"].([]map[string]any)
	if message["text"] != input.Text || message["agentText"] != input.AgentText || len(attachments) != 2 || sourceValue(message["supervisorSource"]) == nil {
		t.Fatalf("lost display/provenance/attachments: %#v", message)
	}
	input.AgentText = "different"
	if err := sendSessionControlled(context.Background(), provider.session, input); err == nil || len(writes) != 0 {
		t.Fatal("reused client ID accepted different instructions")
	}
}

func TestCodexSteeringRejectsStaleAndBlockingStates(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*CodexProvider, *ProviderInput)
	}{
		{"stale", func(_ *CodexProvider, input *ProviderInput) { input.ExpectedTurnID = "old-turn" }},
		{"missing-turn", func(_ *CodexProvider, input *ProviderInput) { input.ExpectedTurnID = "" }},
		{"unknown-delivery", func(_ *CodexProvider, input *ProviderInput) { input.Delivery = "auto" }},
		{"expected-on-normal", func(_ *CodexProvider, input *ProviderInput) { input.Delivery = "" }},
		{"ordinary-send-busy", func(_ *CodexProvider, input *ProviderInput) { input.Delivery, input.ExpectedTurnID = "", "" }},
		{"recovering", func(provider *CodexProvider, _ *ProviderInput) { provider.session.recovering = true }},
		{"closed-session", func(provider *CodexProvider, _ *ProviderInput) { provider.session.closed = true }},
		{"lease", func(provider *CodexProvider, _ *ProviderInput) { provider.session.supervisorLease = "other-invocation" }},
		{"stopping", func(provider *CodexProvider, _ *ProviderInput) { provider.aborting = true }},
		{"sending", func(provider *CodexProvider, _ *ProviderInput) { provider.sending = true }},
		{"resuming", func(provider *CodexProvider, _ *ProviderInput) { provider.resumeInFlight = true }},
		{"idle", func(provider *CodexProvider, _ *ProviderInput) { provider.turnID = "" }},
		{"approval", func(provider *CodexProvider, _ *ProviderInput) {
			provider.permissions["approval"] = codexPendingPermission{}
		}},
		{"blocking-question", func(provider *CodexProvider, _ *ProviderInput) { addTestQuestion(provider, false) }},
		{"invalid-skill", func(_ *CodexProvider, input *ProviderInput) { input.Skills = []map[string]any{{"name": "review"}} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			provider, writes := questionTestProvider(t)
			input := steeringInput()
			test.edit(provider, &input)
			if err := sendSessionControlled(context.Background(), provider.session, input); err == nil || len(writes) != 0 || len(provider.session.Messages) > 1 {
				t.Fatalf("unavailable/stale instruction dispatched: %v", err)
			}
		})
	}
}

func TestCodexSteeringDoesNotAnswerAsyncQuestionOrReviveCompletedTurn(t *testing.T) {
	provider, writes := questionTestProvider(t)
	id := addTestQuestion(provider, true)
	result := make(chan error, 1)
	go func() { result <- sendSessionControlled(context.Background(), provider.session, steeringInput()) }()
	request := readSteeringRequest(t, writes)
	provider.handleRPC(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "root", "turn": map[string]any{"id": "turn", "status": "completed"}}})
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turnId": "turn"}})
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if provider.turnID != "" || provider.session.StatusValue != "idle" || boolValue(provider.session.State["canSteer"]) {
		t.Fatal("late steer reply revived a completed turn")
	}
	if questionMessage(provider, id)["questionStatus"] != "pending" {
		t.Fatal("ordinary instruction answered the async question")
	}
}

func TestCodexSteeringRollbackAndAmbiguousDelivery(t *testing.T) {
	for _, ambiguous := range []bool{false, true} {
		t.Run(map[bool]string{false: "rejected", true: "timeout"}[ambiguous], func(t *testing.T) {
			provider, writes := questionTestProvider(t)
			input := steeringInput()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- sendSessionControlled(ctx, provider.session, input) }()
			request := readSteeringRequest(t, writes)
			if ambiguous {
				cancel()
			} else {
				provider.handleRPC(map[string]any{"id": request["id"], "error": map[string]any{"message": "instruction rejected"}})
			}
			err := <-result
			if err == nil || len(provider.session.Messages) != 0 || provider.turnID != "turn" || provider.steering {
				t.Fatalf("failed steering was not rolled back: %v", err)
			}
			if ambiguous {
				if !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "uncertain") {
					t.Fatalf("missing uncertain result: %v", err)
				}
				if err := sendSessionControlled(context.Background(), provider.session, input); err == nil || len(writes) != 0 {
					t.Fatal("ambiguous instruction was automatically retried")
				}
			} else {
				go func() { result <- sendSessionControlled(context.Background(), provider.session, input) }()
				retry := readSteeringRequest(t, writes)
				provider.handleRPC(map[string]any{"id": retry["id"], "result": map[string]any{"turnId": "turn"}})
				if err := <-result; err != nil {
					t.Fatalf("definitive rejection blocked corrected retry: %v", err)
				}
			}
		})
	}
}
