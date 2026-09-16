package app

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// A small literal reader for persisted code-mode calls. It never evaluates
// JavaScript: expressions, interpolation and executable values are rejected.
type planToken struct {
	text   string
	quoted bool
}

func planTokens(source string) ([]planToken, bool) {
	var tokens []planToken
	for len(source) > 0 {
		c := source[0]
		if strings.ContainsRune(" \t\r\n", rune(c)) {
			source = source[1:]
			continue
		}
		if strings.HasPrefix(source, "//") {
			if end := strings.IndexByte(source, '\n'); end >= 0 {
				source = source[end+1:]
				continue
			}
			break
		}
		if strings.HasPrefix(source, "/*") {
			end := strings.Index(source[2:], "*/")
			if end < 0 {
				return nil, false
			}
			source = source[end+4:]
			continue
		}
		if c == '\'' || c == '"' || c == '`' {
			quote := c
			source = source[1:]
			var value strings.Builder
			for len(source) > 0 && source[0] != quote {
				if quote == '`' && strings.HasPrefix(source, "${") {
					return nil, false
				}
				if strings.HasPrefix(source, "\\\n") {
					source = source[2:]
					continue
				}
				var char rune
				if source[0] == '\\' {
					var err error
					char, _, source, err = strconv.UnquoteChar(source, quote)
					if err != nil {
						return nil, false
					}
				} else {
					var size int
					char, size = utf8.DecodeRuneInString(source)
					source = source[size:]
				}
				value.WriteRune(char)
			}
			if len(source) == 0 {
				return nil, false
			}
			source = source[1:]
			tokens = append(tokens, planToken{text: value.String(), quoted: true})
			continue
		}
		end := 0
		for end < len(source) && (source[end] >= 'a' && source[end] <= 'z' || source[end] >= 'A' && source[end] <= 'Z' ||
			source[end] >= '0' && source[end] <= '9' || source[end] == '_' || source[end] == '$') {
			end++
		}
		if end == 0 {
			end = 1
		}
		tokens = append(tokens, planToken{text: source[:end]})
		source = source[end:]
	}
	return tokens, true
}

type planLiteralReader struct {
	tokens []planToken
	index  int
	values map[string]any
}

func isCodePlanCall(tokens []planToken, index int) bool {
	return index+3 < len(tokens) && !tokens[index].quoted &&
		(index == 0 || tokens[index-1].text != ".") &&
		(tokens[index].text == "tools" || tokens[index].text == "functions") &&
		tokens[index+1].text == "." && tokens[index+2].text == "update_plan" && tokens[index+3].text == "("
}

func (reader *planLiteralReader) take(text string) bool {
	if reader.index < len(reader.tokens) && !reader.tokens[reader.index].quoted && reader.tokens[reader.index].text == text {
		reader.index++
		return true
	}
	return false
}

func (reader *planLiteralReader) value(depth int) (any, bool) {
	if reader.index >= len(reader.tokens) || depth > 16 {
		return nil, false
	}
	if reader.take("{") {
		value := map[string]any{}
		for !reader.take("}") {
			if reader.index >= len(reader.tokens) {
				return nil, false
			}
			key := reader.tokens[reader.index]
			reader.index++
			var entry any
			var ok bool
			if reader.take(":") {
				entry, ok = reader.value(depth + 1)
			} else if !key.quoted {
				entry, ok = reader.values[key.text]
			}
			if !ok {
				return nil, false
			}
			value[key.text] = entry
			if !reader.take(",") {
				if !reader.take("}") {
					return nil, false
				}
				break
			}
		}
		return value, true
	}
	if reader.take("[") {
		value := []any{}
		for !reader.take("]") {
			entry, ok := reader.value(depth + 1)
			if !ok {
				return nil, false
			}
			value = append(value, entry)
			if !reader.take(",") {
				if !reader.take("]") {
					return nil, false
				}
				break
			}
		}
		return value, true
	}
	token := reader.tokens[reader.index]
	reader.index++
	if token.quoted {
		return token.text, true
	}
	if token.text == "null" {
		return nil, true
	}
	value, ok := reader.values[token.text]
	return value, ok
}

// The boolean identifies a possible plan update. A nil plan means its arguments
// cannot be recovered statically; a successful call must then invalidate any
// older snapshot instead of displaying stale progress.
func codexCodePlan(source string) (map[string]any, bool) {
	if !strings.Contains(source, "update_plan") {
		return nil, false
	}
	tokens, ok := planTokens(source)
	if !ok {
		return nil, true
	}
	for i := range tokens {
		if isCodePlanCall(tokens, i) {
			return literalCodePlan(tokens), true
		}
	}
	return nil, false
}

// Recover literals and const-bound arrays without executing saved JavaScript.
// Conditional/function bodies and computed arguments remain unknown.
func literalCodePlan(tokens []planToken) map[string]any {
	for i, token := range tokens {
		if token.quoted {
			continue
		}
		switch token.text {
		case "if", "else", "for", "while", "switch", "function", "class", "return", "throw", "try", "catch", "?", "&", "|", "/":
			return nil
		case "=":
			if i+1 < len(tokens) && tokens[i+1].text == ">" {
				return nil
			}
		}
	}
	reader := planLiteralReader{tokens: tokens, values: map[string]any{}}
	var plan map[string]any
	for i := 0; i < len(tokens); i++ {
		if tokens[i].quoted {
			continue
		}
		if tokens[i].text == "const" && i+2 < len(tokens) && tokens[i+2].text == "=" {
			if tokens[i+1].text == "tools" || tokens[i+1].text == "functions" {
				return nil
			}
			reader.index = i + 3
			if value, ok := reader.value(0); ok && (reader.index == len(tokens) || tokens[reader.index].text == ";") {
				reader.values[tokens[i+1].text] = value
				i = reader.index - 1
				continue
			}
		}
		if _, bound := reader.values[tokens[i].text]; bound {
			// An alias used outside a literal declaration or plan argument may
			// have been mutated or passed to another function. Discard aliases.
			reader.values = map[string]any{}
		}
		if isCodePlanCall(tokens, i) {
			if i == 0 || tokens[i-1].text != "await" {
				return nil
			}
			reader.index = i + 4
			value, valid := reader.value(0)
			if !valid || !reader.take(")") {
				return nil
			}
			plan, valid = normalizeCodexHistoryPlan(mapValue(value))
			if !valid {
				return nil
			}
			i = reader.index - 1
		}
	}
	return plan
}
