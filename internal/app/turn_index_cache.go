package app

import (
	"context"
	"os"
	"sync"
)

type cachedTurnIndex struct {
	info  os.FileInfo
	turns []conversationTurn
	bytes int
}
type turnIndexCache struct {
	mu      sync.Mutex
	entries map[string]cachedTurnIndex
}

func (cache *turnIndexCache) read(ctx context.Context, file *os.File, tool string) ([]conversationTurn, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	key := tool + "\x00" + file.Name()
	if cache != nil {
		cache.mu.Lock()
		entry, ok := cache.entries[key]
		cache.mu.Unlock()
		if ok && os.SameFile(entry.info, info) && entry.info.Size() == info.Size() && entry.info.ModTime() == info.ModTime() {
			return append([]conversationTurn(nil), entry.turns...), nil
		}
	}
	turns, err := indexConversation(ctx, file, tool)
	if err != nil || cache == nil {
		return turns, err
	}
	bytes := 0
	for _, turn := range turns {
		bytes += len(turn.User) + len(turn.Assistant) + len(turn.ID) + 256
	}
	if bytes > 16<<20 {
		return turns, nil
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.entries == nil {
		cache.entries = map[string]cachedTurnIndex{}
	}
	used := bytes
	for k, entry := range cache.entries {
		if k != key {
			used += entry.bytes
		}
	}
	if used > 16<<20 || len(cache.entries) >= 16 {
		clear(cache.entries)
	}
	cache.entries[key] = cachedTurnIndex{info, append([]conversationTurn(nil), turns...), bytes}
	return turns, nil
}
