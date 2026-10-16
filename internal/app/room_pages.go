package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
)

const roomPageSize = 48
const roomPageTextLimit = 24 << 10

type roomPageQuery struct {
	Before, After, Around string
	Limit                 int
}
type roomProjectionCache struct {
	Key     string
	Entries []RoomEntryRecord
}

// Cache the provider projection across list, HTTP and websocket consumers.
// Tool/status events do not invalidate a transcript that has not changed.
// Bound retained projections; the provider remains the history owner.
func (manager *RoomManager) cachedRoomEntriesLocked(room RoomRecord) []RoomEntryRecord {
	key := sha256.New()
	fmt.Fprintf(key, "%d:%d:%d", room.UpdatedAt, room.NextSequence, len(room.Entries))
	for _, entry := range room.Entries {
		fmt.Fprintf(key, "/%s:%s:%s:%s:%s", entry.ID, entry.Status, entry.NativeTurnID, entry.UserText, entry.Error)
	}
	for _, member := range room.Members {
		fmt.Fprintf(key, "/%s:%s:%d", member.ID, member.RuntimeSessionID, member.LeftAt)
		if session := manager.sessions.Get(member.RuntimeSessionID); session != nil {
			session.mu.RLock()
			fmt.Fprintf(key, ":%d", session.roomContentRevision)
			if session.roomContentRevision == 0 {
				fmt.Fprintf(key, ":%d", len(session.Messages))
			}
			session.mu.RUnlock()
		} else {
			// Native history can be written by another process. Do not cache
			// unavailable sessions across requests without a file revision.
			fmt.Fprintf(key, ":%d", millis()/1000)
		}
	}
	encoded, _ := json.Marshal(room.Members)
	key.Write(encoded)
	cacheKey := hex.EncodeToString(key.Sum(nil))
	if cached, ok := manager.projections[room.ID]; ok && cached.Key == cacheKey {
		return cached.Entries
	}
	entries := manager.projectRoomEntriesLocked(room)
	bytes := 0
	for _, entry := range entries {
		bytes += len(entry.UserText) + len(entry.ResolvedText)
	}
	if manager.projections == nil {
		manager.projections = map[string]roomProjectionCache{}
	}
	if len(manager.projections) >= 8 {
		clear(manager.projections)
	}
	delete(manager.projections, room.ID)
	if len(entries) <= 10000 && bytes <= 8<<20 {
		manager.projections[room.ID] = roomProjectionCache{cacheKey, entries}
	}
	return entries
}

func selectRoomPage(entries []RoomEntryRecord, query roomPageQuery) ([]RoomEntryRecord, map[string]any) {
	limit := query.Limit
	if limit <= 0 || limit > roomPageSize {
		limit = roomPageSize
	}
	start, end := max(0, len(entries)-limit), len(entries)
	for index, entry := range entries {
		if query.Around != "" && entry.ID == query.Around {
			start = max(0, index-limit/2)
			end = min(len(entries), start+limit)
			break
		}
		if query.Before != "" && entry.ID == query.Before {
			end = index
			start = max(0, end-limit)
			break
		}
		if query.After != "" && entry.ID == query.After {
			start = index + 1
			end = min(len(entries), start+limit)
			break
		}
	}
	fields := map[string]any{"totalEntries": len(entries), "hasBefore": start > 0, "hasAfter": end < len(entries), "paged": true}
	return entries[start:end], fields
}

func (manager *RoomManager) GetPage(id string, history bool, query roomPageQuery) (map[string]any, error) {
	return manager.roomView(id, history, &query)
}

func (server *Server) roomEntryText(writer http.ResponseWriter, request *http.Request) {
	manager := server.rooms
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.activeIDs[request.PathValue("id")] == "" {
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	room, err := manager.store.Get(manager.roomIDLocked(request.PathValue("id")))
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	members := map[string]RoomMemberRecord{}
	for _, member := range room.Members {
		members[member.ID] = member
	}
	for _, entry := range manager.cachedRoomEntriesLocked(room) {
		if entry.ID == request.PathValue("entryId") {
			item := manager.publicEntryLocked(room, members, entry)
			text := stringValue(item["text"])
			offset := max(0, atoiDefault(request.URL.Query().Get("offset"), 0))
			offset = min(offset, len(text))
			for offset > 0 && offset < len(text) && text[offset]&0xc0 == 0x80 {
				offset--
			}
			// Byte positions are adjusted to a UTF-8 boundary by the reader.
			end := min(len(text), offset+(32<<10))
			for end < len(text) && end > offset && text[end]&0xc0 == 0x80 {
				end--
			}
			chunk := text[offset:end]
			item["text"] = chunk
			item["textTruncated"] = end < len(text)
			respondJSON(writer, 200, map[string]any{"entry": item, "text": chunk, "nextOffset": end, "hasMore": end < len(text)})
			return
		}
	}
	server.writeRoomError(writer, fmt.Errorf("message unavailable"))
}
