package app

import (
	"fmt"
	"sort"
	"strings"
)

// HistoryPage reads metadata only; transcript projection happens on preview.
func (manager *RoomManager) HistoryPage(sortBy, query string, offset, limit int) (map[string]any, error) {
	if sortBy == "" {
		sortBy = "updated_at"
	}
	if sortBy != "created_at" && sortBy != "updated_at" {
		return nil, fmt.Errorf("unsupported history sort")
	}
	if offset < 0 {
		return nil, fmt.Errorf("invalid history offset")
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	rooms, err := manager.store.List()
	if err != nil {
		return nil, err
	}
	query = strings.ToLower(strings.TrimSpace(query))
	filtered := []RoomRecord{}
	for _, room := range rooms {
		if query == "" || strings.Contains(strings.ToLower(room.Name), query) {
			filtered = append(filtered, room)
		}
	}
	sort.Slice(filtered, func(i, j int) bool {
		left, right := filtered[i].UpdatedAt, filtered[j].UpdatedAt
		if sortBy == "created_at" {
			left, right = filtered[i].CreatedAt, filtered[j].CreatedAt
		}
		if left == right {
			return filtered[i].ID < filtered[j].ID
		}
		return left > right
	})
	start := offset
	if start > len(filtered) {
		start = len(filtered)
	}
	end := start + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	items := []map[string]any{}
	for _, room := range filtered[start:end] {
		count := 0
		for _, member := range room.Members {
			if member.LeftAt == 0 {
				count++
			}
		}
		items = append(items, map[string]any{"id": room.ID, "name": room.Name, "createdAt": room.CreatedAt, "updatedAt": room.UpdatedAt, "memberCount": count, "messageCount": len(room.Entries)})
	}
	return map[string]any{"success": true, "items": items, "hasMore": end < len(filtered), "nextOffset": end, "total": len(filtered)}, nil
}
