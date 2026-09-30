package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

type roomTimedInput struct {
	TimedInput
	Message RoomMessageInput `json:"message"`
}

func (manager *RoomManager) TimedInputs(id string) ([]roomTimedInput, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	runtime := manager.runtimeLocked(id)
	if runtime == nil {
		return nil, errRoomNotFound
	}
	items := []roomTimedInput{}
	for _, item := range runtime.timers {
		copy := *item
		copy.Timer = nil
		items = append(items, copy)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].SendAt < items[j].SendAt })
	return items, nil
}

func (manager *RoomManager) Schedule(id, inputID string, message RoomMessageInput, sendAt int64) (roomTimedInput, error) {
	delay := time.Until(time.UnixMilli(sendAt))
	if strings.TrimSpace(message.Text) == "" || len(message.Text) > maxRoomMessageBytes {
		return roomTimedInput{}, errors.New("Message text is required and must fit the group message limit")
	}
	if delay <= 0 || delay > 30*24*time.Hour {
		return roomTimedInput{}, errors.New("Send time must be in the future and within 30 days")
	}
	if len(message.Attachments) > 0 {
		return roomTimedInput{}, errors.New("Scheduled messages support text and references; send attachments immediately")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	runtime := manager.runtimeLocked(id)
	if runtime == nil {
		return roomTimedInput{}, errRoomNotFound
	}
	item := runtime.timers[inputID]
	if inputID != "" && item == nil {
		return roomTimedInput{}, errors.New("Timed input not found")
	}
	if item != nil && item.Status == "sending" {
		return roomTimedInput{}, errors.New("Scheduled message is already being sent")
	}
	if item == nil {
		item = &roomTimedInput{TimedInput: TimedInput{ID: newUUID(), CreatedAt: millis()}}
	}
	if item.Timer != nil {
		item.Timer.Stop()
	}
	item.Text, item.SendAt, item.Message, item.Status, item.Error = message.Text, sendAt, message, "pending", ""
	item.revision = newUUID()
	timerID, revision := item.ID, item.revision
	runtime.timers[timerID] = item
	item.Timer = time.AfterFunc(delay, func() { manager.fireTimed(id, timerID, revision) })
	copy := *item
	copy.Timer = nil
	manager.publishLocked(id)
	return copy, nil
}

func (manager *RoomManager) DeleteTimed(id, inputID string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	runtime := manager.runtimeLocked(id)
	if runtime == nil {
		return errRoomNotFound
	}
	item := runtime.timers[inputID]
	if item == nil {
		return errors.New("Timed input not found")
	}
	if item.Status == "sending" {
		return errors.New("Scheduled message is already being sent")
	}
	if item.Timer != nil {
		item.Timer.Stop()
	}
	delete(runtime.timers, inputID)
	manager.publishLocked(id)
	return nil
}

func (manager *RoomManager) fireTimed(id, inputID, revision string) {
	unlock := manager.lockOperation(id)
	defer unlock()
	manager.mu.Lock()
	runtime := manager.runtimeLocked(id)
	if runtime == nil {
		manager.mu.Unlock()
		return
	}
	item := runtime.timers[inputID]
	if item == nil || item.revision != revision || runtime.ctx.Err() != nil {
		manager.mu.Unlock()
		return
	}
	message := item.Message
	message.ClientMessageID = "timed-" + inputID + "-" + revision
	if item.Timer != nil {
		item.Timer.Stop()
	}
	item.Status, item.Timer = "sending", nil
	ctx, cancel := context.WithTimeout(runtime.ctx, 90*time.Second)
	manager.publishLocked(id)
	manager.mu.Unlock()
	_, err := manager.PostMessage(ctx, id, message)
	cancel()
	if err == nil {
		saved, readErr := manager.GetRecord(id)
		if readErr != nil {
			err = readErr
		} else {
			found := false
			for _, entry := range saved.Entries {
				if entry.Type == "user" {
					if found {
						break
					}
					found = entry.ClientMessageID == message.ClientMessageID
				} else if found && entry.Status == "failed" {
					err = fmt.Errorf("Scheduled member dispatch failed: %s", entry.Error)
					break
				}
			}
		}
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if runtime.timers[inputID] != item || item.revision != revision {
		return
	}
	if err == nil {
		delete(runtime.timers, inputID)
	} else {
		item.Status, item.Error = "failed", err.Error()
	}
	manager.publishLocked(id)
}

func (server *Server) roomTimedInputs(writer http.ResponseWriter, request *http.Request) {
	id, inputID := request.PathValue("id"), request.PathValue("inputId")
	if request.Method == http.MethodGet {
		items, err := server.rooms.TimedInputs(id)
		if err != nil {
			server.writeRoomError(writer, err)
			return
		}
		respondJSON(writer, 200, map[string]any{"success": true, "items": items})
		return
	}
	if request.Method == http.MethodDelete {
		if err := server.rooms.DeleteTimed(id, inputID); err != nil {
			server.writeRoomError(writer, err)
			return
		}
		respondJSON(writer, 200, map[string]any{"success": true})
		return
	}
	var input struct {
		RoomMessageInput
		SendAt int64 `json:"sendAt"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	item, err := server.rooms.Schedule(id, inputID, input.RoomMessageInput, input.SendAt)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "item": item})
}
