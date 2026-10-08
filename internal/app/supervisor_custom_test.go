package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func startCustomSupervisorTest(t *testing.T, manager *SupervisorManager, roomID, taskID, prompt string) {
	t.Helper()
	if err := manager.Trigger(roomID, taskID, SupervisorTriggerInput{Mode: "custom", Prompt: prompt}); err != nil {
		t.Fatal(err)
	}
	manager.tick()
	manager.wg.Wait()
}

func finishCustomSupervisorTest(provider *supervisorTestProvider, status string) {
	provider.session.appendMessage(map[string]any{"kind": "turn-end", "turnId": "test-turn-" + fmt.Sprint(provider.calls.Load()), "status": status, "isRootTurn": true})
	provider.session.setState(map[string]any{"status": "idle"})
}

func TestSupervisorCustomEndScopeAndReservation(t *testing.T) {
	for _, mode := range []string{"custom", "configured", "periodic"} {
		t.Run(mode, func(t *testing.T) {
			manager, provider, saved, roomID := supervisorControlFixture(t)
			if mode == "custom" {
				// The same text is still custom when explicitly submitted in custom mode.
				startCustomSupervisorTest(t, manager, roomID, saved.ID, saved.Prompt)
			} else if mode == "configured" {
				startSupervisorTest(t, manager, roomID, saved.ID)
			} else {
				manager.tasks[saved.ID].NextAt = millis() - 1
				manager.tick()
				manager.wg.Wait()
			}
			task := manager.tasks[saved.ID]
			inv := activeInvocation(task)
			result, err := manager.Call(context.Background(), provider.session, "end_supervision", "end", map[string]any{"invocationId": inv.ID})
			if err != nil {
				t.Fatal(err)
			}
			wantScope := "task"
			if mode == "custom" {
				wantScope = "invocation"
			}
			if result["scope"] != wantScope || task.Enabled != (mode == "custom") || !inv.Revoked {
				t.Fatalf("wrong end scope: result=%v enabled=%v", result, task.Enabled)
			}
			if ready, _ := sessionCanAccept(provider.session); ready {
				t.Fatal("end_supervision released an unfinished executor")
			}
			if _, err := manager.Call(context.Background(), provider.session, "list_targets", "after-end", map[string]any{"invocationId": inv.ID}); err == nil {
				t.Fatal("ended invocation retained tool access")
			}
			manager.tick()
			if inv.EndedAt != 0 || provider.calls.Load() != 1 {
				t.Fatal("unfinished turn was settled or overlapped")
			}
			provider.finish()
			manager.tick()
			if ready, _ := sessionCanAccept(provider.session); !ready {
				t.Fatal("finished executor remained reserved")
			}
			if mode == "custom" && task.NextAt < inv.EndedAt+60000 || mode != "custom" && task.NextAt != 0 {
				t.Fatalf("wrong schedule after end: %#v", task)
			}
		})
	}
}

func TestSupervisorCustomQueuePreservesMessageAndRejectsAnotherRun(t *testing.T) {
	manager, provider, saved, roomID := supervisorControlFixture(t)
	task := manager.tasks[saved.ID]
	task.LastError = "Previous periodic failure"
	provider.session.setState(map[string]any{"status": "running"})
	if err := manager.Trigger(roomID, saved.ID, SupervisorTriggerInput{Mode: "custom", Prompt: "One-time request"}); err != nil {
		t.Fatal(err)
	}
	manager.tick()
	if task.Status != "waiting_executor" || task.RunOncePrompt != "One-time request" || task.LastError != "Previous periodic failure" || provider.calls.Load() != 0 {
		t.Fatalf("queued message lost: %#v", task)
	}
	for _, mode := range []string{"custom", "configured"} {
		input := SupervisorTriggerInput{Mode: mode}
		if mode == "custom" {
			input.Prompt = "Must not replace the queue"
		}
		if err := manager.Trigger(roomID, saved.ID, input); err == nil || !strings.Contains(err.Error(), "queued run once") {
			t.Fatalf("accepted another queued run: %v", err)
		}
	}
	if task.RunOncePrompt != "One-time request" {
		t.Fatal("rejected trigger replaced queued message")
	}
	provider.session.setState(map[string]any{"status": "idle"})
	manager.tick()
	manager.wg.Wait()
	inv := activeInvocation(task)
	if inv == nil || inv.Kind != "custom" || inv.Prompt != "One-time request" || task.Prompt != saved.Prompt || task.RunOnce || task.RunOncePrompt != "" {
		t.Fatalf("wrong queued invocation: %#v", task)
	}
	if err := manager.Trigger(roomID, saved.ID, SupervisorTriggerInput{Mode: "custom", Prompt: "Another"}); err == nil || !strings.Contains(err.Error(), "active invocation") {
		t.Fatalf("accepted a trigger during a run: %v", err)
	}
	message := provider.session.Messages[0]
	if source := sourceValue(message["supervisorSource"]); source == nil || source.Kind != "trigger" || !strings.Contains(stringValue(message["text"]), "One-time request") {
		t.Fatalf("custom source was not a valid trigger: %v", message)
	}
	provider.finish()
	manager.tick()
}

func TestSupervisorCustomQueueClearedOnPauseDeleteRestartAndRoomClose(t *testing.T) {
	for _, action := range []string{"pause", "delete", "restart", "close"} {
		t.Run(action, func(t *testing.T) {
			manager, provider, saved, roomID := supervisorControlFixture(t)
			provider.session.setState(map[string]any{"status": "running"})
			if err := manager.Trigger(roomID, saved.ID, SupervisorTriggerInput{Mode: "custom", Prompt: "Stale request"}); err != nil {
				t.Fatal(err)
			}
			task := manager.tasks[saved.ID]
			if action == "restart" {
				reloaded, err := OpenSupervisorManager(manager.directory, manager.rooms, manager.sessions)
				if err != nil {
					t.Fatal(err)
				}
				manager, task = reloaded, reloaded.tasks[saved.ID]
				manager.ctx = context.Background()
			} else if action == "close" {
				if err := manager.rooms.Close(roomID); err != nil {
					t.Fatal(err)
				}
				manager.tick()
			} else if err := manager.Action(roomID, saved.ID, action); err != nil {
				t.Fatal(err)
			}
			if task.RunOnce || task.RunOncePrompt != "" {
				t.Fatalf("%s retained queued message", action)
			}
			if action == "pause" || action == "restart" {
				provider.session.setState(map[string]any{"status": "idle"})
				startSupervisorTest(t, manager, roomID, saved.ID)
				inv := activeInvocation(task)
				if inv.Prompt != saved.Prompt || inv.Kind != "check" {
					t.Fatal("ordinary trigger reused the stale custom request")
				}
				provider.finish()
				manager.tick()
			}
		})
	}
}

func TestSupervisorCustomResultsPreservePeriodicStateAndForceOriginalPrompt(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			manager, provider, saved, roomID := supervisorControlFixture(t)
			saved.SkipUnchanged = true
			if _, err := manager.Save(roomID, saved.ID, saved); err != nil {
				t.Fatal(err)
			}
			task := manager.tasks[saved.ID]
			task.Enabled, task.failures, task.LastError = enabled, 2, "Periodic check failed"
			for _, status := range []string{"completed", "failed"} {
				startCustomSupervisorTest(t, manager, roomID, saved.ID, "One-time "+status)
				if task.LastError != "Periodic check failed" {
					t.Fatal("custom trigger erased the periodic error")
				}
				finishCustomSupervisorTest(provider, status)
				manager.tick()
				inv := task.Invocations[len(task.Invocations)-1]
				if task.failures != 2 || task.LastError != "Periodic check failed" || task.Enabled != enabled || !task.force || inv.Status != status {
					t.Fatalf("custom %s changed periodic state: %#v", status, task)
				}
				if enabled && (task.NextAt-inv.EndedAt < 60000 || task.NextAt-inv.EndedAt > 61000) || !enabled && task.NextAt != 0 {
					t.Fatalf("wrong custom interval: %d", task.NextAt-inv.EndedAt)
				}
			}
			if enabled {
				// Targets have not changed since Save or either custom run.
				// Advance the real scheduler and inspect what the provider receives.
				task.NextAt = millis() - 1
				manager.tick()
				manager.wg.Wait()
				inv := activeInvocation(task)
				if provider.calls.Load() != 3 || inv == nil || inv.Kind != "check" || inv.Prompt != saved.Prompt {
					t.Fatal("next periodic check was skipped or reused custom text")
				}
				lastUser := ""
				for _, message := range provider.session.Messages {
					if stringValue(message["kind"]) == "user" {
						lastUser = stringValue(message["text"])
					}
				}
				if !strings.HasSuffix(lastUser, "\n\n"+saved.Prompt) {
					t.Fatalf("provider did not receive configured prompt: %s", lastUser)
				}
				provider.finish()
				manager.tick()
			}
		})
	}
}

func TestSupervisorCustomAuditAndLegacyKind(t *testing.T) {
	manager, provider, saved, roomID := supervisorControlFixture(t)
	startCustomSupervisorTest(t, manager, roomID, saved.ID, "Recorded custom prompt")
	provider.finish()
	manager.tick()
	reloaded, err := OpenSupervisorManager(manager.directory, manager.rooms, manager.sessions)
	if err != nil {
		t.Fatal(err)
	}
	inv := reloaded.tasks[saved.ID].Invocations[0]
	if inv.Kind != "custom" || inv.Prompt != "Recorded custom prompt" {
		t.Fatal("custom audit did not survive restart")
	}
	path := filepath.Join(manager.directory, saved.ID+".audit.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.ReplaceAll(string(data), `"kind":"custom",`, ""))
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	legacy, err := OpenSupervisorManager(manager.directory, manager.rooms, manager.sessions)
	if err != nil || legacy.tasks[saved.ID].Invocations[0].Kind != "check" {
		t.Fatalf("old audit was not treated as a normal check: %v", err)
	}
}

func TestSupervisorCustomTaskErrorsRemainVisible(t *testing.T) {
	for _, failure := range []string{"executor", "audit", "save"} {
		t.Run(failure, func(t *testing.T) {
			manager, provider, saved, roomID := supervisorControlFixture(t)
			manager.tasks[saved.ID].LastError = "Old periodic error"
			startCustomSupervisorTest(t, manager, roomID, saved.ID, "Custom check")
			if failure == "executor" {
				delete(manager.sessions.sessions, provider.session.ID)
			} else {
				if failure == "audit" {
					path := filepath.Join(manager.directory, saved.ID+".audit.jsonl")
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(path, 0700); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Mkdir(filepath.Join(manager.directory, saved.ID+".json.tmp"), 0700); err != nil {
					t.Fatal(err)
				}
				provider.finish()
			}
			manager.tick()
			task := manager.tasks[saved.ID]
			if task.Enabled || task.Status != "needs_attention" || task.LastError == "" || task.LastError == "Old periodic error" {
				t.Fatalf("task failure hidden by custom isolation: %#v", task)
			}
			if failure == "executor" && task.LastError != "Executor session was closed" {
				t.Fatalf("wrong executor error: %s", task.LastError)
			}
		})
	}
}

func TestSupervisorTriggerAPIRequiresExplicitCustomMode(t *testing.T) {
	manager, _, saved, roomID := supervisorControlFixture(t)
	server := &Server{supervisors: manager, rooms: manager.rooms, sessions: manager.sessions}
	mux := http.NewServeMux()
	server.registerSupervisorRoutes(mux)
	for _, body := range []string{`{"mode":"custom","prompt":" "}`, `{"mode":"configured","prompt":"unexpected"}`, `{"mode":"unknown"}`, `{"mode":"custom","prompt":12}`, `{"mode":"custom","prompt":"` + strings.Repeat("界", 5500) + `"}`} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest("POST", "/api/rooms/"+roomID+"/supervisors/"+saved.ID+"/trigger", strings.NewReader(body)))
		if response.Code < 400 || manager.tasks[saved.ID].RunOnce {
			t.Fatalf("invalid request accepted: %d %s", response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	data, _ := json.Marshal(SupervisorTriggerInput{Mode: "custom", Prompt: saved.Prompt})
	mux.ServeHTTP(response, httptest.NewRequest("POST", "/api/rooms/"+roomID+"/supervisors/"+saved.ID+"/trigger", strings.NewReader(string(data))))
	if response.Code != 200 || manager.tasks[saved.ID].RunOncePrompt != saved.Prompt {
		t.Fatalf("explicit custom request rejected: %s", response.Body.String())
	}
}

func TestSupervisorCustomTriggerSaveFailureDoesNotQueue(t *testing.T) {
	manager, provider, saved, roomID := supervisorControlFixture(t)
	if err := os.Mkdir(filepath.Join(manager.directory, saved.ID+".json.tmp"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := manager.Trigger(roomID, saved.ID, SupervisorTriggerInput{Mode: "custom", Prompt: "Do not dispatch on save failure"}); err == nil {
		t.Fatal("save failure was accepted")
	}
	task := manager.tasks[saved.ID]
	manager.tick()
	if task.RunOnce || task.RunOncePrompt != "" || task.LastError == "" || provider.calls.Load() != 0 {
		t.Fatal("failed submission queued work or hid the persistence error")
	}
}

func TestSupervisorCustomEndSaveFailureIsVisible(t *testing.T) {
	manager, provider, saved, roomID := supervisorControlFixture(t)
	startCustomSupervisorTest(t, manager, roomID, saved.ID, "Custom check")
	if err := os.Mkdir(filepath.Join(manager.directory, saved.ID+".json.tmp"), 0700); err != nil {
		t.Fatal(err)
	}
	task := manager.tasks[saved.ID]
	inv := activeInvocation(task)
	if _, err := manager.Call(context.Background(), provider.session, "end_supervision", "end", map[string]any{"invocationId": inv.ID}); err == nil || task.LastError == "" || task.Enabled {
		t.Fatal("end_supervision hid a task persistence failure")
	}
	provider.finish()
	manager.tick()
}
