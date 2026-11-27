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
	"sync/atomic"
)

const currentRoomSchemaVersion = 4

var (
	errRoomNotFound     = errors.New("room not found")
	errRoomSchemaTooNew = errors.New("room data was created by a newer Glad version")
)

// RoomRecord is the persisted, provider-independent group-chat index. Assistant
// text and attachments deliberately never enter this structure: session-native
// history remains the source of truth for those values.
type RoomRecord struct {
	SupervisorMemberID            string             `json:"supervisorMemberId,omitempty"`
	Actions                       []RoomActionRecord `json:"actions,omitempty"`
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
	DisplayName          string         `json:"-"`
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
	SenderMemberID       string   `json:"senderMemberId,omitempty"`
	ID                   string   `json:"id"`
	Sequence             int64    `json:"sequence"`
	Type                 string   `json:"type"`
	UserText             string   `json:"userText,omitempty"`
	MemberID             string   `json:"memberId,omitempty"`
	SourceSessionID      string   `json:"sourceSessionId,omitempty"`
	NativeConversationID string   `json:"nativeConversationId,omitempty"`
	NativeTurnID         string   `json:"nativeTurnId,omitempty"`
	OriginRoomID         string   `json:"originRoomId,omitempty"`
	RequestHash          string   `json:"requestHash,omitempty"`
	ClientMessageID      string   `json:"clientMessageId,omitempty"`
	MentionedMemberIDs   []string `json:"mentionedMemberIds,omitempty"`
	TriggerEntryID       string   `json:"triggerEntryId,omitempty"`
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
	revision  atomic.Uint64
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
	store := &FileRoomStore{directory: directory}
	if _, err := store.List(); err != nil {
		return nil, err
	}
	return store, nil
}

func (store *FileRoomStore) roomPath(id string) (string, error) {
	if !safeUploadIDPattern.MatchString(id) || strings.ContainsAny(id, `/\\`) {
		return "", errors.New("invalid room id")
	}
	return filepath.Join(store.directory, id+".json"), nil
}

func (store *FileRoomStore) Revision() uint64 { return store.revision.Load() }

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
		if errors.Is(err, errRoomNotFound) {
			continue
		}
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
	room, err = normalizeRoom(room)
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
	store.revision.Add(1)
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
		if err == nil {
			store.revision.Add(1)
		}
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
	if header.SchemaVersion < currentRoomSchemaVersion {
		var legacy RoomRecord
		if json.Unmarshal(data, &legacy) != nil || legacy.ID == "" || filepath.Base(path) != legacy.ID+".json" {
			return RoomRecord{}, errors.New("invalid legacy room record")
		}
		if err := os.Remove(path); err != nil {
			return RoomRecord{}, err
		}
		store.revision.Add(1)
		return RoomRecord{}, errRoomNotFound
	}
	var room RoomRecord
	if err := json.Unmarshal(data, &room); err != nil {
		return RoomRecord{}, err
	}
	originalVersion, originalEntries, originalActions := room.SchemaVersion, len(room.Entries), len(room.Actions)
	room, err = normalizeRoom(room)
	if err != nil {
		return RoomRecord{}, err
	}
	if room.SchemaVersion != originalVersion || len(room.Entries) != originalEntries || len(room.Actions) != originalActions {
		if err := store.writeLocked(path, room); err != nil {
			return RoomRecord{}, err
		}
	}
	return room, nil
}

// Normalize current records; unsupported historical schemas are handled above.
func normalizeRoom(room RoomRecord) (RoomRecord, error) {
	room.Actions = trimRoomActions(room.Actions)
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
	// Current envelopes carry JSON so quoted or user-authored XML-like tags
	// cannot change which command is displayed or indexed.
	const metaOpen, metaClose = "<glad_group_metadata>", "</glad_group_metadata>"
	if start := strings.LastIndex(trimmed, metaOpen); start >= 0 {
		start += len(metaOpen)
		if end := strings.Index(trimmed[start:], metaClose); end >= 0 {
			var metadata struct {
				Message *string `json:"message"`
				RoomID  string  `json:"roomId"`
			}
			if json.Unmarshal([]byte(trimmed[start:start+end]), &metadata) == nil && metadata.Message != nil {
				return *metadata.Message, metadata.RoomID, true
			}
		}
	}
	const open, close = "<glad_group_message>", "</glad_group_message>"
	start := strings.LastIndex(trimmed, open)
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
