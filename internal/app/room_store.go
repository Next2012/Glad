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

const currentRoomSchemaVersion = 2

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
	Draft                         bool               `json:"draft,omitempty"`
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
	OriginRoomID         string   `json:"originRoomId,omitempty"`
	ClientMessageID      string   `json:"clientMessageId,omitempty"`
	MentionedMemberIDs   []string `json:"mentionedMemberIds,omitempty"`
	QuotedEntryIDs       []string `json:"quotedEntryIds,omitempty"`
	Status               string   `json:"status"`
	Error                string   `json:"error,omitempty"`
	CreatedAt            int64    `json:"createdAt"`
	// Historical is set only on the dynamic room read model. Projected native
	// history is never saved to a room document.
	Historical   bool   `json:"historical,omitempty"`
	ResolvedText string `json:"-"`
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
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.writeLocked(path, room)
}

func (store *FileRoomStore) writeLocked(path string, room RoomRecord) error {
	data, err := json.MarshalIndent(room, "", "  ")
	if err != nil {
		return err
	}
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
	originalVersion, originalEntries := room.SchemaVersion, len(room.Entries)
	room, err = migrateRoom(room)
	if err != nil {
		return RoomRecord{}, err
	}
	if room.SchemaVersion != originalVersion || len(room.Entries) != originalEntries {
		if err := store.writeLocked(path, room); err != nil {
			return RoomRecord{}, err
		}
	}
	return room, nil
}

// Migrations are centralized and persisted atomically on first read.
func migrateRoom(room RoomRecord) (RoomRecord, error) {
	if room.SchemaVersion == 0 {
		room.SchemaVersion = 1
	}
	if room.SchemaVersion == 1 {
		room.Entries = stripRoomTransportArtifacts(room.Entries)
		room.SchemaVersion = 2
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
	// Also repair v2 files written while the provider-history bug was active.
	room.Entries = stripRoomTransportArtifacts(room.Entries)
	return room, nil
}

func isRoomTransportText(text string) bool {
	_, _, ok := roomTransportEnvelope(text)
	return ok
}

func roomTransportVisibleText(text string) (string, bool) {
	visible, _, ok := roomTransportEnvelope(text)
	return visible, ok
}

func roomTransportEnvelope(text string) (string, string, bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "You are being addressed as a member of a Glad group chat.") {
		return "", "", false
	}
	const open, close = "<glad_group_message>", "</glad_group_message>"
	start := strings.Index(trimmed, open)
	if start < 0 {
		return "", "", false
	}
	start += len(open)
	end := strings.Index(trimmed[start:], close)
	if end < 0 {
		return "", "", false
	}
	origin := ""
	const originOpen, originClose = "<glad_group_origin>", "</glad_group_origin>"
	if originStart := strings.Index(trimmed, originOpen); originStart >= 0 {
		originStart += len(originOpen)
		if originEnd := strings.Index(trimmed[originStart:], originClose); originEnd >= 0 {
			origin = strings.TrimSpace(trimmed[originStart : originStart+originEnd])
		}
	}
	return strings.TrimSpace(trimmed[start : start+end]), origin, true
}

// Old provider histories can lose Glad's room-* client ID after resume and
// expose the injected agent payload as an ordinary user message. Those entries
// were never authored by the user and always have a synthetic direct reply.
func stripRoomTransportArtifacts(entries []RoomEntryRecord) []RoomEntryRecord {
	if len(entries) == 0 {
		return entries
	}
	cleaned := make([]RoomEntryRecord, 0, len(entries))
	removed := map[string]bool{}
	for index := 0; index < len(entries); index++ {
		entry := entries[index]
		if entry.Type != "user" || !isRoomTransportText(entry.UserText) {
			cleaned = append(cleaned, entry)
			continue
		}
		removed[entry.ID] = true
		if index+1 < len(entries) {
			reply := entries[index+1]
			if reply.Type == "session" && strings.HasPrefix(reply.ClientMessageID, "direct-") &&
				reply.CreatedAt == entry.CreatedAt && len(entry.MentionedMemberIDs) == 1 &&
				reply.MemberID == entry.MentionedMemberIDs[0] {
				removed[reply.ID] = true
				index++
			}
		}
	}
	if len(removed) == 0 {
		return cleaned
	}
	for index := range cleaned {
		quotes := cleaned[index].QuotedEntryIDs[:0]
		for _, id := range cleaned[index].QuotedEntryIDs {
			if !removed[id] {
				quotes = append(quotes, id)
			}
		}
		cleaned[index].QuotedEntryIDs = quotes
	}
	return cleaned
}
