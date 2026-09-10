package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type codexPendingUserInput struct {
	RPCID     any
	ThreadID  string
	TurnID    string
	Questions []map[string]any
	Async     bool
	Blocking  bool
}

// Both protocols use the same public question card. RPC questions keep their
// response pending; async agent messages are answered with turn/steer.
func codexInputQuestions(raw any, async bool) []map[string]any {
	questions := []map[string]any{}
	seen := map[string]bool{}
	for index, item := range mapsFromAny(raw) {
		id, title := stringValue(item["id"]), stringValue(item["question"])
		if async {
			id, title = fmt.Sprintf("q%d", index+1), stringValue(item["title"])
		}
		if id == "" || strings.TrimSpace(title) == "" || seen[id] {
			return nil
		}
		seen[id] = true
		options := []map[string]any{}
		for _, option := range sliceValue(item["options"]) {
			label, description := stringValue(option), ""
			if !async {
				value := mapValue(option)
				label, description = stringValue(value["label"]), stringValue(value["description"])
			}
			options = append(options, map[string]any{"label": label, "description": description})
		}
		questions = append(questions, map[string]any{
			"id": id, "question": title, "options": options, "isSecret": boolValue(item["isSecret"]),
		})
	}
	return questions
}

func (provider *CodexProvider) addUserInput(rpcID any, params map[string]any, async bool) {
	questions := codexInputQuestions(params["questions"], async)
	if len(questions) == 0 {
		if !async {
			provider.mu.Lock()
			_ = provider.writeLocked(map[string]any{"id": rpcID, "error": map[string]any{"code": -32602, "message": "Invalid user input questions"}})
			provider.mu.Unlock()
		}
		return
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	threadID := firstNonEmpty(stringValue(params["threadId"]), provider.threadID)
	turnID := firstNonEmpty(stringValue(params["turnId"]), provider.turnID)
	itemID := firstNonEmpty(stringValue(params["itemId"]), stringValue(params["id"]), stringValue(rpcID))
	key := fmt.Sprintf("%t:%s:%s:%s", async, threadID, turnID, itemID)
	id := ""
	provider.session.mu.RLock()
	for _, message := range provider.session.Messages {
		if message["questionKey"] == key {
			provider.session.mu.RUnlock()
			return // Repeated item notifications must not reopen an answered card.
		}
		if async && message["providerId"] == itemID && message["threadId"] == threadID {
			id = stringValue(message["id"])
		}
	}
	provider.session.mu.RUnlock()
	existing := id != ""
	if !existing {
		id = newUUID()
	}
	blocking := !async && (params["isBlocking"] == nil || boolValue(params["isBlocking"]))
	provider.userInputs[id] = codexPendingUserInput{
		RPCID: rpcID, ThreadID: threadID, TurnID: turnID, Questions: questions, Async: async, Blocking: blocking,
	}
	message := map[string]any{
		"id": id, "kind": "question", "providerId": itemID, "threadId": threadID, "turnId": turnID,
		"questionKey": key, "questions": questions, "questionStatus": "pending", "blocking": blocking,
		"text": stringValue(params["text"]), "delivery": params["delivery"], "streaming": false,
	}
	if message["text"] == "" {
		titles := []string{}
		for _, question := range questions {
			titles = append(titles, stringValue(question["question"]))
		}
		message["text"] = strings.Join(titles, "\n\n")
	}
	if existing {
		provider.session.patchMessage(id, message)
	} else {
		provider.session.appendMessage(message)
	}
	provider.updatePublicStateLocked("running")
}

// Called with provider.mu held. Empty thread/turn matches all pending cards.
func (provider *CodexProvider) cancelUserInputsLocked(threadID, turnID string, keepAsync bool) {
	for id, pending := range provider.userInputs {
		if (threadID != "" && pending.ThreadID != threadID) || (turnID != "" && pending.TurnID != turnID) {
			continue
		}
		if keepAsync && pending.Async && pending.ThreadID == provider.threadID {
			continue
		}
		delete(provider.userInputs, id)
		provider.session.patchMessage(id, map[string]any{"questionStatus": "cancelled"})
	}
}

func (provider *CodexProvider) resolveUserInput(params map[string]any) {
	provider.mu.Lock()
	for id, pending := range provider.userInputs {
		if !pending.Async && stringValue(pending.RPCID) == stringValue(params["requestId"]) && pending.ThreadID == stringValue(params["threadId"]) {
			delete(provider.userInputs, id)
			provider.session.patchMessage(id, map[string]any{"questionStatus": "cancelled"})
		}
	}
	provider.mu.Unlock()
	provider.refreshPublicState()
}

func (provider *CodexProvider) AnswerUserInput(ctx context.Context, id, clientID string, answers map[string]string) error {
	provider.mu.Lock()
	if provider.closed || provider.aborting || provider.resumeInFlight {
		provider.mu.Unlock()
		return errors.New("Codex session is unavailable")
	}
	pending, ok := provider.userInputs[id]
	if !ok {
		// A retry after a lost HTTP response must not submit the answer twice.
		provider.session.mu.RLock()
		accepted := false
		for _, message := range provider.session.Messages {
			if message["id"] == id && message["questionStatus"] == "answered" && message["answerClientMessageId"] == clientID && clientID != "" {
				accepted = true
			}
		}
		provider.session.mu.RUnlock()
		provider.mu.Unlock()
		if accepted {
			return nil
		}
		return errors.New("This question is no longer awaiting an answer")
	}
	if clientID == "" || len(answers) != len(pending.Questions) {
		provider.mu.Unlock()
		return errors.New("Answer every question before submitting")
	}
	wireAnswers := map[string]any{}
	text, displayText := []string{}, []string{}
	for _, question := range pending.Questions {
		qid := stringValue(question["id"])
		answer := strings.TrimSpace(answers[qid])
		if answer == "" {
			provider.mu.Unlock()
			return errors.New("Answer every question before submitting")
		}
		wireAnswers[qid] = map[string]any{"answers": []string{answer}}
		prefix := stringValue(question["question"]) + "\n"
		text = append(text, prefix+answer)
		if boolValue(question["isSecret"]) {
			answer = "[hidden]"
		}
		displayText = append(displayText, prefix+answer)
	}
	body, displayBody := strings.Join(text, "\n\n"), strings.Join(displayText, "\n\n")
	var err error
	if !pending.Async {
		err = provider.writeLocked(map[string]any{"id": pending.RPCID, "result": map[string]any{"answers": wireAnswers}})
	} else {
		turnID := provider.turnID
		if pending.ThreadID != provider.threadID {
			turnID = provider.activeTurns[pending.ThreadID].ID
		}
		if turnID != "" {
			provider.session.appendMessage(map[string]any{
				"kind": "user", "text": displayBody, "agentText": body, "clientMessageId": clientID,
				"threadId": pending.ThreadID, "turnId": turnID,
			})
			_, err = provider.requestLocked(ctx, "turn/steer", map[string]any{
				"threadId": pending.ThreadID, "expectedTurnId": turnID,
				"input": []any{map[string]any{"type": "text", "text": body}},
			})
		} else if pending.ThreadID == provider.threadID {
			// A completed async turn can receive the reply as the next user turn.
			provider.mu.Unlock()
			err = provider.Send(ctx, ProviderInput{ClientMessageID: clientID, Text: displayBody, AgentText: body})
			provider.mu.Lock()
		} else {
			err = errors.New("The subagent is no longer running")
		}
	}
	if err != nil {
		provider.mu.Unlock()
		provider.session.removeMessagesByClientMessageID(clientID)
		return err
	}
	delete(provider.userInputs, id)
	provider.session.patchMessage(id, map[string]any{"questionStatus": "answered", "answerClientMessageId": clientID})
	// Send already records idle replies. Active-turn replies and RPC responses
	// need their own visible user message (with secret answers redacted).
	provider.session.mu.RLock()
	recorded := false
	for _, message := range provider.session.Messages {
		if message["clientMessageId"] == clientID {
			recorded = true
		}
	}
	provider.session.mu.RUnlock()
	if !recorded {
		provider.session.appendMessage(map[string]any{"kind": "user", "text": displayBody, "clientMessageId": clientID})
	}
	provider.mu.Unlock()
	provider.refreshPublicState()
	return nil
}

func (server *Server) codexUserInput(writer http.ResponseWriter, request *http.Request) {
	provider, ok := server.codexProvider(writer, request)
	if !ok {
		return
	}
	var input struct {
		ID              string            `json:"id"`
		ClientMessageID string            `json:"clientMessageId"`
		Answers         map[string]string `json:"answers"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	provider.session.commandMu.Lock()
	defer provider.session.commandMu.Unlock()
	ctx, cancel := context.WithTimeout(request.Context(), 60*time.Second)
	defer cancel()
	if err := provider.AnswerUserInput(ctx, input.ID, input.ClientMessageID, input.Answers); err != nil {
		respondError(writer, http.StatusConflict, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true})
}
