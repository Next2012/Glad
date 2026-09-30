package app

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

func (server *Server) roomWebsocket(writer http.ResponseWriter, request *http.Request) {
	id := request.URL.Query().Get("roomId")
	if id != "" && !server.rooms.IsActive(id) {
		http.Error(writer, "Invalid group ID", 404)
		return
	}
	connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{OriginPatterns: []string{request.Host}})
	if err != nil {
		return
	}
	subscription := server.rooms.events.Subscribe(id, 256)
	ctx, cancel := context.WithCancel(request.Context())
	defer func() { cancel(); subscription.Close(); _ = connection.Close(websocket.StatusNormalClosure, "") }()
	// Read continuously so control frames and disconnects are processed.
	go func() {
		defer cancel()
		for {
			if _, _, err := connection.Read(ctx); err != nil {
				return
			}
		}
	}()
	send := func() error {
		payload := map[string]any{"type": "room-list"}
		if id == "" {
			rooms, err := server.rooms.List()
			if err != nil {
				return err
			}
			payload["rooms"] = rooms
		} else {
			if !server.rooms.IsActive(id) {
				return errRoomNotFound
			}
			room, err := server.rooms.GetPublic(id)
			if err != nil {
				return err
			}
			payload["type"], payload["room"] = "room-snapshot", room
			items, err := server.rooms.TimedInputs(id)
			if err == nil {
				payload["timedInputs"] = items
			}
		}
		writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
		defer writeCancel()
		return writeWSJSON(writeCtx, connection, payload)
	}
	if send() != nil {
		return
	}
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()
	throttle := time.NewTicker(40 * time.Millisecond)
	defer throttle.Stop()
	dirty := false
	for {
		select {
		case <-subscription.Events():
			dirty = true
		case <-throttle.C:
			if dirty {
				dirty = false
				if send() != nil {
					return
				}
			}
		case <-keepalive.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
			err := connection.Ping(pingCtx)
			pingCancel()
			if err != nil {
				return
			}
		case <-subscription.Done():
			return
		case <-ctx.Done():
			return
		}
	}
}
