package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type ConfigStore struct {
	mu   sync.RWMutex
	path string
	data map[string]any
}

func OpenConfigStore() (*ConfigStore, error) {
	directory, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	directory = filepath.Join(directory, ".glad")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	store := &ConfigStore{path: filepath.Join(directory, "config.json"), data: map[string]any{}}
	bytes, err := os.ReadFile(store.path)
	if err == nil {
		if err := json.Unmarshal(bytes, &store.data); err != nil {
			return nil, fmt.Errorf("parse Glad configuration %s: %w", store.path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return store, nil
}

func (store *ConfigStore) Get(key string) any {
	store.mu.RLock()
	defer store.mu.RUnlock()
	if key == "" {
		copy, _ := cloneConfigValue(store.data)
		return copy
	}
	copy, _ := cloneConfigValue(store.data[key])
	return copy
}

func (store *ConfigStore) Set(key string, value any) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	next := cloneConfigData(store.data)
	copy, err := cloneConfigValue(value)
	if err != nil {
		return err
	}
	next[key] = copy
	next["lastUpdated"] = time.Now().UTC().Format(time.RFC3339)
	if err := store.saveLocked(next); err != nil {
		return err
	}
	store.data = next
	return nil
}

// UpdateMap atomically merges a shallow patch into an object-valued setting.
// It avoids the read/modify/write race that would otherwise occur when two
// live sessions persist different parts of the same preference group.
func (store *ConfigStore) UpdateMap(key string, patch map[string]any) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	next := cloneConfigData(store.data)
	current := mapValue(next[key])
	merged := cloneMap(current)
	for patchKey, value := range patch {
		copy, err := cloneConfigValue(value)
		if err != nil {
			return err
		}
		merged[patchKey] = copy
	}
	next[key] = merged
	next["lastUpdated"] = time.Now().UTC().Format(time.RFC3339)
	if err := store.saveLocked(next); err != nil {
		return err
	}
	store.data = next
	return nil
}

func (store *ConfigStore) Delete(key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	next := cloneConfigData(store.data)
	delete(next, key)
	if err := store.saveLocked(next); err != nil {
		return err
	}
	store.data = next
	return nil
}

func (store *ConfigStore) saveLocked(data map[string]any) error {
	bytes, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	temporary := store.path + ".tmp"
	if err := os.WriteFile(temporary, bytes, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, store.path)
}

func cloneConfigData(source map[string]any) map[string]any {
	copy := make(map[string]any, len(source))
	for key, value := range source {
		copy[key] = value
	}
	return copy
}

func cloneConfigValue(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var copy any
	if err := json.Unmarshal(bytes, &copy); err != nil {
		return nil, err
	}
	return copy, nil
}
