package app

import (
	"context"
	"errors"
	"strings"
)

type claudePendingQuestion struct {
	RequestID string
	ToolUseID string
	MessageID string
	Input     map[string]any
}

func (provider *ClaudeProvider) addQuestion(requestID, toolUseID string, input map[string]any) {
	id := newUUID()
	message := provider.session.appendMessage(map[string]any{
		"id": id, "kind": "question", "toolUseId": toolUseID, "questions": input["questions"],
		"questionStatus": "pending", "blocking": true, "turnId": nilIfEmpty(provider.currentTurnID()),
	})
	if message == nil {
		provider.sendControlError(requestID, "Claude session is closed")
		return
	}
	provider.mu.Lock()
	provider.questions[id] = claudePendingQuestion{
		RequestID: requestID, ToolUseID: toolUseID, MessageID: id, Input: cloneMap(input),
	}
	pending := len(provider.questions)
	provider.mu.Unlock()
	provider.session.setState(map[string]any{"status": "waiting_input", "pendingQuestionCount": pending, "canAbort": true})
	provider.session.emit(map[string]any{"type": "question-request", "questionId": id})
}

func (provider *ClaudeProvider) RespondUserInput(_ context.Context, id string, payload map[string]any) error {
	provider.mu.Lock()
	pending, ok := provider.questions[id]
	if ok {
		delete(provider.questions, id)
	}
	remaining := len(provider.questions)
	provider.mu.Unlock()
	if !ok {
		return errors.New("question request not found")
	}
	updated := cloneMap(pending.Input)
	updated["answers"] = mapValue(payload["answers"])
	if response := strings.TrimSpace(stringValue(payload["response"])); response != "" {
		updated["response"] = response
	}
	provider.session.patchMessage(id, map[string]any{
		"questionStatus": "answered", "answers": updated["answers"], "response": updated["response"],
		"answerClientMessageId": payload["clientMessageId"], "answerRoomActionSource": payload["roomActionSource"],
	})
	provider.sendControl(pending.RequestID, map[string]any{
		"subtype": "success", "request_id": pending.RequestID,
		"response": map[string]any{
			"behavior": "allow", "updatedInput": updated, "toolUseID": pending.ToolUseID,
			"decisionClassification": "user_temporary",
		},
	})
	status := "thinking"
	if remaining > 0 {
		status = "waiting_input"
	}
	provider.session.setState(map[string]any{"status": status, "pendingQuestionCount": remaining})
	return nil
}

func (provider *ClaudeProvider) cancelQuestionRequest(requestID string) {
	provider.mu.Lock()
	messageIDs := []string{}
	for id, pending := range provider.questions {
		if pending.RequestID == requestID {
			delete(provider.questions, id)
			messageIDs = append(messageIDs, pending.MessageID)
		}
	}
	remaining := len(provider.questions)
	provider.mu.Unlock()
	for _, id := range messageIDs {
		provider.session.patchMessage(id, map[string]any{"questionStatus": "cancelled"})
	}
	if len(messageIDs) > 0 {
		provider.session.setState(map[string]any{"status": "thinking", "pendingQuestionCount": remaining})
	}
}

// Adapt the browser question contract without granting tool permissions.
func (provider *ClaudeProvider) AnswerUserInput(ctx context.Context, id, clientID string, answers map[string]string, images []Attachment, sources ...*RoomActionSource) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(images) > 0 {
		return errors.New("Claude questions do not accept image answers")
	}
	provider.mu.Lock()
	pending, ok := provider.questions[id]
	provider.mu.Unlock()
	if !ok {
		provider.session.mu.RLock()
		defer provider.session.mu.RUnlock()
		for _, message := range provider.session.Messages {
			if message["id"] == id && message["questionStatus"] == "answered" && clientID != "" && message["answerClientMessageId"] == clientID {
				return nil
			}
		}
		return errors.New("question request not found")
	}
	questions := mapsFromAny(pending.Input["questions"])
	if clientID == "" || len(answers) != len(questions) {
		return errors.New("Answer every question before submitting")
	}
	values := map[string]any{}
	for _, question := range questions {
		key := firstNonEmpty(stringValue(question["id"]), stringValue(question["question"]))
		answer := strings.TrimSpace(answers[key])
		if answer == "" {
			return errors.New("Answer every question before submitting")
		}
		values[stringValue(question["question"])] = answer
	}
	payload := map[string]any{"answers": values, "clientMessageId": clientID}
	if len(sources) > 0 && sources[0] != nil {
		payload["roomActionSource"] = sources[0].values()
	}
	return provider.RespondUserInput(ctx, id, payload)
}

var (
	_ QuestionProvider = (*ClaudeProvider)(nil)
	_ QuestionProvider = (*CodexProvider)(nil)
	_ QuestionProvider = (*AntigravityProvider)(nil)
)
