package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

func (provider *CodexProvider) UpdateSettings(ctx context.Context, settings map[string]any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	normalized, err := normalizeCodexSettings(settings)
	if err != nil {
		return err
	}

	provider.mu.Lock()
	model := firstNonEmpty(stringValue(normalized["model"]), stringValue(provider.options["model"]))
	if normalized["serviceTier"] == "priority" && !provider.modelSupportsFastLocked(model) {
		provider.mu.Unlock()
		return errors.New("Fast mode is unavailable for the selected Codex model")
	}
	if normalized["model"] != nil && normalized["serviceTier"] == nil &&
		(model != stringValue(provider.options["model"]) || !provider.modelSupportsFastLocked(model)) {
		normalized["serviceTier"] = "default"
	}
	// Current app-server applies choices through thread/turn options. Save them
	// for the next turn instead of calling the obsolete thread/settings/update.
	if provider.defaultsStore != nil {
		defaults := cloneMap(normalized)
		delete(defaults, "serviceTier") // Fast is a per-session opt-in.
		if len(defaults) > 0 {
			err = provider.defaultsStore.UpdateMap("codexDefaults", defaults)
		}
	}
	if err == nil {
		for key, value := range normalized {
			provider.options[key] = value
		}
		provider.settingsRevision++
	}
	provider.mu.Unlock()
	provider.updatePublicState(provider.session.StatusValue)
	return err
}

func normalizeCodexSettings(settings map[string]any) (map[string]any, error) {
	normalized := map[string]any{}
	for key, raw := range settings {
		value, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be a string", key)
		}
		value = strings.TrimSpace(value)
		switch key {
		case "model", "effort":
			if value == "" || len(value) > 160 || strings.ContainsAny(value, "\r\n") {
				return nil, fmt.Errorf("invalid Codex %s", key)
			}
		case "serviceTier":
			if value == "fast" {
				value = "priority"
			}
			if value != "default" && value != "priority" {
				return nil, errors.New("invalid Codex service tier")
			}
		case "permissionMode":
			if value != "default" && value != "untrusted" && value != "on-request" && value != "never" {
				return nil, errors.New("invalid Codex approval policy")
			}
		case "sandboxMode":
			if value != "default" && value != "read-only" && value != "workspace-write" && value != "danger-full-access" {
				return nil, errors.New("invalid Codex sandbox mode")
			}
		default:
			return nil, fmt.Errorf("unsupported Codex setting: %s", key)
		}
		normalized[key] = value
	}
	if len(normalized) == 0 {
		return nil, errors.New("no Codex settings supplied")
	}
	return normalized, nil
}

func (provider *CodexProvider) WriteGlobalDefaults(ctx context.Context) (map[string]any, error) {
	provider.mu.Lock()
	model := stringValue(provider.options["model"])
	effort := stringValue(provider.options["effort"])
	permission := stringValue(provider.options["permissionMode"])
	if permission == "" || permission == "default" {
		permission = stringValue(provider.options["configPermissionMode"])
	}
	sandbox := stringValue(provider.options["sandboxMode"])
	if sandbox == "" || sandbox == "default" {
		sandbox = stringValue(provider.options["configSandboxMode"])
	}
	settings, err := normalizeCodexSettings(map[string]any{
		"model": model, "effort": effort, "permissionMode": permission, "sandboxMode": sandbox,
		"serviceTier": provider.serviceTierLocked(),
	})
	if err != nil {
		provider.mu.Unlock()
		return nil, fmt.Errorf("current Codex settings cannot be saved as global defaults: %w", err)
	}

	tier := "default"
	if settings["serviceTier"] == "priority" {
		tier = "fast"
	}
	edits := []any{
		map[string]any{"keyPath": "model", "value": settings["model"], "mergeStrategy": "upsert"},
		map[string]any{"keyPath": "model_reasoning_effort", "value": settings["effort"], "mergeStrategy": "upsert"},
		map[string]any{"keyPath": "sandbox_mode", "value": settings["sandboxMode"], "mergeStrategy": "upsert"},
		map[string]any{"keyPath": "approval_policy", "value": settings["permissionMode"], "mergeStrategy": "upsert"},
		map[string]any{"keyPath": "service_tier", "value": tier, "mergeStrategy": "upsert"},
	}
	_, err = provider.requestLocked(ctx, "config/batchWrite", map[string]any{"edits": edits})
	if err == nil {
		provider.options["configPermissionMode"] = settings["permissionMode"]
		provider.options["configSandboxMode"] = settings["sandboxMode"]
	}
	provider.mu.Unlock()
	provider.updatePublicState(provider.session.StatusValue)
	if err != nil {
		return nil, fmt.Errorf("write Codex global defaults: %w", err)
	}
	return settings, nil
}

func (provider *CodexProvider) modelSupportsFastLocked(model string) bool {
	for _, item := range provider.models {
		if stringValue(item["id"]) == model {
			return stringValue(item["fastServiceTier"]) == "priority"
		}
	}
	return false
}

func (provider *CodexProvider) serviceTierLocked() string {
	if tier := stringValue(provider.options["serviceTier"]); (tier == "priority" || tier == "fast") &&
		provider.modelSupportsFastLocked(stringValue(provider.options["model"])) {
		return "priority"
	}
	return "default"
}
