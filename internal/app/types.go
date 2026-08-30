package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type ToolInfo struct {
	Key         string   `json:"key"`
	Command     string   `json:"command"`
	Args        []string `json:"args"`
	DisplayName string   `json:"displayName"`
	Description string   `json:"description"`
	Website     string   `json:"website"`
	Version     string   `json:"version,omitempty"`
	Installed   bool     `json:"installed"`
}

var supportedTools = []ToolInfo{
	{
		Key:         "claude-code",
		Command:     "claude",
		Args:        []string{},
		DisplayName: "Claude",
		Description: "Anthropic's AI coding assistant",
		Website:     "https://code.claude.com",
	},
	{
		Key:         "codex",
		Command:     "codex",
		Args:        []string{},
		DisplayName: "Codex",
		Description: "Official OpenAI Codex CLI",
		Website:     "https://developers.openai.com/codex",
	},
}

func detectTools(ctx context.Context) []ToolInfo {
	result := make([]ToolInfo, 0, len(supportedTools))
	for _, candidate := range supportedTools {
		tool := candidate
		path, err := exec.LookPath(tool.Command)
		if err != nil {
			result = append(result, tool)
			continue
		}
		tool.Command = path
		versionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		output, err := exec.CommandContext(versionCtx, path, "--version").CombinedOutput()
		cancel()
		tool.Installed = true
		if err == nil {
			tool.Version = strings.TrimSpace(string(output))
		}
		if tool.Version == "" {
			tool.Version = "unknown"
		}
		result = append(result, tool)
	}
	return result
}

func toolByKey(key string) (ToolInfo, bool) {
	for _, tool := range detectTools(context.Background()) {
		if tool.Key == key {
			return tool, true
		}
	}
	return ToolInfo{}, false
}

func newUUID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes)
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:])
}

func writeJSON(writer io.Writer, value any) {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}

func commandForPlatform(name string, args ...string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		all := append([]string{"/d", "/s", "/c", name}, args...)
		return exec.Command("cmd.exe", all...)
	}
	return exec.Command(name, args...)
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func mapValue(value any) map[string]any {
	if result, ok := value.(map[string]any); ok {
		return result
	}
	return map[string]any{}
}

func sliceValue(value any) []any {
	switch result := value.(type) {
	case []any:
		return result
	case []string:
		items := make([]any, len(result))
		for index, item := range result {
			items[index] = item
		}
		return items
	}
	return nil
}

func millis() int64 { return time.Now().UnixMilli() }

func atoiDefault(value string, fallback int) int {
	number, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return number
}
