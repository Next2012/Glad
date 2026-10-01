package app

import (
	"os"
	"testing"
)

func TestWorkbenchWorkspacesRejectsStaleInventoryGeneration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store, err := openWorkbenchWorkspaces("合成版本校验")
	if err != nil {
		t.Fatal(err)
	}
	before := store.generation.Load()
	directory, err := store.acquire("editing:new-session", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store.release("editing:new-session")
	if err := store.reconcile([]string{}, before); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); err != nil {
		t.Fatal("旧清单删除了新会话目录")
	}
	if err := store.reconcile([]string{}, store.generation.Load()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("当前清单未清理已删除会话")
	}
}
