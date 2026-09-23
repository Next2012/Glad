package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// runSessions 通过已运行的 Glad HTTP 服务管理会话。
func runSessions(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: glad sessions [tools|list|create|delete]")
	}
	action := args[0]
	flags := flag.NewFlagSet("glad sessions "+action, flag.ContinueOnError)
	baseURL := flags.String("url", "http://127.0.0.1:3000", "running Glad URL")
	tool := flags.String("tool", "codex", "backend key")
	name := flags.String("name", "", "session name")
	cwd := flags.String("cwd", "", "working directory")
	instructionsFile := flags.String("instructions-file", "", "session instructions file")
	initialMessage := flags.String("initial-message", "", "message that starts the first turn")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	origin, err := url.Parse(*baseURL)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.RawQuery != "" || origin.Fragment != "" {
		return errors.New("invalid Glad URL")
	}
	endpoint := strings.TrimRight(origin.String(), "/") + "/api/sessions"
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	switch action {
	case "tools":
		endpoint = strings.TrimRight(origin.String(), "/") + "/api/tools"
		return requestSessionCLI(ctx, http.MethodGet, endpoint, nil)
	case "list":
		return requestSessionCLI(ctx, http.MethodGet, endpoint, nil)
	case "create":
		var instructions string
		if *instructionsFile != "" {
			data, err := os.ReadFile(*instructionsFile)
			if err != nil {
				return err
			}
			instructions = string(data)
		}
		body := CreateSessionRequest{
			ToolKey: *tool, Name: *name, WorkingDirectory: *cwd,
			Instructions: instructions, InitialMessage: *initialMessage,
		}
		return requestSessionCLI(ctx, http.MethodPost, endpoint, body)
	case "delete":
		if flags.NArg() != 1 {
			return errors.New("usage: glad sessions delete [--url URL] SESSION_ID")
		}
		return requestSessionCLI(ctx, http.MethodDelete, endpoint+"/"+url.PathEscape(flags.Arg(0)), nil)
	default:
		return fmt.Errorf("unknown sessions action: %s", action)
	}
}

func requestSessionCLI(ctx context.Context, method, endpoint string, body any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode >= 400 {
		var problem struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &problem)
		if problem.Error != "" {
			return errors.New(problem.Error)
		}
		return fmt.Errorf("Glad returned HTTP %d", response.StatusCode)
	}
	if len(data) > 0 {
		_, err = os.Stdout.Write(data)
		return err
	}
	return nil
}
