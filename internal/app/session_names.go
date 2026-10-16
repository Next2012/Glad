package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Session names belong to provider conversation identities, never to rooms.
// A missing name is an empty name; callers must not substitute room snapshots.
type SessionNameStore struct {
	mu        sync.Mutex
	directory string
}

type sessionName struct {
	Name   string `json:"name"`
	Manual bool   `json:"manual"`
}

func (store *SessionNameStore) path(tool, cwd, id string) string {
	key := sha256.Sum256([]byte(tool + "\x00" + filepath.Clean(cwd) + "\x00" + id))
	return filepath.Join(store.directory, hex.EncodeToString(key[:])+".json")
}

func (store *SessionNameStore) read(tool, cwd, id string) (sessionName, error) {
	name, _, err := store.lookup(tool, cwd, id)
	return name, err
}

func (store *SessionNameStore) lookup(tool, cwd, id string) (sessionName, bool, error) {
	if store == nil || id == "" {
		return sessionName{}, false, nil
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	data, err := os.ReadFile(store.path(tool, cwd, id))
	if errors.Is(err, os.ErrNotExist) {
		return sessionName{}, false, nil
	}
	var name sessionName
	if err == nil {
		err = json.Unmarshal(data, &name)
	}
	return name, err == nil, err
}

func (store *SessionNameStore) write(tool, cwd, id string, name sessionName) error {
	if store == nil || id == "" {
		return nil
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.writeLocked(tool, cwd, id, name)
}

// Register an existing provider session's persisted name when it first enters
// the session catalog. Existing catalog entries, including explicit empty names,
// remain authoritative. Group snapshots and prompt previews are never inputs.
func (store *SessionNameStore) registerNativeName(tool, cwd, id, name string) error {
	if store == nil || id == "" || name == "" {
		return nil
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, err := os.Stat(store.path(tool, cwd, id)); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return store.writeLocked(tool, cwd, id, sessionName{Name: name})
}

func (store *SessionNameStore) writeLocked(tool, cwd, id string, name sessionName) error {
	if err := os.MkdirAll(store.directory, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(name)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(store.directory, ".name-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), store.path(tool, cwd, id))
}

func (session *Session) restoreConversationName(id string) error {
	if session.names == nil {
		return nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	name, err := session.names.read(session.Tool.Key, session.WorkingDirectory, id)
	if err != nil {
		return err
	}
	session.nameConversationID = id
	session.Name, session.NameManual = name.Name, name.Manual
	session.publishLocked(map[string]any{"type": "session-renamed", "name": name.Name})
	return nil
}

func (session *Session) beginNameRestore(id string) func() {
	session.mu.Lock()
	session.nameRestoreTarget = id
	session.mu.Unlock()
	return func() {
		session.mu.Lock()
		if session.nameRestoreTarget == id {
			session.nameRestoreTarget = ""
		}
		session.mu.Unlock()
	}
}

func (session *Session) bindNameLocked(id string) {
	if id == "" || id == session.nameConversationID || session.names == nil {
		return
	}
	if session.forkNameSource != "" && id == session.forkNameSource {
		return
	}
	first := session.nameConversationID == ""
	var value sessionName
	var err error
	if session.forkNameSource != "" {
		if session.nameRevision != session.forkNameRevision {
			value = sessionName{session.Name, session.NameManual}
		} else {
			value, err = session.names.read(session.Tool.Key, session.WorkingDirectory, session.forkNameSource)
		}
		if err == nil {
			err = session.names.write(session.Tool.Key, session.WorkingDirectory, id, value)
		}
	} else if first && session.NameManual && id != session.nameRestoreTarget {
		value = sessionName{session.Name, true}
		err = session.names.write(session.Tool.Key, session.WorkingDirectory, id, value)
	} else {
		value, err = session.names.read(session.Tool.Key, session.WorkingDirectory, id)
	}
	if err != nil {
		session.State["nameError"] = err.Error()
		return
	}
	delete(session.State, "nameError")
	session.nameConversationID = id
	session.forkNameSource = ""
	session.Name, session.NameManual = value.Name, value.Manual
	session.publishLocked(map[string]any{"type": "session-renamed", "name": session.Name})
}

func (manager *SessionManager) memberName(member RoomMemberRecord) string {
	if session := manager.Get(member.RuntimeSessionID); session != nil {
		session.mu.RLock()
		matches := member.NativeConversationID == "" || sessionNativeConversationID(session) == member.NativeConversationID
		name := session.Name
		session.mu.RUnlock()
		if matches {
			return name
		}
	}
	name, _ := manager.names.read(member.ToolKey, member.WorkingDirectory, member.NativeConversationID)
	return name.Name
}

func (manager *SessionManager) hydrateRoomNames(room RoomRecord) RoomRecord {
	for i := range room.Members {
		room.Members[i].DisplayName = manager.memberName(room.Members[i])
	}
	return room
}

func (session *Session) copyForkName(source, destination string) error {
	if session.names == nil {
		return nil
	}
	value, exists, err := session.names.lookup(session.Tool.Key, session.WorkingDirectory, source)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if err = session.names.write(session.Tool.Key, session.WorkingDirectory, destination, value); err != nil {
		return err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if sessionNativeConversationID(session) == destination {
		session.Name, session.NameManual = value.Name, value.Manual
		session.publishLocked(map[string]any{"type": "session-renamed", "name": value.Name})
	}
	return nil
}
