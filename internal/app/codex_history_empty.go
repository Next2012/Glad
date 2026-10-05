package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

// 空历史页只有在原线程也没有对话时才有效，不能用它清空已有历史。
func (provider *CodexProvider) validateEmptyCodexHistory(ctx context.Context, thread map[string]any) error {
	missing := errors.New("Codex 原对话的历史尚未加载，原对话保留，请重试恢复")
	provider.session.mu.RLock()
	hasMessages := false
	for _, message := range provider.session.Messages {
		kind := stringValue(message["kind"])
		if kind == "event" {
			continue
		}
		messageThread := firstNonEmpty(stringValue(message["threadId"]), stringValue(provider.session.State["threadId"]))
		if messageThread == stringValue(thread["id"]) {
			hasMessages = true
			break
		}
	}
	provider.session.mu.RUnlock()
	if hasMessages || strings.TrimSpace(stringValue(thread["preview"])) != "" {
		return missing
	}
	path := stringValue(thread["path"])
	if path == "" {
		return missing
	}
	file, err := os.Open(path)
	if err != nil {
		return missing
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return missing
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	matched := false
	scannedBytes, records := 0, 0
	for scanner.Scan() {
		scannedBytes += len(scanner.Bytes()) + 1
		records++
		if scannedBytes > 8<<20 || records > 8192 {
			return missing
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		var record struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if json.Unmarshal(scanner.Bytes(), &record) != nil || record.Type == "" {
			return missing
		}
		if record.Type == "session_meta" {
			if stringValue(record.Payload["id"]) != stringValue(thread["id"]) {
				return missing
			}
			matched = true
		}
		if record.Type == "turn_context" || (record.Type == "event_msg" && stringValue(record.Payload["type"]) == "task_started") {
			return missing
		}
		if record.Type == "response_item" && (stringValue(record.Payload["role"]) == "assistant" || codexRolloutUserAuthored(record.Payload)) {
			return missing
		}
	}
	if scanner.Err() != nil || !matched {
		return missing
	}
	return nil
}

// 历史数组包含坏条目时整体失败，避免空标记掩盖丢失的真实消息。
func validateCodexHistoryTurns(turns []any) error {
	for _, value := range turns {
		turn, ok := value.(map[string]any)
		if !ok || turn == nil {
			return errors.New("Codex 历史 turn 格式无效，原对话保留")
		}
		id, ok := turn["id"].(string)
		if !ok || strings.TrimSpace(id) == "" {
			return errors.New("Codex 历史 turn ID 无效，原对话保留")
		}
		items, ok := turn["items"].([]any)
		if !ok {
			return errors.New("Codex 历史 items 格式无效，原对话保留")
		}
		for _, value := range items {
			item, ok := value.(map[string]any)
			if !ok || item == nil {
				return errors.New("Codex 历史 item 格式无效，原对话保留")
			}
			itemID, idOK := item["id"].(string)
			itemType, typeOK := item["type"].(string)
			if !idOK || strings.TrimSpace(itemID) == "" || !typeOK || strings.TrimSpace(itemType) == "" {
				return errors.New("Codex 历史 item ID 或类型无效，原对话保留")
			}
		}
	}
	return nil
}

func codexHistoryHasVisibleItems(turns []any) bool {
	for _, value := range turns {
		for _, itemValue := range sliceValue(mapValue(value)["items"]) {
			if codexHistoryItem(mapValue(itemValue)) != nil {
				return true
			}
		}
	}
	return false
}
