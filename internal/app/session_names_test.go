package app

import "testing"

func TestSessionDefaultNamesAcrossCreationRecoveryAndFork(t *testing.T) {
	for _, test := range []struct{ tool, stateKey, name string }{
		{"codex", "threadId", "codex"},
		{"claude-code", "claudeSessionId", "claude"},
	} {
		t.Run(test.tool, func(t *testing.T) {
			store := &SessionNameStore{directory: t.TempDir()}
			session := newSession("window", "", "", ToolInfo{Key: test.tool}, "/project")
			defer session.cancel()
			session.names = store
			if session.Name != test.name || session.NameManual {
				t.Fatal("new session did not use an automatic default", session.Name)
			}
			session.setState(map[string]any{test.stateKey: "source"})
			session.setAutomaticName("Generated name")
			saved, err := store.read(test.tool, "/project", "source")
			if err != nil || saved.Name != "Generated name" || saved.Manual {
				t.Fatal("default prevented generated name persistence", saved, err)
			}
			session.setState(map[string]any{test.stateKey: "unnamed"})
			if session.Name != test.name || session.NameManual {
				t.Fatal("unnamed recovery kept the previous name", session.Name)
			}
			// Older records may explicitly contain an empty name.
			if err := store.write(test.tool, "/project", "unnamed", sessionName{Manual: true}); err != nil {
				t.Fatal(err)
			}
			session.setState(map[string]any{test.stateKey: "fork"})
			if err := session.copyForkName("unnamed", "fork"); err != nil {
				t.Fatal(err)
			}
			if session.Name != test.name || !session.NameManual {
				t.Fatal("fork of an explicitly cleared name lost its default", session.Name)
			}
		})
	}
}

func TestAutomaticNameMatchingDefaultIsStillPersisted(t *testing.T) {
	store := &SessionNameStore{directory: t.TempDir()}
	session := newSession("window", "", "", ToolInfo{Key: "codex"}, "/project")
	defer session.cancel()
	session.names = store
	session.setState(map[string]any{"threadId": "source"})
	session.setAutomaticName("codex")
	saved, exists, err := store.lookup("codex", "/project", "source")
	if err != nil || !exists || saved.Name != "codex" || saved.Manual {
		t.Fatal("generated name equal to the default was not saved", saved, exists, err)
	}
}
