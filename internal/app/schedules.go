package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type ScheduleJob struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Enabled        bool             `json:"enabled"`
	Schedule       map[string]any   `json:"schedule"`
	Target         map[string]any   `json:"target"`
	Steps          []map[string]any `json:"steps"`
	CreatedAt      int64            `json:"createdAt"`
	UpdatedAt      int64            `json:"updatedAt"`
	LastRunAt      any              `json:"lastRunAt"`
	LastRunStatus  string           `json:"lastRunStatus"`
	LastRunMessage string           `json:"lastRunMessage"`
	LastSessionID  any              `json:"lastSessionId"`
	Running        bool             `json:"running"`
	NextRunAt      any              `json:"nextRunAt"`
}
type ScheduleStore struct {
	mu      sync.Mutex
	config  *ConfigStore
	jobs    map[string]*ScheduleJob
	running map[string]bool
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

func NewScheduleStore(config *ConfigStore) *ScheduleStore {
	store := &ScheduleStore{config: config, jobs: map[string]*ScheduleJob{}, running: map[string]bool{}}
	if rows, ok := config.Get("schedules").([]any); ok {
		for _, value := range rows {
			bytes, _ := jsonMarshal(value)
			var job ScheduleJob
			if jsonUnmarshal(bytes, &job) == nil && job.ID != "" {
				store.jobs[job.ID] = &job
			}
		}
	}
	if len(store.jobs) == 0 {
		if content, err := os.ReadFile(filepath.Join(filepath.Dir(config.path), "schedules.json")); err == nil {
			var legacy map[string]any
			if jsonUnmarshal(content, &legacy) == nil {
				for _, value := range sliceValue(legacy["jobs"]) {
					encoded, _ := jsonMarshal(value)
					var job ScheduleJob
					if jsonUnmarshal(encoded, &job) == nil && job.ID != "" {
						store.jobs[job.ID] = &job
					}
				}
			}
		}
	}
	return store
}
func (store *ScheduleStore) persistLocked() error {
	rows := []*ScheduleJob{}
	for _, job := range store.jobs {
		rows = append(rows, job)
	}
	return store.config.Set("schedules", rows)
}
func (store *ScheduleStore) list() []*ScheduleJob {
	store.mu.Lock()
	defer store.mu.Unlock()
	rows := []*ScheduleJob{}
	for _, job := range store.jobs {
		copy := *job
		rows = append(rows, &copy)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].CreatedAt < rows[j].CreatedAt })
	return rows
}
func (store *ScheduleStore) get(id string) *ScheduleJob {
	store.mu.Lock()
	defer store.mu.Unlock()
	if job := store.jobs[id]; job != nil {
		copy := *job
		return &copy
	}
	return nil
}
func normalizeSchedule(input map[string]any, existing *ScheduleJob) *ScheduleJob {
	now := millis()
	job := &ScheduleJob{
		ID:      newUUID(),
		Name:    "Scheduled Task",
		Enabled: true,
		Schedule: map[string]any{
			"time":     "09:00",
			"weekdays": []any{float64(1), float64(2), float64(3), float64(4), float64(5)},
		},
		Target:        map[string]any{"toolKey": "codex", "workingDirectory": ""},
		Steps:         []map[string]any{},
		CreatedAt:     now,
		UpdatedAt:     now,
		LastRunAt:     nil,
		LastRunStatus: "idle",
		LastSessionID: nil,
	}
	if existing != nil {
		copy := *existing
		job = &copy
	}
	if value := stringValue(input["name"]); value != "" {
		job.Name = value
	}
	if value, ok := input["enabled"].(bool); ok {
		job.Enabled = value
	}
	if value := mapValue(input["schedule"]); len(value) > 0 {
		job.Schedule = value
	}
	if value := mapValue(input["target"]); len(value) > 0 {
		job.Target = value
	}
	if value := mapsFromAny(input["steps"]); value != nil {
		job.Steps = value
	}
	job.UpdatedAt = now
	if job.Enabled {
		job.NextRunAt = computeNextRun(job.Schedule, now)
	} else {
		job.NextRunAt = nil
	}
	return job
}
func computeNextRun(schedule map[string]any, now int64) any {
	clock := stringValue(schedule["time"])
	parts := strings.Split(clock, ":")
	if len(parts) != 2 {
		return nil
	}
	hour, minute := atoiDefault(parts[0], -1), atoiDefault(parts[1], -1)
	if hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return nil
	}
	days := map[int]bool{}
	for _, value := range sliceValue(schedule["weekdays"]) {
		days[int(numberInt64(value))] = true
	}
	start := time.UnixMilli(now)
	for offset := 0; offset <= 7; offset++ {
		candidate := time.Date(start.Year(), start.Month(), start.Day()+offset, hour, minute, 0, 0, start.Location())
		if candidate.UnixMilli() > now && days[int(candidate.Weekday())] {
			return candidate.UnixMilli()
		}
	}
	return nil
}
func (store *ScheduleStore) Start(parent context.Context, manager *SessionManager) {
	store.mu.Lock()
	if store.cancel != nil {
		store.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	store.ctx = ctx
	store.cancel = cancel
	store.wg.Add(1)
	store.mu.Unlock()
	go func() {
		defer store.wg.Done()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				for _, job := range store.list() {
					if job.Enabled && numberInt64(job.NextRunAt) > 0 && numberInt64(job.NextRunAt) <= millis() {
						_, _ = store.run(ctx, manager, job.ID, false)
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}
func (store *ScheduleStore) Stop() {
	store.mu.Lock()
	cancel := store.cancel
	store.cancel = nil
	store.ctx = nil
	store.mu.Unlock()
	if cancel != nil {
		cancel()
		store.wg.Wait()
	}
}

func (store *ScheduleStore) run(
	ctx context.Context,
	manager *SessionManager,
	id string,
	manual bool,
) (map[string]any, error) {
	store.mu.Lock()
	if store.ctx == nil {
		store.mu.Unlock()
		return nil, errors.New("Scheduler is not running")
	}
	job := store.jobs[id]
	if job == nil {
		store.mu.Unlock()
		return nil, errors.New("Scheduled task not found")
	}
	if store.running[id] {
		store.mu.Unlock()
		return map[string]any{"skipped": true, "reason": "Previous run is still active"}, nil
	}
	store.running[id] = true
	previous := *job
	job.Running = true
	job.LastRunAt = millis()
	job.LastRunStatus = "running"
	if err := store.persistLocked(); err != nil {
		*job = previous
		delete(store.running, id)
		store.mu.Unlock()
		return nil, err
	}
	copy := *job
	runCtx := store.ctx
	store.wg.Add(1)
	store.mu.Unlock()
	createCtx, cancelCreate := context.WithCancel(ctx)
	stopCancel := context.AfterFunc(runCtx, cancelCreate)
	session, err := manager.Create(
		createCtx,
		CreateSessionRequest{
			ToolKey:          stringValue(copy.Target["toolKey"]),
			WorkingDirectory: stringValue(copy.Target["workingDirectory"]),
			Name:             copy.Name,
		},
	)
	stopCancel()
	cancelCreate()
	if err != nil {
		store.finish(id, "failed", err.Error(), nil)
		store.wg.Done()
		return nil, err
	}
	store.mu.Lock()
	if store.jobs[id] == nil {
		delete(store.running, id)
		store.mu.Unlock()
		manager.Delete(context.Background(), session.ID)
		store.wg.Done()
		return nil, errors.New("Scheduled task was deleted while starting")
	}
	store.jobs[id].LastSessionID = session.ID
	if err := store.persistLocked(); err != nil {
		store.mu.Unlock()
		manager.Delete(context.Background(), session.ID)
		store.finish(id, "failed", err.Error(), nil)
		store.wg.Done()
		return nil, err
	}
	store.mu.Unlock()
	go func() {
		defer store.wg.Done()
		if !waitForContext(runCtx, time.Second) {
			manager.Delete(context.Background(), session.ID)
			store.finish(id, "cancelled", "Scheduled task stopped", session.ID)
			return
		}
		for _, step := range copy.Steps {
			if runCtx.Err() != nil {
				manager.Delete(context.Background(), session.ID)
				store.finish(id, "cancelled", "Scheduled task stopped", session.ID)
				return
			}
			switch stringValue(step["type"]) {
			case "sleep":
				if !waitForContext(runCtx, time.Duration(numberInt64(step["seconds"]))*time.Second) {
					manager.Delete(context.Background(), session.ID)
					store.finish(id, "cancelled", "Scheduled task stopped", session.ID)
					return
				}
			case "sendText":
				sendCtx, cancel := context.WithTimeout(runCtx, 60*time.Second)
				if err := session.Provider.Send(
					sendCtx,
					ProviderInput{
						ClientMessageID: "schedule-" + copy.ID + "-" + newUUID(),
						Text:            stringValue(step["text"]), AgentText: stringValue(step["text"]),
					},
				); err != nil {
					cancel()
					store.finish(id, "failed", "Message failed: "+err.Error(), session.ID)
					return
				}
				cancel()
			case "stop":
				store.finish(id, "success", "Started session "+session.ID, session.ID)
				return
			case "closeSession":
				manager.Delete(context.Background(), session.ID)
				store.finish(id, "success", "Session closed", session.ID)
				return
			}
		}
		store.finish(id, "success", "Started session "+session.ID, session.ID)
	}()
	return map[string]any{"success": true, "sessionId": session.ID}, nil
}

func waitForContext(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
func (store *ScheduleStore) finish(id, status, message string, sessionID any) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if job := store.jobs[id]; job != nil {
		job.Running = false
		job.LastRunStatus = status
		job.LastRunMessage = message
		job.LastSessionID = sessionID
		job.NextRunAt = computeNextRun(job.Schedule, millis())
	}
	delete(store.running, id)
	if err := store.persistLocked(); err != nil {
		logDebug("[scheduler] unable to persist completion for %s: %v", id, err)
	}
}
func (server *Server) registerScheduleRoutes(mux *http.ServeMux) {
	mux.HandleFunc(
		"GET /api/schedules",
		func(w http.ResponseWriter, r *http.Request) { respondJSON(w, 200, server.schedules.list()) },
	)
	mux.HandleFunc("POST /api/schedules", server.createSchedule)
	mux.HandleFunc("GET /api/schedules/{id}", server.getSchedule)
	mux.HandleFunc("PATCH /api/schedules/{id}", server.updateSchedule)
	mux.HandleFunc("PATCH /api/schedules/{id}/enabled", server.enableSchedule)
	mux.HandleFunc("DELETE /api/schedules/{id}", server.deleteSchedule)
	mux.HandleFunc("POST /api/schedules/{id}/duplicate", server.duplicateSchedule)
	mux.HandleFunc("POST /api/schedules/{id}/run", server.runSchedule)
	mux.HandleFunc("POST /api/schedules/{id}/simulate", server.runSchedule)
}
func (server *Server) createSchedule(w http.ResponseWriter, r *http.Request) {
	var input map[string]any
	if decodeJSON(r, &input) != nil {
		input = map[string]any{}
	}
	job := normalizeSchedule(input, nil)
	server.schedules.mu.Lock()
	server.schedules.jobs[job.ID] = job
	err := server.schedules.persistLocked()
	if err != nil {
		delete(server.schedules.jobs, job.ID)
	}
	server.schedules.mu.Unlock()
	if err != nil {
		respondError(w, 500, err)
		return
	}
	respondJSON(w, 200, job)
}
func (server *Server) getSchedule(w http.ResponseWriter, r *http.Request) {
	job := server.schedules.get(r.PathValue("id"))
	if job == nil {
		notFound(w, "Scheduled task not found")
		return
	}
	respondJSON(w, 200, job)
}
func (server *Server) updateSchedule(w http.ResponseWriter, r *http.Request) {
	existing := server.schedules.get(r.PathValue("id"))
	if existing == nil {
		notFound(w, "Scheduled task not found")
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input)
	job := normalizeSchedule(input, existing)
	server.schedules.mu.Lock()
	previous := server.schedules.jobs[job.ID]
	server.schedules.jobs[job.ID] = job
	err := server.schedules.persistLocked()
	if err != nil {
		server.schedules.jobs[job.ID] = previous
	}
	server.schedules.mu.Unlock()
	if err != nil {
		respondError(w, 500, err)
		return
	}
	respondJSON(w, 200, job)
}
func (server *Server) enableSchedule(w http.ResponseWriter, r *http.Request) {
	var input map[string]any
	_ = decodeJSON(r, &input)
	server.updateScheduleWith(w, r, map[string]any{"enabled": boolValue(input["enabled"])})
}
func (server *Server) updateScheduleWith(w http.ResponseWriter, r *http.Request, input map[string]any) {
	existing := server.schedules.get(r.PathValue("id"))
	if existing == nil {
		notFound(w, "Scheduled task not found")
		return
	}
	job := normalizeSchedule(input, existing)
	server.schedules.mu.Lock()
	previous := server.schedules.jobs[job.ID]
	server.schedules.jobs[job.ID] = job
	err := server.schedules.persistLocked()
	if err != nil {
		server.schedules.jobs[job.ID] = previous
	}
	server.schedules.mu.Unlock()
	if err != nil {
		respondError(w, 500, err)
		return
	}
	respondJSON(w, 200, job)
}
func (server *Server) deleteSchedule(w http.ResponseWriter, r *http.Request) {
	server.schedules.mu.Lock()
	previous, ok := server.schedules.jobs[r.PathValue("id")]
	delete(server.schedules.jobs, r.PathValue("id"))
	err := server.schedules.persistLocked()
	if err != nil && previous != nil {
		server.schedules.jobs[r.PathValue("id")] = previous
	}
	server.schedules.mu.Unlock()
	if err != nil {
		respondError(w, 500, err)
		return
	}
	respondJSON(w, 200, map[string]any{"success": ok})
}
func (server *Server) duplicateSchedule(w http.ResponseWriter, r *http.Request) {
	existing := server.schedules.get(r.PathValue("id"))
	if existing == nil {
		notFound(w, "Scheduled task not found")
		return
	}
	existing.ID = newUUID()
	existing.Name += " Copy"
	existing.Enabled = false
	existing.CreatedAt = millis()
	existing.UpdatedAt = millis()
	existing.LastRunAt = nil
	existing.LastRunStatus = "idle"
	existing.LastRunMessage = ""
	existing.LastSessionID = nil
	existing.NextRunAt = nil
	server.schedules.mu.Lock()
	server.schedules.jobs[existing.ID] = existing
	err := server.schedules.persistLocked()
	if err != nil {
		delete(server.schedules.jobs, existing.ID)
	}
	server.schedules.mu.Unlock()
	if err != nil {
		respondError(w, 500, err)
		return
	}
	respondJSON(w, 200, existing)
}
func (server *Server) runSchedule(w http.ResponseWriter, r *http.Request) {
	result, err := server.schedules.run(
		r.Context(),
		server.sessions,
		r.PathValue("id"),
		strings.HasSuffix(r.URL.Path, "/simulate"),
	)
	if err != nil {
		respondError(w, 400, err)
		return
	}
	respondJSON(w, 200, result)
}
