package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func supervisorMCPConfig(session *Session) map[string]any {
	return map[string]any{"command": session.mcpExecutable, "args": []string{"mcp"}, "env": map[string]string{"GLAD_SUPERVISOR_URL": session.mcpURL, "GLAD_SUPERVISOR_TOKEN": session.mcpToken, "GLAD_SUPERVISOR_SESSION": session.ID}}
}
func codexSupervisorArgs(session *Session) []string {
	if session.mcpURL == "" || session.mcpExecutable == "" {
		return nil
	}
	args := []string{}
	for _, key := range []string{"command", "args", "env"} {
		value, _ := json.Marshal(supervisorMCPConfig(session)[key])
		if key == "env" {
			entries := []string{}
			for _, name := range []string{"GLAD_SUPERVISOR_URL", "GLAD_SUPERVISOR_TOKEN", "GLAD_SUPERVISOR_SESSION"} {
				entries = append(entries, name+" = "+strconv.Quote(supervisorMCPConfig(session)["env"].(map[string]string)[name]))
			}
			value = []byte("{" + strings.Join(entries, ", ") + "}")
		}
		args = append(args, "-c", "mcp_servers.glad."+key+"="+string(value))
	}
	return args
}
func claudeSupervisorArgs(session *Session) []string {
	if session.mcpURL == "" || session.mcpExecutable == "" {
		return nil
	}
	config, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"glad": supervisorMCPConfig(session)}})
	return []string{"--mcp-config", string(config), "--allowedTools", "mcp__glad"}
}
func supervisorTools() []map[string]any {
	tools := []map[string]any{}
	for _, item := range []struct{ name, description string }{
		{"list_targets", "List monitored sessions and authorized operations for this supervisor invocation."},
		{"read_session", "Read live output or paginated history, including a session that is still running."},
		{"stop_session", "Interrupt the expected target turn. Read again before sending; stop acceptance does not mean the session is ready."},
		{"send_to_session", "Send a prompt to an idle target session. The command appears in the group."},
		{"end_supervision", "Finish this supervisor task and cancel future scheduled invocations."},
	} {
		properties := map[string]any{"invocationId": map[string]any{"type": "string", "description": "Invocation ID supplied in the current supervisor prompt. Required; old invocation IDs are rejected."}}
		required := []string{"invocationId"}
		if item.name != "list_targets" && item.name != "end_supervision" {
			properties["memberId"] = map[string]any{"type": "string"}
			required = append(required, "memberId")
		}
		switch item.name {
		case "read_session":
			properties["after"] = map[string]any{"type": "integer", "minimum": 0}
			properties["limit"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 200}
			properties["offset"] = map[string]any{"type": "integer", "minimum": 0}
			properties["history"] = map[string]any{"type": "boolean"}
		case "stop_session":
			properties["expectedTurnId"] = map[string]any{"type": "string"}
			required = append(required, "expectedTurnId")
		case "send_to_session":
			properties["text"] = map[string]any{"type": "string", "minLength": 1, "maxLength": 16384}
			required = append(required, "text")
		}
		tools = append(tools, map[string]any{"name": item.name, "description": item.description, "inputSchema": map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}})
	}
	return tools
}

// MCP uses newline-delimited stdio. Diagnostics never go to protocol stdout.
func runSupervisorMCP() error { return serveSupervisorMCP(os.Stdin, os.Stdout) }
func serveSupervisorMCP(input io.Reader, output io.Writer) error {
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
			response["result"] = map[string]any{"tools": supervisorTools()}
		case "tools/call":
			body := map[string]any{"sessionId": os.Getenv("GLAD_SUPERVISOR_SESSION"), "tool": request.Params["name"], "arguments": request.Params["arguments"], "callId": connectionID + ":" + string(request.ID)}
			result, err := callSupervisorDaemon(body)
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
func callSupervisorDaemon(body any) ([]byte, error) {
	endpoint, token := os.Getenv("GLAD_SUPERVISOR_URL"), os.Getenv("GLAD_SUPERVISOR_TOKEN")
	if endpoint == "" || token == "" {
		return nil, errors.New("Glad supervisor connection is not configured")
	}
	data, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/api/supervisor/call", bytes.NewReader(data))
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
