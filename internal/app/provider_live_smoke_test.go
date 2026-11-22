package app

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Opt-in only: exercises the installed, authenticated CLI. Normal test runs
// never submit model requests or depend on the developer's account.
func TestLiveAntigravitySteeringAndResume(t *testing.T) {
	if os.Getenv("GLAD_LIVE_ANTIGRAVITY") != "1" {
		t.Skip("set GLAD_LIVE_ANTIGRAVITY=1 for the installed CLI smoke test")
	}
	command, err := exec.LookPath("agy")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	session := newSession(newUUID(), "Glad ACP verification", "antigravity-structured", ToolInfo{Key: "antigravity", Command: command}, t.TempDir())
	defer session.cancel()
	speedStore, err := openSpeedStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session.speed = &SpeedTracker{session: session, store: speedStore}
	usageDirectory := t.TempDir()
	session.antigravityUsage, err = openAntigravityUsageStore(usageDirectory)
	if err != nil {
		t.Fatal(err)
	}
	provider := NewAntigravityProvider(session, map[string]any{"model": "gemini-3.8-flash", "effort": "high"})
	session.Provider = provider
	defer provider.Close(context.Background())
	if err := provider.Start(ctx); err != nil {
		t.Fatal(err)
	}
	input := ProviderInput{ClientMessageID: newUUID(), Text: "Adapter verification only. Do not use tools, files, network, subagents or commands. Write the numbers 1 through 600, one number per line."}
	input.AgentText = input.Text
	if err := sendSessionControlled(ctx, session, input); err != nil {
		t.Fatal(err)
	}
	var turn, native string
	for ctx.Err() == nil {
		session.mu.RLock()
		streamed := false
		for _, message := range session.Messages {
			if message["kind"] == "assistant" && strings.TrimSpace(stringValue(message["text"])) != "" {
				streamed = true
			}
		}
		turn, native = stringValue(session.State["turnId"]), sessionNativeConversationID(session)
		canSteer := boolValue(session.State["canSteer"])
		session.mu.RUnlock()
		if turn != "" && canSteer && streamed {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if ctx.Err() != nil {
		t.Fatal("no live streamed turn available for steering")
	}
	steer := ProviderInput{ClientMessageID: newUUID(), Delivery: "steer", ExpectedTurnID: turn, Text: "Stop counting now. Reply with exactly GLAD_STEERING_VERIFIED and then end your turn."}
	steer.AgentText = steer.Text
	if err := sendSessionControlled(ctx, session, steer); err != nil {
		t.Fatal(err)
	}
	for ctx.Err() == nil {
		session.mu.RLock()
		idle := session.StatusValue == "idle"
		session.mu.RUnlock()
		if idle {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if ctx.Err() != nil {
		_ = provider.Interrupt(context.Background())
		t.Fatal("live turn did not finish")
	}
	session.mu.RLock()
	starts, ends, users := 0, 0, 0
	verified := false
	for _, message := range session.Messages {
		switch message["kind"] {
		case "turn-start":
			starts++
		case "turn-end":
			ends++
		case "user":
			users++
		case "assistant":
			verified = verified || strings.Contains(stringValue(message["text"]), "GLAD_STEERING_VERIFIED")
		}
	}
	session.mu.RUnlock()
	if starts != 1 || ends != 1 || users != 2 || !verified {
		t.Fatalf("live steering lifecycle: starts=%d ends=%d users=%d verified=%v", starts, ends, users, verified)
	}
	sample := speedStore.last("antigravity", native)
	if sample == nil || sample.Rate == nil || sample.OutputTokens == nil || *sample.OutputTokens <= 0 || !antigravityUsageKnown(*sample) {
		t.Fatalf("native steering did not produce complete token/speed accounting: %#v", sample)
	}
	ledger, err := openAntigravityUsageStore(usageDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if rows := ledger.snapshot(); len(rows) != 1 || *rows[0].OutputTokens != *sample.OutputTokens {
		t.Fatalf("native usage was not persisted once: %#v", rows)
	}
	t.Logf("native final usage: input=%d cached=%d output=%d, effective speed=%.1f tok/s", *sample.InputTokens, *sample.CachedInputTokens, *sample.OutputTokens, *sample.Rate)
	if err := provider.Resume(ctx, native); err != nil {
		t.Fatalf("native history loading: %v", err)
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	if sessionNativeConversationID(session) != native || len(session.Messages) < 2 {
		t.Fatal("native conversation or history was lost after reload")
	}
	t.Logf("native streaming, current-turn steering, single lifecycle and history reload verified (%d replay messages)", len(session.Messages))
}

func TestLiveCodexSteering(t *testing.T) {
	if os.Getenv("GLAD_LIVE_CODEX") != "1" {
		t.Skip("set GLAD_LIVE_CODEX=1 for the installed CLI smoke test")
	}
	command, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	session := newSession(newUUID(), "Glad Codex verification", "codex-structured", ToolInfo{Key: "codex", Command: command}, t.TempDir())
	defer session.cancel()
	provider := NewCodexProvider(session, map[string]any{"sandboxMode": "read-only", "permissionMode": "never"})
	session.Provider = provider
	defer provider.Close(context.Background())
	if err := provider.Start(ctx); err != nil {
		t.Fatal(err)
	}
	provider.titles.mu.Lock()
	provider.titles.enabled = false
	provider.titles.mu.Unlock()
	text := "Adapter verification only. Do not use tools, files, network, subagents or commands. Write numbers 1 through 1000, one number per line."
	if err := sendSessionControlled(ctx, session, ProviderInput{ClientMessageID: newUUID(), Text: text, AgentText: text}); err != nil {
		t.Fatal(err)
	}
	turn := ""
	for ctx.Err() == nil {
		session.mu.RLock()
		streamed := false
		for _, message := range session.Messages {
			streamed = streamed || message["kind"] == "assistant" && stringValue(message["text"]) != ""
		}
		turn = stringValue(session.State["turnId"])
		ready := boolValue(session.State["canSteer"])
		session.mu.RUnlock()
		if streamed && ready && turn != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if ctx.Err() != nil {
		t.Fatal("no live Codex streamed turn available for steering")
	}
	text = "Stop counting now. Reply with exactly GLAD_CODEX_STEERING_VERIFIED and end your turn."
	if err := sendSessionControlled(ctx, session, ProviderInput{ClientMessageID: newUUID(), Text: text, AgentText: text, Delivery: "steer", ExpectedTurnID: turn}); err != nil {
		t.Fatal(err)
	}
	for ctx.Err() == nil {
		ready, _ := provider.CanAccept()
		if ready {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if ctx.Err() != nil {
		_ = provider.Interrupt(context.Background())
		t.Fatal("live Codex turn did not finish")
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	starts, ends, verified := 0, 0, false
	for _, message := range session.Messages {
		if message["kind"] == "turn-start" {
			starts++
		}
		if message["kind"] == "turn-end" {
			ends++
		}
		if message["kind"] == "assistant" {
			verified = verified || strings.Contains(stringValue(message["text"]), "GLAD_CODEX_STEERING_VERIFIED")
		}
	}
	if starts != 1 || ends != 1 || !verified {
		t.Fatalf("live Codex lifecycle: starts=%d ends=%d verified=%v", starts, ends, verified)
	}
	t.Log("native Codex streaming, current-turn steering and single lifecycle verified")
}
