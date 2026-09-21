package app

import (
	"regexp"
	"strconv"
)

type claudeTask struct {
	ID         string
	Step       string
	ActiveForm string
	Status     string
	BlockedBy  []string
}

type claudeTaskPlan struct {
	MessageID string
	Order     []string
	Tasks     map[string]*claudeTask
}

func normalizeClaudeTaskStatus(status string) string {
	switch status {
	case "in_progress", "inProgress":
		return "inProgress"
	case "completed":
		return "completed"
	case "deleted":
		return "removed"
	default:
		return "pending"
	}
}

func stringsFromSlice(value any) []string {
	result := []string{}
	for _, item := range sliceValue(value) {
		if text := stringValue(item); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func (provider *ClaudeProvider) taskPlanLocked(turnID string) *claudeTaskPlan {
	plan := provider.taskPlans[turnID]
	if plan == nil {
		plan = &claudeTaskPlan{Tasks: map[string]*claudeTask{}}
		provider.taskPlans[turnID] = plan
	}
	return plan
}

func (provider *ClaudeProvider) handleTaskToolCall(turnID, name, toolUseID string, input map[string]any) {
	if name != "TodoWrite" && name != "TaskCreate" && name != "TaskUpdate" && name != "TaskList" {
		return
	}
	provider.mu.Lock()
	plan := provider.taskPlanLocked(turnID)
	if name == "TodoWrite" {
		plan.Order = nil
		plan.Tasks = map[string]*claudeTask{}
		for index, raw := range sliceValue(input["todos"]) {
			item := mapValue(raw)
			id := firstNonEmpty(stringValue(item["id"]), strconv.Itoa(index+1))
			plan.Order = append(plan.Order, id)
			plan.Tasks[id] = &claudeTask{
				ID: id, Step: firstNonEmpty(stringValue(item["content"]), stringValue(item["subject"]), "Task"),
				ActiveForm: stringValue(item["activeForm"]), Status: normalizeClaudeTaskStatus(stringValue(item["status"])),
			}
		}
	} else if name == "TaskCreate" {
		id := "create:" + toolUseID
		plan.Order = append(plan.Order, id)
		plan.Tasks[id] = &claudeTask{
			ID: id, Step: firstNonEmpty(stringValue(input["subject"]), stringValue(input["description"]), "Task"),
			ActiveForm: stringValue(input["activeForm"]), Status: "pending",
		}
	} else if name == "TaskUpdate" {
		id := firstNonEmpty(stringValue(input["taskId"]), stringValue(input["task_id"]), stringValue(input["id"]))
		if id != "" {
			task := plan.Tasks[id]
			if task == nil {
				task = &claudeTask{ID: id, Step: firstNonEmpty(stringValue(input["subject"]), "Task "+id)}
				plan.Tasks[id] = task
				plan.Order = append(plan.Order, id)
			}
			if value := stringValue(input["subject"]); value != "" {
				task.Step = value
			}
			if value := stringValue(input["activeForm"]); value != "" {
				task.ActiveForm = value
			}
			if value := stringValue(input["status"]); value != "" {
				task.Status = normalizeClaudeTaskStatus(value)
			}
			task.BlockedBy = stringsFromSlice(input["addBlockedBy"])
		}
	}
	provider.mu.Unlock()
	provider.publishTaskPlan(turnID)
}

func (provider *ClaudeProvider) handleTaskToolResult(turnID, toolUseID string, result any, text string) {
	provider.mu.Lock()
	plan := provider.taskPlans[turnID]
	if plan == nil {
		provider.mu.Unlock()
		return
	}
	temporaryID := "create:" + toolUseID
	task := plan.Tasks[temporaryID]
	if task == nil {
		provider.mu.Unlock()
		return
	}
	resultMap := mapValue(result)
	assignedID := firstNonEmpty(
		stringValue(mapValue(resultMap["task"])["id"]), stringValue(resultMap["taskId"]), stringValue(resultMap["id"]),
	)
	if assignedID == "" {
		match := regexp.MustCompile(`(?i)(?:task\s*)?(?:id)?[:#\s]+([\w-]+)`).FindStringSubmatch(text)
		if len(match) > 1 {
			assignedID = match[1]
		}
	}
	if assignedID != "" && assignedID != temporaryID {
		delete(plan.Tasks, temporaryID)
		task.ID = assignedID
		plan.Tasks[assignedID] = task
		for index, id := range plan.Order {
			if id == temporaryID {
				plan.Order[index] = assignedID
			}
		}
	}
	provider.mu.Unlock()
	provider.publishTaskPlan(turnID)
}

func (provider *ClaudeProvider) publishTaskPlan(turnID string) {
	provider.mu.Lock()
	plan := provider.taskPlans[turnID]
	if plan == nil {
		provider.mu.Unlock()
		return
	}
	steps := []any{}
	for _, id := range plan.Order {
		task := plan.Tasks[id]
		if task == nil || task.Status == "removed" {
			continue
		}
		steps = append(steps, map[string]any{
			"id": task.ID, "step": task.Step, "activeForm": task.ActiveForm,
			"status": task.Status, "blockedBy": task.BlockedBy,
		})
	}
	messageID := plan.MessageID
	provider.mu.Unlock()
	patch := map[string]any{
		"kind": "task-plan", "provider": "claude", "turnId": nilIfEmpty(turnID),
		"plan": steps, "planTurnStatus": "running", "explanation": "Claude task progress",
	}
	if messageID != "" {
		provider.session.patchMessage(messageID, patch)
		return
	}
	created := provider.session.appendMessage(patch)
	if created == nil {
		return
	}
	provider.mu.Lock()
	if current := provider.taskPlans[turnID]; current == plan && current.MessageID == "" {
		current.MessageID = stringValue(created["id"])
	}
	provider.mu.Unlock()
}

func (provider *ClaudeProvider) finishTaskPlan(turnID, status string) {
	provider.mu.Lock()
	plan := provider.taskPlans[turnID]
	if plan != nil {
		delete(provider.taskPlans, turnID)
	}
	provider.mu.Unlock()
	if plan != nil && plan.MessageID != "" {
		provider.session.patchMessage(plan.MessageID, map[string]any{"planTurnStatus": status})
	}
}
