package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const currentRoomSchemaVersion = 1

var (
	errRoomNotFound     = errors.New("room not found")
	errRoomSchemaTooNew = errors.New("room data was created by a newer Glad version")
)

// RoomRecord is the persisted, provider-independent group-chat index. Assistant
// text and attachments deliberately never enter this structure: session-native
// history remains the source of truth for those values.
type RoomRecord struct {
	SchemaVersion                 int                `json:"schemaVersion"`
	ID                            string             `json:"id"`
	Name                          string             `json:"name"`
	CreatedAt                     int64              `json:"createdAt"`
	UpdatedAt                     int64              `json:"updatedAt"`
	NextSequence                  int64              `json:"nextSequence"`
	ServerChanNotificationEnabled bool               `json:"serverChanNotificationEnabled,omitempty"`
	Members                       []RoomMemberRecord `json:"members"`
	Entries                       []RoomEntryRecord  `json:"entries"`
}

type RoomMemberRecord struct {
	ID                   string         `json:"id"`
	RuntimeSessionID     string         `json:"runtimeSessionId,omitempty"`
	DisplayName          string         `json:"displayName"`
	AvatarSeed           string         `json:"avatarSeed"`
	AvatarColor          string         `json:"avatarColor"`
	ToolKey              string         `json:"toolKey"`
	ToolName             string         `json:"toolName,omitempty"`
	WorkingDirectory     string         `json:"workingDirectory"`
	NativeConversationID string         `json:"nativeConversationId,omitempty"`
	SessionOptions       map[string]any `json:"sessionOptions,omitempty"`
	JoinedAt             int64          `json:"joinedAt"`
	LeftAt               int64          `json:"leftAt,omitempty"`
}

type RoomEntryRecord struct {
	ID                   string   `json:"id"`
	Sequence             int64    `json:"sequence"`
	Type                 string   `json:"type"`
	UserText             string   `json:"userText,omitempty"`
	MemberID             string   `json:"memberId,omitempty"`
	SourceSessionID      string   `json:"sourceSessionId,omitempty"`
	NativeConversationID string   `json:"nativeConversationId,omitempty"`
	NativeTurnID         string   `json:"nativeTurnId,omitempty"`
	ClientMessageID      string   `json:"clientMessageId,omitempty"`
	MentionedMemberIDs   []string `json:"mentionedMemberIds,omitempty"`
	QuotedEntryIDs       []string `json:"quotedEntryIds,omitempty"`
	Status               string   `json:"status"`
	Error                string   `json:"error,omitempty"`
	CreatedAt            int64    `json:"createdAt"`
}

type RoomStore interface {
	List() ([]RoomRecord, error)
	Get(string) (RoomRecord, error)
	Save(RoomRecord) error
	Delete(string) error
}

// FileRoomStore intentionally has its own directory and schema lifecycle. It
// must not share config.json: rooms are user data, can grow independently, and
// need per-room atomic updates and future migrations.
type FileRoomStore struct {
	mu        sync.Mutex
	directory string
}

func OpenRoomStore() (*FileRoomStore, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return OpenRoomStoreAt(filepath.Join(home, ".glad", "rooms"))
}

func OpenRoomStoreAt(directory string) (*FileRoomStore, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	return &FileRoomStore{directory: directory}, nil
}

func (store *FileRoomStore) roomPath(id string) (string, error) {
	if !safeUploadIDPattern.MatchString(id) || strings.ContainsAny(id, `/\\`) {
		return "", errors.New("invalid room id")
	}
	return filepath.Join(store.directory, id+".json"), nil
}

func (store *FileRoomStore) List() ([]RoomRecord, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	items, err := os.ReadDir(store.directory)
	if err != nil {
		return nil, err
	}
	rooms := []RoomRecord{}
	for _, item := range items {
		if item.IsDir() || !strings.HasSuffix(item.Name(), ".json") || strings.HasSuffix(item.Name(), ".tmp") {
			continue
		}
		room, err := store.readLocked(filepath.Join(store.directory, item.Name()))
		if err != nil {
			return nil, fmt.Errorf("read room %s: %w", item.Name(), err)
		}
		rooms = append(rooms, room)
	}
	sort.Slice(rooms, func(i, j int) bool {
		if rooms[i].UpdatedAt == rooms[j].UpdatedAt {
			return rooms[i].ID < rooms[j].ID
		}
		return rooms[i].UpdatedAt > rooms[j].UpdatedAt
	})
	return rooms, nil
}

func (store *FileRoomStore) Get(id string) (RoomRecord, error) {
	path, err := store.roomPath(id)
	if err != nil {
		return RoomRecord{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	room, err := store.readLocked(path)
	if errors.Is(err, os.ErrNotExist) {
		return RoomRecord{}, errRoomNotFound
	}
	return room, err
}

func (store *FileRoomStore) Save(room RoomRecord) error {
	path, err := store.roomPath(room.ID)
	if err != nil {
		return err
	}
	if room.SchemaVersion == 0 {
		room.SchemaVersion = currentRoomSchemaVersion
	}
	if room.SchemaVersion > currentRoomSchemaVersion {
		return errRoomSchemaTooNew
	}
	room, err = migrateRoom(room)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(room, "", "  ")
	if err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func (store *FileRoomStore) Delete(id string) error {
	path, err := store.roomPath(id)
	if err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := os.Remove(path); errors.Is(err, os.ErrNotExist) {
		return errRoomNotFound
	} else {
		return err
	}
}

func (store *FileRoomStore) readLocked(path string) (RoomRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return RoomRecord{}, err
	}
	var header struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return RoomRecord{}, err
	}
	if header.SchemaVersion > currentRoomSchemaVersion {
		return RoomRecord{}, errRoomSchemaTooNew
	}
	var room RoomRecord
	if err := json.Unmarshal(data, &room); err != nil {
		return RoomRecord{}, err
	}
	return migrateRoom(room)
}

// Migrations are intentionally centralized even though v1 is the first
// schema. Future versions append one deterministic step per version here.
func migrateRoom(room RoomRecord) (RoomRecord, error) {
	if room.SchemaVersion == 0 {
		room.SchemaVersion = 1
	}
	if room.SchemaVersion != currentRoomSchemaVersion {
		return RoomRecord{}, fmt.Errorf("unsupported room schema version %d", room.SchemaVersion)
	}
	if room.NextSequence < 1 {
		room.NextSequence = 1
		for _, entry := range room.Entries {
			room.NextSequence = max64(room.NextSequence, entry.Sequence+1)
		}
	}
	if room.Members == nil {
		room.Members = []RoomMemberRecord{}
	}
	usedColors := map[string]bool{}
	for index := range room.Members {
		member := &room.Members[index]
		if member.ToolName == "" {
			for _, tool := range supportedTools {
				if tool.Key == member.ToolKey {
					member.ToolName = tool.DisplayName
					break
				}
			}
		}
		if member.AvatarColor == "" {
			member.AvatarColor = chooseRoomAvatarColor(member.ToolKey, firstNonEmpty(member.AvatarSeed, member.ID), usedColors)
		}
		usedColors[member.AvatarColor] = true
	}
	if room.Entries == nil {
		room.Entries = []RoomEntryRecord{}
	}
	return room, nil
}
