package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

func (provider *CodexProvider) UpdateSettings(ctx context.Context, settings map[string]any) error {
	normalized, err := normalizeCodexSettings(settings)
	if err != nil {
		return err
	}

	provider.mu.Lock()
	if provider.threadID != "" {
		params := map[string]any{"threadId": provider.threadID}
		if value := normalized["permissionMode"]; value != nil {
			if stringValue(value) == "default" {
				value = provider.options["configPermissionMode"]
			}
			if value != nil {
				params["approvalPolicy"] = value
			}
		}
		if value := normalized["sandboxMode"]; value != nil {
			if stringValue(value) == "default" {
				value = provider.options["configSandboxMode"]
			}
			if policy := codexSandboxPolicy(stringValue(value), provider.session.WorkingDirectory); policy != nil {
				params["sandboxPolicy"] = policy
			}
		}
		if value := normalized["model"]; value != nil {
			params["model"] = value
		}
		if value := normalized["effort"]; value != nil {
			params["effort"] = value
		}
		_, err = provider.requestLocked(ctx, "thread/settings/update", params)
	}
	if err == nil {
		for key, value := range normalized {
			provider.options[key] = value
		}
		if provider.defaultsStore != nil {
			err = provider.defaultsStore.UpdateMap("codexDefaults", normalized)
		}
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
	})
	if err != nil {
		provider.mu.Unlock()
		return nil, fmt.Errorf("current Codex settings cannot be saved as global defaults: %w", err)
	}

	edits := []any{
		map[string]any{"keyPath": "model", "value": settings["model"], "mergeStrategy": "upsert"},
		map[string]any{"keyPath": "model_reasoning_effort", "value": settings["effort"], "mergeStrategy": "upsert"},
		map[string]any{"keyPath": "sandbox_mode", "value": settings["sandboxMode"], "mergeStrategy": "upsert"},
		map[string]any{"keyPath": "approval_policy", "value": settings["permissionMode"], "mergeStrategy": "upsert"},
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
