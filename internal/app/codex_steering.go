package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// A server rejection is definitive. Transport errors and cancelled waits can
// leave an accepted instruction without its acknowledgement.
type codexRPCError struct{ message string }

func (err codexRPCError) Error() string { return err.message }

func (provider *CodexProvider) canSteerLocked() bool {
	if provider.closed || provider.cmd == nil || provider.stdin == nil || provider.threadID == "" || provider.turnID == "" ||
		provider.sending || provider.steering || provider.aborting || provider.resumeInFlight || provider.resuming || provider.forking ||
		provider.needsThreadResume || provider.capacityRetryTimer != nil || len(provider.permissions) > 0 || len(provider.uncertainSteering) >= 1024 {
		return false
	}
	for _, input := range provider.userInputs {
		if input.Blocking {
			return false
		}
	}
	return true
}

func (provider *CodexProvider) CanSteer() (bool, string) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if !provider.canSteerLocked() {
		return false, "Codex requires a running turn without pending approval, blocking questions, or recovery"
	}
	return true, ""
}

// Steer deliberately does not start a process, resume a thread, apply turn
// settings, or replace turnID. Codex enforces the same expected-turn precondition.
func (provider *CodexProvider) Steer(ctx context.Context, input ProviderInput, expectedTurnID string) error {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if expectedTurnID == "" || expectedTurnID != provider.turnID {
		return errors.New("Target turn changed; read its state again before adding instructions")
	}
	if !provider.canSteerLocked() {
		return errors.New("Codex cannot accept running-turn instructions while stopping, recovering, sending, or awaiting a blocking control")
	}
	if input.ClientMessageID == "" {
		return errors.New("Running-turn instructions require a client message ID")
	}
	if _, uncertain := provider.uncertainSteering[input.ClientMessageID]; uncertain {
		return errors.New("Instruction delivery is uncertain; inspect the conversation before submitting another instruction")
	}
	items := []any{}
	for _, skill := range input.Skills {
		if stringValue(skill["name"]) == "" || stringValue(skill["path"]) == "" {
			return errors.New("Steering skills require a name and path")
		}
		items = append(items, map[string]any{"type": "skill", "name": skill["name"], "path": skill["path"]})
	}
	if strings.TrimSpace(input.AgentText) != "" {
		items = append(items, map[string]any{"type": "text", "text": input.AgentText})
	}
	attachments := []map[string]any{}
	for _, image := range input.Images {
		items = append(items, map[string]any{"type": "localImage", "path": image.Path})
		attachments = append(attachments, map[string]any{"id": image.ID, "name": image.Name})
	}
	// File paths are included in AgentText by the attachment resolver, as for Send.
	for _, file := range input.Files {
		attachments = append(attachments, map[string]any{"id": file.ID, "name": file.Name, "size": file.Size, "kind": "file"})
	}
	if len(items) == 0 {
		return errors.New("Running-turn instructions cannot be empty")
	}
	provider.steering = true
	provider.session.appendMessage(map[string]any{
		"kind": "user", "text": input.Text, "agentText": input.AgentText,
		"attachments": attachments, "skills": input.Skills, "clientMessageId": input.ClientMessageID,
		"supervisorSource": input.Source.values(), "threadId": provider.threadID, "turnId": expectedTurnID,
		"delivery": "steer",
	})
	provider.updatePublicStateLocked("running")
	_, err := provider.requestLocked(ctx, "turn/steer", map[string]any{
		"threadId": provider.threadID, "expectedTurnId": expectedTurnID,
		"clientUserMessageId": input.ClientMessageID, "input": items,
	})
	provider.steering = false
	// Notifications may have completed the turn during the RPC. Preserve their
	// current status instead of manufacturing a second running lifecycle.
	provider.session.mu.RLock()
	status := provider.session.StatusValue
	provider.session.mu.RUnlock()
	provider.updatePublicStateLocked(status)
	if err != nil {
		provider.session.removeMessagesByClientMessageID(input.ClientMessageID)
		var rejection codexRPCError
		if !errors.As(err, &rejection) {
			if provider.uncertainSteering == nil {
				provider.uncertainSteering = map[string]struct{}{}
			}
			provider.uncertainSteering[input.ClientMessageID] = struct{}{}
			provider.updatePublicStateLocked(status)
			return fmt.Errorf("Instruction delivery is uncertain; inspect the conversation before retrying: %w", err)
		}
		return err
	}
	return nil
}
