package app

import (
	"context"
	"errors"
	"testing"
)

type questionReplyProvider struct {
	stubProvider
	replyError error
}

func (provider *questionReplyProvider) RespondUserInput(context.Context, string, map[string]any) error {
	return provider.replyError
}
func TestQuestionRepliesReturnCorrelatedSuccessAndRejection(t *testing.T) {
	for _, rejected := range []bool{false, true} {
		t.Run(map[bool]string{false: "accepted", true: "rejected"}[rejected], func(t *testing.T) {
			current := newSession("question-owner", "Owner", "claude-structured", ToolInfo{Key: "claude-code"}, t.TempDir())
			provider := &questionReplyProvider{}
			if rejected {
				provider.replyError = errors.New("question is no longer pending")
			}
			current.Provider = provider
			server := &Server{}
			var result map[string]any
			server.handleWebsocketMessage(context.Background(), current, func(value map[string]any) bool { result = value; return true }, map[string]any{"type": "claude-user-input", "id": "question", "clientMessageId": "reply-correlation", "answers": map[string]any{"Choice": "A"}})
			if result["type"] != "user-input-result" || result["id"] != "question" || result["clientMessageId"] != "reply-correlation" || boolValue(result["success"]) == rejected {
				t.Fatalf("incorrect result: %#v", result)
			}
			if rejected && result["error"] != provider.replyError.Error() {
				t.Fatalf("rejection was lost: %#v", result)
			}
		})
	}
}
