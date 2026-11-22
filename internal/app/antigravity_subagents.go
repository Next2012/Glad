package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const agySubagentGraphLimit = 64
const agySubagentDepthLimit = 8
const agySubagentMetadataLimit = 32 << 10
const agySubagentPageBytes = 512 << 10
const agySubagentRecordBytes = 128 << 10

var agySubagentUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var errAgySubagentNotFound = errors.New("Native subagent is not owned by this conversation")
var errAgySubagentChanged = errors.New("Native conversation or transcript changed; reopen the subagent history")

type antigravitySubagentItem struct {
	ID             string `json:"id"`
	ParentID       string `json:"parentId"`
	Name           string `json:"name"`
	Role           string `json:"role"`
	TaskSummary    string `json:"taskSummary,omitempty"`
	NativeStatus   string `json:"nativeStatus"`
	Activity       string `json:"activity"`
	LastActivityAt int64  `json:"lastActivityAt,omitempty"`
	Revision       string `json:"revision"`
	HasTranscript  bool   `json:"hasTranscript"`
	Depth          int    `json:"depth"`
	proof          []string
}
type antigravitySubagentMetadata struct {
	ConversationID string `json:"conversationId"`
	State          string `json:"state"`
	SpawnStepIndex *int64 `json:"spawnStepIndex"`
	TaskSummary    string `json:"taskSummary"`
	Descriptor     struct {
		TypeName string `json:"typeName"`
		Role     string `json:"role"`
		Prompt   string `json:"prompt"`
	} `json:"subagentDescriptor"`
}
type antigravitySubagentFile struct {
	info  os.FileInfo
	token string
	size  int64
}
type antigravitySubagentReader struct {
	gate      chan struct{}
	dirty     atomic.Bool
	mu        sync.Mutex
	directory string
	identity  string
	expires   time.Time
	items     []antigravitySubagentItem
	warnings  []string
	revision  string
	files     map[string]antigravitySubagentFile
}
type antigravitySubagentCursor struct {
	Identity string `json:"r"`
	Child    string `json:"c"`
	File     string `json:"f"`
	Offset   int64  `json:"o"`
}
type antigravitySubagentPage struct {
	Success         bool             `json:"success"`
	ParentSessionID string           `json:"parentSessionId"`
	SessionID       string           `json:"sessionId"`
	Messages        []map[string]any `json:"messages"`
	NextBefore      string           `json:"nextBefore,omitempty"`
	HasMore         bool             `json:"hasMore"`
	HistoryOnly     bool             `json:"historyOnly"`
	TranscriptEpoch string           `json:"transcriptEpoch"`
	Warnings        []string         `json:"warnings,omitempty"`
}

func newAntigravitySubagentReader(directory string) *antigravitySubagentReader {
	return &antigravitySubagentReader{gate: make(chan struct{}, 1), directory: directory, files: map[string]antigravitySubagentFile{}}
}
func antigravitySubagentBrain() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".gemini", "antigravity-cli", "brain")
}
func agySubagentText(value string, limit int) string {
	if len(value) > limit {
		return strings.ToValidUTF8(value[:limit], "�") + "…"
	}
	return value
}

// os.Root enforces containment even if native directories change during a read.
// Refuse symlinks within the graph as well: a sibling transcript is not the
// declared child merely because it lives somewhere inside the same brain.
func agySubagentOpenBrain(directory string) (*os.Root, error) {
	info, err := os.Lstat(directory)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errAgySubagentNotFound
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	actual, err := root.Stat(".")
	if err != nil || !os.SameFile(info, actual) {
		root.Close()
		return nil, errAgySubagentNotFound
	}
	return root, nil
}
func agySubagentOpen(root *os.Root, relative string) (*os.File, error) {
	clean := filepath.Clean(relative)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return nil, errAgySubagentNotFound
	}
	parts := strings.Split(clean, string(filepath.Separator))
	var expected os.FileInfo
	for i := range parts {
		var err error
		expected, err = root.Lstat(filepath.Join(parts[:i+1]...))
		if err != nil {
			return nil, err
		}
		if expected.Mode()&os.ModeSymlink != 0 || (!expected.Mode().IsRegular() && !expected.IsDir()) || (i < len(parts)-1 && !expected.IsDir()) {
			return nil, errAgySubagentNotFound
		}
	}
	// A native writer could replace a checked file before Open. NONBLOCK keeps
	// a substituted FIFO from pinning the request; the inode check still rejects it.
	file, err := root.OpenFile(clean, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	actual, err := file.Stat()
	if err != nil || !os.SameFile(expected, actual) {
		file.Close()
		return nil, errAgySubagentNotFound
	}
	return file, nil
}
func agySubagentMetadata(root *os.Root, parent, child string) (antigravitySubagentMetadata, error) {
	var metadata antigravitySubagentMetadata
	if !agySubagentUUID.MatchString(parent) || !agySubagentUUID.MatchString(child) {
		return metadata, errAgySubagentNotFound
	}
	file, err := agySubagentOpen(root, filepath.Join(parent, ".system_generated", "subagents", child+".json"))
	if err != nil {
		return metadata, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > agySubagentMetadataLimit {
		return metadata, errAgySubagentNotFound
	}
	decoder := json.NewDecoder(io.LimitReader(file, agySubagentMetadataLimit+1))
	if err = decoder.Decode(&metadata); err != nil {
		return metadata, err
	}
	if metadata.ConversationID != child {
		return metadata, errAgySubagentNotFound
	}
	return metadata, nil
}
func agySubagentActivity(native string) string {
	switch native {
	case "SUBAGENT_STATE_IDLE":
		return "idle"
	case "SUBAGENT_STATE_RUNNING":
		return "running"
	case "SUBAGENT_STATE_KILLED", "SUBAGENT_STATE_TERMINATED":
		return "terminated"
	}
	return "unknown"
}
func (reader *antigravitySubagentReader) graph(ctx context.Context, rootID, identity string, force bool) ([]antigravitySubagentItem, []string, string, error) {
	select {
	case reader.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, "", ctx.Err()
	}
	defer func() { <-reader.gate }()
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, nil, "", err
	}
	if reader.identity != identity {
		reader.identity = identity
		reader.expires = time.Time{}
		reader.items = nil
		reader.files = map[string]antigravitySubagentFile{}
	}
	if !force && !reader.dirty.Swap(false) && time.Now().Before(reader.expires) {
		return append([]antigravitySubagentItem(nil), reader.items...), append([]string(nil), reader.warnings...), reader.revision, nil
	}
	items := []antigravitySubagentItem{}
	warnings := []string{}
	if !agySubagentUUID.MatchString(rootID) || reader.directory == "" {
		return items, warnings, "", nil
	}
	root, err := agySubagentOpenBrain(reader.directory)
	if os.IsNotExist(err) {
		return items, warnings, "", nil
	}
	if err != nil {
		return nil, nil, "", err
	}
	defer root.Close()
	type node struct {
		id    string
		proof []string
		depth int
	}
	queue := []node{{rootID, nil, 0}}
	seen := map[string]bool{rootID: true}
	hasher := sha256.New()
	for len(queue) > 0 && len(items) < agySubagentGraphLimit {
		if err := ctx.Err(); err != nil {
			return nil, nil, "", err
		}
		parent := queue[0]
		queue = queue[1:]
		if parent.depth >= agySubagentDepthLimit {
			warnings = append(warnings, "Native subagent nesting is limited in this view.")
			continue
		}
		dir, err := agySubagentOpen(root, filepath.Join(parent.id, ".system_generated", "subagents"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			warnings = append(warnings, "A native subagent index could not be read safely.")
			continue
		}
		entries, readErr := dir.ReadDir(agySubagentGraphLimit + 1)
		dir.Close()
		if readErr != nil && readErr != io.EOF {
			warnings = append(warnings, "A native subagent index is unavailable.")
			continue
		}
		if len(entries) > agySubagentGraphLimit {
			warnings = append(warnings, "Additional native subagents were omitted by the bounded preview.")
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			if len(items) >= agySubagentGraphLimit {
				break
			}
			if err := ctx.Err(); err != nil {
				return nil, nil, "", err
			}
			name := entry.Name()
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			id := strings.TrimSuffix(name, ".json")
			if !agySubagentUUID.MatchString(id) || seen[id] {
				continue
			}
			metadata, err := agySubagentMetadata(root, parent.id, id)
			if err != nil {
				warnings = append(warnings, "An invalid native subagent reference was omitted.")
				continue
			}
			seen[id] = true
			proof := append(append([]string(nil), parent.proof...), parent.id, id)
			item := antigravitySubagentItem{ID: id, ParentID: parent.id, Name: agySubagentText(firstNonEmpty(metadata.Descriptor.TypeName, "Subagent"), 120), Role: agySubagentText(metadata.Descriptor.Role, 512), TaskSummary: agySubagentText(firstNonEmpty(metadata.TaskSummary, metadata.Descriptor.Prompt), 320), NativeStatus: agySubagentText(metadata.State, 80), Activity: agySubagentActivity(metadata.State), Depth: parent.depth + 1, proof: proof}
			fmt.Fprintf(hasher, "%s:%s:%s:%s:%s;", parent.id, id, metadata.State, item.Name, item.Role)
			transcript, err := agySubagentOpen(root, filepath.Join(id, ".system_generated", "logs", "transcript_full.jsonl"))
			if err == nil {
				info, statErr := transcript.Stat()
				if statErr == nil && info.Mode().IsRegular() {
					item.HasTranscript = true
					item.Revision = antigravityHistoryHash(fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano()))
					fmt.Fprintf(hasher, "%d:%d;", info.Size(), info.ModTime().UnixNano())
					rows, _, _, _ := agySubagentReadRows(ctx, transcript, info.Size(), 1, 32<<10)
					if len(rows) > 0 {
						item.LastActivityAt = agySubagentCreatedAt(rows[len(rows)-1].step.CreatedAt)
					}
				}
				transcript.Close()
			}
			item.Revision = antigravityHistoryHash(fmt.Sprintf("%s:%s:%s:%s:%s:%s", item.ID, item.NativeStatus, item.Name, item.Role, item.TaskSummary, item.Revision))
			items = append(items, item)
			queue = append(queue, node{id, proof, parent.depth + 1})
		}
	}
	if len(queue) > 0 {
		warnings = append(warnings, "Additional native subagents were omitted by the bounded preview.")
	}
	reader.items = items
	reader.warnings = warnings
	reader.revision = hex.EncodeToString(hasher.Sum(nil))
	reader.expires = time.Now().Add(2 * time.Second)
	for id := range reader.files {
		if !seen[id] {
			delete(reader.files, id)
		}
	}
	return append([]antigravitySubagentItem(nil), items...), append([]string(nil), warnings...), reader.revision, nil
}
func (reader *antigravitySubagentReader) invalidate() { reader.dirty.Store(true) }
func (p *AntigravityProvider) subagentIdentity() (string, string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.nativeID, fmt.Sprintf("%s:%d", p.nativeID, p.generation), !p.closed && !p.switching
}
func (p *AntigravityProvider) subagentReader() *antigravitySubagentReader {
	p.subagentsMu.Lock()
	defer p.subagentsMu.Unlock()
	if p.subagents == nil {
		p.subagents = newAntigravitySubagentReader(antigravitySubagentBrain())
	}
	return p.subagents
}
func (p *AntigravityProvider) subagentDirectory(ctx context.Context) (map[string]any, error) {
	root, identity, valid := p.subagentIdentity()
	if !valid {
		return nil, errAgySubagentChanged
	}
	items, warnings, revision, err := p.subagentReader().graph(ctx, root, identity, false)
	if err != nil {
		return nil, err
	}
	_, current, valid := p.subagentIdentity()
	if !valid || current != identity {
		return nil, errAgySubagentChanged
	}
	return map[string]any{"success": true, "parentSessionId": root, "revision": revision, "items": items, "warnings": warnings, "historyOnly": true}, nil
}

func (p *AntigravityProvider) invalidateSubagentDirectory() {
	p.subagentsMu.Lock()
	reader := p.subagents
	p.subagentsMu.Unlock()
	if reader != nil {
		reader.invalidate()
	}
}
