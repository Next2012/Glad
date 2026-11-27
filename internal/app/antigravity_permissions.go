package app

// Policy changes reconnect the same native conversation and restore the previous
// configuration if the replacement ACP process cannot be started.
import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type agyPermissionChange struct {
	Revision string                     `json:"revision"`
	Policy   map[string]any             `json:"policy"`
	Mode     string                     `json:"mode"`
	Rules    map[string]agyRuleDocument `json:"rules"`
}

func (p *AntigravityProvider) permissionStateLocked() map[string]any {
	state := map[string]any{"isolated": p.permissionDir != "", "applying": p.permissionApplying, "sandboxWarning": p.sandboxWarning}
	if p.permissionSettings != nil {
		values := cloneMap(agyPolicyDefaults)
		for key := range values {
			if v, ok := p.permissionSettings[key]; ok {
				values[key] = v
			}
		}
		state["values"] = values
		state["overrides"] = cloneMap(p.permissionOverrides)
	}
	return state
}
func (p *AntigravityProvider) PermissionSettings(ctx context.Context) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p.opMu.Lock()
	defer p.opMu.Unlock()
	agyPolicyDiskMu.Lock()
	defer agyPolicyDiskMu.Unlock()
	return p.permissionDocumentLocked()
}
func (p *AntigravityProvider) permissionDocumentLocked() (map[string]any, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	docs := map[string]agyRuleDocument{}
	global := map[string]any{}
	for _, scope := range []string{"global", "shared", "project", "session"} {
		path, err := p.rulePath(scope)
		if err != nil {
			return nil, err
		}
		settings, err := agyReadSettings(path)
		if err != nil {
			return nil, err
		}
		if scope == "global" {
			global = settings
			if err := agyValidateSettings(settings); err != nil {
				return nil, err
			}
		}
		doc, err := agyRules(settings)
		if err != nil {
			return nil, err
		}
		// Show locally added rules and native grants separately from inherited rules.
		if scope == "session" && p.permissionSettings != nil {
			previous, _ := agyRules(p.permissionSettings)
			doc = agyMergeRules(p.permissionSessionRules, agySubtractRules(doc, previous))
			doc.Revision = agyRevision(doc)
		}
		docs[scope] = doc
	}
	values := cloneMap(agyPolicyDefaults)
	source := global
	if p.permissionSettings != nil {
		source = p.permissionSettings
	}
	for key := range values {
		if v, ok := source[key]; ok {
			values[key] = v
		}
	}
	overrides := cloneMap(p.permissionOverrides)
	defaults := cloneMap(agyPolicyDefaults)
	for key := range defaults {
		if value, ok := global[key]; ok {
			defaults[key] = value
		}
	}
	return map[string]any{"defaults": defaults, "success": true, "values": values, "overrides": overrides, "rules": docs, "isolated": p.permissionDir != "", "revision": agyRevision(map[string]any{"settings": source, "mode": p.modes["currentModeId"]}), "globalRevision": agyRevision(global), "mode": p.modes["currentModeId"]}, nil
}
func (p *AntigravityProvider) ApplyPermissions(ctx context.Context, change agyPermissionChange) error {
	if err := agyValidatePolicy(change.Policy, true); err != nil {
		return err
	}
	for scope, doc := range change.Rules {
		if scope != "session" && scope != "global" && scope != "shared" && scope != "project" {
			return errors.New("unknown rule scope")
		}
		if err := agyValidateRules(doc); err != nil {
			return err
		}
	}
	p.opMu.Lock()
	defer p.opMu.Unlock()
	p.mu.Lock()
	if p.closed || p.turnID != "" || p.switching || p.stopping || p.compacting || len(p.permissions) > 0 || len(p.questions) > 0 {
		p.mu.Unlock()
		return errors.New("permissions can only change while the session is idle")
	}
	// Validate native mode before touching files or processes.
	if change.Mode != "" && !p.supportsModeLocked(change.Mode) {
		p.mu.Unlock()
		return errors.New("mode is not advertised by the CLI")
	}
	oldMode := p.modes["currentModeId"]
	oldSandboxWarning := p.sandboxWarning
	oldModeInherited := p.modeInherited
	oldLocal := p.permissionSessionRules
	oldDir, oldSettings, oldOverrides, oldOptions := p.permissionDir, p.permissionSettings, p.permissionOverrides, cloneMap(p.options)
	p.mu.Unlock()
	agyPolicyDiskMu.Lock()
	defer agyPolicyDiskMu.Unlock()
	// Read and validate all scopes, then stage a fresh immutable profile.
	scopeSettings := map[string]map[string]any{}
	originalSettings := map[string]map[string]any{}
	originalRevisions := map[string]string{}
	docs := map[string]agyRuleDocument{}
	for _, scope := range []string{"global", "shared", "project", "session"} {
		path, err := p.rulePath(scope)
		if err != nil {
			return err
		}
		settings, err := agyReadSettings(path)
		if err != nil {
			return err
		}
		originalSettings[scope] = cloneMap(settings)
		originalRevisions[scope] = agyRevision(settings)
		doc, err := agyRules(settings)
		if err != nil {
			return err
		}
		if scope == "session" && oldSettings != nil {
			previous, _ := agyRules(oldSettings)
			doc = agyMergeRules(oldLocal, agySubtractRules(doc, previous))
			doc.Revision = agyRevision(doc)
		}
		if next, ok := change.Rules[scope]; ok {
			if next.Revision != doc.Revision {
				return errors.New("permission rules changed; reload before applying")
			}
			doc = next
			agySetRules(settings, doc)
		}
		scopeSettings[scope], docs[scope] = settings, doc
	}
	source := oldSettings
	if source == nil {
		source = originalSettings["global"]
	}
	if change.Revision != "" && change.Revision != agyRevision(map[string]any{"settings": source, "mode": oldMode}) {
		return errors.New("permission policy changed; reload before applying")
	}
	settings := cloneMap(scopeSettings["global"])
	if err := agyValidateSettings(settings); err != nil {
		return err
	}
	overrides := cloneMap(oldOverrides)
	for key, value := range change.Policy {
		if value == "inherit" {
			delete(overrides, key)
		} else {
			overrides[key] = value
		}
	}
	for key, value := range overrides {
		settings[key] = value
	}
	agySetRules(settings, agyMergeRules(docs["global"], docs["shared"], docs["project"], docs["session"]))
	if err := agyValidateSettings(settings); err != nil {
		return err
	}
	dir, err := p.newPermissionProfile(settings)
	if err != nil {
		return err
	}
	profile := filepath.Join(p.permissionRoot(), dir)
	p.mu.Lock()
	p.permissionApplying = true
	p.sandboxWarning = ""
	p.permissionDir, p.permissionSettings, p.permissionOverrides = dir, settings, overrides
	p.permissionSessionRules = docs["session"]
	// Preserve current native values even when they were inherited originally.
	for _, option := range p.configOptions {
		key := stringValue(option["id"])
		if key == "thought_level" {
			key = "effort"
		}
		if key == "mode" || key == "model" || key == "effort" {
			p.options[key] = option["currentValue"]
			oldOptions[key] = option["currentValue"]
		}
	}
	if change.Mode != "" {
		p.options["mode"] = change.Mode
	}
	generation := p.generation
	p.publishStateLocked()
	p.mu.Unlock()
	p.recycle(generation)
	err = p.start(ctx)
	committed := []string{}
	if err == nil {
		// Commit shared documents only after the replacement process is ready.
		for _, scope := range []string{"global", "shared", "project"} {
			if _, changed := change.Rules[scope]; changed {
				path, _ := p.rulePath(scope)
				current, e := agyReadSettings(path)
				if e == nil && agyRevision(current) != originalRevisions[scope] {
					e = errors.New("permission settings changed while reconnecting; reload before applying")
				}
				if e == nil {
					e = agyWriteSettings(path, scopeSettings[scope])
				}
				if e != nil {
					err = e
					break
				}
				committed = append(committed, scope)
			}
		}
	}
	if err != nil {
		for _, scope := range committed {
			path, _ := p.rulePath(scope)
			if rollbackErr := agyWriteSettings(path, originalSettings[scope]); rollbackErr != nil {
				err = fmt.Errorf("%w; reverting %s rules failed: %v", err, scope, rollbackErr)
			}
		}
		p.mu.Lock()
		generation = p.generation
		p.mu.Unlock()
		p.recycle(generation)
		p.mu.Lock()
		p.permissionDir, p.permissionSettings, p.permissionOverrides, p.options = oldDir, oldSettings, oldOverrides, oldOptions
		p.permissionSessionRules = oldLocal
		p.sandboxWarning = oldSandboxWarning
		p.modeInherited = oldModeInherited
		p.mu.Unlock()
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		restoreErr := p.start(rollbackCtx)
		cancel()
		p.mu.Lock()
		p.permissionApplying = false
		p.publishStateLocked()
		p.mu.Unlock()
		os.RemoveAll(profile)
		if restoreErr != nil {
			return fmt.Errorf("apply permissions: %w; restoring the previous process also failed: %v", err, restoreErr)
		}
		return fmt.Errorf("permissions were not applied; previous settings restored: %w", err)
	}
	p.mu.Lock()
	p.permissionApplying = false
	p.publishStateLocked()
	p.mu.Unlock()
	if oldDir != "" {
		os.RemoveAll(filepath.Join(p.permissionRoot(), oldDir))
	}
	return nil
}
func (p *AntigravityProvider) SavePermissionDefaults(policy map[string]any, revision string, mode string) error {
	if err := agyValidatePolicy(policy, true); err != nil {
		return err
	}
	agyPolicyDiskMu.Lock()
	defer agyPolicyDiskMu.Unlock()
	path := filepath.Join(p.permissionRoot(), "settings.json")
	settings, err := agyReadSettings(path)
	if err != nil {
		return err
	}
	if revision == "" || revision != agyRevision(settings) {
		return errors.New("default settings changed; reload before saving")
	}
	if mode != "" {
		switch mode {
		case "default":
			settings["agentMode"] = ""
		case "accept-edits", "auto", "plan":
			settings["agentMode"] = mode
		default:
			return errors.New("invalid default mode")
		}
	}
	for key, value := range policy {
		if value == "inherit" {
			delete(settings, key)
		} else {
			settings[key] = value
		}
	}
	if err := agyValidateSettings(settings); err != nil {
		return err
	}
	return agyWriteSettings(path, settings)
}

// Called with opMu and mu held before the first process starts. Scoped defaults
// are applied to new sessions without changing the native global settings.
func (p *AntigravityProvider) preparePermissionProfileLocked() error {
	if p.permissionDir != "" {
		return nil
	}
	settings, err := agyReadSettings(filepath.Join(p.permissionRoot(), "settings.json"))
	if err != nil {
		return err
	}
	if err := agyValidateSettings(settings); err != nil {
		return err
	}
	if _, explicit := p.options["mode"]; !explicit {
		if mode := stringValue(settings["agentMode"]); mode != "" {
			p.options["mode"] = mode
			p.modeInherited = true
		}
	}
	var docs []agyRuleDocument
	for _, scope := range []string{"shared", "project"} {
		path, err := p.rulePath(scope)
		if err != nil {
			return err
		}
		settings, err := agyReadSettings(path)
		if err != nil {
			return err
		}
		doc, err := agyRules(settings)
		if err != nil {
			return err
		}
		docs = append(docs, doc)
	}
	scoped := agyMergeRules(docs...)
	raw := mapValue(p.options["permissionPolicy"])
	if len(scoped.Allow)+len(scoped.Ask)+len(scoped.Deny) == 0 && len(raw) == 0 && p.session.mcpURL == "" {
		if p.permissionSettings == nil {
			p.permissionSettings = cloneMap(settings)
		}
		return nil
	}
	if err := agyValidatePolicy(raw, true); err != nil {
		return err
	}
	global, _ := agyRules(settings)
	agySetRules(settings, agyMergeRules(global, scoped))
	overrides := map[string]any{}
	for key, value := range raw {
		if value != "inherit" {
			settings[key] = value
			overrides[key] = value
		}
	}
	dir, err := p.newPermissionProfile(settings)
	if err != nil {
		return err
	}
	p.permissionDir, p.permissionSettings, p.permissionOverrides = dir, settings, overrides
	return nil
}
func (p *AntigravityProvider) cleanupPermissionProfile() {
	p.opMu.Lock()
	defer p.opMu.Unlock()
	p.mu.Lock()
	dir := p.permissionDir
	p.mu.Unlock()
	if dir != "" {
		_ = os.RemoveAll(filepath.Join(p.permissionRoot(), dir))
	}
}
