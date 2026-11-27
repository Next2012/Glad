package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func (session *Session) rememberTranscriptPath(thread map[string]any) {
	if path, id := stringValue(thread["path"]), stringValue(thread["id"]); path != "" && id != "" {
		session.mu.Lock()
		session.nativeTranscriptPath, session.nativeTranscriptID = path, id
		session.mu.Unlock()
	}
}

// Resolve from provider identity, never from a caller-supplied filesystem path.
func sessionTranscriptPath(session *Session) (string, error) {
	session.mu.RLock()
	id, tool, cwd := sessionNativeConversationID(session), session.Tool.Key, session.WorkingDirectory
	hint, hintID := session.nativeTranscriptPath, session.nativeTranscriptID
	session.mu.RUnlock()
	if id == "" || strings.ContainsAny(id, `/\`) {
		return "", errors.New("Native conversation is not available yet")
	}
	if hint != "" && hintID == id {
		if info, err := os.Stat(hint); err == nil && info.Mode().IsRegular() {
			return filepath.Abs(hint)
		}
	}
	if tool == "claude-code" {
		return filepath.Abs(filepathForClaudeTranscript(cwd, id))
	}
	if tool == "antigravity" {
		return antigravityNativeTranscriptPath(id), nil
	}
	if tool != "codex" {
		return "", errors.New("Provider transcript is unsupported")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	matches, err := filepath.Glob(filepath.Join(codexHome, "sessions", "*", "*", "*", "*-"+id+".jsonl"))
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", errors.New("Native transcript has not been located. Use room_read_member for live output.")
	}
	return filepath.Abs(matches[len(matches)-1])
}
