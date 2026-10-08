package app

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"path"
	"regexp"
	"strings"
)

const resourceDownloadsKey = "_mcpDownloads"

var downloadInstanceID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,63}$`)

type mcpDownload struct {
	URI  string
	Name string
}

func codexMCPDownloads(raw map[string]any, status string) []mcpDownload {
	if firstNonEmpty(status, stringValue(raw["status"]), "completed") != "completed" || raw["error"] != nil || raw["success"] == false {
		return nil
	}
	switch stringValue(raw["type"]) {
	case "mcpToolCall":
		return mcpDownloads(raw["result"])
	case "dynamicToolCall":
		// 当前 CLI 将 functions.exec 回执放在 contentItems，旧历史仍可能用 result。
		return mcpDownloads(firstNonNil(raw["contentItems"], raw["result"]))
	case "commandExecution":
		// MCP 客户端也可由命令调用；只扫描成功命令返回的结构化资源回执。
		if raw["exitCode"] != nil && numberInt64(raw["exitCode"]) != 0 {
			return nil
		}
		return mcpDownloads(raw["aggregatedOutput"])
	}
	return nil
}

// 只从成功工具回执提取原资源，不读取模型回复或猜测 sandbox 文件归属。
func mcpDownloads(value any) []mcpDownload {
	result := []mcpDownload{}
	seen := map[string]bool{}
	nodes := 0
	var walk func(any, int)
	walk = func(value any, depth int) {
		nodes++
		if depth > 16 || nodes > 4096 || len(result) >= 64 {
			return
		}
		switch value := value.(type) {
		case map[string]any:
			if boolValue(value["isError"]) || boolValue(value["is_error"]) || value["ok"] == false || value["error"] != nil {
				return
			}
			switch stringValue(value["status"]) {
			case "failed", "cancelled", "canceled", "accepted", "queued", "running":
				return
			}
			uri := firstNonEmpty(stringValue(value["resource_uri"]), stringValue(value["uri"]))
			mediaType := firstNonEmpty(stringValue(value["media_type"]), stringValue(value["mimeType"]))
			if mediaType == "application/pdf" && !seen[uri] {
				if name, ok := mcpDownloadName(uri); ok {
					seen[uri] = true
					result = append(result, mcpDownload{URI: uri, Name: name})
				}
			}
			// 不扫描附件正文或命令输入；text 可包含 SDK 包装的 JSON 回执。
			for _, key := range []string{"structuredContent", "data", "result", "content", "contents", "resource", "text", "output"} {
				if child, ok := value[key]; ok {
					walk(child, depth+1)
				}
			}
		case []any:
			for _, child := range value {
				walk(child, depth+1)
			}
		case string:
			if len(value) > 8<<20 || !strings.Contains(value, "botlink-hub://resource/") {
				return
			}
			var decoded any
			if json.Unmarshal([]byte(value), &decoded) == nil {
				walk(decoded, depth+1)
				return
			}
			// 原生 CLI 的多段输出常在说明行后带一个完整 JSON 回执。
			for _, line := range strings.Split(value, "\n") {
				if json.Unmarshal([]byte(line), &decoded) == nil {
					walk(decoded, depth+1)
				}
			}
		}
	}
	walk(value, 0)
	return result
}

func mcpDownloadName(uri string) (string, bool) {
	if len(uri) > 8192 || !strings.HasPrefix(uri, "botlink-hub://resource/") {
		return "", false
	}
	parsed, err := url.Parse(uri)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if len(parts) != 3 || (parts[0] != "software" && parts[0] != "hardware") || !downloadInstanceID.MatchString(parts[1]) {
		return "", false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !strings.HasPrefix(string(decoded), "botlink://") {
		return "", false
	}
	original, err := url.Parse(string(decoded))
	if err != nil {
		return "", false
	}
	name := path.Base(original.Path)
	if name == "." || name == "/" || name == "" {
		name = "document.pdf"
	}
	// 文件名仅是显示标签，链接始终使用回执中的原 URI。
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name)
	return name, true
}

func resourceDownloadMessage(messages []map[string]any, sessionID, turnID string) map[string]any {
	if turnID == "" {
		return nil
	}
	var end map[string]any
	for _, message := range messages {
		if message["kind"] == "turn-end" && stringValue(message["turnId"]) == turnID {
			end = message
		}
	}
	if end == nil || end["isRootTurn"] == false {
		return nil
	}
	seen := map[string]bool{}
	lines := []string{}
	escape := strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "*", "\\*", "_", "\\_")
	for _, message := range messages {
		if stringValue(message["turnId"]) != turnID {
			continue
		}
		if thread := stringValue(message["threadId"]); thread != "" && stringValue(end["threadId"]) != "" && thread != stringValue(end["threadId"]) {
			continue
		}
		for _, item := range downloadsFromMessage(message) {
			if seen[item.URI] || len(lines) >= 64 {
				continue
			}
			seen[item.URI] = true
			link := "/api/sessions/" + url.PathEscape(sessionID) + "/mcp-resource?uri=" + url.QueryEscape(item.URI)
			lines = append(lines, "[打开 / 下载 "+escape.Replace(item.Name)+"]("+link+")")
		}
	}
	if len(lines) == 0 {
		return nil
	}
	digest := sha256.Sum256([]byte(sessionID + "\n" + stringValue(end["threadId"]) + "\n" + turnID))
	return map[string]any{
		"id": "mcp-downloads-" + hex.EncodeToString(digest[:16]), "kind": "assistant",
		"text": "本轮文件：\n\n" + strings.Join(lines, "\n\n"), "turnId": turnID,
		"threadId": end["threadId"], "createdAt": end["createdAt"], "streaming": false,
	}
}

func downloadsFromMessage(message map[string]any) []mcpDownload {
	if values, ok := message[resourceDownloadsKey].([]mcpDownload); ok {
		return values
	}
	return nil
}

// 使用既有 assistant message 事件，下载入口不需要新增前后端协议。
func (session *Session) syncResourceDownloadsLocked(turnID string) {
	message := resourceDownloadMessage(session.Messages, session.ID, turnID)
	if message == nil {
		return
	}
	for _, existing := range session.Messages {
		if existing["id"] != message["id"] {
			continue
		}
		if existing["text"] != message["text"] {
			existing["text"] = message["text"]
			session.publishLocked(map[string]any{"type": "message-updated", "message": publicMessage(existing, session.Kind)})
		}
		return
	}
	session.Messages = append(session.Messages, message)
	session.publishLocked(map[string]any{"type": "message", "message": publicMessage(message, session.Kind)})
}

func withResourceDownloads(messages []map[string]any, sessionID string) []map[string]any {
	result := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		if strings.HasPrefix(stringValue(message["id"]), "mcp-downloads-") {
			continue
		}
		result = append(result, message)
		if message["kind"] == "turn-end" {
			if download := resourceDownloadMessage(result, sessionID, stringValue(message["turnId"])); download != nil {
				result = append(result, download)
			}
		}
	}
	return result
}
