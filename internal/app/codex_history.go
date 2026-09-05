package app

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

type codexThreadQuery struct {
	Cursor, Search, Sort string
	AllDirectories       bool
}

// Keep list requests metadata-only; searching and pagination belong to Codex's
// index, not to a browser-side scan of the first page or of rollout files.
func (provider *CodexProvider) listThreadPage(ctx context.Context, query codexThreadQuery) ([]map[string]any, string, error) {
	sortKey := "updated_at"
	if query.Sort == "created_at" {
		sortKey = query.Sort
	}
	params := map[string]any{
		"cursor": nil, "limit": 40, "sortKey": sortKey,
		"sortDirection": "desc", "archived": false,
	}
	if query.Cursor != "" {
		params["cursor"] = query.Cursor
	}
	if !query.AllDirectories {
		params["cwd"] = provider.session.WorkingDirectory
	}
	if search := strings.TrimSpace(query.Search); search != "" {
		params["searchTerm"] = search
	}
	result, err := provider.rpc(ctx, "thread/list", params)
	if err != nil {
		return nil, "", err
	}
	provider.mu.Lock()
	currentID := provider.threadID
	provider.mu.Unlock()
	items := []map[string]any{}
	for _, value := range sliceValue(result["data"]) {
		thread := mapValue(value)
		if thread["parentThreadId"] != nil {
			continue
		}
		preview := codexPreviewText(stringValue(thread["preview"]), 600)
		items = append(items, map[string]any{
			"id": thread["id"], "sessionId": firstNonNil(thread["sessionId"], thread["id"]),
			"title":   codexPreviewText(firstNonEmpty(stringValue(thread["name"]), preview, "Codex session"), 300),
			"preview": preview, "questions": []string{preview, ""},
			"createdAt": timestampMillis(thread["createdAt"]),
			"updatedAt": timestampMillis(firstNonNil(thread["updatedAt"], thread["createdAt"])),
			"cwd":       stringValue(thread["cwd"]), "branch": stringValue(mapValue(thread["gitInfo"])["branch"]),
			"current": stringValue(thread["id"]) == currentID,
		})
	}
	return items, stringValue(result["nextCursor"]), nil
}

func (server *Server) codexThreadPreview(writer http.ResponseWriter, request *http.Request) {
	provider, ok := server.codexProvider(writer, request)
	if !ok {
		return
	}
	threadID := request.URL.Query().Get("threadId")
	if threadID == "" {
		respondError(writer, 400, errors.New("Missing threadId"))
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
	defer cancel()
	messages, err := provider.previewThread(ctx, threadID)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "messages": messages})
}

// A preview must not resume, subscribe to, or replace the current conversation.
// Fetch just three recent turn summaries, and return bounded user/assistant text.
func (provider *CodexProvider) previewThread(ctx context.Context, threadID string) ([]map[string]any, error) {
	result, err := provider.rpc(ctx, "thread/turns/list", map[string]any{
		"threadId": threadID, "limit": 3, "sortDirection": "desc", "itemsView": "summary",
	})
	if err != nil {
		return nil, err
	}
	messages := []map[string]any{}
	turns := sliceValue(result["data"])
	// Traverse newest-first, taking the last twelve text messages, then reverse
	// into reading order. Tool payloads never enter the preview response.
	for _, value := range turns {
		items := sliceValue(mapValue(value)["items"])
		for i := len(items) - 1; i >= 0 && len(messages) < 12; i-- {
			item := mapValue(items[i])
			kind, text := "", ""
			switch stringValue(item["type"]) {
			case "userMessage":
				kind, text = "user", textFromCodexInput(item["content"])
			case "agentMessage":
				kind, text = "assistant", stringValue(item["text"])
			}
			if strings.TrimSpace(text) != "" {
				messages = append(messages, map[string]any{"kind": kind, "text": codexPreviewText(text, 2000)})
			}
		}
	}
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	return messages, nil
}

func codexPreviewText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	for limit > 0 && !utf8.RuneStart(text[limit]) {
		limit--
	}
	return text[:limit] + "…"
}
