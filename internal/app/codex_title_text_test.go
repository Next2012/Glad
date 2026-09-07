package app

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCodexTitlePromptsAndParsing(t *testing.T) {
	for _, input := range []string{"修复项目构建", strings.Repeat("中文<&", 4000)} {
		prompt := codexFirstTitlePrompt(input)
		if len(prompt) > 960 || !utf8.ValidString(prompt) {
			t.Fatal("unbounded first title prompt")
		}
	}
	turns := []any{}
	for i := 0; i < 6; i++ {
		turns = append(turns, map[string]any{"items": []any{
			map[string]any{"type": "userMessage", "content": []any{map[string]any{"type": "text", "text": strings.Repeat("最新请求<&", 200)}}},
			map[string]any{"type": "agentMessage", "phase": "commentary", "text": "MUST_SKIP_COMMENTARY"},
			map[string]any{"type": "commandExecution", "aggregatedOutput": "MUST_SKIP_TOOLS"},
			map[string]any{"type": "agentMessage", "text": strings.Repeat("回答>&", 200)},
		}})
	}
	prompt, provisional := codexRecentTitlePrompt(turns)
	if len(prompt) > 960 || !utf8.ValidString(prompt) || strings.Count(prompt, "<message role=") != 8 || strings.Contains(prompt, "MUST_SKIP") || len([]rune(provisional)) != 36 {
		t.Fatalf("incorrect recent title prompt: %s", prompt)
	}
	for _, invalid := range []string{"hello", `{"title":""}`, `{"title":"ok","extra":true}`, `{"title":"ok"} trailing`, `{"title":"ok"}{}`} {
		if _, err := parseCodexTitle(invalid); err == nil {
			t.Fatalf("accepted invalid title %q", invalid)
		}
	}
	if title, err := parseCodexTitle(`{"title":"  ‘修复   项目构建’  "}`); err != nil || title != "修复 项目构建" {
		t.Fatalf("normalization: %q %v", title, err)
	}
}

func TestCodexTitleDisablesMCPWithoutLosingTransport(t *testing.T) {
	servers := map[string]any{
		"http":           map[string]any{"url": "http://127.0.0.1:1234/mcp", "http_headers": map[string]any{"X-Test": "local"}, "enabled": true},
		"stdio.with.dot": map[string]any{"command": "mcp-test", "args": []any{"--read-only"}, "env": map[string]any{"MODE": "test"}},
	}
	config := map[string]any{"mcp_servers": servers}
	params := codexTitleThreadParams(config, "test-model", "openai", "/workspace")
	disabled := mapValue(mapValue(params["config"])["mcp_servers"])
	for name, raw := range servers {
		original := mapValue(raw)
		copy := mapValue(disabled[name])
		if copy["enabled"] != false {
			t.Fatalf("MCP %s was not disabled", name)
		}
		for key, value := range original {
			if key != "enabled" && !reflect.DeepEqual(copy[key], value) {
				t.Fatalf("MCP %s lost %s", name, key)
			}
		}
	}
	if mapValue(servers["http"])["enabled"] != true {
		t.Fatal("main conversation MCP was disabled")
	}
	if _, ok := mapValue(servers["stdio.with.dot"])["enabled"]; ok {
		t.Fatal("source config was modified")
	}
}

func TestCodexTitleConfigOmitsNullWithoutChangingSource(t *testing.T) {
	original := map[string]any{"url": "http://127.0.0.1:9/mcp", "tool_timeout_sec": nil,
		"oauth": map[string]any{"client_id": "test", "scopes": nil}, "required": true}
	config := map[string]any{"mcp_servers": map[string]any{"test": original}}
	params := codexTitleThreadParams(config, "model", "openai", "/workspace")
	server := mapValue(mapValue(mapValue(params["config"])["mcp_servers"])["test"])
	if _, ok := server["tool_timeout_sec"]; ok {
		t.Fatal("null timeout was copied into TOML overrides")
	}
	if _, ok := mapValue(server["oauth"])["scopes"]; ok {
		t.Fatal("nested null was copied")
	}
	if mapValue(server["oauth"])["client_id"] != "test" || server["required"] != true {
		t.Fatal("non-null settings were lost")
	}
	if _, ok := original["tool_timeout_sec"]; !ok {
		t.Fatal("source configuration was modified")
	}
	if _, ok := mapValue(original["oauth"])["scopes"]; !ok {
		t.Fatal("nested source configuration was modified")
	}
}
