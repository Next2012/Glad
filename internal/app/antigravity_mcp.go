package app

import (
	"path"
	"strings"
)

// ACP 1.5.x may forward client-supplied MCP tools as generic external tools,
// asking the client even when its private settings allow mcp(glad/*). Resolve
// only our known Glad tools here. The daemon still authenticates and authorizes
// the actual call. Strict and explicit Ask/Deny retain their precedence.
// Called with p.mu held. Disk reads use atomic settings files, not diskMu:
// permission updates acquire diskMu before p.mu.
func (p *AntigravityProvider) resolveGladMCPPermissionLocked(rpcID any, tool map[string]any, options []map[string]any) bool {
	if p.session.mcpURL == "" || p.permissionDir == "" {
		return false
	}
	name := stringValue(tool["name"])
	short := strings.TrimPrefix(name, "mcp_glad_")
	known := false
	for _, definition := range allGladTools() {
		if definition["name"] == short && name == "mcp_glad_"+short {
			known = true
			break
		}
	}
	if !known {
		return false
	}
	file, err := p.rulePath("session")
	if err != nil {
		return false
	}
	settings, err := agyReadSettings(file)
	if err != nil {
		return false
	}
	rules, err := agyRules(settings)
	if err != nil {
		return false
	}
	matches := func(entries []string) (bool, bool) {
		for _, rule := range entries {
			if !strings.HasPrefix(rule, "mcp(") || !strings.HasSuffix(rule, ")") {
				continue
			}
			pattern := strings.TrimSuffix(strings.TrimPrefix(rule, "mcp("), ")")
			if strings.HasPrefix(pattern, "regex:") {
				return false, false
			}
			for _, target := range []string{"glad/" + short, name} {
				matched, err := path.Match(pattern, target)
				if err != nil {
					return false, false
				}
				if pattern == "*" || matched {
					return true, true
				}
			}
		}
		return false, true
	}
	kind := "allow_once"
	denied, valid := matches(rules.Deny)
	if !valid {
		return false
	}
	if denied {
		kind = "reject_once"
	} else {
		ask, valid := matches(rules.Ask)
		if !valid || ask || settings["toolPermission"] == "strict" {
			return false
		}
		allowed, valid := matches(rules.Allow)
		if !valid || !allowed {
			return false
		}
	}
	for _, option := range options {
		if option["kind"] == kind {
			return p.writeLocked(map[string]any{"jsonrpc": "2.0", "id": rpcID, "result": map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": option["optionId"]}}}) == nil
		}
	}
	return false
}
