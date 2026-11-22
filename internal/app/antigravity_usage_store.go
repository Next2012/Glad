package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Keep accounting separate from the bounded speed history. Daily append-only
// ledgers never overwrite one another, and each native root-turn ID is counted
// once across reconnects and daemon restarts. No prompts or tool bodies are saved.
type AntigravityUsageStore struct {
	mu         sync.Mutex
	directory  string
	samples    map[string]SpeedSample
	warnings   int
	cleanupDay string
}

type antigravityUsageRecord struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	EndedAt int64  `json:"endedAt"`
	Status  string `json:"status"`
	Input   *int64 `json:"inputTokens"`
	Cached  *int64 `json:"cachedInputTokens"`
	Write   *int64 `json:"cacheWriteTokens"`
	Output  *int64 `json:"outputTokens"`
	Thought *int64 `json:"thoughtTokens"`
}

func (record antigravityUsageRecord) sample() SpeedSample {
	return SpeedSample{ID: record.ID, Provider: "antigravity", Model: record.Model, EndedAt: record.EndedAt, Status: record.Status, InputTokens: record.Input, CachedInputTokens: record.Cached, CacheWriteTokens: record.Write, OutputTokens: record.Output, ThoughtTokens: record.Thought}
}

func openAntigravityUsageStore(directory string) (*AntigravityUsageStore, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	store := &AntigravityUsageStore{directory: directory, samples: map[string]SpeedSample{}}
	if err := store.cleanupLocked(); err != nil {
		return nil, err
	}
	quarantines, _ := filepath.Glob(filepath.Join(directory, "*.jsonl.partial-*"))
	store.warnings = len(quarantines)
	files, err := filepath.Glob(filepath.Join(directory, "*.jsonl"))
	if err != nil {
		return nil, err
	}
	cutoff := time.Now().AddDate(0, 0, -90).UnixMilli()
	for _, path := range files {
		day, parseErr := time.Parse("2006-01-02", strings.TrimSuffix(filepath.Base(path), ".jsonl"))
		if parseErr != nil {
			continue
		}
		if day.AddDate(0, 0, 1).UnixMilli() < cutoff {
			if err := os.Remove(path); err != nil {
				return nil, err
			}
			continue
		}
		file, err := os.OpenFile(path, os.O_RDWR, 0600)
		if err != nil {
			return nil, err
		}
		repaired, repairErr := recoverAntigravityUsageTail(file, path)
		if repairErr != nil {
			file.Close()
			return nil, repairErr
		}
		if repaired {
			store.warnings++
		}
		scan := bufio.NewScanner(file)
		scan.Buffer(make([]byte, 4096), 64<<10)
		for scan.Scan() {
			var record antigravityUsageRecord
			if err := json.Unmarshal(scan.Bytes(), &record); err != nil {
				file.Close()
				return nil, fmt.Errorf("Antigravity usage ledger %s is invalid: %w", filepath.Base(path), err)
			}
			if record.ID == "" || record.EndedAt <= 0 {
				file.Close()
				return nil, fmt.Errorf("Antigravity usage ledger %s has an invalid record", filepath.Base(path))
			}
			if record.EndedAt >= cutoff {
				store.samples[record.ID] = record.sample()
			}
		}
		err = scan.Err()
		file.Close()
		if err != nil {
			return nil, err
		}
	}
	return store, nil
}

func (store *AntigravityUsageStore) add(sample SpeedSample) error {
	if store == nil {
		return nil
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if sample.ID == "" || sample.Provider != "antigravity" || sample.EndedAt <= 0 {
		return fmt.Errorf("invalid Antigravity usage sample")
	}
	if _, exists := store.samples[sample.ID]; exists {
		return nil
	}
	if err := store.cleanupLocked(); err != nil {
		return err
	}
	cutoff := time.Now().AddDate(0, 0, -90).UnixMilli()
	if sample.EndedAt < cutoff {
		return nil
	}
	record := antigravityUsageRecord{ID: sample.ID, Model: sample.Model, EndedAt: sample.EndedAt, Status: sample.Status, Input: sample.InputTokens, Cached: sample.CachedInputTokens, Write: sample.CacheWriteTokens, Output: sample.OutputTokens, Thought: sample.ThoughtTokens}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	path := filepath.Join(store.directory, time.UnixMilli(sample.EndedAt).UTC().Format("2006-01-02")+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	_, err = file.Write(append(data, '\n'))
	if err == nil {
		err = file.Sync()
	}
	if err != nil {
		_ = file.Truncate(info.Size())
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	store.samples[sample.ID] = record.sample()
	for id, old := range store.samples {
		if old.EndedAt < cutoff {
			delete(store.samples, id)
		}
	}
	return nil
}

func (store *AntigravityUsageStore) snapshot() []SpeedSample {
	if store == nil {
		return nil
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	cutoff := time.Now().AddDate(0, 0, -90).UnixMilli()
	rows := make([]SpeedSample, 0, len(store.samples))
	for id, sample := range store.samples {
		if sample.EndedAt < cutoff {
			delete(store.samples, id)
		} else {
			rows = append(rows, sample)
		}
	}
	return rows
}

// Truncated appends are isolated before parsing. Keep the valid newline-delimited
// prefix and report the loss instead of preventing the whole daemon from opening.
func recoverAntigravityUsageTail(file *os.File, path string) (bool, error) {
	info, err := file.Stat()
	if err != nil {
		return false, err
	}
	size := info.Size()
	if size == 0 {
		return false, nil
	}
	var tail [1]byte
	if _, err = file.ReadAt(tail[:], size-1); err != nil {
		return false, err
	}
	if tail[0] == '\n' {
		return false, nil
	}
	boundary := int64(0)
	for end := size; end > 0; {
		start := end - 4096
		if start < 0 {
			start = 0
		}
		buf := make([]byte, end-start)
		if _, err = file.ReadAt(buf, start); err != nil {
			return false, err
		}
		if idx := bytes.LastIndexByte(buf, '\n'); idx >= 0 {
			boundary = start + int64(idx) + 1
			break
		}
		end = start
	}
	quarantine, err := os.OpenFile(path+".partial-"+strconv.FormatInt(time.Now().UnixNano(), 10), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return false, err
	}
	_, copyErr := io.Copy(quarantine, io.NewSectionReader(file, boundary, size-boundary))
	if copyErr == nil {
		copyErr = quarantine.Sync()
	}
	closeErr := quarantine.Close()
	if copyErr != nil {
		return false, copyErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	if err = file.Truncate(boundary); err != nil {
		return false, err
	}
	if err = file.Sync(); err != nil {
		return false, err
	}
	_, err = file.Seek(0, 0)
	return true, err
}

func (store *AntigravityUsageStore) cleanupLocked() error {
	today := time.Now().UTC().Format("2006-01-02")
	if store.cleanupDay == today {
		return nil
	}
	paths, err := filepath.Glob(filepath.Join(store.directory, "*"))
	if err != nil {
		return err
	}
	cutoff := time.Now().AddDate(0, 0, -90).UnixMilli()
	for _, path := range paths {
		name := filepath.Base(path)
		if len(name) < 16 || (!strings.HasSuffix(name, ".jsonl") && !strings.Contains(name, ".jsonl.partial-")) {
			continue
		}
		day, err := time.Parse("2006-01-02", name[:10])
		if err != nil {
			continue
		}
		if day.AddDate(0, 0, 1).UnixMilli() < cutoff {
			if err := os.Remove(path); err != nil {
				return err
			}
		}
	}
	store.cleanupDay = today
	return nil
}

func (store *AntigravityUsageStore) warningCount() int {
	if store == nil {
		return 0
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.warnings
}
