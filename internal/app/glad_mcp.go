package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

func gladMCPConfig(session *Session) map[string]any {
	return map[string]any{"command": session.mcpExecutable, "args": []string{"mcp"}, "env": map[string]string{"GLAD_MCP_URL": session.mcpURL, "GLAD_MCP_TOKEN": session.mcpToken, "GLAD_MCP_SESSION": session.ID}}
}
func codexGladArgs(session *Session) []string {
	if session.mcpURL == "" || session.mcpExecutable == "" {
		return nil
	}
	args := []string{}
	for _, key := range []string{"command", "args", "env"} {
		value, _ := json.Marshal(gladMCPConfig(session)[key])
		if key == "env" {
			entries := []string{}
			for _, name := range []string{"GLAD_MCP_URL", "GLAD_MCP_TOKEN", "GLAD_MCP_SESSION"} {
				entries = append(entries, name+" = "+strconv.Quote(gladMCPConfig(session)["env"].(map[string]string)[name]))
			}
			value = []byte("{" + strings.Join(entries, ", ") + "}")
		}
		args = append(args, "-c", "mcp_servers.glad."+key+"="+string(value))
	}
	// These local tools enforce the current group membership and Supervisor role in
	// the daemon. Permit them without an interactive prompt, including when the
	// user's shell approval policy is never; other servers and tools keep theirs.
	for _, tool := range allGladTools() {
		args = append(args, "-c", "mcp_servers.glad.tools."+stringValue(tool["name"])+".approval_mode=\"approve\"")
	}
	return args
}
func claudeGladArgs(session *Session) []string {
	if session.mcpURL == "" || session.mcpExecutable == "" {
		return nil
	}
	config, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"glad": gladMCPConfig(session)}})
	return []string{"--mcp-config", string(config), "--allowedTools", "mcp__glad"}
}
func validateGladArguments(name string, args map[string]any, definitions []map[string]any) error {
	for _, tool := range definitions {
		if tool["name"] != name {
			continue
		}
		schema := mapValue(tool["inputSchema"])
		properties := mapValue(schema["properties"])
		allowed := make([]string, 0, len(properties))
		for key := range properties {
			allowed = append(allowed, key)
		}
		sort.Strings(allowed)
		keys := make([]string, 0, len(args))
		for key := range args {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if _, exists := properties[key]; !exists {
				return fmt.Errorf("Unknown argument %q; allowed: %s", key, strings.Join(allowed, ", "))
			}
		}
		for _, key := range schema["required"].([]string) {
			value, exists := args[key]
			if !exists || value == nil {
				return fmt.Errorf("Argument %q is required", key)
			}
		}
		for _, key := range keys {
			definition := mapValue(properties[key])
			switch definition["type"] {
			case "string":
				if _, ok := args[key].(string); !ok {
					return fmt.Errorf("Argument %q must be a string", key)
				}
			case "boolean":
				if _, ok := args[key].(bool); !ok {
					return fmt.Errorf("Argument %q must be a boolean", key)
				}
			case "array":
				if err := validateGladArray(key, args[key], definition); err != nil {
					return err
				}
			case "object":
				data, err := json.Marshal(args[key])
				var value map[string]string
				if err != nil || json.Unmarshal(data, &value) != nil || value == nil {
					return fmt.Errorf("Argument %q must be an object of strings", key)
				}
			case "integer":
				data, err := json.Marshal(args[key])
				var number float64
				if args[key] == nil || err != nil || json.Unmarshal(data, &number) != nil || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number >= float64(math.MaxInt64) || number < math.MinInt64 {
					return fmt.Errorf("Argument %q must be an integer within the supported range", key)
				}
				if minimum, exists := definition["minimum"]; exists && number < float64(numberInt64(minimum)) {
					return fmt.Errorf("Argument %q must be at least %v", key, minimum)
				}
				if maximum, exists := definition["maximum"]; exists && number > float64(numberInt64(maximum)) {
					return fmt.Errorf("Argument %q must be at most %v", key, maximum)
				}
			}
		}
		return nil
	}
	return errors.New("Unknown Glad tool")
}

func validateGladArray(key string, value any, definition map[string]any) error {
	values, ok := value.([]any)
	if !ok {
		if items, valid := value.([]string); valid {
			values = make([]any, len(items))
			for i, item := range items {
				values[i] = item
			}
			ok = true
		}
	}
	if !ok {
		return fmt.Errorf("Argument %q must be an array", key)
	}
	if maximum, exists := definition["maxItems"]; exists && len(values) > int(numberInt64(maximum)) {
		return fmt.Errorf("Argument %q has too many items", key)
	}
	itemType := mapValue(definition["items"])["type"]
	for _, item := range values {
		if itemType == "string" {
			if _, valid := item.(string); !valid {
				return fmt.Errorf("Argument %q must contain strings", key)
			}
			continue
		}
		data, err := json.Marshal(item)
		var number float64
		if item == nil || err != nil || json.Unmarshal(data, &number) != nil || math.Trunc(number) != number || number < 1 || number > float64(math.MaxInt32) {
			return fmt.Errorf("Argument %q must contain positive integers", key)
		}
	}
	return nil
}

// MCP uses newline-delimited stdio. Diagnostics never go to protocol stdout.
func runGladMCP() error { return serveGladMCP(os.Stdin, os.Stdout) }
func serveGladMCP(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	encoder := json.NewEncoder(output)
	connectionID := newUUID()
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			continue
		}
		if len(request.ID) == 0 {
			continue
		}
		response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		switch request.Method {
		case "initialize":
			response["result"] = map[string]any{"protocolVersion": firstNonEmpty(stringValue(request.Params["protocolVersion"]), "2024-11-05"), "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "glad", "version": buildVersion}}
		case "ping":
			response["result"] = map[string]any{}
		case "tools/list":
			response["result"] = map[string]any{"tools": allGladTools()}
		case "tools/call":
			body := map[string]any{"sessionId": os.Getenv("GLAD_MCP_SESSION"), "tool": request.Params["name"], "arguments": request.Params["arguments"], "callId": connectionID + ":" + string(request.ID)}
			result, err := callGladDaemon(body)
			content := []map[string]any{{"type": "text", "text": string(result)}}
			if err != nil {
				content[0]["text"] = err.Error()
			}
			response["result"] = map[string]any{"content": content, "isError": err != nil}
		default:
			response["error"] = map[string]any{"code": -32601, "message": "Method not found"}
		}
		if err := encoder.Encode(response); err != nil {
			return err
		}
	}
	return scanner.Err()
}
func callGladDaemon(body any) ([]byte, error) {
	endpoint, token := os.Getenv("GLAD_MCP_URL"), os.Getenv("GLAD_MCP_TOKEN")
	if endpoint == "" || token == "" {
		return nil, errors.New("Glad MCP connection is not configured")
	}
	data, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/api/mcp/call", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 {
		var problem map[string]any
		_ = json.Unmarshal(result, &problem)
		return nil, fmt.Errorf("%s", firstNonEmpty(stringValue(problem["error"]), "HTTP "+strconv.Itoa(response.StatusCode)))
	}
	return result, nil
}
