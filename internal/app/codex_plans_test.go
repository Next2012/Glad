package app

import "testing"

func planTestProvider(t *testing.T) *CodexProvider {
	t.Helper()
	session := newSession("plans", "Codex", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	t.Cleanup(session.cancel)
	provider := NewCodexProvider(session, nil)
	provider.threadID = "root"
	return provider
}

func sendTestPlan(provider *CodexProvider, thread, turn, status string) {
	provider.handleNotification("turn/plan/updated", map[string]any{
		"threadId": thread, "turnId": turn,
		"plan": []any{map[string]any{"step": "Verify changes", "status": status}},
	})
}

func TestCodexPlanUpdatesReplaceStepsAndSurviveSnapshots(t *testing.T) {
	provider := planTestProvider(t)
	sendTestPlan(provider, "root", "one", "pending")
	id := provider.session.Messages[0]["id"]
	sendTestPlan(provider, "root", "one", "inProgress")
	sendTestPlan(provider, "child", "one", "pending")
	sendTestPlan(provider, "root", "two", "pending")
	messages := provider.session.snapshot()["messages"].([]map[string]any)
	if len(messages) != 3 {
		t.Fatalf("expected one plan per thread and turn, got %d", len(messages))
	}
	plan := mapValue(messages[0])
	if plan["id"] != id || mapValue(sliceValue(plan["plan"])[0])["status"] != "inProgress" {
		t.Fatalf("snapshot lost the updated plan: %v", plan)
	}
	provider.handleNotification("turn/plan/updated", map[string]any{
		"threadId": "root", "turnId": "one", "plan": []any{},
	})
	if len(provider.session.Messages) != 3 || len(sliceValue(provider.session.Messages[0]["plan"])) != 0 {
		t.Fatal("an empty update must clear the existing plan")
	}
}

func TestCodexPlanCompletionPreservesUnfinishedSteps(t *testing.T) {
	for _, status := range []string{"completed", "interrupted", "failed"} {
		t.Run(status, func(t *testing.T) {
			provider := planTestProvider(t)
			provider.turnID = "one"
			sendTestPlan(provider, "root", "one", "inProgress")
			sendTestPlan(provider, "child", "child-turn", "pending")
			provider.handleNotification("turn/completed", map[string]any{
				"threadId": "root", "turn": map[string]any{"id": "one", "status": status},
			})
			want := status
			if want == "interrupted" {
				want = "cancelled"
			}
			plan := provider.session.Messages[0]
			if plan["planTurnStatus"] != want || mapValue(sliceValue(plan["plan"])[0])["status"] != "inProgress" {
				t.Fatalf("completion changed the actual step progress: %v", plan)
			}
			if provider.session.Messages[1]["planTurnStatus"] != "cancelled" {
				t.Fatal("root completion left a child plan running")
			}
			sendTestPlan(provider, "root", "one", "pending")
			if provider.session.Messages[0]["planTurnStatus"] != want {
				t.Fatal("a late plan notification revived an ended turn")
			}
		})
	}
}

func TestCodexPlanTransportFailureSettlesAllPlans(t *testing.T) {
	provider := planTestProvider(t)
	sendTestPlan(provider, "root", "one", "inProgress")
	sendTestPlan(provider, "child", "two", "pending")
	provider.settleStoppedTurn("root", "one", 0, "Connection lost", "failed")
	for _, plan := range provider.session.Messages[:2] {
		if plan["planTurnStatus"] != "failed" {
			t.Fatalf("transport failure left a plan active: %v", plan)
		}
	}
}

func TestCodexPlanRehydrationRetainsOnlyMatchingThreadAndTurns(t *testing.T) {
	provider := planTestProvider(t)
	sendTestPlan(provider, "root", "one", "completed")
	sendTestPlan(provider, "other", "one", "pending")
	sendTestPlan(provider, "root", "removed", "pending")
	messages := provider.retainPlans([]map[string]any{
		{"kind": "turn-start", "threadId": "root", "turnId": "one"},
		{"kind": "assistant", "threadId": "root", "turnId": "one", "text": "Done"},
	}, nil)
	if len(messages) != 3 || messages[1]["id"] != provider.session.Messages[0]["id"] || messages[2]["kind"] != "assistant" {
		t.Fatalf("rehydration lost or mixed plans: %v", messages)
	}
}
