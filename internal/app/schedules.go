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
	stop    chan struct{}
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
func (store *ScheduleStore) persistLocked() {
	rows := []*ScheduleJob{}
	for _, job := range store.jobs {
		rows = append(rows, job)
	}
	_ = store.config.Set("schedules", rows)
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
func (store *ScheduleStore) Start(manager *SessionManager) {
	store.mu.Lock()
	if store.stop != nil {
		store.mu.Unlock()
		return
	}
	store.stop = make(chan struct{})
	stop := store.stop
	store.mu.Unlock()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				for _, job := range store.list() {
					if job.Enabled && numberInt64(job.NextRunAt) > 0 && numberInt64(job.NextRunAt) <= millis() {
						go store.run(context.Background(), manager, job.ID, false)
					}
				}
			case <-stop:
				return
			}
		}
	}()
}
func (store *ScheduleStore) Stop() {
	store.mu.Lock()
	if store.stop != nil {
		close(store.stop)
		store.stop = nil
	}
	store.mu.Unlock()
}

func (store *ScheduleStore) run(
	ctx context.Context,
	manager *SessionManager,
	id string,
	manual bool,
) (map[string]any, error) {
	store.mu.Lock()
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
	job.Running = true
	job.LastRunAt = millis()
	job.LastRunStatus = "running"
	store.persistLocked()
	copy := *job
	store.mu.Unlock()
	session, err := manager.Create(
		ctx,
		CreateSessionRequest{
			ToolKey:          stringValue(copy.Target["toolKey"]),
			WorkingDirectory: stringValue(copy.Target["workingDirectory"]),
			Name:             copy.Name,
		},
	)
	if err != nil {
		store.finish(id, "failed", err.Error(), nil)
		return nil, err
	}
	store.mu.Lock()
	store.jobs[id].LastSessionID = session.ID
	store.persistLocked()
	store.mu.Unlock()
	go func() {
		time.Sleep(time.Second)
		for _, step := range copy.Steps {
			switch stringValue(step["type"]) {
			case "sleep":
				time.Sleep(time.Duration(numberInt64(step["seconds"])) * time.Second)
			case "sendText":
				_ = session.Provider.Send(
					context.Background(),
					ProviderInput{Text: stringValue(step["text"]), AgentText: stringValue(step["text"])},
				)
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
	store.persistLocked()
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
	server.schedules.persistLocked()
	server.schedules.mu.Unlock()
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
	server.schedules.jobs[job.ID] = job
	server.schedules.persistLocked()
	server.schedules.mu.Unlock()
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
	server.schedules.jobs[job.ID] = job
	server.schedules.persistLocked()
	server.schedules.mu.Unlock()
	respondJSON(w, 200, job)
}
func (server *Server) deleteSchedule(w http.ResponseWriter, r *http.Request) {
	server.schedules.mu.Lock()
	_, ok := server.schedules.jobs[r.PathValue("id")]
	delete(server.schedules.jobs, r.PathValue("id"))
	server.schedules.persistLocked()
	server.schedules.mu.Unlock()
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
	server.schedules.persistLocked()
	server.schedules.mu.Unlock()
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
