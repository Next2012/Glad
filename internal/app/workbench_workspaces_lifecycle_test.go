package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// 所有用例都隔离 HOME，只使用合成会话和文件，避免访问开发机的 CLI 凭据。
func isolatedWorkbenchWorkspaces(t *testing.T, scope string) *workbenchWorkspaces {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store, err := openWorkbenchWorkspaces(scope)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func workspaceAcquire(t *testing.T, store *workbenchWorkspaces, key string) string {
	t.Helper()
	directory, err := store.acquire(key, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func workspaceWriteMarker(t *testing.T, directory string) string {
	t.Helper()
	path := filepath.Join(directory, "user-work.txt")
	if err := os.WriteFile(path, []byte("用户会话文件"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func workspaceAssertExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected path to remain: %s: %v", path, err)
	}
}

func workspaceAssertAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("expected path to be removed: %s: %v", path, err)
	}
}

func TestWorkbenchWorkspacesStableReconnectAndOfflineDelete(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "workbench-a\nglad-a")
	key := "editing:stable-session"
	directory := workspaceAcquire(t, store, key)
	marker := workspaceWriteMarker(t, directory)
	if second := workspaceAcquire(t, store, key); second != directory {
		t.Fatal("same session received a different directory")
	}
	store.release(key)
	if err := store.remove(key); err == nil {
		t.Fatal("deleted a directory still held by a runtime")
	}
	store.release(key)
	// 暂停、断开仅释放占用；工作台 Session 仍在完整清单中。
	for i := 0; i < 3; i++ {
		if err := store.reconcile([]string{key}); err != nil {
			t.Fatal(err)
		}
		workspaceAssertExists(t, marker)
	}
	reopened, err := openWorkbenchWorkspaces("workbench-a\nglad-a")
	if err != nil {
		t.Fatal(err)
	}
	if resumed := workspaceAcquire(t, reopened, key); resumed != directory {
		t.Fatal("reconnection changed the working directory")
	}
	workspaceAssertExists(t, marker)
	reopened.release(key)
	// 离线删除后下次心跳发送显式空清单，重复对照保持幂等。
	for i := 0; i < 3; i++ {
		if err := reopened.reconcile([]string{}); err != nil {
			t.Fatal(err)
		}
	}
	workspaceAssertAbsent(t, directory)
	if len(reopened.records) != 0 {
		t.Fatal("offline-deleted session remained registered")
	}
}

func TestWorkbenchWorkspacesKeysAndScopesAreIsolated(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "workbench-a\nglad-a")
	a := workspaceAcquire(t, store, "editing:same-id")
	b := workspaceAcquire(t, store, "running:same-id")
	c := workspaceAcquire(t, store, "editing:other-id")
	otherScope, err := openWorkbenchWorkspaces("workbench-b\nglad-a")
	if err != nil {
		t.Fatal(err)
	}
	d := workspaceAcquire(t, otherScope, "editing:same-id")
	otherGlad, err := openWorkbenchWorkspaces("workbench-a\nglad-b")
	if err != nil {
		t.Fatal(err)
	}
	e := workspaceAcquire(t, otherGlad, "editing:same-id")
	seen := map[string]bool{}
	for _, dir := range []string{a, b, c, d, e} {
		if seen[dir] {
			t.Fatalf("distinct session/scope shared a directory: %s", dir)
		}
		seen[dir] = true
	}
	store.release("editing:same-id")
	if err := store.remove("editing:same-id"); err != nil {
		t.Fatal(err)
	}
	workspaceAssertAbsent(t, a)
	for _, dir := range []string{b, c, d, e} {
		workspaceAssertExists(t, dir)
	}
}

func TestWorkbenchWorkspacesReferencesAndRetainedHistorySurviveReopen(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	a := workspaceAcquire(t, store, "editing:a")
	b := workspaceAcquire(t, store, "running:b")
	c := workspaceAcquire(t, store, "editing:c")
	store.release("editing:a")
	store.release("running:b")
	store.release("editing:c")
	if err := store.adopt("running:b", a, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	store.release("running:b")
	if err := store.adopt("running:b", c, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	store.release("running:b")
	reopened, err := openWorkbenchWorkspaces("scope")
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"editing:a", "editing:c"} {
		if err := reopened.remove(key); err != nil {
			t.Fatal(err)
		}
	}
	for _, dir := range []string{a, b, c} {
		workspaceAssertExists(t, dir)
	}
	if err := reopened.reconcile([]string{"running:b"}); err != nil {
		t.Fatal(err)
	}
	if err := reopened.remove("running:b"); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{a, b, c} {
		workspaceAssertAbsent(t, dir)
	}
}

func TestWorkbenchWorkspacesRepeatedAdoptionAndFinalReconcile(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	a := workspaceAcquire(t, store, "editing:a")
	b := workspaceAcquire(t, store, "running:b")
	store.release("editing:a")
	store.release("running:b")
	for _, dir := range []string{a, b, a, b, a} {
		if err := store.adopt("running:b", dir, ""); err != nil {
			t.Fatal(err)
		}
		store.release("running:b")
	}
	if err := store.reconcile([]string{}); err != nil {
		t.Fatal(err)
	}
	workspaceAssertAbsent(t, a)
	workspaceAssertAbsent(t, b)
	if err := store.reconcile([]string{}); err != nil {
		t.Fatal(err)
	}
}

func TestWorkbenchWorkspacesLegacyDirectoriesAreNeverDeleted(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	legacy := t.TempDir()
	marker := workspaceWriteMarker(t, legacy)
	directory, err := store.acquire("editing:legacy", "old-native-thread", legacy, legacy)
	if err != nil || directory != legacy {
		t.Fatalf("legacy resume failed: %s: %v", directory, err)
	}
	store.release("editing:legacy")
	managed := workspaceAcquire(t, store, "running:adopt")
	store.release("running:adopt")
	if err := store.adopt("running:adopt", legacy, legacy); err != nil {
		t.Fatal(err)
	}
	store.release("running:adopt")
	if err := store.reconcile([]string{}); err != nil {
		t.Fatal(err)
	}
	workspaceAssertExists(t, marker)
	workspaceAssertAbsent(t, managed)
}

func TestWorkbenchWorkspacesResumeFromRegisteredDirectorySharesReference(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	directory := workspaceAcquire(t, store, "editing:source")
	store.release("editing:source")
	resumed, err := store.acquire("running:target", "old-native-thread", t.TempDir(), directory)
	if err != nil || resumed != directory {
		t.Fatalf("registered native directory not restored: %s: %v", resumed, err)
	}
	store.release("running:target")
	if err := store.remove("editing:source"); err != nil {
		t.Fatal(err)
	}
	workspaceAssertExists(t, directory)
	if err := store.remove("running:target"); err != nil {
		t.Fatal(err)
	}
	workspaceAssertAbsent(t, directory)
	if _, err := store.acquire("running:unknown", "old-native-thread", t.TempDir(), t.TempDir()); err == nil {
		t.Fatal("unregistered historical directory accepted")
	}
	if err := store.adopt("editing:unknown", t.TempDir(), t.TempDir()); err == nil {
		t.Fatal("unregistered adopted directory accepted")
	}
}

func TestWorkbenchWorkspacesInvalidKeysDoNotTriggerCleanup(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	directory := workspaceAcquire(t, store, "editing:keep")
	store.release("editing:keep")
	for _, key := range []string{"", "../outside", "editing:../outside", "other:a", "editing:" + strings.Repeat("a", 101)} {
		if _, err := store.acquire(key, "", "", ""); err == nil {
			t.Errorf("invalid key accepted by acquire: %q", key)
		}
		if err := store.remove(key); err == nil {
			t.Errorf("invalid key accepted by remove: %q", key)
		}
		if err := store.reconcile([]string{key}); err == nil {
			t.Errorf("invalid inventory accepted: %q", key)
		}
		workspaceAssertExists(t, directory)
	}
}

func TestWorkbenchWorkspacesRefuseTamperedPersistentPaths(t *testing.T) {
	for _, kind := range []string{"invalid-key", "outside-managed", "relative-external", "null", "malformed"} {
		t.Run(kind, func(t *testing.T) {
			store := isolatedWorkbenchWorkspaces(t, "scope")
			records := map[string]workbenchWorkspace{"editing:a": {Directory: t.TempDir(), Managed: false}}
			var data []byte
			switch kind {
			case "invalid-key":
				records["../outside"] = records["editing:a"]
			case "outside-managed":
				records["editing:a"] = workbenchWorkspace{Directory: t.TempDir(), Managed: true}
			case "relative-external":
				records["editing:a"] = workbenchWorkspace{Directory: "relative", Managed: false}
			case "null":
				data = []byte("null")
			case "malformed":
				data = []byte("{broken")
			}
			if data == nil {
				data, _ = json.Marshal(records)
			}
			if err := os.WriteFile(filepath.Join(store.root, "workspaces.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := openWorkbenchWorkspaces("scope"); err == nil {
				t.Fatal("tampered persistent paths accepted")
			}
		})
	}
}

func TestWorkbenchWorkspacesSymlinkReplacementCannotDeleteExternalFiles(t *testing.T) {
	for _, level := range []string{"leaf", "parent", "root"} {
		t.Run(level, func(t *testing.T) {
			store := isolatedWorkbenchWorkspaces(t, "scope")
			key := "editing:symlink"
			directory := workspaceAcquire(t, store, key)
			store.release(key)
			outside := t.TempDir()
			marker := workspaceWriteMarker(t, outside)
			switch level {
			case "leaf":
				if err := os.Remove(directory); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, directory); err != nil {
					t.Fatal(err)
				}
			case "parent", "root":
				path := filepath.Dir(directory)
				if level == "root" {
					path = store.root
				}
				if err := os.Rename(path, path+".original"); err != nil {
					t.Fatal(err)
				}
				// 外部目录中放置同名目录，确认检查覆盖祖先路径。
				mirrored := filepath.Join(outside, filepath.Base(directory))
				if level == "root" {
					mirrored = filepath.Join(outside, "directories", filepath.Base(directory))
				}
				if err := os.MkdirAll(mirrored, 0700); err != nil {
					t.Fatal(err)
				}
				workspaceWriteMarker(t, mirrored)
				if err := os.Symlink(outside, path); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := store.acquire(key, "", "", ""); err == nil {
				t.Fatal("symlink-replaced managed path accepted")
			}
			if err := store.remove(key); err == nil {
				t.Fatal("symlink-replaced managed path cleanup accepted")
			}
			workspaceAssertExists(t, marker)
			if len(store.records) != 1 || store.used[key] != 0 {
				t.Fatal("refused symlink operation changed references")
			}
		})
	}
}

func TestWorkbenchWorkspacesMissingDirectoryCleanupIsIdempotent(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	directory := workspaceAcquire(t, store, "editing:missing")
	store.release("editing:missing")
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := store.remove("editing:missing"); err != nil {
			t.Fatal(err)
		}
	}
}

// 用目录占住最终记录路径，稳定模拟保存失败；root 运行时 chmod 无法可靠阻止写入。
// 保留已有记录，恢复障碍后仍能测试重新连接；此装置不依赖产品临时文件的命名方式。
func workspaceBlockSave(t *testing.T, store *workbenchWorkspaces) func() {
	t.Helper()
	path := filepath.Join(store.root, "workspaces.json")
	backup := path + ".saved-by-test"
	exists := false
	if _, err := os.Stat(path); err == nil {
		if err := os.Rename(path, backup); err != nil {
			t.Fatal(err)
		}
		exists = true
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	return func() {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if exists {
			if err := os.Rename(backup, path); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestWorkbenchWorkspacesAcquireSaveFailureLeavesNoOrphan(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	workspaceBlockSave(t, store)
	key := "editing:failed-create"
	if _, err := store.acquire(key, "", "", ""); err == nil {
		t.Fatal("save failure was not reported")
	}
	if len(store.records) != 0 || store.used[key] != 0 {
		t.Fatal("failed acquisition registered an active workspace")
	}
	workspaceAssertAbsent(t, store.directory(key))
}

func TestWorkbenchWorkspacesRemoveSaveFailurePreservesUserFiles(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	key := "editing:failed-delete"
	directory := workspaceAcquire(t, store, key)
	marker := workspaceWriteMarker(t, directory)
	store.release(key)
	restoreSave := workspaceBlockSave(t, store)
	if err := store.remove(key); err == nil {
		t.Fatal("save failure was not reported")
	}
	if _, exists := store.records[key]; !exists {
		t.Fatal("failed removal changed registry")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("failed removal deleted user files: %v", err)
	}
	restoreSave()
	reopened, err := openWorkbenchWorkspaces("scope")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.acquire(key, "", "", ""); err != nil {
		t.Fatalf("failed removal left persisted session unrecoverable: %v", err)
	}
}

func TestWorkbenchWorkspacesAdoptSaveFailurePreservesReferences(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	a := workspaceAcquire(t, store, "editing:a")
	b := workspaceAcquire(t, store, "running:b")
	store.release("editing:a")
	store.release("running:b")
	workspaceBlockSave(t, store)
	if err := store.adopt("running:b", a, ""); err == nil {
		t.Fatal("save failure was not reported")
	}
	if record := store.records["running:b"]; record.Directory != b || len(record.Retained) != 0 || store.used["running:b"] != 0 {
		t.Fatalf("failed adoption changed references: %#v", record)
	}
	workspaceAssertExists(t, a)
	workspaceAssertExists(t, b)
}

func TestWorkbenchWorkspacesSaveDoesNotFollowTemporarySymlink(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	outside := filepath.Join(t.TempDir(), "outside-user-file.txt")
	sentinel := []byte("外部文件必须保留")
	if err := os.WriteFile(outside, sentinel, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(store.root, "workspaces.json.tmp")); err != nil {
		t.Fatal(err)
	}
	_, _ = store.acquire("editing:symlink-save", "", "", "")
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != string(sentinel) {
		t.Fatalf("workspace save followed temporary-file symlink and overwrote external data: %v", err)
	}
}

func TestWorkbenchWorkspacesConcurrentReconcileAcquireRelease(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	const workers = 12
	var group sync.WaitGroup
	errors := make(chan error, workers*20)
	ready := make(chan struct{})
	for worker := 0; worker < workers; worker++ {
		group.Add(1)
		go func(worker int) {
			defer group.Done()
			<-ready
			key := fmt.Sprintf("editing:worker-%d", worker)
			for i := 0; i < 20; i++ {
				directory, err := store.acquire(key, "", "", "")
				if err != nil {
					errors <- err
					continue
				}
				if _, err := os.Stat(directory); err != nil {
					errors <- fmt.Errorf("active directory missing: %w", err)
				}
				// 第二次占用模拟创建请求和运行会话同时持有目录。
				if _, err := store.acquire(key, "", "", ""); err != nil {
					errors <- err
				} else {
					store.release(key)
				}
				if _, err := os.Stat(directory); err != nil {
					errors <- fmt.Errorf("partially released directory missing: %w", err)
				}
				store.release(key)
			}
		}(worker)
	}
	group.Add(1)
	go func() {
		defer group.Done()
		<-ready
		for i := 0; i < 60; i++ {
			// 清单和 acquire 可交错；remove 拒绝新的占用是允许的，目录必须仍存在。
			_ = store.reconcile([]string{})
		}
	}()
	close(ready)
	group.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	if err := store.reconcile([]string{}); err != nil {
		t.Fatal(err)
	}
	if len(store.records) != 0 {
		t.Fatal("idle directories remained after final reconciliation")
	}
	entries, err := os.ReadDir(filepath.Join(store.root, "directories"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("final reconciliation left physical directories: %d: %v", len(entries), err)
	}
}

func TestWorkbenchWorkspacesHeartbeatDistinguishesAbsentAndEmptyInventory(t *testing.T) {
	var absent, empty workbenchMessage
	if err := json.Unmarshal([]byte(`{"type":"pong"}`), &absent); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"type":"pong","workspace_keys":[]}`), &empty); err != nil {
		t.Fatal(err)
	}
	if absent.WorkspaceKeys != nil || empty.WorkspaceKeys == nil {
		t.Fatal("older-client heartbeat cannot be distinguished from an empty complete inventory")
	}
}

func TestWorkbenchWorkspacesBridgeCreatePauseAndFinalDelete(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	base := t.TempDir()
	server, err := newWorkbenchServer(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	bridge := &workbenchBridge{server: server, ctx: ctx, owned: map[string]bool{}, threads: map[string]bool{}, workspaces: store, mux: http.NewServeMux()}
	t.Cleanup(func() {
		cancel()
		server.sessions.Close(context.Background())
		bridge.tasks.Wait()
	})
	var captured map[string]any
	// 替换 CLI 创建处理器，仍经过真实桥接、SessionManager 关闭和 dispose 路径。
	bridge.mux.HandleFunc("POST /api/sessions", func(writer http.ResponseWriter, request *http.Request) {
		if err := json.NewDecoder(request.Body).Decode(&captured); err != nil {
			t.Error(err)
			return
		}
		session := newSession("runtime", "synthetic", "codex-structured", ToolInfo{Key: "codex"}, stringValue(captured["workingDirectory"]))
		session.Provider = &stubProvider{}
		session.events = server.sessions.events
		server.sessions.sessions[session.ID] = session
		respondJSON(writer, http.StatusOK, map[string]any{"id": session.ID})
	})
	key := "editing:bridge"
	body, _ := json.Marshal(map[string]any{"workspaceKey": key, "workingDirectory": t.TempDir(), "toolKey": "codex"})
	response := httptest.NewRecorder()
	if err := bridge.serveRequest(response, workbenchMessage{Method: "POST", Path: "/api/sessions", Body: base64.StdEncoding.EncodeToString(body)}); err != nil || response.Code != http.StatusOK {
		t.Fatalf("synthetic bridge creation failed: %v: %d", err, response.Code)
	}
	directory := stringValue(captured["workingDirectory"])
	marker := workspaceWriteMarker(t, directory)
	if directory != store.directory(key) || !bridge.owns("runtime") || store.used[key] != 1 {
		t.Fatal("bridge did not transfer workspace usage to the runtime")
	}
	for _, field := range []string{"workspaceKey", "previousThreadId", "previousWorkingDirectory"} {
		if _, exists := captured[field]; exists {
			t.Errorf("bridge leaked management field into CLI create body: %s", field)
		}
	}
	if err := store.reconcile([]string{}); err != nil {
		t.Fatal(err)
	}
	workspaceAssertExists(t, marker)
	if !server.sessions.Delete(context.Background(), "runtime") || store.used[key] != 0 {
		t.Fatal("runtime shutdown did not release workspace usage")
	}
	workspaceAssertExists(t, marker)
	if err := bridge.serveRequest(httptest.NewRecorder(), workbenchMessage{Method: "DELETE", Path: "/api/workbench-workspaces/editing%3Abridge"}); err != nil {
		t.Fatal(err)
	}
	workspaceAssertAbsent(t, directory)
}

func TestWorkbenchWorkspacesBridgeCreateFailureReleasesUsage(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	server, err := newWorkbenchServer(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	bridge := &workbenchBridge{server: server, ctx: context.Background(), owned: map[string]bool{}, workspaces: store, mux: http.NewServeMux()}
	bridge.mux.HandleFunc("POST /api/sessions", func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "synthetic CLI start failure", http.StatusBadRequest)
	})
	key := "running:failed-cli"
	body, _ := json.Marshal(map[string]any{"workspaceKey": key})
	if err := bridge.serveRequest(httptest.NewRecorder(), workbenchMessage{Method: "POST", Path: "/api/sessions", Body: base64.StdEncoding.EncodeToString(body)}); err != nil {
		t.Fatal(err)
	}
	if store.used[key] != 0 {
		t.Fatal("failed CLI creation leaked a workspace usage count")
	}
	if err := store.reconcile([]string{}); err != nil {
		t.Fatal(err)
	}
	workspaceAssertAbsent(t, store.directory(key))
}

func TestWorkbenchWorkspacesBridgeAdoptionReleasesEveryReferenceOnClose(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	directory := workspaceAcquire(t, store, "editing:source")
	historical := workspaceAcquire(t, store, "running:target")
	store.release("running:target")
	server, err := newWorkbenchServer(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	session := newSession("source-runtime", "synthetic", "codex-structured", ToolInfo{Key: "codex"}, directory)
	session.Provider = &stubProvider{}
	session.events = server.sessions.events
	session.dispose = func() { store.release("editing:source") }
	server.sessions.sessions[session.ID] = session
	bridge := &workbenchBridge{server: server, ctx: context.Background(), owned: map[string]bool{session.ID: true}, workspaces: store, mux: http.NewServeMux()}
	body, _ := json.Marshal(map[string]any{"sessionId": session.ID})
	for i := 0; i < 2; i++ {
		response := httptest.NewRecorder()
		if err := bridge.serveRequest(response, workbenchMessage{Method: "POST", Path: "/api/workbench-workspaces/running%3Atarget/adopt", Body: base64.StdEncoding.EncodeToString(body)}); err != nil || response.Code != http.StatusOK {
			t.Fatalf("adoption failed: %v: %d", err, response.Code)
		}
	}
	if store.used["running:target"] != 2 || store.used["editing:source"] != 1 {
		t.Fatal("adoption did not retain runtime references")
	}
	if err := store.remove("running:target"); err == nil {
		t.Fatal("adopted runtime directory was removed while still in use")
	}
	workspaceAssertExists(t, historical)
	server.sessions.Close(context.Background())
	// dispose 链必须释放原始占用及每次登记的引用；重复关闭不能二次释放。
	server.sessions.Close(context.Background())
	if store.used["running:target"] != 0 || store.used["editing:source"] != 0 {
		t.Fatal("runtime shutdown leaked adoption usage counts")
	}
	if err := store.remove("editing:source"); err != nil {
		t.Fatal(err)
	}
	workspaceAssertExists(t, directory)
	if err := store.remove("running:target"); err != nil {
		t.Fatal(err)
	}
	workspaceAssertAbsent(t, directory)
	workspaceAssertAbsent(t, historical)
}

// 合成进程退出时的磁盘状态，覆盖记录提交前后；不依赖真实 CLI 或断电。
func workspaceStageRemoval(t *testing.T, directory string) string {
	t.Helper()
	staged := directory + ".deleting-11111111-2222-4333-8444-555555555555"
	if err := os.Rename(directory, staged); err != nil {
		t.Fatal(err)
	}
	return staged
}

func TestWorkbenchWorkspacesCrashBeforeDeleteCommitRestoresDirectory(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	key := "editing:crash-before-commit"
	directory := workspaceAcquire(t, store, key)
	marker := workspaceWriteMarker(t, directory)
	store.release(key)
	staged := workspaceStageRemoval(t, directory)
	reopened, err := openWorkbenchWorkspaces("scope")
	if err != nil {
		t.Fatal(err)
	}
	workspaceAssertExists(t, marker)
	workspaceAssertAbsent(t, staged)
	if restored := workspaceAcquire(t, reopened, key); restored != directory {
		t.Fatal("crash recovery changed stable working directory")
	}
	reopened.release(key)
	if _, err := openWorkbenchWorkspaces("scope"); err != nil {
		t.Fatalf("repeated recovery failed: %v", err)
	}
	workspaceAssertExists(t, marker)
}

func TestWorkbenchWorkspacesCrashAfterDeleteCommitCompletesCleanup(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	key := "running:crash-after-commit"
	directory := workspaceAcquire(t, store, key)
	workspaceWriteMarker(t, directory)
	store.release(key)
	staged := workspaceStageRemoval(t, directory)
	if err := store.save(map[string]workbenchWorkspace{}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		reopened, err := openWorkbenchWorkspaces("scope")
		if err != nil {
			t.Fatal(err)
		}
		if len(reopened.records) != 0 {
			t.Fatal("committed deletion reintroduced a workspace record")
		}
		workspaceAssertAbsent(t, directory)
		workspaceAssertAbsent(t, staged)
	}
}

func TestWorkbenchWorkspacesCrashRecoveryIncludesRetainedDirectoryReferences(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprintf("committed-%t", committed), func(t *testing.T) {
			store := isolatedWorkbenchWorkspaces(t, "scope")
			a := workspaceAcquire(t, store, "editing:a")
			b := workspaceAcquire(t, store, "running:b")
			markerA := workspaceWriteMarker(t, a)
			markerB := workspaceWriteMarker(t, b)
			store.release("editing:a")
			store.release("running:b")
			if err := store.adopt("running:b", a, ""); err != nil {
				t.Fatal(err)
			}
			store.release("running:b")
			if err := store.remove("editing:a"); err != nil {
				t.Fatal(err)
			}
			// b 的当前目录和历史目录均暂存，恢复必须参考 retained。
			stagedA := workspaceStageRemoval(t, a)
			stagedB := workspaceStageRemoval(t, b)
			if committed {
				if err := store.save(map[string]workbenchWorkspace{}); err != nil {
					t.Fatal(err)
				}
			}
			reopened, err := openWorkbenchWorkspaces("scope")
			if err != nil {
				t.Fatal(err)
			}
			workspaceAssertAbsent(t, stagedA)
			workspaceAssertAbsent(t, stagedB)
			if committed {
				workspaceAssertAbsent(t, a)
				workspaceAssertAbsent(t, b)
			} else {
				workspaceAssertExists(t, markerA)
				workspaceAssertExists(t, markerB)
				if err := reopened.remove("running:b"); err != nil {
					t.Fatal(err)
				}
				workspaceAssertAbsent(t, a)
				workspaceAssertAbsent(t, b)
			}
		})
	}
}

func TestWorkbenchWorkspacesCrashRecoveryRejectsConflictsAndStagedSymlinks(t *testing.T) {
	for _, kind := range []string{"original-conflict", "staged-symlink"} {
		t.Run(kind, func(t *testing.T) {
			store := isolatedWorkbenchWorkspaces(t, "scope")
			key := "editing:conflict"
			directory := workspaceAcquire(t, store, key)
			store.release(key)
			staged := workspaceStageRemoval(t, directory)
			outside := t.TempDir()
			marker := workspaceWriteMarker(t, outside)
			if kind == "original-conflict" {
				if err := os.Mkdir(directory, 0700); err != nil {
					t.Fatal(err)
				}
				workspaceWriteMarker(t, directory)
			} else {
				if err := os.Remove(staged); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, staged); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := openWorkbenchWorkspaces("scope"); err == nil {
				t.Fatal("unsafe crash recovery was accepted")
			}
			workspaceAssertExists(t, staged)
			workspaceAssertExists(t, marker)
		})
	}
}

func TestWorkbenchWorkspacesCrashRecoveryLeavesUnknownNamesUntouched(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	parent := filepath.Join(store.root, "directories")
	unknown := []string{
		"unrelated.deleting-11111111-2222-4333-8444-555555555555",
		filepath.Base(store.directory("editing:unknown")) + ".deleting-invalid",
		"user-project",
	}
	for _, name := range unknown {
		path := filepath.Join(parent, name)
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		workspaceWriteMarker(t, path)
	}
	if _, err := openWorkbenchWorkspaces("scope"); err != nil {
		t.Fatal(err)
	}
	for _, name := range unknown {
		workspaceAssertExists(t, filepath.Join(parent, name, "user-work.txt"))
	}
}

func TestWorkbenchWorkspacesAcquireSaveFailurePreservesPreexistingFiles(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	key := "editing:preexisting-unregistered"
	directory := store.directory(key)
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	marker := workspaceWriteMarker(t, directory)
	workspaceBlockSave(t, store)
	if _, err := store.acquire(key, "", "", ""); err == nil {
		t.Fatal("save failure was not reported")
	}
	workspaceAssertExists(t, marker)
	if len(store.records) != 0 || store.used[key] != 0 {
		t.Fatal("failed registration changed workspace ownership")
	}
}

func TestWorkbenchWorkspacesStartupRootSymlinkCannotCleanupExternalFiles(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	outside := t.TempDir()
	parent := filepath.Join(outside, "directories")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(parent, filepath.Base(store.directory("editing:outside"))+".deleting-11111111-2222-4333-8444-555555555555")
	if err := os.Mkdir(staged, 0700); err != nil {
		t.Fatal(err)
	}
	marker := workspaceWriteMarker(t, staged)
	if err := os.Rename(store.root, store.root+".original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, store.root); err != nil {
		t.Fatal(err)
	}
	if _, err := openWorkbenchWorkspaces("scope"); err == nil {
		t.Error("startup accepted a replaced workspace root symlink")
	}
	workspaceAssertExists(t, marker)
}

func TestWorkbenchWorkspacesBridgeAdoptionConcurrentCloseDoesNotLeak(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	// 每轮用独立 key，共享记录管理器，以覆盖关闭前、关闭中和关闭后的关联请求。
	for round := 0; round < 40; round++ {
		sourceKey := fmt.Sprintf("editing:source-%d", round)
		targetKey := fmt.Sprintf("running:target-%d", round)
		directory := workspaceAcquire(t, store, sourceKey)
		historical := workspaceAcquire(t, store, targetKey)
		store.release(targetKey)
		server, err := newWorkbenchServer(t.TempDir(), nil)
		if err != nil {
			t.Fatal(err)
		}
		session := newSession("source-runtime", "synthetic", "codex-structured", ToolInfo{Key: "codex"}, directory)
		session.Provider = &stubProvider{}
		session.events = server.sessions.events
		session.dispose = func() { store.release(sourceKey) }
		server.sessions.sessions[session.ID] = session
		bridge := &workbenchBridge{server: server, ctx: context.Background(), owned: map[string]bool{session.ID: true}, workspaces: store, mux: http.NewServeMux()}
		body, _ := json.Marshal(map[string]any{"sessionId": session.ID})
		start := make(chan struct{})
		done := make(chan struct{}, 2)
		go func() {
			<-start
			// 会话先关闭时允许关联被拒绝；成功关联必须在关闭时释放占用。
			_ = bridge.serveRequest(httptest.NewRecorder(), workbenchMessage{Method: "POST", Path: "/api/workbench-workspaces/" + targetKey + "/adopt", Body: base64.StdEncoding.EncodeToString(body)})
			done <- struct{}{}
		}()
		go func() {
			<-start
			server.sessions.Delete(context.Background(), session.ID)
			done <- struct{}{}
		}()
		close(start)
		for i := 0; i < 2; i++ {
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("adoption and runtime close deadlocked")
			}
		}
		if store.used[sourceKey] != 0 || store.used[targetKey] != 0 {
			t.Fatal("concurrent adoption/close leaked workspace usage")
		}
		workspaceAssertExists(t, directory)
		workspaceAssertExists(t, historical)
		if err := store.remove(sourceKey); err != nil {
			t.Fatal(err)
		}
		if err := store.remove(targetKey); err != nil {
			t.Fatal(err)
		}
		workspaceAssertAbsent(t, directory)
		workspaceAssertAbsent(t, historical)
	}
}

func TestWorkbenchWorkspacesPartialStagingFailureRestoresEarlierDirectories(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	a := workspaceAcquire(t, store, "editing:a")
	b := workspaceAcquire(t, store, "running:b")
	markerA := workspaceWriteMarker(t, a)
	store.release("editing:a")
	store.release("running:b")
	if err := store.adopt("running:b", a, ""); err != nil {
		t.Fatal(err)
	}
	store.release("running:b")
	if err := store.remove("editing:a"); err != nil {
		t.Fatal(err)
	}
	// 当前目录 a 会先暂存，随后 retained 中的 b 安全检查失败，a 必须恢复。
	outside := t.TempDir()
	outsideMarker := workspaceWriteMarker(t, outside)
	if err := os.Rename(b, b+".original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, b); err != nil {
		t.Fatal(err)
	}
	if err := store.remove("running:b"); err == nil {
		t.Fatal("retained symlink was accepted during staged removal")
	}
	workspaceAssertExists(t, markerA)
	workspaceAssertExists(t, outsideMarker)
	if _, exists := store.records["running:b"]; !exists {
		t.Fatal("partially staged failure committed the removal")
	}
	entries, err := os.ReadDir(filepath.Join(store.root, "directories"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".deleting-") {
			t.Fatal("rollback left a staged directory after the operation returned")
		}
	}
}

func TestWorkbenchWorkspacesBridgeFailedAdoptionPreservesDisposeChain(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	directory := workspaceAcquire(t, store, "editing:source")
	historical := workspaceAcquire(t, store, "running:target")
	store.release("running:target")
	server, err := newWorkbenchServer(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	session := newSession("source-runtime", "synthetic", "codex-structured", ToolInfo{Key: "codex"}, directory)
	session.Provider = &stubProvider{}
	session.events = server.sessions.events
	session.dispose = func() { store.release("editing:source") }
	server.sessions.sessions[session.ID] = session
	bridge := &workbenchBridge{server: server, ctx: context.Background(), owned: map[string]bool{session.ID: true}, workspaces: store, mux: http.NewServeMux()}
	body, _ := json.Marshal(map[string]any{"sessionId": session.ID})
	restoreSave := workspaceBlockSave(t, store)
	if err := bridge.serveRequest(httptest.NewRecorder(), workbenchMessage{Method: "POST", Path: "/api/workbench-workspaces/running:target/adopt", Body: base64.StdEncoding.EncodeToString(body)}); err == nil {
		t.Fatal("failed adoption was not reported by bridge")
	}
	restoreSave()
	if store.used["running:target"] != 0 || store.records["running:target"].Directory != historical {
		t.Fatal("failed bridge adoption changed the target reference")
	}
	server.sessions.Close(context.Background())
	if store.used["editing:source"] != 0 {
		t.Fatal("failed adoption damaged the original disposal callback")
	}
	if err := store.reconcile([]string{}); err != nil {
		t.Fatal(err)
	}
	workspaceAssertAbsent(t, directory)
	workspaceAssertAbsent(t, historical)
}

func workspaceTreeSnapshot(t *testing.T, root string) string {
	t.Helper()
	var paths []string
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		value := relative + "\t" + entry.Type().String()
		if entry.Type().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value += "\t" + string(data)
		}
		paths = append(paths, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return strings.Join(paths, "\n")
}

func TestWorkbenchWorkspacesRuntimeAncestorReplacementCannotWriteExternalDirectories(t *testing.T) {
	for _, level := range []string{"scope", "directories", "scopes-parent", "glad-parent"} {
		t.Run(level, func(t *testing.T) {
			store := isolatedWorkbenchWorkspaces(t, "scope")
			existingKey, newKey := "editing:existing", "running:new-after-replacement"
			existing := workspaceAcquire(t, store, existingKey)
			workspaceWriteMarker(t, existing)
			store.release(existingKey)
			replaced := store.root
			switch level {
			case "directories":
				replaced = filepath.Join(store.root, "directories")
			case "scopes-parent":
				replaced = filepath.Dir(store.root)
			case "glad-parent":
				replaced = filepath.Dir(filepath.Dir(store.root))
			}
			outside := t.TempDir()
			relative, err := filepath.Rel(replaced, store.directory(newKey))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Join(outside, filepath.Dir(relative)), 0700); err != nil {
				t.Fatal(err)
			}
			workspaceWriteMarker(t, outside)
			before := workspaceTreeSnapshot(t, outside)
			if err := os.Rename(replaced, replaced+".original"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, replaced); err != nil {
				t.Fatal(err)
			}
			// 新 key 在创建目录前拒绝；旧 key 也不能沿被替换的路径重新占用。
			for _, key := range []string{newKey, existingKey} {
				if _, err := store.acquire(key, "", "", ""); err == nil {
					t.Errorf("replaced %s accepted acquisition for %s", level, key)
				}
			}
			if after := workspaceTreeSnapshot(t, outside); after != before {
				t.Fatal("rejected acquisition changed external directory contents")
			}
			if len(store.records) != 1 || store.used[newKey] != 0 || store.used[existingKey] != 0 {
				t.Fatal("rejected acquisition changed workspace records or usage")
			}
		})
	}
}

func TestWorkbenchWorkspacesStartupRejectsEveryManagedAncestorSymlink(t *testing.T) {
	for _, level := range []string{"scope", "directories", "scopes-parent", "glad-parent"} {
		t.Run(level, func(t *testing.T) {
			store := isolatedWorkbenchWorkspaces(t, "scope")
			replaced := store.root
			switch level {
			case "directories":
				replaced = filepath.Join(store.root, "directories")
			case "scopes-parent":
				replaced = filepath.Dir(store.root)
			case "glad-parent":
				replaced = filepath.Dir(filepath.Dir(store.root))
			}
			outside := t.TempDir()
			workspaceWriteMarker(t, outside)
			before := workspaceTreeSnapshot(t, outside)
			if err := os.Rename(replaced, replaced+".original"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, replaced); err != nil {
				t.Fatal(err)
			}
			if _, err := openWorkbenchWorkspaces("scope"); err == nil {
				t.Fatalf("startup accepted replaced %s symlink", level)
			}
			if after := workspaceTreeSnapshot(t, outside); after != before {
				t.Fatal("rejected startup changed external directory contents")
			}
		})
	}
}

func TestWorkbenchWorkspacesHomeSymlinkRemainsSupported(t *testing.T) {
	store := isolatedWorkbenchWorkspaces(t, "scope")
	key := "editing:canonical-home"
	directory := workspaceAcquire(t, store, key)
	marker := workspaceWriteMarker(t, directory)
	store.release(key)
	alias := filepath.Join(t.TempDir(), "home-alias")
	if err := os.Symlink(os.Getenv("HOME"), alias); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", alias)
	reopened, err := openWorkbenchWorkspaces("scope")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.root != store.root || workspaceAcquire(t, reopened, key) != directory {
		t.Fatal("HOME alias changed stable scope or workspace identity")
	}
	workspaceAssertExists(t, marker)
	reopened.release(key)
	if err := reopened.remove(key); err != nil {
		t.Fatal(err)
	}
	workspaceAssertAbsent(t, directory)
}
