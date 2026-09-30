package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	sessioncore "glad-web/internal/session"
)

type roomRuntimeProvider struct {
	stubProvider
	calls      atomic.Int32
	interrupts atomic.Int32
	entered    chan struct{}
	release    chan struct{}
}

func (provider *roomRuntimeProvider) Send(ctx context.Context, _ ProviderInput) error {
	provider.calls.Add(1)
	if provider.entered != nil {
		select {
		case provider.entered <- struct{}{}:
		default:
		}
	}
	if provider.release != nil {
		select {
		case <-provider.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return provider.sendErr
}
func (provider *roomRuntimeProvider) Interrupt(context.Context) error {
	provider.interrupts.Add(1)
	return nil
}

func newRuntimeRoomTest(t *testing.T) (*RoomManager, *Session, *roomRuntimeProvider, RoomRecord, RoomMemberRecord) {
	t.Helper()
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(directory)
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	session := newSession(newUUID(), "Member", "codex-structured", ToolInfo{Key: "codex"}, directory)
	provider := &roomRuntimeProvider{}
	session.Provider, session.events = provider, sessions.Events()
	sessions.sessions[session.ID] = session
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	room, err := manager.Create("Group")
	if err != nil {
		t.Fatal(err)
	}
	member, err := manager.AddSession(room.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Stop)
	return manager, session, provider, room, member
}

func TestRoomMessageRetryIsAcceptedOnceEvenWhileDispatchIsPending(t *testing.T) {
	manager, _, provider, room, member := newRuntimeRoomTest(t)
	provider.entered, provider.release = make(chan struct{}, 1), make(chan struct{})
	input := RoomMessageInput{ClientMessageID: "retry-once", Text: "hello", MentionedMemberIDs: []string{member.ID}}
	var wait sync.WaitGroup
	wait.Add(1)
	firstErr := make(chan error, 1)
	go func() {
		defer wait.Done()
		_, err := manager.PostMessage(context.Background(), room.ID, input)
		firstErr <- err
	}()
	select {
	case <-provider.entered:
	case <-time.After(time.Second):
		t.Fatal("dispatch never started")
	}
	if _, err := manager.PostMessage(context.Background(), room.ID, input); err != nil {
		t.Fatal(err)
	}
	if provider.calls.Load() != 1 {
		t.Fatal("duplicate request dispatched another turn")
	}
	input.Text = "different content"
	if _, err := manager.PostMessage(context.Background(), room.ID, input); err == nil {
		t.Fatal("reused message ID accepted different content")
	}
	close(provider.release)
	wait.Wait()
	if err := <-firstErr; err != nil {
		t.Fatal(err)
	}
	// The persisted acceptance also survives a daemon restart.
	restarted := NewRoomManager(manager.store, manager.sessions, NewAttachmentStore())
	if _, err := restarted.PostMessage(context.Background(), room.ID, RoomMessageInput{ClientMessageID: "retry-once", Text: "hello", MentionedMemberIDs: []string{member.ID}}); err != nil {
		t.Fatal(err)
	}
	saved, err := manager.GetRecord(room.ID)
	if err != nil || len(saved.Entries) != 2 || provider.calls.Load() != 1 {
		t.Fatalf("retry duplicated entries or work: %#v, %v", saved, err)
	}
}

func TestRoomCompletionAcknowledgementsDoNotEraseNewerOrChildTurns(t *testing.T) {
	manager, session, _, room, _ := newRuntimeRoomTest(t)
	publish := func(id string, root bool) {
		manager.sessionEvent(sessioncore.Event{SessionID: session.ID, Payload: map[string]any{"type": "message", "message": map[string]any{"kind": "turn-end", "turnId": id, "isRootTurn": root}}})
	}
	publish("child", false)
	publish("first", true)
	publish("first", true)
	publish("second", true)
	if err := manager.MarkRead(room.ID, 1); err != nil {
		t.Fatal(err)
	}
	view, _ := manager.GetPublic(room.ID)
	if view["completionRevision"] != uint64(2) || !boolValue(view["hasUnreadCompletion"]) {
		t.Fatalf("old acknowledgement erased a new completion: %#v", view)
	}
	if err := manager.MarkRead(room.ID, 2); err != nil {
		t.Fatal(err)
	}
	view, _ = manager.GetPublic(room.ID)
	if boolValue(view["hasUnreadCompletion"]) {
		t.Fatal("visible completion was not acknowledged")
	}
}

func TestRoomAbortCancelsRecoveryAndStopsTrackedSessions(t *testing.T) {
	manager, session, provider, room, _ := newRuntimeRoomTest(t)
	operationCtx, end, err := manager.beginLifecycle(context.Background(), room.ID, "resume")
	if err != nil {
		t.Fatal(err)
	}
	manager.trackOperationSession(room.ID, session.ID)
	view, _ := manager.GetPublic(room.ID)
	if !boolValue(view["resuming"]) || !boolValue(view["canAbort"]) {
		t.Fatal("recovery has no stop state")
	}
	if _, err := manager.Abort(context.Background(), room.ID); err != nil {
		t.Fatal(err)
	}
	if operationCtx.Err() != context.Canceled || provider.interrupts.Load() != 1 {
		t.Fatal("recovery was not cancelled and interrupted")
	}
	end()
	view, _ = manager.GetPublic(room.ID)
	if boolValue(view["resuming"]) || boolValue(view["aborting"]) {
		t.Fatal("recovery state was left busy")
	}
	session.setState(map[string]any{"status": "running"})
	if _, err := manager.Abort(context.Background(), room.ID); err != nil {
		t.Fatal(err)
	}
	if provider.interrupts.Load() != 2 {
		t.Fatal("ordinary group stop did not interrupt the running member")
	}
}

func TestRoomTimerUpdatesDeletionAndClosingPreventObsoleteDispatch(t *testing.T) {
	manager, _, provider, room, member := newRuntimeRoomTest(t)
	message := RoomMessageInput{Text: "first", MentionedMemberIDs: []string{member.ID}}
	first, err := manager.Schedule(room.ID, "", message, time.Now().Add(time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	message.Text = "updated"
	updated, err := manager.Schedule(room.ID, first.ID, message, time.Now().Add(2*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	manager.fireTimed(room.ID, first.ID, first.revision)
	if provider.calls.Load() != 0 {
		t.Fatal("old timer revision sent after edit")
	}
	manager.fireTimed(room.ID, updated.ID, updated.revision)
	if provider.calls.Load() != 1 {
		t.Fatal("updated timer did not dispatch")
	}
	if items, _ := manager.TimedInputs(room.ID); len(items) != 0 {
		t.Fatal("sent timer was not removed")
	}
	removed, _ := manager.Schedule(room.ID, "", message, time.Now().Add(time.Hour).UnixMilli())
	if err := manager.DeleteTimed(room.ID, removed.ID); err != nil {
		t.Fatal(err)
	}
	manager.fireTimed(room.ID, removed.ID, removed.revision)
	if provider.calls.Load() != 1 {
		t.Fatal("deleted timer fired")
	}
	remaining, _ := manager.Schedule(room.ID, "", message, time.Now().Add(time.Hour).UnixMilli())
	if err := manager.Close(room.ID); err != nil {
		t.Fatal(err)
	}
	manager.fireTimed(room.ID, remaining.ID, remaining.revision)
	if provider.calls.Load() != 1 {
		t.Fatal("closed group timer fired")
	}
}

func TestRoomTimerRetainsFailedMessagesForRetry(t *testing.T) {
	manager, _, _, room, _ := newRuntimeRoomTest(t)
	item, err := manager.Schedule(room.ID, "", RoomMessageInput{Text: "keep this", MentionedMemberIDs: []string{"missing-member"}}, time.Now().Add(time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	manager.fireTimed(room.ID, item.ID, item.revision)
	items, err := manager.TimedInputs(room.ID)
	if err != nil || len(items) != 1 || items[0].Status != "failed" || items[0].Error == "" || items[0].Text != "keep this" {
		t.Fatalf("failed timer lost its message: %#v, %v", items, err)
	}
}

func TestRoomTimerRetainsProviderRejectedMessages(t *testing.T) {
	manager, session, provider, room, member := newRuntimeRoomTest(t)
	provider.sendErr = errors.New("provider rejected scheduled input")
	item, err := manager.Schedule(room.ID, "", RoomMessageInput{Text: "keep rejected input", MentionedMemberIDs: []string{member.ID}}, time.Now().Add(time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	manager.fireTimed(room.ID, item.ID, item.revision)
	items, err := manager.TimedInputs(room.ID)
	if err != nil || len(items) != 1 || items[0].Status != "failed" || !strings.Contains(items[0].Error, "provider rejected") {
		t.Fatalf("provider failure was not retained: %#v, %v", items, err)
	}
	if failure := manager.RequestDispatchFailure(room.ID, "timed-"+item.ID+"-"+item.revision); !strings.Contains(failure, "provider rejected") {
		t.Fatalf("rejected send was reported as accepted: %q", failure)
	}
	manager.finishSessionTurn(session.ID, "later-unrelated-turn", map[string]any{"status": "completed"})
	saved, _ := manager.GetRecord(room.ID)
	if saved.Entries[1].Status != "failed" {
		t.Fatal("a later completion rewrote an earlier rejected dispatch")
	}
}

func TestRoomHistoryPagesSortMetadataWithoutProjectingTranscripts(t *testing.T) {
	manager, _, _, room, _ := newRuntimeRoomTest(t)
	for i := 0; i < 25; i++ {
		saved := RoomRecord{ID: newUUID(), Name: "History", SchemaVersion: currentRoomSchemaVersion, CreatedAt: int64(i + 1), UpdatedAt: int64(100 - i)}
		if err := manager.store.Save(saved); err != nil {
			t.Fatal(err)
		}
	}
	page, err := manager.HistoryPage("created_at", "History", 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	items := page["items"].([]map[string]any)
	if len(items) != 20 || !boolValue(page["hasMore"]) || items[0]["createdAt"] != int64(25) {
		t.Fatalf("first page is invalid: %#v", page)
	}
	next, _ := manager.HistoryPage("created_at", "History", 20, 20)
	if len(next["items"].([]map[string]any)) != 5 || boolValue(next["hasMore"]) {
		t.Fatalf("last page is invalid: %#v", next)
	}
	updated, _ := manager.HistoryPage("updated_at", "History", 0, 20)
	if updated["items"].([]map[string]any)[0]["updatedAt"] != int64(100) {
		t.Fatal("history sort ignored updated timestamps")
	}
	if _, err := manager.HistoryPage("invalid", "", 0, 20); err == nil {
		t.Fatal("invalid sort was accepted")
	}
	if !manager.IsActive(room.ID) {
		t.Fatal("history reads changed active group")
	}
}

func TestRoomWebsocketPushesMemberStateWithoutPolling(t *testing.T) {
	manager, session, _, room, _ := newRuntimeRoomTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager.Start(ctx)
	server := &Server{rooms: manager, sessions: manager.sessions}
	mux := http.NewServeMux()
	server.registerRoomRoutes(mux)
	httpServer := httptest.NewServer(mux)
	defer httpServer.Close()
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/ws/rooms?roomId="+room.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	read := func() map[string]any {
		t.Helper()
		readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
		defer readCancel()
		_, data, err := connection.Read(readCtx)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(data, &payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	first := read()
	if first["type"] != "room-snapshot" || mapValue(first["room"])["id"] != room.ID {
		t.Fatal("missing initial group snapshot")
	}
	session.setState(map[string]any{"status": "running"})
	next := read()
	if mapValue(next["room"])["status"] != "running" {
		t.Fatalf("member state was not pushed: %#v", next)
	}
}
