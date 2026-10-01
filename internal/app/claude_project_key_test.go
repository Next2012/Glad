package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeLongProjectKeyMatchesInstalledCLIRule(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	cwd := "/root/data/Test/bot-link/artifacts/glad-session-workspace-20261001/home/.glad/workbench-workspaces/62da44d2c35d43c411da23c38b801d35a88471ffa80568cc8be7e442e70285e6/directories/cc5b31c33585400bc02e2a117327e8180677c4c770c448f8700198f3f4055dc9"
	directory := claudeProjectDir(cwd)
	if len(filepath.Base(directory)) != 207 || !strings.HasSuffix(directory, "-cir42l") {
		t.Fatalf("CLI长项目编码不匹配: %s", directory)
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	id := "31d01ca8-67bd-4397-b19d-23c92eef2d52"
	if err := os.WriteFile(filepath.Join(directory, id+".jsonl"), []byte("{\"type\":\"user\",\"uuid\":\"message\",\"message\":{\"content\":\"保留的历史\"}}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	messages, err := readClaudeTranscriptFile(cwd, id)
	if err != nil || len(messages) == 0 {
		t.Fatalf("长目录历史恢复失败: %v", err)
	}
}

func TestClaudeProjectKeyUsesUTF16Units(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	cwd := "/tmp/" + strings.Join(makeProjectNames(40), "/")
	if !strings.HasSuffix(claudeProjectDir(cwd), "-du0buw") {
		t.Fatal("Unicode项目目录哈希与CLI不一致")
	}
}

func makeProjectNames(count int) []string {
	names := make([]string, count)
	for i := range names {
		names[i] = "项目😀"
	}
	return names
}
