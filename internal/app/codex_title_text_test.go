package app

import (
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
