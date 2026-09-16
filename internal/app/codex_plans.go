package app

import "strings"

// Codex 0.152+ disables this tool by default. Enable it for Glad conversation
// threads so they can emit progress, including resumed and forked threads.
func codexPlanConfig() map[string]any {
	return map[string]any{"tools.update_plan.enabled": true}
}

// A plan notification replaces the steps for one turn; it is separate from the
// plan-mode text carried by item/plan/delta and ThreadItem.plan.
func (provider *CodexProvider) updatePlan(threadID, turnID string, params map[string]any) {
	if threadID == "" || turnID == "" || params["plan"] == nil {
		return
	}
	steps := []any{}
	for _, value := range sliceValue(params["plan"]) {
		step := mapValue(value)
		text, status := strings.TrimSpace(stringValue(step["step"])), stringValue(step["status"])
		if text == "" || (status != "pending" && status != "inProgress" && status != "completed") {
			continue
		}
		steps = append(steps, map[string]any{"step": text, "status": status})
	}
	patch := map[string]any{
		"kind": "task-plan", "threadId": threadID, "turnId": turnID,
		"plan": steps, "explanation": stringValue(params["explanation"]),
		"planTurnStatus": "running", "planSource": "live",
	}
	id := ""
	provider.session.mu.RLock()
	for _, message := range provider.session.Messages {
		if message["threadId"] != threadID || message["turnId"] != turnID {
			continue
		}
		if message["kind"] == "task-plan" {
			id = stringValue(message["id"])
			patch["planTurnStatus"] = message["planTurnStatus"]
		}
		if message["kind"] == "turn-end" {
			patch["planTurnStatus"] = message["status"]
		}
	}
	provider.session.mu.RUnlock()
	if id != "" {
		provider.session.patchMessage(id, patch)
	} else {
		provider.session.appendMessage(patch)
	}
}

func (provider *CodexProvider) finishPlans(threadID, turnID, status string) {
	ids := []string{}
	provider.session.mu.RLock()
	for _, message := range provider.session.Messages {
		if message["kind"] == "task-plan" && message["planTurnStatus"] == "running" &&
			(threadID == "" || message["threadId"] == threadID) && (turnID == "" || message["turnId"] == turnID) {
			ids = append(ids, stringValue(message["id"]))
		}
	}
	provider.session.mu.RUnlock()
	for _, id := range ids {
		// Ending a turn must never turn unfinished steps into completed steps.
		provider.session.patchMessage(id, map[string]any{"planTurnStatus": status})
	}
}

// Merge recovered rollout plans with live plans. Already observed live state
// takes precedence and only turns in the loaded history may receive a card.
func (provider *CodexProvider) retainPlans(messages []map[string]any, history map[string]map[string]any) []map[string]any {
	type turnKey struct{ thread, turn string }
	plans := map[turnKey]map[string]any{}
	for _, plan := range history {
		copy := cloneMap(plan)
		copy["planSource"] = "history"
		plans[turnKey{stringValue(plan["threadId"]), stringValue(plan["turnId"])}] = copy
	}
	provider.session.mu.RLock()
	for _, message := range provider.session.Messages {
		if message["kind"] == "task-plan" && (history == nil || message["planSource"] != "history") {
			plans[turnKey{stringValue(message["threadId"]), stringValue(message["turnId"])}] = cloneMap(message)
		}
	}
	provider.session.mu.RUnlock()
	statuses := map[turnKey]any{}
	for _, message := range messages {
		if message["kind"] == "turn-end" {
			statuses[turnKey{stringValue(message["threadId"]), stringValue(message["turnId"])}] = message["status"]
		}
	}
	result := make([]map[string]any, 0, len(messages)+len(plans))
	for _, message := range messages {
		result = append(result, message)
		if message["kind"] == "turn-start" {
			key := turnKey{stringValue(message["threadId"]), stringValue(message["turnId"])}
			if plan := plans[key]; plan != nil {
				plan["kind"] = "task-plan"
				if plan["id"] == nil {
					plan["id"] = "codex-plan-" + key.thread + "-" + key.turn
				}
				if plan["createdAt"] == nil {
					plan["createdAt"] = message["createdAt"]
				}
				if plan["planTurnStatus"] == nil {
					plan["planTurnStatus"] = firstNonNil(statuses[key], "completed")
				}
				result = append(result, plan)
			}
		}
	}
	return result
}
