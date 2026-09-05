package app

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
)

func (server *Server) listTimedInputs(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	session.mu.RLock()
	items := []*TimedInput{}
	for _, item := range session.TimedInputs {
		copy := *item
		copy.Timer = nil
		items = append(items, &copy)
	}
	session.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].SendAt < items[j].SendAt })
	respondJSON(writer, 200, map[string]any{"success": true, "items": items})
}
func (server *Server) createTimedInput(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	var input map[string]any
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	item, err := scheduleTimed(session, "", input)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "item": item})
}
func (server *Server) updateTimedInput(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	var input map[string]any
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	item, err := scheduleTimed(session, request.PathValue("inputId"), input)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "item": item})
}
func (server *Server) deleteTimedInput(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	session.mu.Lock()
	item := session.TimedInputs[request.PathValue("inputId")]
	if item != nil {
		if item.Timer != nil {
			item.Timer.Stop()
		}
		delete(session.TimedInputs, item.ID)
	}
	session.mu.Unlock()
	if item == nil {
		notFound(writer, "Timed input not found")
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}
func scheduleTimed(session *Session, id string, input map[string]any) (*TimedInput, error) {
	text := stringValue(input["text"])
	sendAt := numberInt64(input["sendAt"])
	delay := time.Until(time.UnixMilli(sendAt))
	if strings.TrimSpace(text) == "" {
		return nil, errors.New("Text is required")
	}
	if delay <= 0 {
		return nil, errors.New("Send time must be in the future")
	}
	if delay > 30*24*time.Hour {
		return nil, errors.New("Send time must be within 30 days")
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil, errors.New("Session is closed")
	}
	item := session.TimedInputs[id]
	if id != "" && item == nil {
		session.mu.Unlock()
		return nil, errors.New("Timed input not found")
	}
	if item == nil {
		item = &TimedInput{ID: newUUID(), CreatedAt: millis(), Status: "pending"}
	} else {
		if item.Timer != nil {
			item.Timer.Stop()
		}
	}
	item.Text = text
	item.SendAt = sendAt
	item.Status = "pending"
	item.Error = ""
	revision := newUUID()
	item.revision = revision
	item.Timer = time.AfterFunc(delay, func() {
		sendCtx, cancel := context.WithTimeout(session.ctx, 60*time.Second)
		defer cancel()
		err := session.Provider.Send(
			sendCtx,
			ProviderInput{ClientMessageID: "timed-" + item.ID + "-" + revision, Text: text, AgentText: text},
		)
		session.mu.Lock()
		current := session.TimedInputs[item.ID]
		if current == item && item.revision == revision {
			item.Timer = nil
			if err == nil {
				delete(session.TimedInputs, item.ID)
			} else {
				item.Status = "failed"
				item.Error = err.Error()
			}
		}
		session.mu.Unlock()
		if err != nil {
			session.appendMessage(
				map[string]any{
					"kind": "event", "level": "error",
					"text": "Scheduled message failed: " + err.Error(),
				},
			)
		}
	})
	session.TimedInputs[item.ID] = item
	copy := *item
	copy.Timer = nil
	session.mu.Unlock()
	return &copy, nil
}
