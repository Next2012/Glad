package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSupervisorCommandContentFieldsAndByteLimit(t *testing.T) {
	for _, test := range []struct {
		name            string
		args            map[string]any
		text, errorText string
	}{
		{"text", map[string]any{"text": "继续开发"}, "继续开发", ""},
		{"message alias", map[string]any{"message": "请继续开发，先完成当前步骤。"}, "请继续开发，先完成当前步骤。", ""},
		{"matching aliases", map[string]any{"text": "work", "message": "work"}, "work", ""},
		{"missing", map[string]any{}, "", "required"},
		{"empty", map[string]any{"message": " \n "}, "", "empty"},
		{"non-string", map[string]any{"text": 123}, "", "must be a string"},
		{"ambiguous", map[string]any{"text": "first", "message": "second"}, "", "must match"},
		{"limit", map[string]any{"text": strings.Repeat("a", maxRoomMessageBytes)}, strings.Repeat("a", maxRoomMessageBytes), ""},
		{"UTF-8 limit", map[string]any{"message": strings.Repeat("中", maxRoomMessageBytes/3+1)}, "", "exceeds 16 KiB"},
	} {
		t.Run(test.name, func(t *testing.T) {
			text, err := supervisorCommandText(test.args)
			if test.errorText != "" {
				if err == nil || !strings.Contains(err.Error(), test.errorText) {
					t.Fatalf("expected %s, got %v", test.errorText, err)
				}
				return
			}
			if err != nil || text != test.text {
				t.Fatalf("unexpected command/result: %q %v", text, err)
			}
		})
	}
}

func TestSupervisorSendMessageAliasThroughRealMCPBridge(t *testing.T) {
	manager, executor, task, roomID := supervisorControlFixture(t)
	manager.mu.Lock()
	manager.tasks[task.ID].Targets[0].Send = true
	manager.mu.Unlock()
	startSupervisorTest(t, manager, roomID, task.ID)
	inv := manager.List(roomID)[0].Invocations[0]
	server := &Server{supervisors: manager, rooms: manager.rooms, sessions: manager.sessions}
	mux := http.NewServeMux()
	server.registerSupervisorRoutes(mux)
	daemon := httptest.NewServer(mux)
	defer daemon.Close()
	executor.session.mcpToken = "test-command-token"
	t.Setenv("GLAD_SUPERVISOR_URL", daemon.URL)
	t.Setenv("GLAD_SUPERVISOR_TOKEN", executor.session.mcpToken)
	t.Setenv("GLAD_SUPERVISOR_SESSION", executor.session.ID)
	command := "请继续执行既定计划，完成后汇报验证结果。"
	request := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "send_to_session", "arguments": map[string]any{"invocationId": inv.ID, "memberId": task.Targets[0].MemberID, "message": command}}}
	encoded, _ := json.Marshal(request)
	var output strings.Builder
	if err := serveSupervisorMCP(strings.NewReader(string(encoded)+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	_ = json.Unmarshal([]byte(output.String()), &reply)
	if boolValue(mapValue(reply["result"])["isError"]) {
		t.Fatalf("MCP rejected short message: %s", output.String())
	}
	record, err := manager.rooms.GetRecord(roomID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range record.Entries {
		if entry.Type == "user" && entry.UserText == command && entry.SenderMemberID == task.ExecutorMemberID {
			found = true
		}
	}
	if !found {
		t.Fatal("alias command did not reach the target group dispatch")
	}
	// Missing content is diagnosed and audited; it must not look like a size error.
	_, err = manager.Call(context.Background(), executor.session, "send_to_session", "missing", map[string]any{"invocationId": inv.ID, "memberId": task.Targets[0].MemberID})
	if err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("wrong missing-content error: %v", err)
	}
	run := manager.List(roomID)[0].Invocations[0]
	last := run.Calls[len(run.Calls)-1]
	if last.Success || !strings.Contains(last.Summary, "required") {
		t.Fatal("invalid command was not audited")
	}
}

func TestSupervisorSendSchemaAdvertisesBothContentFields(t *testing.T) {
	for _, tool := range supervisorTools() {
		if tool["name"] != "send_to_session" {
			continue
		}
		schema := mapValue(tool["inputSchema"])
		properties := mapValue(schema["properties"])
		if properties["text"] == nil || properties["message"] == nil {
			t.Fatal("alias is not advertised to MCP clients")
		}
		return
	}
	t.Fatal("send tool not found")
}

func TestSupervisorSchemasUsePortableObjectRoots(t *testing.T) {
	for _, tool := range supervisorTools() {
		schema := mapValue(tool["inputSchema"])
		if schema["type"] != "object" || schema["additionalProperties"] != false {
			t.Fatalf("invalid object contract for %s", tool["name"])
		}
		for _, key := range []string{"anyOf", "oneOf", "allOf"} {
			if _, exists := schema[key]; exists {
				t.Fatalf("%s has a top-level %s", tool["name"], key)
			}
		}
		if tool["name"] == "send_to_session" {
			for _, key := range schema["required"].([]string) {
				if key == "text" || key == "message" {
					t.Fatal("content alternatives must be checked by the backend")
				}
			}
			for _, key := range []string{"text", "message"} {
				if mapValue(mapValue(schema["properties"])[key])["maxLength"] != nil {
					t.Fatal("a character limit cannot describe the UTF-8 byte limit")
				}
			}
		}
	}
}

func TestSupervisorCodexApprovalOverridesOnlyGladTools(t *testing.T) {
	session := newSession("approval-test", "Test", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	session.mcpURL, session.mcpExecutable, session.mcpToken = "http://127.0.0.1:3005", "/tmp/glad", "test-token"
	args := codexSupervisorArgs(session)
	settings := map[string]string{}
	for i := 0; i < len(args); i += 2 {
		if args[i] != "-c" {
			t.Fatalf("unexpected argument %q", args[i])
		}
		pair := strings.SplitN(args[i+1], "=", 2)
		if !strings.HasPrefix(pair[0], "mcp_servers.glad.") {
			t.Fatal("Glad changed unrelated approval or sandbox configuration")
		}
		settings[pair[0]] = pair[1]
	}
	for _, tool := range supervisorTools() {
		if settings["mcp_servers.glad.tools."+stringValue(tool["name"])+".approval_mode"] != `"approve"` {
			t.Fatalf("Glad tool %s would require interactive approval", tool["name"])
		}
	}
	if len(settings) != 3+len(supervisorTools()) {
		t.Fatal("unexpected server-wide or unrelated overrides")
	}
}

func TestSupervisorArgumentsRejectUnknownFieldsAndInvalidTypes(t *testing.T) {
	manager, executor, task, roomID := supervisorControlFixture(t)
	startSupervisorTest(t, manager, roomID, task.ID)
	inv := manager.List(roomID)[0].Invocations[0]
	for _, test := range []struct {
		tool, key string
		value     any
		want      string
	}{
		{"read_session", "limt", 20, `Unknown argument "limt"; allowed:`},
		{"read_session", "limit", "20", "must be an integer"},
		{"read_session", "limit", nil, "must be an integer"},
		{"read_session", "limit", 1.5, "must be an integer"},
		{"read_session", "limit", 201, "must be at most 200"},
		{"read_session", "after", -1, "must be at least 0"},
		{"read_session", "history", "true", "must be a boolean"},
		{"list_targets", "memberId", task.Targets[0].MemberID, "Unknown argument"},
	} {
		t.Run(test.tool+"/"+test.key+"/"+test.want, func(t *testing.T) {
			args := map[string]any{"invocationId": inv.ID}
			if test.tool != "list_targets" {
				args["memberId"] = task.Targets[0].MemberID
			}
			args[test.key] = test.value
			_, err := manager.Call(context.Background(), executor.session, test.tool, "invalid-argument", args)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %s: %v", test.want, err)
			}
			run := manager.List(roomID)[0].Invocations[0]
			last := run.Calls[len(run.Calls)-1]
			if last.Success || !strings.Contains(last.Summary, test.want) {
				t.Fatal("rejected arguments were not audited")
			}
		})
	}
	_, err := manager.Call(context.Background(), executor.session, "read_session", "valid", map[string]any{"invocationId": inv.ID, "memberId": task.Targets[0].MemberID, "limit": float64(50)})
	if err != nil {
		t.Fatalf("rejected JSON integer: %v", err)
	}
	_, err = manager.Call(context.Background(), executor.session, "read_session", "outside", map[string]any{"invocationId": "old", "unknown": true})
	if err == nil || !strings.Contains(err.Error(), "not an authorized supervisor invocation") {
		t.Fatal("arguments were checked before invocation authorization")
	}
}
