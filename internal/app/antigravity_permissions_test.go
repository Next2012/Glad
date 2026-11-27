package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func agyTestDocument(t *testing.T, p *AntigravityProvider) map[string]any {
	t.Helper()
	d, err := p.PermissionSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func agyTestRules(t *testing.T, d map[string]any, scope string) agyRuleDocument {
	t.Helper()
	return d["rules"].(map[string]agyRuleDocument)[scope]
}
func TestAntigravityPermissionIsolationAndRecovery(t *testing.T) {
	p := antigravityFixture(t)
	ctx := context.Background()
	global := filepath.Join(p.permissionRoot(), "settings.json")
	if err := agyWriteSettings(global, map[string]any{"toolPermission": "always-proceed", "enableTerminalSandbox": true, "otherPreference": "keep"}); err != nil {
		t.Fatal(err)
	}
	if err := p.Send(ctx, ProviderInput{Text: "Before settings"}); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, time.Second, func() bool { ok, _ := p.CanAccept(); return ok })
	native := p.nativeID
	count := len(antigravityMessages(p))
	before, _ := os.ReadFile(global)
	if err := p.UpdateSettings(ctx, map[string]any{"model": "claude-sonnet-4.6", "effort": "low", "mode": "plan"}); err != nil {
		t.Fatal(err)
	}
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Mode: "default", Policy: map[string]any{"toolPermission": "request-review", "enableTerminalSandbox": false}}); err != nil {
		t.Fatal(err)
	}
	if p.nativeID != native || len(antigravityMessages(p)) != count {
		t.Fatal("policy reconnection changed conversation history")
	}
	if p.options["mode"] != "default" || p.options["model"] != "claude-sonnet-4.6" || p.options["effort"] != "low" {
		t.Fatalf("lost native settings: %#v", p.options)
	}
	active, err := agyReadSettings(filepath.Join(p.permissionRoot(), p.permissionDir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if active["enableTerminalSandbox"] != false || active["toolPermission"] != "request-review" || active["otherPreference"] != "keep" {
		t.Fatalf("wrong isolated settings: %#v", active)
	}
	after, _ := os.ReadFile(global)
	if string(before) != string(after) {
		t.Fatal("session policy modified native global configuration")
	}
	doc := agyTestDocument(t, p)
	rules := agyTestRules(t, doc, "session")
	rules.Allow = append(rules.Allow, "command(git status)")
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Rules: map[string]agyRuleDocument{"session": rules}}); err != nil {
		t.Fatal(err)
	}
	if err := p.Send(ctx, ProviderInput{Text: "agy-approval"}); err != nil {
		t.Fatal(err)
	}
	var permission string
	antigravityWait(t, time.Second, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		for id := range p.permissions {
			permission = id
		}
		return permission != ""
	})
	if err := p.Approve(ctx, permission, "allow-remember", nil); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, time.Second, func() bool { ok, _ := p.CanAccept(); return ok })
	rules = agyTestRules(t, agyTestDocument(t, p), "session")
	if strings.Join(rules.Allow, ",") != "command(echo approved),command(git status)" {
		t.Fatalf("native grant not visible: %#v", rules)
	}
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Policy: map[string]any{"toolPermission": "strict"}}); err != nil {
		t.Fatal(err)
	}
	rules = agyTestRules(t, agyTestDocument(t, p), "session")
	if len(rules.Allow) != 2 {
		t.Fatal("native grant or explicit session rules lost on reconnect")
	}
}
func TestAntigravityPermissionFailedApplyRestoresProcess(t *testing.T) {
	p := antigravityFixture(t)
	ctx := context.Background()
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Policy: map[string]any{"toolPermission": "request-review"}}); err != nil {
		t.Fatal(err)
	}
	old := p.permissionDir
	native := p.nativeID
	p.session.environment = append(p.session.environment, "GLAD_AGY_FAIL_POLICY=strict")
	doc := agyTestDocument(t, p)
	rules := agyTestRules(t, doc, "global")
	rules.Deny = []string{"command(rm)"}
	err := p.ApplyPermissions(ctx, agyPermissionChange{Policy: map[string]any{"toolPermission": "strict"}, Rules: map[string]agyRuleDocument{"global": rules}})
	if err == nil {
		t.Fatal("accepted failed startup")
	}
	if p.permissionDir != old || p.nativeID != native || !p.ready || p.permissionApplying {
		t.Fatal("previous process was not restored")
	}
	if got := agyTestRules(t, agyTestDocument(t, p), "global"); len(got.Deny) != 0 {
		t.Fatal("failed apply committed global rules")
	}
	if err := p.Send(ctx, ProviderInput{Text: "After rollback"}); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, time.Second, func() bool { ok, _ := p.CanAccept(); return ok })
}
func TestAntigravityPermissionRulesRevisionAndValidation(t *testing.T) {
	p := antigravityFixture(t)
	ctx := context.Background()
	doc := agyTestDocument(t, p)
	rule := agyTestRules(t, doc, "global")
	global, _ := p.rulePath("global")
	if err := agyWriteSettings(global, map[string]any{"permissions": map[string]any{"deny": []string{"command(rm)"}}}); err != nil {
		t.Fatal(err)
	}
	pid := p.cmd.Process.Pid
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Rules: map[string]agyRuleDocument{"global": rule}}); err == nil {
		t.Fatal("stale rules overwrote external edits")
	}
	for _, rule := range []string{"invalid", "command()", "command(regex:[)", "command(git)\ncommand(rm)"} {
		if err := p.ApplyPermissions(ctx, agyPermissionChange{Rules: map[string]agyRuleDocument{"session": {Allow: []string{rule}}}}); err == nil {
			t.Fatalf("accepted invalid rule %q", rule)
		}
	}
	if p.cmd.Process.Pid != pid {
		t.Fatal("invalid requests restarted the process")
	}
	if err := os.WriteFile(global, []byte("{invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Policy: map[string]any{"toolPermission": "always-proceed"}}); err == nil {
		t.Fatal("silently accepted corrupted settings")
	}
}
func TestAntigravityPermissionBusyAndDefaults(t *testing.T) {
	p := antigravityFixture(t)
	ctx := context.Background()
	doc := agyTestDocument(t, p)
	if err := p.SavePermissionDefaults(map[string]any{"toolPermission": "strict"}, doc["globalRevision"].(string), "plan"); err != nil {
		t.Fatal(err)
	}
	if p.permissionDir != "" {
		t.Fatal("saving defaults changed current session")
	}
	file, _ := p.rulePath("global")
	data, err := agyReadSettings(file)
	if err != nil || data["agentMode"] != "plan" || data["toolPermission"] != "strict" {
		t.Fatal("defaults not saved")
	}
	if err := p.SavePermissionDefaults(map[string]any{"toolPermission": "always-proceed"}, doc["globalRevision"].(string), ""); err == nil {
		t.Fatal("accepted stale default revision")
	}
	if err := p.Send(ctx, ProviderInput{Text: "agy-approval"}); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, time.Second, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.permissions) > 0 })
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Policy: map[string]any{"toolPermission": "always-proceed"}}); err == nil {
		t.Fatal("changed permissions during pending approval")
	}
}
func TestAntigravityPermissionScopedRulesAndCleanup(t *testing.T) {
	p := antigravityFixture(t)
	ctx := context.Background()
	doc := agyTestDocument(t, p)
	project := agyTestRules(t, doc, "project")
	project.Allow = []string{"command(git)"}
	shared := agyTestRules(t, doc, "shared")
	shared.Ask = []string{"mcp(*)"}
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Rules: map[string]agyRuleDocument{"project": project, "shared": shared}}); err != nil {
		t.Fatal(err)
	}
	settings, err := agyReadSettings(filepath.Join(p.permissionRoot(), p.permissionDir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	rules, err := agyRules(settings)
	if err != nil || len(rules.Allow) != 1 || len(rules.Ask) != 1 {
		t.Fatal("scoped rules not merged")
	}
	q := NewAntigravityProvider(p.session, nil)
	q.mu.Lock()
	err = q.preparePermissionProfileLocked()
	q.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	rules, err = agyRules(q.permissionSettings)
	if err != nil || len(rules.Allow) != 1 || len(rules.Ask) != 1 {
		t.Fatal("new session did not inherit scoped rules")
	}
	profile := filepath.Join(q.permissionRoot(), q.permissionDir)
	q.cleanupPermissionProfile()
	if _, err := os.Stat(profile); !os.IsNotExist(err) {
		t.Fatal("profile not cleaned")
	}
	// Typed documents survive JSON transport and maintain a stable revision.
	bytes, _ := json.Marshal(agyTestDocument(t, p))
	if !json.Valid(bytes) {
		t.Fatal("invalid permission document")
	}
}

func TestAntigravityPermissionReportsSandboxFailure(t *testing.T) {
	p := antigravityFixture(t)
	if err := p.Send(context.Background(), ProviderInput{Text: "agy-sandbox-error"}); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, time.Second, func() bool { ok, _ := p.CanAccept(); return ok })
	p.mu.Lock()
	warning := p.sandboxWarning
	p.mu.Unlock()
	if warning == "" {
		t.Fatal("sandbox execution failure was not exposed in policy state")
	}
}

func TestAntigravityPermissionTwoLiveSessionsStayIndependent(t *testing.T) {
	p := antigravityFixture(t)
	ctx := context.Background()
	other := newSession(newUUID(), "second policy session", "antigravity-structured", p.session.Tool, t.TempDir())
	other.environment = []string{"HOME=" + p.permissionHome(), "ANTIGRAVITY_HOME=" + t.TempDir()}
	q := NewAntigravityProvider(other, nil)
	other.Provider = q
	t.Cleanup(func() { other.cancel(); _ = q.Close(ctx); q.cleanupPermissionProfile() })
	if err := q.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.ApplyPermissions(ctx, agyPermissionChange{Policy: map[string]any{"toolPermission": "strict", "enableTerminalSandbox": true}}); err != nil {
		t.Fatal(err)
	}
	if err := q.ApplyPermissions(ctx, agyPermissionChange{Policy: map[string]any{"toolPermission": "always-proceed", "enableTerminalSandbox": false}}); err != nil {
		t.Fatal(err)
	}
	pd, qd := agyTestDocument(t, p), agyTestDocument(t, q)
	if mapValue(pd["values"])["toolPermission"] != "strict" || mapValue(qd["values"])["toolPermission"] != "always-proceed" || p.permissionDir == q.permissionDir {
		t.Fatal("live session policies contaminated each other")
	}
}

func TestAntigravityPermissionStoreRejectsOversizedReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	original := map[string]any{"toolPermission": "strict", "otherPreference": "keep"}
	if err := agyWriteSettings(path, original); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := agyWriteSettings(path, map[string]any{"otherPreference": strings.Repeat("x", agyPermissionSettingsLimit)}); err == nil {
		t.Fatal("accepted a file that the settings reader would reject")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("rejected replacement changed existing settings")
	}
	if _, err := agyReadSettings(path); err != nil {
		t.Fatal(err)
	}
}

func TestAntigravityPermissionProfileFailureLeavesNoDirectory(t *testing.T) {
	p := antigravityFixture(t)
	if _, err := p.newPermissionProfile(map[string]any{"invalid": make(chan int)}); err == nil {
		t.Fatal("accepted unencodable settings")
	}
	entries, err := os.ReadDir(p.permissionRoot())
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "glad-session-") {
			t.Fatal("failed profile creation left a directory behind")
		}
	}
}

func TestAntigravityPermissionInheritedModeUsesAdvertisedCapabilities(t *testing.T) {
	p := antigravityFixture(t)
	ctx := context.Background()
	if err := agyWriteSettings(filepath.Join(p.permissionRoot(), "settings.json"), map[string]any{"agentMode": "future-mode"}); err != nil {
		t.Fatal(err)
	}
	session := newSession(newUUID(), "inherited mode", "antigravity-structured", p.session.Tool, t.TempDir())
	session.environment = []string{"HOME=" + p.permissionHome(), "ANTIGRAVITY_HOME=" + t.TempDir()}
	q := NewAntigravityProvider(session, nil)
	session.Provider = q
	t.Cleanup(func() { session.cancel(); _ = q.Close(ctx); q.cleanupPermissionProfile() })
	if err := q.Start(ctx); err != nil {
		t.Fatalf("unsupported inherited mode should use the native default: %v", err)
	}
	q.mu.Lock()
	mode := q.modes["currentModeId"]
	inherited := q.modeInherited
	q.mu.Unlock()
	if mode != "default" || !inherited {
		t.Fatal("inherited mode did not fall back to the advertised default")
	}
	if err := q.UpdateSettings(ctx, map[string]any{"mode": "future-mode"}); err == nil {
		t.Fatal("accepted an unsupported explicit mode")
	}
	if err := q.UpdateSettings(ctx, map[string]any{"mode": "plan"}); err != nil {
		t.Fatal(err)
	}
	q.mu.Lock()
	inherited = q.modeInherited
	q.mu.Unlock()
	if inherited {
		t.Fatal("explicit mode did not replace inherited preference")
	}
}
