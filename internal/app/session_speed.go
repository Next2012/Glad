package app

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const speedMethod = "adjusted-turn-v1"

type SpeedSample struct {
	ID                 string   `json:"id"`
	Provider           string   `json:"provider"`
	ConversationID     string   `json:"conversationId"`
	TurnID             string   `json:"turnId"`
	Model              string   `json:"model"`
	Profile            string   `json:"profile"`
	Effort             string   `json:"effort"`
	Fast               bool     `json:"fast"`
	Method             string   `json:"method"`
	StartedAt          int64    `json:"startedAt"`
	EndedAt            int64    `json:"endedAt"`
	Status             string   `json:"status"`
	OutputTokens       *int64   `json:"outputTokens"`
	WallMs             int64    `json:"wallMs"`
	BlockedMs          int64    `json:"blockedMs"`
	ObservedMs         int64    `json:"observedMs"`
	StreamMs           int64    `json:"streamMs,omitempty"`
	VisibleStreamMs    int64    `json:"visibleStreamMs,omitempty"`
	APIMs              int64    `json:"apiMs,omitempty"`
	Rate               *float64 `json:"rate"`
	Quality            string   `json:"quality"`
	Short              bool     `json:"shortSample"`
	ResultOutputTokens *int64   `json:"resultOutputTokens,omitempty"`
	ResultTokensMatch  *bool    `json:"resultTokensMatch,omitempty"`
	SubagentObserved   bool     `json:"subagentObserved,omitempty"`
	Compacted          bool     `json:"compacted,omitempty"`
}

type SpeedStore struct {
	mu        sync.RWMutex
	directory string
	samples   map[string]SpeedSample
	latest    map[string]SpeedSample
	warnings  int
}

func openSpeedStore(directory string) (*SpeedStore, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	store := &SpeedStore{directory: directory, samples: map[string]SpeedSample{}, latest: map[string]SpeedSample{}}
	files, _ := filepath.Glob(filepath.Join(directory, "*.jsonl"))
	sort.SliceStable(files, func(i, j int) bool {
		a, b := strings.ReplaceAll(files[i], ".previous", ""), strings.ReplaceAll(files[j], ".previous", "")
		if a == b {
			return strings.Contains(files[i], ".previous")
		}
		return a < b
	})
	for _, path := range files {
		file, err := os.Open(path)
		if err != nil {
			store.warnings++
			continue
		}
		scan := bufio.NewScanner(file)
		scan.Buffer(make([]byte, 4096), 64<<10)
		for scan.Scan() {
			var sample SpeedSample
			if json.Unmarshal(scan.Bytes(), &sample) != nil || sample.Method != speedMethod || sample.ID == "" {
				store.warnings++
				continue
			}
			if sample.EndedAt >= millis()-90*86400000 {
				store.samples[sample.ID] = sample
				store.updateLatest(sample)
				if len(store.samples) > 75000 {
					store.trim()
				}
			}
		}
		if scan.Err() != nil {
			store.warnings++
		}
		file.Close()
	}
	store.trim()
	return store, nil
}
func speedHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func (store *SpeedStore) add(sample SpeedSample) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, exists := store.samples[sample.ID]; exists {
		return nil
	}
	path := filepath.Join(store.directory, speedHash(sample.Provider+":"+sample.ConversationID)+".jsonl")
	if info, err := os.Stat(path); err == nil && info.Size() > 4<<20 {
		if err = os.Rename(path, strings.TrimSuffix(path, ".jsonl")+".previous.jsonl"); err != nil {
			return err
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if info, statErr := file.Stat(); statErr == nil && info.Size() > 0 {
		var tail [1]byte
		if _, readErr := file.ReadAt(tail[:], info.Size()-1); readErr == nil && tail[0] != '\n' {
			if _, err = file.Write([]byte{'\n'}); err != nil {
				file.Close()
				return err
			}
		}
	}
	data, err := json.Marshal(sample)
	if err == nil {
		_, err = file.Write(append(data, '\n'))
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	store.samples[sample.ID] = sample
	store.updateLatest(sample)
	for key, old := range store.samples {
		if old.EndedAt < millis()-90*86400000 {
			delete(store.samples, key)
		}
	}
	store.trim()
	return nil
}
func (store *SpeedStore) last(provider, conversation string) *SpeedSample {
	if store == nil || conversation == "" {
		return nil
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	sample, exists := store.latest[provider+"\x00"+conversation]
	if !exists {
		return nil
	}
	return &sample
}
func (store *SpeedStore) updateLatest(sample SpeedSample) {
	key := sample.Provider + "\x00" + sample.ConversationID
	old, exists := store.latest[key]
	if sample.Status == "completed" && (!exists || sample.EndedAt >= old.EndedAt) {
		store.latest[key] = sample
	}
}
func (store *SpeedStore) trim() {
	if len(store.samples) <= 50000 {
		return
	}
	rows := make([]SpeedSample, 0, len(store.samples))
	for _, row := range store.samples {
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].EndedAt > rows[j].EndedAt })
	store.samples = map[string]SpeedSample{}
	store.latest = map[string]SpeedSample{}
	for _, row := range rows[:50000] {
		store.samples[row.ID] = row
		store.updateLatest(row)
	}
}
func sameSpeedModel(a, b SpeedSample) bool {
	return a.Provider == b.Provider && a.Model == b.Model && a.Profile == b.Profile && a.Effort == b.Effort && a.Fast == b.Fast && a.Method == b.Method
}

type speedSpan struct{ start, end int64 }
type speedReply struct {
	tokens                   int64
	known                    bool
	model                    string
	start, stop, first, last int64
}
type speedRun struct {
	sample      SpeedSample
	started     time.Time
	blocks      map[string]int64
	intervals   []speedSpan
	replies     map[string]*speedReply
	replyID     string
	tokens      int64
	known       bool
	bad         bool
	lastTotal   int64
	totalKnown  bool
	first, last int64
}
type SpeedTracker struct {
	mu            sync.Mutex
	session       *Session
	store         *SpeedStore
	run           *speedRun
	root          string
	baseline      int64
	baselineKnown bool
}

func (session *Session) speedConversationLocked() string {
	if session.Tool.Key == "codex" {
		return stringValue(session.State["threadId"])
	}
	return stringValue(session.State["claudeSessionId"])
}
func (tracker *SpeedTracker) begin(conversation, turn, model, profile, effort string, fast bool) {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if tracker.run != nil && tracker.run.sample.TurnID == turn {
		return
	}
	if tracker.root != conversation {
		tracker.baseline = 0
		tracker.baselineKnown = false
	}
	tracker.root = conversation
	tracker.run = &speedRun{sample: SpeedSample{Provider: tracker.session.Tool.Key, ConversationID: conversation, TurnID: turn, Model: model, Profile: profile, Effort: effort, Fast: fast, Method: speedMethod, StartedAt: millis(), Quality: "estimated"}, started: time.Now(), blocks: map[string]int64{}, replies: map[string]*speedReply{}, lastTotal: tracker.baseline, totalKnown: tracker.baselineKnown, first: -1, last: -1}
}
func (run *speedRun) elapsed() int64 { return time.Since(run.started).Milliseconds() }
func (run *speedRun) block(id string, start bool) {
	if id == "" {
		return
	}
	now := run.elapsed()
	if start {
		if _, exists := run.blocks[id]; !exists {
			run.blocks[id] = now
		}
	} else if began, exists := run.blocks[id]; exists {
		run.intervals = append(run.intervals, speedSpan{began, now})
		delete(run.blocks, id)
	}
}
func (tracker *SpeedTracker) state(status string) {
	if tracker == nil {
		return
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if tracker.run == nil {
		return
	}
	tracker.run.block("human-wait", status == "waiting_approval" || status == "waiting_input")
}
func speedUnion(spans []speedSpan, end int64) int64 {
	clipped := []speedSpan{}
	for _, span := range spans {
		span.start = max64(0, span.start)
		span.end = min(end, span.end)
		if span.end > span.start {
			clipped = append(clipped, span)
		}
	}
	sort.Slice(clipped, func(i, j int) bool { return clipped[i].start < clipped[j].start })
	var sum, begin, stop int64
	for i, span := range clipped {
		if i == 0 {
			begin, stop = span.start, span.end
			continue
		}
		if span.start > stop {
			sum += stop - begin
			begin, stop = span.start, span.end
		} else {
			stop = max64(stop, span.end)
		}
	}
	if len(clipped) > 0 {
		sum += stop - begin
	}
	return sum
}
func speedRate(tokens *int64, duration int64) *float64 {
	if tokens == nil || duration <= 0 {
		return nil
	}
	rate := float64(*tokens) * 1000 / float64(duration)
	if math.IsNaN(rate) || math.IsInf(rate, 0) || rate < 0 {
		return nil
	}
	return &rate
}
func (tracker *SpeedTracker) finish(status string, apiMs int64) {
	if tracker == nil {
		return
	}
	tracker.mu.Lock()
	run := tracker.run
	if run == nil {
		tracker.mu.Unlock()
		return
	}
	tracker.run = nil
	sample := run.sample
	sample.EndedAt = millis()
	sample.WallMs = run.elapsed()
	sample.Status = status
	sample.APIMs = apiMs
	if len(run.blocks) > 0 {
		run.bad = true
	}
	sample.BlockedMs = speedUnion(run.intervals, sample.WallMs)
	sample.ObservedMs = sample.WallMs - sample.BlockedMs
	if sample.Provider == "claude-code" {
		run.tokens = 0
		run.known = false
		streams := []speedSpan{}
		visible := []speedSpan{}
		for _, reply := range run.replies {
			if reply.known {
				run.tokens += reply.tokens
				run.known = true
			} else {
				run.bad = true
			}
			if reply.stop > reply.start {
				streams = append(streams, speedSpan{reply.start, reply.stop})
			}
			if reply.last > reply.first && reply.first >= 0 {
				visible = append(visible, speedSpan{reply.first, reply.last})
			}
		}
		sample.StreamMs = speedUnion(streams, sample.WallMs)
		sample.VisibleStreamMs = speedUnion(visible, sample.WallMs)
	} else {
		visible := []speedSpan{}
		for _, reply := range run.replies {
			if reply.last > reply.first && reply.first >= 0 {
				visible = append(visible, speedSpan{reply.first, reply.last})
			}
		}
		sample.VisibleStreamMs = speedUnion(visible, sample.WallMs)
	}
	// Keep time that overlaps an observed root-model stream; do not subtract
	// a whole parallel tool lifetime from confirmed model activity.
	modelSpans := []speedSpan{}
	for _, reply := range run.replies {
		if sample.Provider == "claude-code" && reply.stop > reply.start {
			modelSpans = append(modelSpans, speedSpan{reply.start, reply.stop})
		} else if reply.last > reply.first && reply.first >= 0 {
			modelSpans = append(modelSpans, speedSpan{reply.first, reply.last})
		}
	}
	both := append(append([]speedSpan{}, run.intervals...), modelSpans...)
	overlap := sample.BlockedMs + speedUnion(modelSpans, sample.WallMs) - speedUnion(both, sample.WallMs)
	sample.BlockedMs -= max64(0, overlap)
	sample.ObservedMs = sample.WallMs - sample.BlockedMs
	if sample.ResultOutputTokens != nil && run.known {
		matches := *sample.ResultOutputTokens == run.tokens
		sample.ResultTokensMatch = &matches
	}
	if run.tokens < 0 {
		run.bad = true
	}
	if run.known {
		tokens := run.tokens
		sample.OutputTokens = &tokens
		sample.Short = tokens < 50
	}
	if run.bad || !run.known || sample.ConversationID == "" || sample.ObservedMs <= 0 {
		sample.Quality = "incomplete"
	} else {
		sample.Rate = speedRate(sample.OutputTokens, sample.ObservedMs)
	}
	sample.ID = speedHash(sample.Provider + "\x00" + sample.ConversationID + "\x00" + sample.TurnID)
	tracker.mu.Unlock()
	if tracker.store != nil {
		if err := tracker.store.add(sample); err != nil {
			log.Printf("[speed] cannot persist sample: %v", err)
		}
	}
	tracker.session.setState(map[string]any{"lastSpeed": tracker.store.last(sample.Provider, sample.ConversationID)})
}
func (tracker *SpeedTracker) codex(method string, params map[string]any, thread, model, profile, effort string, fast bool) {
	if tracker == nil {
		return
	}
	eventThread := firstNonEmpty(stringValue(params["threadId"]), thread)
	if eventThread != thread || thread == "" {
		return
	}
	turn := mapValue(params["turn"])
	id := firstNonEmpty(stringValue(turn["id"]), stringValue(params["turnId"]))
	if method == "turn/started" {
		tracker.begin(thread, id, model, profile, effort, fast)
		return
	}
	if method == "turn/completed" {
		tracker.mu.Lock()
		valid := tracker.run != nil && tracker.run.sample.TurnID == id
		tracker.mu.Unlock()
		if valid {
			status := stringValue(turn["status"])
			if status == "interrupted" {
				status = "cancelled"
			}
			tracker.finish(status, 0)
		}
		return
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	usage := mapValue(firstNonNil(params["tokenUsage"], params["usage"]))
	if method == "thread/tokenUsage/updated" {
		total := mapValue(firstNonNil(usage["total"], usage["totalTokenUsage"]))
		last := mapValue(firstNonNil(usage["last"], usage["lastTokenUsage"]))
		_, haveTotal := total["outputTokens"]
		_, haveLast := last["outputTokens"]
		if tracker.run == nil {
			tracker.root = thread
			if haveTotal {
				tracker.baseline = numberInt64(total["outputTokens"])
				tracker.baselineKnown = true
			}
			return
		}
		run := tracker.run
		if id != "" && id != run.sample.TurnID {
			return
		}
		if haveTotal && haveLast {
			current := numberInt64(total["outputTokens"])
			if !run.totalKnown {
				run.lastTotal = current - numberInt64(last["outputTokens"])
				run.totalKnown = true
			}
			if current < run.lastTotal {
				run.bad = true
			} else {
				run.tokens += current - run.lastTotal
				run.known = true
			}
			run.lastTotal = current
			tracker.baseline = current
			tracker.baselineKnown = true
		} else {
			run.bad = true
		}
		return
	}
	run := tracker.run
	if run == nil || id != "" && id != run.sample.TurnID {
		return
	}
	if method == "thread/compacted" {
		run.sample.Compacted = true
	}
	if strings.Contains(method, "agentMessage/delta") || strings.Contains(method, "reasoning/") {
		now := run.elapsed()
		if run.first < 0 {
			run.first = now
		}
		run.last = now
		key := stringValue(params["itemId"])
		reply := run.replies[key]
		if reply == nil {
			reply = &speedReply{first: now}
			run.replies[key] = reply
		}
		reply.last = now
	}
	if method == "item/started" || method == "item/completed" {
		item := mapValue(params["item"])
		kind := stringValue(item["type"])
		if kind == "contextCompaction" {
			run.sample.Compacted = true
		}
		if kind == "commandExecution" || kind == "fileChange" || kind == "mcpToolCall" || kind == "dynamicToolCall" || kind == "webSearch" || kind == "collabAgentToolCall" {
			key := "tool:" + stringValue(item["id"])
			if method == "item/completed" {
				if _, exists := run.blocks[key]; !exists {
					run.bad = true
				}
			}
			run.block(key, method == "item/started")
		}
	}
}
func (tracker *SpeedTracker) claude(message map[string]any) {
	if tracker == nil {
		return
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	run := tracker.run
	if run == nil {
		return
	}
	if stringValue(message["parent_tool_use_id"]) != "" {
		run.sample.SubagentObserved = true
		return
	}
	if native := stringValue(message["session_id"]); native != "" {
		run.sample.ConversationID = native
	}
	kind := stringValue(message["type"])
	if kind == "result" {
		if value, exists := mapValue(message["usage"])["output_tokens"]; exists {
			tokens := numberInt64(value)
			run.sample.ResultOutputTokens = &tokens
		}
	}
	if kind == "system" && strings.Contains(strings.ToLower(stringValue(message["subtype"])), "compact") {
		run.sample.Compacted = true
	}
	event := mapValue(message["event"])
	eventType := stringValue(event["type"])
	raw := mapValue(message["message"])
	if kind == "stream_event" {
		switch eventType {
		case "message_start":
			raw = mapValue(event["message"])
			run.replyID = stringValue(raw["id"])
			if run.replies[run.replyID] == nil {
				run.replies[run.replyID] = &speedReply{start: run.elapsed(), first: -1}
			}
		case "content_block_delta":
			if reply := run.replies[run.replyID]; reply != nil {
				if reply.first < 0 {
					reply.first = run.elapsed()
				}
				reply.last = run.elapsed()
			}
		case "message_delta":
			if reply := run.replies[run.replyID]; reply != nil {
				if value, exists := mapValue(event["usage"])["output_tokens"]; exists {
					reply.tokens = max64(reply.tokens, numberInt64(value))
					reply.known = true
				}
			}
		case "message_stop":
			if reply := run.replies[run.replyID]; reply != nil {
				reply.stop = run.elapsed()
			}
		}
	}
	if kind == "assistant" {
		id := stringValue(raw["id"])
		if id == "" {
			run.bad = true
			return
		}
		reply := run.replies[id]
		if reply == nil {
			reply = &speedReply{first: -1}
			run.replies[id] = reply
		}
		if value, exists := mapValue(raw["usage"])["output_tokens"]; exists {
			reply.tokens = max64(reply.tokens, numberInt64(value))
			reply.known = true
		}
		for _, value := range sliceValue(raw["content"]) {
			block := mapValue(value)
			if block["type"] == "tool_use" && block["name"] != "AskUserQuestion" {
				run.block("tool:"+stringValue(block["id"]), true)
			}
		}
	}
	if model := stringValue(raw["model"]); model != "" {
		if run.sample.Model != "" && run.sample.Model != "default" && run.sample.Model != model && len(run.replies) > 1 {
			run.bad = true
		}
		run.sample.Model = model
	}
	if kind == "user" {
		for _, value := range sliceValue(raw["content"]) {
			block := mapValue(value)
			if block["type"] == "tool_result" {
				run.block("tool:"+stringValue(block["tool_use_id"]), false)
			}
		}
	}
}
func (session *Session) speedLastLocked() *SpeedSample {
	if session.speed == nil {
		return nil
	}
	return session.speed.store.last(session.Tool.Key, session.speedConversationLocked())
}
func (session *Session) speedStateLocked() map[string]any {
	state := cloneMap(session.State)
	if session.speed != nil {
		state["lastSpeed"] = session.speedLastLocked()
	}
	return state
}
func (server *Server) sessionSpeed(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	session.mu.RLock()
	native := session.speedConversationLocked()
	provider := session.Tool.Key
	session.mu.RUnlock()
	store := server.sessions.speeds
	last := store.last(provider, native)
	items := []SpeedSample{}
	query := request.URL.Query()
	scope := query.Get("scope")
	if scope != "" && scope != "session" && scope != "model" {
		respondError(writer, 400, fmt.Errorf("Invalid speed scope"))
		return
	}
	excludeShort := false
	if raw := query.Get("excludeShort"); raw != "" {
		if raw != "true" && raw != "false" {
			respondError(writer, 400, fmt.Errorf("excludeShort must be true or false"))
			return
		}
		excludeShort = raw == "true"
	}
	limit := 50
	if query.Get("limit") != "" {
		n, err := strconv.Atoi(query.Get("limit"))
		if err != nil || n < 1 || n > 100 {
			respondError(writer, 400, fmt.Errorf("Limit must be 1–100"))
			return
		}
		limit = n
	}
	timezone := firstNonEmpty(query.Get("timezone"), "UTC")
	location, err := time.LoadLocation(timezone)
	if err != nil {
		respondError(writer, 400, fmt.Errorf("Invalid timezone"))
		return
	}
	if store != nil {
		store.mu.RLock()
		for _, sample := range store.samples {
			if sample.Provider != provider {
				continue
			}
			if scope == "model" {
				if last == nil || last.Model == "" || !sameSpeedModel(sample, *last) {
					continue
				}
			} else if sample.ConversationID != native {
				continue
			}
			items = append(items, sample)
		}
		store.mu.RUnlock()
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].EndedAt == items[j].EndedAt {
			return items[i].ID > items[j].ID
		}
		return items[i].EndedAt > items[j].EndedAt
	})
	type hour struct {
		At            int64    `json:"at"`
		Label         string   `json:"label"`
		Count         int      `json:"count"`
		ExcludedCount int      `json:"excludedCount"`
		SampleCount   int      `json:"sampleCount"`
		Mean          *float64 `json:"mean"`
		sum           float64
	}
	hours := []hour{}
	now := time.Now().In(location)
	anchor := now.Add(-time.Duration(now.Minute())*time.Minute - time.Duration(now.Second())*time.Second - time.Duration(now.Nanosecond()))
	for i := 23; i >= 0; i-- {
		at := anchor.Add(-time.Duration(i) * time.Hour)
		row := hour{At: at.UnixMilli(), Label: at.Format("01-02 15:00")}
		for _, sample := range items {
			if sample.EndedAt >= row.At && sample.EndedAt < row.At+3600000 && sample.Status == "completed" {
				row.SampleCount++
				if sample.Rate == nil {
					continue
				}
				if excludeShort && sample.Short {
					row.ExcludedCount++
					continue
				}
				row.sum += *sample.Rate
				row.Count++
			}
		}
		if row.Count > 0 {
			mean := row.sum / float64(row.Count)
			row.Mean = &mean
		}
		hours = append(hours, row)
	}
	// Select the most recent N completed turns; missing data is never replaced by zero.
	selected := []SpeedSample{}
	valid, short, excluded := 0, 0, 0
	var sum float64
	for _, sample := range items {
		if sample.Status == "completed" && len(selected) < limit {
			selected = append(selected, sample)
			if sample.Rate != nil {
				if sample.Short {
					short++
				}
				if excludeShort && sample.Short {
					excluded++
					continue
				}
				sum += *sample.Rate
				valid++
			}
		}
	}
	var mean *float64
	if valid > 0 {
		value := sum / float64(valid)
		mean = &value
	}
	detail := items
	if len(detail) > limit {
		detail = detail[:limit]
	}
	respondJSON(writer, 200, map[string]any{"success": true, "last": last, "items": detail, "hours": hours, "mean": mean, "validCount": valid, "sampleCount": len(selected), "shortCount": short, "excludedCount": excluded, "excludeShort": excludeShort, "scope": scope, "method": speedMethod, "timezone": timezone})
}

// Profile fingerprints contain only routing configuration, never credentials.
func claudeSpeedProfile(cwd string) string {
	home, _ := os.UserHomeDir()
	profile := map[string]string{}
	paths := []string{filepath.Join(home, ".claude", "settings.json"), filepath.Join(home, ".claude", "settings.local.json")}
	parents := []string{}
	for dir := cwd; dir != ""; dir = filepath.Dir(dir) {
		parents = append(parents, dir)
		if filepath.Dir(dir) == dir {
			break
		}
	}
	for i := len(parents) - 1; i >= 0; i-- {
		for _, name := range []string{"settings.json", "settings.local.json"} {
			paths = append(paths, filepath.Join(parents[i], ".claude", name))
		}
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil || len(data) > 1<<20 {
			continue
		}
		var config map[string]any
		if json.Unmarshal(data, &config) != nil {
			continue
		}
		env := mapValue(config["env"])
		for _, key := range []string{"ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "AWS_REGION", "CLOUD_ML_REGION"} {
			if value := stringValue(env[key]); value != "" {
				profile[key] = value
			}
		}
	}
	for _, key := range []string{"ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "AWS_REGION", "CLOUD_ML_REGION"} {
		if value := os.Getenv(key); value != "" {
			profile[key] = value
		}
	}
	data, _ := json.Marshal(profile)
	return speedHash(string(data))
}
