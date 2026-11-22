package app

import (
	"os/exec"
	"testing"
)

func TestClaudeForkIgnoresDisplacedProcessInitBeforeBindingInheritedName(t *testing.T) {
	store := &SessionNameStore{directory: t.TempDir()}
	session := newSession("fork-window", "", "claude-structured", ToolInfo{Key: "claude-code"}, t.TempDir())
	defer session.cancel()
	session.names = store
	source := "canonical-source"
	inherited := sessionName{Name: "Renamed while connected", Manual: true}
	if err := store.write("claude-code", session.WorkingDirectory, source, inherited); err != nil {
		t.Fatal(err)
	}
	// A newly created destination starts one process before Fork replaces it.
	// Its reader may have passed the initial cmd check before that replacement.
	oldCommand, forkCommand := &exec.Cmd{}, &exec.Cmd{}
	provider := NewClaudeProvider(session, nil)
	provider.cmd = forkCommand
	session.Provider = provider
	provider.resumeID = source
	session.mu.Lock()
	session.forkNameSource = source
	session.forkNameRevision = session.nameRevision
	session.mu.Unlock()
	provider.handleMessage(map[string]any{"type": "system", "subtype": "init", "session_id": "displaced-initial-session", "model": "fixture"}, oldCommand)
	provider.mu.Lock()
	currentID := provider.claudeSessionID
	provider.mu.Unlock()
	session.mu.RLock()
	pendingSource := session.forkNameSource
	session.mu.RUnlock()
	if currentID != "" || pendingSource != source {
		t.Fatalf("displaced init consumed the pending fork identity/name: id=%q source=%q", currentID, pendingSource)
	}
	if _, exists, err := store.lookup("claude-code", session.WorkingDirectory, "displaced-initial-session"); err != nil || exists {
		t.Fatalf("displaced process received the fork's inherited name: exists=%v err=%v", exists, err)
	}
	provider.handleMessage(map[string]any{"type": "system", "subtype": "init", "session_id": "fork-destination", "model": "fixture"}, forkCommand)
	session.mu.RLock()
	name, manual, bound := session.Name, session.NameManual, session.nameConversationID
	session.mu.RUnlock()
	if name != inherited.Name || !manual || bound != "fork-destination" {
		t.Fatalf("current fork init lost the source name: name=%q manual=%v bound=%q", name, manual, bound)
	}
	for _, id := range []string{source, "fork-destination"} {
		persisted, exists, err := store.lookup("claude-code", session.WorkingDirectory, id)
		if err != nil || !exists || persisted != inherited {
			t.Fatalf("name persistence changed for %q: %#v exists=%v err=%v", id, persisted, exists, err)
		}
	}
	// Late old-process init cannot replace a successfully bound fork either.
	provider.handleMessage(map[string]any{"type": "system", "subtype": "init", "session_id": "displaced-initial-session"}, oldCommand)
	session.mu.RLock()
	defer session.mu.RUnlock()
	if sessionNativeConversationID(session) != "fork-destination" || session.Name != inherited.Name {
		t.Fatal("late displaced init replaced an already bound fork")
	}
}
