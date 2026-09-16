package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func planRecord(kind string, payload map[string]any) map[string]any {
	return map[string]any{"type": kind, "payload": payload}
}

func planParams(step, status string) map[string]any {
	return map[string]any{"plan": []any{map[string]any{"step": step, "status": status}}}
}

func writePlanRollout(t *testing.T, threadID string, records ...map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	encoder := json.NewEncoder(file)
	if err := encoder.Encode(planRecord("session_meta", map[string]any{"id": threadID})); err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		if err := encoder.Encode(record); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func TestCodexCodePlanReadsLiteralsWithoutExecutingCode(t *testing.T) {
	for _, test := range []struct {
		name, code, step, status string
	}{
		{"literal", `text(await tools.update_plan({plan:[{step:"核对代码",status:"in_progress"}]}));`, "核对代码", "inProgress"},
		{"escapes", `await functions.update_plan({explanation:null,plan:[{step:'it\'s "quoted"\n中文',status:'completed'},],});`, "it's \"quoted\"\n中文", "completed"},
		{"alias", "const steps = [{step:`检查`,status:'pending'}]; const args = {plan:steps}; text(await tools.update_plan(args));", "检查", "pending"},
		{"shorthand", `const plan = [{step:'static',status:'completed'}]; await tools.update_plan({plan});`, "static", "completed"},
		{"last update", `await tools.update_plan({plan:[{step:'first',status:'pending'}]}); /* note */ text(await tools.update_plan({plan:[{step:'last',status:'completed'}]}));`, "last", "completed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan, ok := codexCodePlan(test.code)
			if !ok || plan == nil {
				t.Fatal("literal plan was not recovered")
			}
			step := mapValue(sliceValue(plan["plan"])[0])
			if step["step"] != test.step || step["status"] != test.status {
				t.Fatalf("wrong recovered step: %#v", step)
			}
		})
	}
	for _, code := range []string{
		`text("await tools.update_plan({plan:[]})");`,
		`// await tools.update_plan({plan:[]})`,
		`if (false) await tools.update_plan({plan:[]});`,
		`false && await tools.update_plan({plan:[]});`,
		`const unused = () => tools.update_plan({plan:[]});`,
		`const pattern = /await tools.update_plan({plan:[]})/;`,
		`await tools.update_plan({plan:computePlan()});`,
		`await tools.update_plan({plan:[{step:'bad',status:'unknown'}]});`,
		`const plan = [{step:'old',status:'pending'}]; plan[0].step='new'; await tools.update_plan({plan});`,
		`const plan = [{step:'old',status:'pending'}]; const args = {plan}; mutate(plan); await tools.update_plan(args);`,
		`await tools.update_plan({plan:[{step:'unterminated`,
	} {
		if plan, _ := codexCodePlan(code); plan != nil {
			t.Fatalf("ambiguous or non-executed code produced a plan: %s => %v", code, plan)
		}
	}
}

func TestCodexPlanRolloutKeepsLatestSuccessfulUpdatePerTurn(t *testing.T) {
	path := writePlanRollout(t, "root",
		planRecord("event_msg", map[string]any{"type": "task_started", "turn_id": "one"}),
		planRecord("response_item", map[string]any{"type": "function_call", "name": "update_plan", "call_id": "first", "arguments": `{"plan":[{"step":"first","status":"pending"}]}`}),
		planRecord("response_item", map[string]any{"type": "function_call_output", "call_id": "first", "output": "Plan updated"}),
		planRecord("response_item", map[string]any{"type": "custom_tool_call", "name": "exec", "call_id": "last", "input": `text(await tools.update_plan({plan:[{step:'final',status:'completed'}]}));`}),
		planRecord("response_item", map[string]any{"type": "custom_tool_call_output", "call_id": "last", "output": []any{map[string]any{"type": "input_text", "text": "Script completed\nOutput:\n{}"}}}),
		planRecord("response_item", map[string]any{"type": "function_call", "name": "update_plan", "call_id": "failed", "arguments": planParams("rejected", "pending")}),
		planRecord("response_item", map[string]any{"type": "function_call_output", "call_id": "failed", "output": "Error: invalid update"}),
		planRecord("response_item", map[string]any{"type": "function_call", "name": "update_plan", "call_id": "unfinished", "arguments": planParams("unconfirmed", "pending")}),
		planRecord("event_msg", map[string]any{"type": "task_complete", "turn_id": "one"}),
		planRecord("turn_context", map[string]any{"turn_id": "two"}),
		planRecord("event_msg", map[string]any{"type": "plan_update", "plan": planParams("still working", "in_progress")["plan"]}),
	)
	plans, err := readCodexPlanHistory(context.Background(), path, "root")
	if err != nil || len(plans) != 2 {
		t.Fatalf("wrong recovered turns: %v, %v", plans, err)
	}
	first := mapValue(sliceValue(plans["one"]["plan"])[0])
	second := mapValue(sliceValue(plans["two"]["plan"])[0])
	if first["step"] != "final" || first["status"] != "completed" || second["status"] != "inProgress" {
		t.Fatalf("incorrect final snapshots: %v", plans)
	}
}

func TestCodexPlanRolloutClearsWithdrawnOrUnrecoverableUpdates(t *testing.T) {
	for _, code := range []string{
		`await tools.update_plan({plan:[]});`,
		`await tools.update_plan({plan:computed});`,
		"await tools.update_plan({plan:[{step:`check ${name}`,status:'completed'}]});",
	} {
		path := writePlanRollout(t, "root",
			planRecord("event_msg", map[string]any{"type": "task_started", "turn_id": "one"}),
			planRecord("event_msg", map[string]any{"type": "plan_update", "plan": planParams("old", "pending")["plan"]}),
			planRecord("response_item", map[string]any{"type": "custom_tool_call", "name": "exec", "call_id": "clear", "input": code}),
			planRecord("response_item", map[string]any{"type": "custom_tool_call_output", "call_id": "clear", "output": "Script completed"}),
		)
		plans, err := readCodexPlanHistory(context.Background(), path, "root")
		if err != nil || len(sliceValue(plans["one"]["plan"])) != 0 {
			t.Fatalf("stale plan survived replacement: %v, %v", plans, err)
		}
	}
}

func TestCodexPlanRolloutHandlesCorruptionCancellationAndThreadMismatch(t *testing.T) {
	path := writePlanRollout(t, "root")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	// An oversized unrelated line and a truncated JSON record must not hide
	// later valid plan events or cause unbounded allocations.
	_, _ = file.WriteString(strings.Repeat("x", 9<<20) + "\n{broken\n")
	_ = json.NewEncoder(file).Encode(planRecord("event_msg", map[string]any{"type": "plan_update", "turn_id": "one", "plan": planParams("recovered", "pending")["plan"]}))
	_ = file.Close()
	plans, err := readCodexPlanHistory(context.Background(), path, "root")
	if err != nil || len(plans) != 1 {
		t.Fatalf("corrupt line blocked recovery: %v, %v", plans, err)
	}
	if plans, err := readCodexPlanHistory(context.Background(), path, "another"); err == nil || len(plans) != 0 {
		t.Fatal("rollout from another thread was accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := readCodexPlanHistory(ctx, path, "root"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation was ignored: %v", err)
	}
}

func TestCodexHistoricalPlansRestoreInNewSessionsWithoutDuplication(t *testing.T) {
	path := writePlanRollout(t, "root",
		planRecord("event_msg", map[string]any{"type": "plan_update", "turn_id": "one", "plan": planParams("finished", "completed")["plan"]}),
		planRecord("event_msg", map[string]any{"type": "plan_update", "turn_id": "two", "plan": planParams("unfinished", "in_progress")["plan"]}),
		planRecord("event_msg", map[string]any{"type": "plan_update", "turn_id": "rolled-back", "plan": planParams("removed", "pending")["plan"]}),
	)
	result := map[string]any{"thread": map[string]any{"id": "root", "path": path, "turns": []any{
		map[string]any{"id": "one", "status": "completed", "createdAt": 1700000000},
		map[string]any{"id": "two", "status": "interrupted", "createdAt": 1700000100},
	}}}
	for session := 0; session < 2; session++ {
		provider := planTestProvider(t)
		for resume := 0; resume < 2; resume++ {
			if err := provider.hydrateThread(context.Background(), result); err != nil {
				t.Fatal(err)
			}
			plans := []map[string]any{}
			for _, item := range provider.session.Messages {
				if item["kind"] == "task-plan" {
					plans = append(plans, item)
				}
			}
			if len(plans) != 2 || plans[0]["planTurnStatus"] != "completed" || plans[1]["planTurnStatus"] != "cancelled" {
				t.Fatalf("history lost, duplicated, or revived a plan: %v", plans)
			}
			if mapValue(sliceValue(plans[1]["plan"])[0])["status"] != "inProgress" || plans[0]["createdAt"] != int64(1700000000000) {
				t.Fatalf("restored steps or timestamps were changed: %v", plans)
			}
		}
	}
	// Losing the optional rollout must not prevent normal history hydration.
	_ = os.Remove(path)
	if err := planTestProvider(t).hydrateThread(context.Background(), result); err != nil {
		t.Fatalf("missing rollout blocked conversation history: %v", err)
	}
}

func TestCodexHistoricalPlansRefreshWhileLivePlansTakePrecedence(t *testing.T) {
	provider := planTestProvider(t)
	path := writePlanRollout(t, "root",
		planRecord("event_msg", map[string]any{"type": "plan_update", "turn_id": "one", "plan": planParams("old", "pending")["plan"]}),
	)
	result := map[string]any{"thread": map[string]any{"id": "root", "path": path, "turns": []any{
		map[string]any{"id": "one", "status": "completed"},
	}}}
	if err := provider.hydrateThread(context.Background(), result); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := json.NewEncoder(file).Encode(planRecord("event_msg", map[string]any{
		"type": "plan_update", "turn_id": "one", "plan": planParams("new", "completed")["plan"],
	})); err != nil {
		t.Fatal(err)
	}
	if err := provider.hydrateThread(context.Background(), result); err != nil {
		t.Fatal(err)
	}
	if step := mapValue(sliceValue(provider.session.Messages[1]["plan"])[0]); step["step"] != "new" {
		t.Fatalf("cached history masked newer persisted progress: %v", step)
	}
	sendTestPlan(provider, "root", "one", "inProgress")
	if err := provider.hydrateThread(context.Background(), result); err != nil {
		t.Fatal(err)
	}
	if step := mapValue(sliceValue(provider.session.Messages[1]["plan"])[0]); step["step"] != "Verify changes" {
		t.Fatalf("older persisted data replaced live progress: %v", step)
	}
}
