package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type integrationSteeringProvider struct {
	inputs []ProviderInput
	steers []ProviderInput
}

func (*integrationSteeringProvider) Start(context.Context) error { return nil }
func (*integrationSteeringProvider) Close(context.Context) error { return nil }
func (p *integrationSteeringProvider) Send(_ context.Context, input ProviderInput) error {
	p.inputs = append(p.inputs, input)
	return nil
}
func (p *integrationSteeringProvider) Steer(_ context.Context, input ProviderInput, _ string) error {
	p.steers = append(p.steers, input)
	return nil
}
func (*integrationSteeringProvider) CanSteer() (bool, string) { return true, "" }

func integrationProviderSession(t *testing.T) (*Server, *Session, *integrationSteeringProvider) {
	t.Helper()
	manager := NewSessionManager(t.TempDir())
	session := newSession("agy-integration", "", "antigravity-structured", ToolInfo{Key: "antigravity"}, manager.baseDir)
	provider := &integrationSteeringProvider{}
	session.Provider = provider
	manager.sessions[session.ID] = session
	t.Cleanup(session.cancel)
	return &Server{sessions: manager, attachments: NewAttachmentStore()}, session, provider
}

func TestStructuredProviderIdentityAndTransport(t *testing.T) {
	for _, key := range []string{"codex", "claude", "antigravity"} {
		if got := structuredMessageType(key+"-structured", "snapshot"); got != key+"-snapshot" {
			t.Fatalf("wrong provider envelope: %s", got)
		}
	}
	_, session, _ := integrationProviderSession(t)
	session.State["antigravitySessionId"] = "native-agy"
	if got := sessionNativeConversationID(session); got != "native-agy" {
		t.Fatalf("lost Antigravity identity: %q", got)
	}
	if got := session.speedConversationLocked(); got != "native-agy" {
		t.Fatalf("speed identity differs: %q", got)
	}
	settings := workbenchSessionSettings(map[string]any{"model": "base-model", "mode": "auto", "usage": "private"})
	if settings["mode"] != "auto" || settings["usage"] != nil {
		t.Fatalf("invalid persisted settings: %#v", settings)
	}
}

func TestStructuredHTTPRunningInputDispatch(t *testing.T) {
	server, session, provider := integrationProviderSession(t)
	session.StatusValue = "running"
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"text":"Focus on tests","clientMessageId":"http-steer","delivery":"steer","expectedTurnId":"turn-1"}`))
	request.SetPathValue("id", session.ID)
	writer := httptest.NewRecorder()
	server.sendSessionInput(writer, request)
	if writer.Code != http.StatusAccepted || len(provider.inputs) != 0 || len(provider.steers) != 1 {
		t.Fatalf("steering routed incorrectly: status=%d body=%s", writer.Code, writer.Body.String())
	}
	if provider.steers[0].ExpectedTurnID != "turn-1" {
		t.Fatal("expected turn ID was lost")
	}
}

func TestStructuredWebSocketSteeringAndDedup(t *testing.T) {
	server, session, provider := integrationProviderSession(t)
	session.StatusValue = "running"
	var results []map[string]any
	send := func(value map[string]any) bool { results = append(results, value); return true }
	payload := map[string]any{"type": "antigravity-input", "text": "More detail", "clientMessageId": "ws-steer", "delivery": "steer", "expectedTurnId": "turn-2"}
	server.handleWebsocketMessage(context.Background(), session, send, payload)
	server.handleWebsocketMessage(context.Background(), session, send, payload)
	if len(provider.steers) != 1 || len(results) != 2 || results[1]["accepted"] != true {
		t.Fatalf("duplicate instruction executed: steers=%d results=%#v", len(provider.steers), results)
	}
	payload["text"] = "Different content"
	server.handleWebsocketMessage(context.Background(), session, send, payload)
	if len(provider.steers) != 1 || results[len(results)-1]["accepted"] != false {
		t.Fatal("reused message ID accepted different content")
	}
	payload["type"] = "claude-input"
	payload["clientMessageId"] = "wrong-provider"
	server.handleWebsocketMessage(context.Background(), session, send, payload)
	if len(provider.steers) != 1 || results[len(results)-1]["accepted"] != false {
		t.Fatal("Antigravity input accepted a Claude transport envelope")
	}
	payload["type"] = "antigravity-input"
	payload["clientMessageId"] = "malformed-delivery"
	payload["delivery"] = 123
	delete(payload, "expectedTurnId")
	server.handleWebsocketMessage(context.Background(), session, send, payload)
	if len(provider.steers) != 1 || len(provider.inputs) != 0 || results[len(results)-1]["accepted"] != false {
		t.Fatal("malformed steering fell through to a new turn")
	}
}

func TestAntigravityLazyDetailsAndWorkspaceModes(t *testing.T) {
	message := map[string]any{"kind": "tool", "input": map[string]any{"command": "private command"}, "result": "large output", "updatedAt": int64(5)}
	public := publicMessage(message, "antigravity-structured")
	if public["input"] != nil || public["result"] != nil || public["hasDetail"] != true || message["result"] == nil {
		t.Fatalf("tool detail leaked or original was mutated: %#v", public)
	}
	for _, mode := range []string{"default", "accept-edits", "auto", "plan"} {
		if !workbenchPayloadAllowed(map[string]any{"type": "antigravity-settings", "settings": map[string]any{"mode": mode}}) {
			t.Fatalf("workbench rejected native mode %q", mode)
		}
	}
	if workbenchSettingsAllowed(map[string]any{"mode": "unknown"}) {
		t.Fatal("workbench accepted invalid native mode")
	}
}

func TestAntigravityBootstrapAndAutoStartValidation(t *testing.T) {
	server, session, provider := integrationProviderSession(t)
	bootstrap := sessionBootstrapInput(session)
	if !bootstrap.Internal || bootstrap.Text != "" || bootstrap.AgentText == "" {
		t.Fatalf("invalid Antigravity bootstrap: %#v", bootstrap)
	}
	for _, body := range []string{
		`{"autoStart":true,"delivery":"other"}`,
		`{"autoStart":true,"expectedTurnId":"old-turn"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		request.SetPathValue("id", session.ID)
		writer := httptest.NewRecorder()
		server.sendSessionInput(writer, request)
		if writer.Code != http.StatusBadRequest || len(provider.inputs) != 0 {
			t.Fatalf("invalid autoStart accepted: %d", writer.Code)
		}
	}
}

func TestAntigravityGroupDispatchAndHistoryIdentity(t *testing.T) {
	p := antigravityFixture(t)
	sessions := NewSessionManager(p.session.WorkingDirectory)
	p.session.mu.Lock()
	p.session.events = sessions.events
	p.session.turnIndexes = sessions.turnIndexes
	p.session.mu.Unlock()
	sessions.sessions[p.session.ID] = p.session
	store, err := OpenRoomStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rooms := NewRoomManager(store, sessions, NewAttachmentStore())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rooms.Start(ctx)
	room, err := rooms.Create("Antigravity group")
	if err != nil {
		t.Fatal(err)
	}
	member, err := rooms.AddSession(room.ID, p.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	native := member.NativeConversationID
	if native == "" {
		t.Fatal("group member lost native Antigravity identity")
	}
	if _, err := rooms.PostMessage(ctx, room.ID, RoomMessageInput{ClientMessageID: newUUID(), Text: "Review grouped Antigravity work", MentionedMemberIDs: []string{member.ID}}); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 5*time.Second, func() bool { return antigravityIdle(p) && antigravityKindCount(p, "assistant") > 0 })
	assertVisible := func() {
		t.Helper()
		view, err := rooms.GetPublic(room.ID)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(view)
		if err != nil || !strings.Contains(string(encoded), "AGY fixture reply:") {
			t.Fatalf("group lost projected native reply: %s, %v", encoded, err)
		}
	}
	assertVisible()
	if err := p.Resume(ctx, native); err != nil {
		t.Fatal(err)
	}
	assertVisible()
	turns, _, err := conversationTurns(ctx, p.session)
	if err != nil || len(turns) == 0 {
		t.Fatalf("authorized normalized turn history unavailable: %v", err)
	}
}
