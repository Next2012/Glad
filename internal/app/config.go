package app

import (
	"encoding/json"
	"errors"
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
		_ = json.Unmarshal(bytes, &store.data)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return store, nil
}

func (store *ConfigStore) Get(key string) any {
	store.mu.RLock()
	defer store.mu.RUnlock()
	if key == "" {
		copy := make(map[string]any, len(store.data))
		for name, value := range store.data {
			copy[name] = value
		}
		return copy
	}
	return store.data[key]
}

func (store *ConfigStore) Set(key string, value any) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.data[key] = value
	store.data["lastUpdated"] = time.Now().UTC().Format(time.RFC3339)
	return store.saveLocked()
}

func (store *ConfigStore) Delete(key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.data, key)
	return store.saveLocked()
}

func (store *ConfigStore) saveLocked() error {
	bytes, err := json.MarshalIndent(store.data, "", "  ")
	if err != nil {
		return err
	}
	temporary := store.path + ".tmp"
	if err := os.WriteFile(temporary, bytes, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, store.path)
}
