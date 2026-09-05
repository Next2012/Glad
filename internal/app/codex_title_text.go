package app

// Bounded title prompts and structured-output parsing, following Codex CLI's
// thread_title.rs. Kept independent from RPC and session lifecycle handling.
import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

const codexTitleLimit = 36
const codexTitlePromptBytes = 960

const codexTitleInstructions = "Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request."

func codexTitleText(text string) string {
	runes := []rune(strings.Join(strings.Fields(text), " "))
	if len(runes) > codexTitleLimit {
		runes = runes[:codexTitleLimit]
	}
	return string(runes)
}

func titleBound(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	for limit > 0 && !utf8.RuneStart(text[limit]) {
		limit--
	}
	return text[:limit]
}

func codexFirstTitlePrompt(text string) string {
	prefix := codexTitleInstructions + "\n\nUser prompt:\n"
	return prefix + titleBound(strings.TrimSpace(text), codexTitlePromptBytes-len(prefix))
}

func codexRecentTitlePrompt(turns []any) (string, string) {
	type message struct{ role, text string }
	messages := []message{}
	for _, value := range turns {
		items := sliceValue(mapValue(value)["items"])
		for i := len(items) - 1; i >= 0 && len(messages) < 8; i-- {
			item := mapValue(items[i])
			role, text := "", ""
			if item["type"] == "userMessage" {
				role, text = "user", textFromCodexInput(item["content"])
			}
			if item["type"] == "agentMessage" && item["phase"] != "commentary" {
				role, text = "assistant", stringValue(item["text"])
			}
			if strings.TrimSpace(text) != "" {
				messages = append(messages, message{role, strings.TrimSpace(text)})
			}
		}
	}
	if len(messages) == 0 {
		return "", ""
	}
	provisional := messages[0].text
	for _, msg := range messages {
		if msg.role == "user" {
			provisional = msg.text
			break
		}
	}
	prefix := codexTitleInstructions + "\nPrioritize the current task and latest substantive user request.\n\nRecent conversation messages:\n"
	markupBytes := len("<conversation>\n\n</conversation>") + len(messages) - 1
	for _, msg := range messages {
		markupBytes += len("<message role=\"\"></message>") + len(msg.role)
	}
	perMessage := (codexTitlePromptBytes - len(prefix) - markupBytes) / len(messages)
	parts := []string{}
	for i := len(messages) - 1; i >= 0; i-- {
		msg := messages[i]
		escaped := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(titleBound(msg.text, codexTitlePromptBytes))
		escaped = titleBound(escaped, perMessage)
		if start := strings.LastIndex(escaped, "&"); start >= 0 && !strings.Contains(escaped[start:], ";") {
			escaped = escaped[:start]
		}
		parts = append(parts, fmt.Sprintf("<message role=\"%s\">%s</message>", msg.role, escaped))
	}
	return prefix + "<conversation>\n" + strings.Join(parts, "\n") + "\n</conversation>", codexTitleText(provisional)
}

func parseCodexTitle(text string) (string, error) {
	var value struct {
		Title string `json:"title"`
	}
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return "", errors.New("invalid trailing title response")
	}
	name := strings.Trim(strings.TrimSpace(value.Title), "\"'`“”‘’")
	name = strings.TrimSpace(strings.TrimRight(strings.Join(strings.Fields(name), " "), ".?!"))
	if name == "" {
		return "", errors.New("empty title")
	}
	return codexTitleText(name), nil
}
