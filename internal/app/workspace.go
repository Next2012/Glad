package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxWorkspaceCommandOutput = 16 << 20
const maxWorkspaceFileBytes = 4 << 20

var gitObjectPattern = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

func (server *Server) registerWorkspaceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sessions/{id}/git-show/{hash}", server.gitShow)
	mux.HandleFunc("GET /api/sessions/{id}/git-branch/{hash}", server.gitBranch)
	mux.HandleFunc("GET /api/sessions/{id}/git-log", server.gitLog)
	mux.HandleFunc("GET /api/sessions/{id}/git-status", server.gitStatus)
	mux.HandleFunc("GET /api/sessions/{id}/git-diff-numstat", server.gitDiffNumstat)
	mux.HandleFunc("GET /api/sessions/{id}/git-diff-file", server.gitDiffFile)
	mux.HandleFunc("GET /api/sessions/{id}/file", server.workspaceFile)
	mux.HandleFunc("GET /api/sessions/{id}/fs/dir", server.workspaceDirectory)
}

type commandResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Stdout  string `json:"stdout"`
	Stderr  string `json:"stderr"`
}

type limitedCommandBuffer struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (buffer *limitedCommandBuffer) Write(value []byte) (int, error) {
	remaining := buffer.limit - buffer.Len()
	if remaining <= 0 {
		buffer.exceeded = true
		return 0, errors.New("command output limit exceeded")
	}
	if len(value) > remaining {
		_, _ = buffer.Buffer.Write(value[:remaining])
		buffer.exceeded = true
		return remaining, errors.New("command output limit exceeded")
	}
	return buffer.Buffer.Write(value)
}

func runCommand(ctx context.Context, cwd, name string, args ...string) commandResult {
	commandCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(commandCtx, name, args...)
	command.Dir = cwd
	stdout := &limitedCommandBuffer{limit: maxWorkspaceCommandOutput}
	stderr := &limitedCommandBuffer{limit: maxWorkspaceCommandOutput}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	result := commandResult{Success: err == nil, Stdout: stdout.String(), Stderr: stderr.String()}
	if stdout.exceeded || stderr.exceeded {
		result.Success = false
		result.Error = "Command output exceeded 16 MB"
	} else if errors.Is(commandCtx.Err(), context.DeadlineExceeded) {
		result.Success = false
		result.Error = "Command timed out after 30 seconds"
	} else if err != nil {
		result.Error = err.Error()
	}
	return result
}
func (server *Server) sessionForRoute(writer http.ResponseWriter, request *http.Request) (*Session, bool) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return nil, false
	}
	return session, true
}
func (server *Server) gitShow(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	hash := request.PathValue("hash")
	if !gitObjectPattern.MatchString(hash) {
		respondError(writer, 400, errors.New("Invalid Git object id"))
		return
	}
	result := runCommand(
		request.Context(),
		session.WorkingDirectory,
		"git",
		"show",
		"--format=fuller",
		"--stat",
		"-p",
		hash,
	)
	respondJSON(writer, 200, result)
}
func (server *Server) gitBranch(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	hash := request.PathValue("hash")
	if !gitObjectPattern.MatchString(hash) {
		respondError(writer, 400, errors.New("Invalid Git object id"))
		return
	}
	result := runCommand(
		request.Context(),
		session.WorkingDirectory,
		"git",
		"name-rev",
		"--name-only",
		"--exclude=tags/*",
		hash,
	)
	respondJSON(writer, 200, result)
}
func (server *Server) gitLog(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	count := atoiDefault(request.URL.Query().Get("maxCount"), 100)
	if count < 1 {
		count = 1
	}
	if count > 500 {
		count = 500
	}
	result := runCommand(
		request.Context(),
		session.WorkingDirectory,
		"git",
		"log",
		"--all",
		"--date-order",
		"--max-count="+strconv.Itoa(count),
		"--pretty=format:%h|%p|%d|%s|%an|%ar",
	)
	if !result.Success {
		respondJSON(writer, 500, map[string]any{"error": result.Error, "stderr": result.Stderr})
		return
	}
	commits := []map[string]any{}
	for _, line := range strings.Split(result.Stdout, "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 6)
		for len(parts) < 6 {
			parts = append(parts, "")
		}
		parents := []string{}
		if parts[1] != "" {
			parents = strings.Split(parts[1], " ")
		}
		commits = append(
			commits,
			map[string]any{
				"hash":    parts[0],
				"parents": parents,
				"refs":    strings.TrimSpace(parts[2]),
				"subject": parts[3],
				"author":  parts[4],
				"time":    parts[5],
			},
		)
	}
	respondJSON(writer, 200, map[string]any{"success": true, "commits": commits})
}
func parseGitStatus(output string) []map[string]any {
	records := strings.Split(output, "\x00")
	files := []map[string]any{}
	for index := 0; index < len(records); index++ {
		record := records[index]
		if len(record) < 3 {
			continue
		}
		status, path := record[:2], record[3:]
		item := map[string]any{"path": path, "status": status}
		if (strings.Contains(status, "R") || strings.Contains(status, "C")) && index+1 < len(records) {
			index++
			item["originalPath"] = records[index]
		}
		files = append(files, item)
	}
	return files
}
func (server *Server) gitStatus(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	result := runCommand(request.Context(), session.WorkingDirectory, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if !result.Success {
		respondJSON(writer, 500, map[string]any{"error": result.Error, "stderr": result.Stderr})
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "files": parseGitStatus(result.Stdout)})
}
func (server *Server) gitDiffNumstat(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	args := []string{"diff"}
	if request.URL.Query().Get("staged") == "true" {
		args = append(args, "--cached")
	}
	args = append(args, "--numstat")
	respondJSON(writer, 200, runCommand(request.Context(), session.WorkingDirectory, "git", args...))
}
func (server *Server) gitDiffFile(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	filename := request.URL.Query().Get("path")
	if filename == "" {
		respondError(writer, 400, errors.New("Missing file path"))
		return
	}
	args := []string{"diff"}
	if request.URL.Query().Get("staged") == "true" {
		args = append(args, "--cached")
	}
	args = append(args, "--no-ext-diff", "--", filename)
	respondJSON(writer, 200, runCommand(request.Context(), session.WorkingDirectory, "git", args...))
}
func resolveInside(root, target string) (string, error) {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	requested := filepath.Join(realRoot, target)
	resolved, err := filepath.EvalSymlinks(requested)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(realRoot, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("Access denied")
	}
	return resolved, nil
}
func (server *Server) workspaceFile(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	filename := request.URL.Query().Get("path")
	if filename == "" {
		respondError(writer, 400, errors.New("Missing file path"))
		return
	}
	resolved, err := resolveInside(session.WorkingDirectory, filename)
	if err != nil {
		respondJSON(writer, 200, map[string]any{"success": false, "error": err.Error()})
		return
	}
	info, err := os.Stat(resolved)
	if err != nil {
		respondJSON(writer, 200, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if info.IsDir() || info.Size() > maxWorkspaceFileBytes {
		respondJSON(writer, 200, map[string]any{"success": false, "error": "File is not a regular text file or exceeds 4 MB"})
		return
	}
	file, err := os.Open(resolved)
	if err != nil {
		respondJSON(writer, 200, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxWorkspaceFileBytes+1))
	if err != nil || len(content) > maxWorkspaceFileBytes {
		respondJSON(writer, 200, map[string]any{"success": false, "error": "Unable to read file within the 4 MB limit"})
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "content": string(content)})
}
func (server *Server) workspaceDirectory(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	relative := request.URL.Query().Get("path")
	resolved, err := resolveInside(session.WorkingDirectory, relative)
	if err != nil {
		respondJSON(writer, 200, map[string]any{"success": false, "error": err.Error()})
		return
	}
	entries, err := os.ReadDir(resolved)
	if err != nil {
		respondJSON(writer, 200, map[string]any{"success": false, "error": err.Error()})
		return
	}
	files := []map[string]any{}
	gitStatuses := map[string]string{}
	if result := runCommand(request.Context(), session.WorkingDirectory, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all"); result.Success {
		for _, item := range parseGitStatus(result.Stdout) {
			gitStatuses[stringValue(item["path"])] = stringValue(item["status"])
		}
	}
	for _, entry := range entries {
		itemPath := entry.Name()
		if relative != "" {
			itemPath = filepath.ToSlash(filepath.Join(relative, entry.Name()))
		}
		var status any
		if entry.IsDir() {
			for filename := range gitStatuses {
				if strings.HasPrefix(filename, itemPath+"/") {
					status = "M"
					break
				}
			}
		} else if value, ok := gitStatuses[itemPath]; ok {
			status = value
		}
		files = append(files, map[string]any{"name": entry.Name(), "isDirectory": entry.IsDir(), "gitStatus": status})
	}
	sort.Slice(files, func(i, j int) bool {
		left, right := boolValue(files[i]["isDirectory"]), boolValue(files[j]["isDirectory"])
		if left != right {
			return left
		}
		return stringValue(files[i]["name"]) < stringValue(files[j]["name"])
	})
	respondJSON(writer, 200, map[string]any{"success": true, "files": files})
}
