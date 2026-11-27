package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func antigravityFixture(t *testing.T) *AntigravityProvider {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node is required for the ACP process fixture")
	}
	fixture, err := filepath.Abs("../../tests/e2e/fixtures/bin/agy")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fixture); err != nil {
		t.Fatal(err)
	}
	session := newSession(newUUID(), "AGY fixture", "antigravity-structured", ToolInfo{Key: "antigravity", Command: fixture}, t.TempDir())
	session.environment = []string{"ANTIGRAVITY_HOME=" + t.TempDir(), "HOME=" + t.TempDir()}
	provider := NewAntigravityProvider(session, nil)
	session.Provider = provider
	t.Cleanup(func() { session.cancel(); _ = provider.Close(context.Background()) })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := provider.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return provider
}
func antigravityWait(t *testing.T, timeout time.Duration, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for Antigravity fixture")
}
func antigravityMessages(p *AntigravityProvider) []map[string]any {
	p.session.mu.RLock()
	defer p.session.mu.RUnlock()
	messages := make([]map[string]any, len(p.session.Messages))
	for i, m := range p.session.Messages {
		messages[i] = cloneMap(m)
	}
	return messages
}
func antigravityKindCount(p *AntigravityProvider, kind string) int {
	count := 0
	for _, m := range antigravityMessages(p) {
		if m["kind"] == kind {
			count++
		}
	}
	return count
}
func antigravityIdle(p *AntigravityProvider) bool { ready, _ := p.CanAccept(); return ready }
func antigravitySend(t *testing.T, p *AntigravityProvider, text string) {
	t.Helper()
	if err := p.Send(context.Background(), ProviderInput{Text: text, AgentText: text, ClientMessageID: newUUID()}); err != nil {
		t.Fatal(err)
	}
}

func TestAntigravityInflightSteeringKeepsOneRootTurn(t *testing.T) {
	p := antigravityFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	start := time.Now()
	if err := p.Send(ctx, ProviderInput{Text: "agy-long", AgentText: "agy-long", ClientMessageID: "initial"}); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("Send waited for inference")
	}
	cancel()
	antigravityWait(t, time.Second, func() bool {
		for _, m := range antigravityMessages(p) {
			if strings.Contains(stringValue(m["text"]), "working before steering") {
				return true
			}
		}
		return false
	})
	p.mu.Lock()
	turn := p.turnID
	native := p.nativeID
	p.mu.Unlock()
	if allowed, _ := p.CanSteer(); !allowed {
		t.Fatal("in-flight prompt should accept steering")
	}
	if err := p.Steer(context.Background(), ProviderInput{Text: "redirect", AgentText: "redirect", ClientMessageID: "steering"}, "stale-turn"); err == nil {
		t.Fatal("accepted stale steering")
	}
	if err := p.Steer(context.Background(), ProviderInput{Text: "redirect", AgentText: "redirect", ClientMessageID: "steering"}, turn); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 3*time.Second, func() bool { return antigravityIdle(p) })
	if antigravityKindCount(p, "turn-start") != 1 || antigravityKindCount(p, "turn-end") != 1 {
		t.Fatal("steering split the root turn")
	}
	users := 0
	steered := false
	for _, m := range antigravityMessages(p) {
		if m["kind"] == "user" {
			users++
		}
		if strings.Contains(stringValue(m["text"]), "AGY steering accepted") {
			steered = true
		}
		if m["threadId"] != native || m["turnId"] != turn || m["isRootTurn"] != true {
			t.Fatalf("missing native/root identity: %#v", m)
		}
	}
	if users != 2 || !steered {
		t.Fatal("steering messages were not retained")
	}
	p.session.mu.RLock()
	revision := p.session.CompletionRevision
	p.session.mu.RUnlock()
	if revision != 1 {
		t.Fatal("missing completion revision")
	}
}
func TestAntigravityPermissionsDoNotBlockRPCReader(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "agy-approval")
	var id string
	antigravityWait(t, time.Second, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		for key := range p.permissions {
			id = key
		}
		return id != "" && len(p.commands) > 0
	})
	// A separate local command returns while the permission RPC remains pending.
	if err := p.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, time.Second, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.quota != nil })
	if err := p.Approve(context.Background(), id, "approved", map[string]any{"optionId": "invented"}); err == nil {
		t.Fatal("accepted unadvertised permission option")
	}
	if err := p.Approve(context.Background(), id, "approved", map[string]any{"optionId": "allow-once-exact"}); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
	p.session.mu.RLock()
	pending := len(p.session.Permissions)
	p.session.mu.RUnlock()
	if pending != 0 {
		t.Fatal("permission stayed pending")
	}
}

func TestAntigravityDenyClearsInteractionAtCompletion(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "agy-approval")
	var id string
	antigravityWait(t, time.Second, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		for key := range p.permissions {
			id = key
		}
		return id != ""
	})
	// Use the same payload as the browser: an exact native rejection option,
	// without a synthesized Codex decision value.
	if err := p.Approve(context.Background(), id, "", map[string]any{"optionId": "reject-once-exact"}); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
	p.mu.Lock()
	activePermissions, activeQuestions, activeTurn := len(p.permissions), len(p.questions), p.turnID
	p.mu.Unlock()
	snapshot := p.session.snapshot()
	state := mapValue(snapshot["state"])
	if activePermissions != 0 || activeQuestions != 0 || activeTurn != "" || state["status"] != "idle" || numberInt64(state["pendingPermissionCount"]) != 0 || boolValue(state["canAbort"]) || boolValue(state["canSteer"]) {
		t.Fatalf("denied interaction remained active: %#v", state)
	}
	permissions, _ := snapshot["pendingPermissions"].([]Permission)
	if len(permissions) != 1 || permissions[0].Status != "denied" {
		t.Fatalf("denied audit was lost or became pending on reconnect: %#v", permissions)
	}
	if antigravityKindCount(p, "assistant") == 0 || antigravityKindCount(p, "turn-end") != 1 {
		t.Fatal("denial did not settle into a final reply and one completed turn")
	}
	antigravitySend(t, p, "Continue after denied command")
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
	if antigravityKindCount(p, "turn-end") != 2 {
		t.Fatal("denied interaction blocked the next turn")
	}
}
func TestAntigravityFormQuestionsValidateAndPreserveTypes(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "agy-question")
	var id string
	antigravityWait(t, time.Second, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		for key := range p.questions {
			id = key
		}
		return id != ""
	})
	if err := p.RespondUserInput(context.Background(), id, map[string]any{"answers": map[string]any{"destination": "Elsewhere"}}); err == nil {
		t.Fatal("accepted invalid enum")
	}
	if err := p.AnswerUserInput(context.Background(), id, "answer", map[string]string{"destination": "Local", "count": "3", "enabled": "false"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := p.AnswerUserInput(context.Background(), id, "answer", map[string]string{"destination": "Local", "count": "3", "enabled": "false"}, nil); err != nil {
		t.Fatalf("answer retry failed: %v", err)
	}
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
	for _, m := range antigravityMessages(p) {
		if m["kind"] == "question" {
			answers := mapValue(m["answers"])
			if answers["count"] != float64(3) || answers["enabled"] != false || m["questionStatus"] != "answered" {
				t.Fatalf("wrong form answer: %#v", m)
			}
		}
	}
}
func TestAntigravityDeferredToolsAndDaemonLifecycle(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "agy-background")
	antigravityWait(t, time.Second, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.deferred && p.wirePrompts == 0 })
	if antigravityKindCount(p, "turn-end") != 0 {
		t.Fatal("turn completed while background tool was running")
	}
	p.mu.Lock()
	turn := p.turnID
	p.mu.Unlock()
	if err := p.Steer(context.Background(), ProviderInput{Text: "follow background", AgentText: "follow background"}, turn); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 3*time.Second, func() bool { return antigravityIdle(p) })
	if antigravityKindCount(p, "turn-end") != 1 {
		t.Fatal("background follow-up duplicated completion")
	}
	antigravitySend(t, p, "agy-daemon")
	antigravityWait(t, 1500*time.Millisecond, func() bool { return antigravityIdle(p) })
}
func TestAntigravityResumeIsAtomicStableAndPreviewIsolated(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "remember this")
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
	before, _ := json.Marshal(antigravityMessages(p))
	p.mu.Lock()
	original := p.nativeID
	p.mu.Unlock()
	if err := p.Resume(context.Background(), "agy-missing"); err == nil {
		t.Fatal("missing resume succeeded")
	}
	after, _ := json.Marshal(antigravityMessages(p))
	if string(before) != string(after) {
		t.Fatal("failed replay changed live messages")
	}
	if err := p.Resume(context.Background(), "agy-history"); err != nil {
		t.Fatal(err)
	}
	first := antigravityMessages(p)
	if err := p.Resume(context.Background(), "agy-history"); err != nil {
		t.Fatal(err)
	}
	second := antigravityMessages(p)
	if len(first) != len(second) {
		t.Fatal("unstable replay length")
	}
	for i := range first {
		if first[i]["id"] != second[i]["id"] || first[i]["turnId"] != second[i]["turnId"] {
			t.Fatalf("unstable replay identity at %d", i)
		}
	}
	antigravitySend(t, p, "agy-long")
	p.mu.Lock()
	native, turn := p.nativeID, p.turnID
	p.mu.Unlock()
	messages, err := p.preview(context.Background(), original)
	if err != nil || len(messages) == 0 {
		t.Fatalf("preview failed: %v", err)
	}
	p.mu.Lock()
	same := p.nativeID == native && p.turnID == turn
	p.mu.Unlock()
	if !same {
		t.Fatal("preview switched live conversation")
	}
	if err := p.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
}
func TestAntigravityNativeSettingsAndImages(t *testing.T) {
	p := antigravityFixture(t)
	if err := p.UpdateSettings(context.Background(), map[string]any{"model": "claude-sonnet-4.6", "effort": "medium", "mode": "plan"}); err != nil {
		t.Fatal(err)
	}
	p.session.mu.RLock()
	model, effort, mode := p.session.State["model"], p.session.State["effort"], p.session.State["mode"]
	p.session.mu.RUnlock()
	if model != "claude-sonnet-4.6" || effort != "medium" || mode != "plan" {
		t.Fatal("settings did not reach public state")
	}
	if err := p.UpdateSettings(context.Background(), map[string]any{"model": "not-advertised"}); err == nil {
		t.Fatal("accepted unadvertised model")
	}
	file := filepath.Join(t.TempDir(), "image.png")
	if err := os.WriteFile(file, []byte("image bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	content, err := p.promptContent(ProviderInput{Text: "image", Images: []Attachment{{Path: file, MediaType: "image/png"}}})
	if err != nil {
		t.Fatal(err)
	}
	image := mapValue(content[1])
	if image["type"] != "image" || image["mimeType"] != "image/png" || image["data"] == nil {
		t.Fatal("wrong ACP image content")
	}
	if err := p.UpdateInstructions(context.Background(), "Follow the session instruction."); err != nil {
		t.Fatal(err)
	}
}

func TestAntigravityRejectedSteeringDoesNotFailOriginalTurn(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "agy-long")
	antigravityWait(t, time.Second, func() bool { return antigravityKindCount(p, "assistant") > 0 })
	p.mu.Lock()
	turn := p.turnID
	p.mu.Unlock()
	if err := p.Steer(context.Background(), ProviderInput{Text: "agy-steer-reject", AgentText: "agy-steer-reject"}, turn); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, time.Second, func() bool {
		for _, message := range antigravityMessages(p) {
			if message["deliveryStatus"] == "failed" {
				return true
			}
		}
		return false
	})
	if antigravityKindCount(p, "turn-end") != 0 {
		t.Fatal("rejected steering ended original turn")
	}
	if err := p.Steer(context.Background(), ProviderInput{Text: "accepted redirect", AgentText: "accepted redirect"}, turn); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 3*time.Second, func() bool { return antigravityIdle(p) })
	for _, message := range antigravityMessages(p) {
		if message["kind"] == "turn-end" && message["status"] != "completed" {
			t.Fatalf("original turn failed after rejected steering: %#v", message)
		}
	}
}
func TestAntigravityUnacknowledgedStopRecyclesAndRestores(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "agy-ignore-cancel")
	antigravityWait(t, time.Second, func() bool { return antigravityKindCount(p, "assistant") > 0 })
	p.mu.Lock()
	generation, native := p.generation, p.nativeID
	p.mu.Unlock()
	if err := p.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 7*time.Second, func() bool { return antigravityIdle(p) })
	p.mu.Lock()
	recycled := p.generation > generation && p.cmd == nil
	p.mu.Unlock()
	if !recycled {
		t.Fatal("unacknowledged cancel did not recycle the ACP process")
	}
	antigravitySend(t, p, "after interrupted turn")
	antigravityWait(t, 3*time.Second, func() bool { return antigravityIdle(p) })
	p.mu.Lock()
	restored := p.nativeID == native
	p.mu.Unlock()
	if !restored {
		t.Fatal("next input lost native conversation identity")
	}
	if antigravityKindCount(p, "turn-start") != 2 || antigravityKindCount(p, "turn-end") != 2 {
		t.Fatal("reconnect duplicated/replayed live lifecycle")
	}
}

func TestAntigravityInternalBootstrapHasNoAuthoredUserEcho(t *testing.T) {
	p := antigravityFixture(t)
	if err := p.Send(context.Background(), ProviderInput{Text: "Prepare the workspace", AgentText: "Prepare the workspace", Internal: true}); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
	if antigravityKindCount(p, "user") != 0 {
		t.Fatal("internal bootstrap appeared as an authored user message")
	}
	if antigravityKindCount(p, "assistant") == 0 || antigravityKindCount(p, "turn-end") != 1 {
		t.Fatal("internal bootstrap did not complete")
	}
}

func TestAntigravityStopDuringResumePreservesDisplayedHistory(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "original history")
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
	before, _ := json.Marshal(antigravityMessages(p))
	finished := make(chan error, 1)
	go func() { finished <- p.Resume(context.Background(), "agy-slow-load") }()
	antigravityWait(t, time.Second, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.switching })
	if err := p.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("cancelled resume succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("stop did not cancel history loading")
	}
	after, _ := json.Marshal(antigravityMessages(p))
	if string(before) != string(after) {
		t.Fatal("interrupted resume replaced displayed history")
	}
}
func TestAntigravityInitialResumeHydratesHistory(t *testing.T) {
	original := antigravityFixture(t)
	antigravitySend(t, original, "persisted conversation")
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(original) })
	original.mu.Lock()
	native := original.nativeID
	original.mu.Unlock()
	session := newSession(newUUID(), "Resumed AGY", "antigravity-structured", original.session.Tool, original.session.WorkingDirectory)
	session.environment = append([]string(nil), original.session.environment...)
	resumed := NewAntigravityProvider(session, map[string]any{"resume": native})
	session.Provider = resumed
	t.Cleanup(func() { session.cancel(); _ = resumed.Close(context.Background()) })
	if err := resumed.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if antigravityKindCount(resumed, "user") != 1 || antigravityKindCount(resumed, "assistant") == 0 {
		t.Fatal("initial resume did not install native history")
	}
	for _, message := range antigravityMessages(resumed) {
		if message["threadId"] != native {
			t.Fatal("resume history lost native identity")
		}
	}
}

func TestAntigravityCompactionRequiresAdvertisedCommand(t *testing.T) {
	p := antigravityFixture(t)
	antigravityWait(t, time.Second, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.hasCommandLocked("compact") })
	if err := p.Compact(context.Background()); err != nil {
		t.Fatal(err)
	}
	if allowed, _ := p.CanSteer(); allowed {
		t.Fatal("compaction accepted unrelated running-turn input")
	}
	antigravityWait(t, 2*time.Second, func() bool { return antigravityIdle(p) })
	if antigravityKindCount(p, "user") != 0 {
		t.Fatal("compaction appeared as an authored user input")
	}
	compacted := false
	for _, message := range antigravityMessages(p) {
		if message["kind"] == "compaction" && message["compactionStatus"] == "completed" {
			compacted = true
		}
	}
	if !compacted {
		t.Fatal("native compaction update was not normalized")
	}
	p.mu.Lock()
	p.commands = nil
	p.mu.Unlock()
	if err := p.Compact(context.Background()); err == nil {
		t.Fatal("compaction enabled without CLI advertisement")
	}
}

// Snapshots and queued WS state events retain configOptions after the provider
// lock is released. Native mode updates and old-agent setting responses must
// replace both the slice and the changed option before publishing again.
func TestAntigravityConfigSnapshotsRemainImmutableDuringSettings(t *testing.T) {
	session := newSession("agy-config-snapshots", "AGY", "antigravity-structured", ToolInfo{Key: "antigravity"}, t.TempDir())
	defer session.cancel()
	p := NewAntigravityProvider(session, nil)
	session.Provider = p
	writes := make(chan []byte, 8)
	p.stdin = &channelWriteCloser{writes: writes}
	p.ready = true
	p.nativeID = "native-config"
	p.configOptions = []map[string]any{{"id": "mode", "type": "select", "currentValue": "default", "options": []any{map[string]any{"value": "default"}, map[string]any{"value": "plan"}}}}
	p.modes = map[string]any{"currentModeId": "default"}
	p.mu.Lock()
	p.publishStateLocked()
	p.mu.Unlock()
	original := session.snapshot()
	stop := make(chan struct{})
	encoded := make(chan struct{})
	encodeErrors := make(chan error, 1)
	go func() {
		defer close(encoded)
		for {
			select {
			case <-stop:
				return
			default:
			}
			for _, snapshot := range []map[string]any{original, session.snapshot()} {
				if _, err := json.Marshal(snapshot); err != nil {
					select {
					case encodeErrors <- err:
					default:
					}
					return
				}
			}
		}
	}()
	replies := make(chan struct{})
	go func() {
		defer close(replies)
		for {
			select {
			case <-stop:
				return
			case data := <-writes:
				var request map[string]any
				if json.Unmarshal(data, &request) != nil {
					continue
				}
				p.mu.Lock()
				id := stringValue(request["id"])
				pending, ok := p.pending[id]
				if ok {
					delete(p.pending, id)
					pending.reply <- antigravityReply{result: map[string]any{}}
				}
				p.mu.Unlock()
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var updateError error
	for i := 0; i < 100; i++ {
		p.mu.Lock()
		p.updateLocked(map[string]any{"sessionId": p.nativeID, "update": map[string]any{"sessionUpdate": "current_mode_update", "currentModeId": "plan"}})
		p.mu.Unlock()
		if err := p.updateSettings(ctx, map[string]any{"mode": "default"}); err != nil {
			updateError = err
			break
		}
		// Exercise the fallback response without a subsequent native notification.
		if err := p.updateSettings(ctx, map[string]any{"mode": "plan"}); err != nil {
			updateError = err
			break
		}
	}
	close(stop)
	<-encoded
	<-replies
	if updateError != nil {
		t.Fatal(updateError)
	}
	select {
	case err := <-encodeErrors:
		t.Fatal(err)
	default:
	}
	state := mapValue(original["state"])
	options, _ := state["configOptions"].([]map[string]any)
	if len(options) != 1 || options[0]["currentValue"] != "default" || mapValue(state["modes"])["currentModeId"] != "default" {
		t.Fatalf("published snapshot was mutated: %#v", state)
	}
	p.mu.Lock()
	latest := p.configOptions[0]["currentValue"]
	p.mu.Unlock()
	if latest != "plan" {
		t.Fatal("settings did not update provider state")
	}
}
