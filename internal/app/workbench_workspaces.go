package app

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
)

var workbenchWorkspaceKey = regexp.MustCompile(`^(editing|running):[a-zA-Z0-9_-]{1,100}$`)

type workbenchWorkspace struct {
	Directory string                        `json:"directory"`
	Managed   bool                          `json:"managed"`
	Retained  []workbenchWorkspaceDirectory `json:"retained,omitempty"`
}

type workbenchWorkspaceDirectory struct {
	Directory string `json:"directory"`
	Managed   bool   `json:"managed"`
}

func workspaceDirectories(record workbenchWorkspace) []workbenchWorkspaceDirectory {
	return append([]workbenchWorkspaceDirectory{{record.Directory, record.Managed}}, record.Retained...)
}

// 目录跟随工作台 Session，运行会话关闭只释放占用，不删除恢复所需文件。
type workbenchWorkspaces struct {
	mu         sync.Mutex
	root       string
	records    map[string]workbenchWorkspace
	used       map[string]int
	generation atomic.Uint64
}

func openWorkbenchWorkspaces(scope string) (*workbenchWorkspaces, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	home, err = filepath.EvalSymlinks(home)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256([]byte(scope))
	root := filepath.Join(home, ".glad", "workbench-workspaces", fmt.Sprintf("%x", hash))
	// 逐层建立自己管理的目录，启动时也拒绝被替换的目录符号链接。
	for _, path := range []string{filepath.Join(home, ".glad"), filepath.Join(home, ".glad", "workbench-workspaces"), root, filepath.Join(root, "directories")} {
		if err = os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
			return nil, err
		}
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("自动会话目录路径被替换，已停止操作")
		}
	}
	store := &workbenchWorkspaces{root: root, records: map[string]workbenchWorkspace{}, used: map[string]int{}}
	data, err := os.ReadFile(filepath.Join(root, "workspaces.json"))
	if err == nil {
		if json.Unmarshal(data, &store.records) != nil || store.records == nil {
			return nil, errors.New("会话目录记录无效")
		}
		for key, record := range store.records {
			if !workbenchWorkspaceKey.MatchString(key) {
				return nil, errors.New("会话目录记录路径无效")
			}
			for _, dir := range workspaceDirectories(record) {
				if !filepath.IsAbs(dir.Directory) || (dir.Managed && !store.isManagedDirectory(dir.Directory)) {
					return nil, errors.New("会话目录记录路径无效")
				}
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if err := store.recoverRemovals(); err != nil {
		return nil, err
	}
	return store, nil
}

func (store *workbenchWorkspaces) directory(key string) string {
	hash := sha256.Sum256([]byte(key))
	return filepath.Join(store.root, "directories", fmt.Sprintf("%x", hash))
}

func (store *workbenchWorkspaces) save(records map[string]workbenchWorkspace) error {
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(store.root, "workspaces.json")
	real, err := filepath.EvalSymlinks(store.root)
	if err != nil || real != store.root {
		return errors.New("会话目录记录路径发生变化")
	}
	temporary, err := os.CreateTemp(store.root, ".workspaces-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err = temporary.Write(data); err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(temporary.Name(), path); err != nil {
		return err
	}
	store.records = records
	return nil
}

func (store *workbenchWorkspaces) acquire(key, previousThread, legacyDirectory, previousDirectory string) (string, error) {
	if !workbenchWorkspaceKey.MatchString(key) {
		return "", errors.New("工作台会话标识无效")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.checkManagedPath(filepath.Join(store.root, "directories")); err != nil {
		return "", err
	}
	record, exists := store.records[key]
	created := false
	if !exists {
		record = workbenchWorkspace{Directory: store.directory(key), Managed: true}
		if previousThread != "" {
			// 旧会话沿用其原项目目录，用户目录始终不属于自动清理范围。
			record = workbenchWorkspace{Directory: legacyDirectory, Managed: false}
			if previousDirectory != "" && previousDirectory != legacyDirectory {
				found := false
				for _, other := range store.records {
					for _, dir := range workspaceDirectories(other) {
						if dir.Directory == previousDirectory {
							record.Directory, record.Managed = dir.Directory, dir.Managed
							found = true
						}
					}
				}
				if !found {
					return "", errors.New("历史会话目录未登记")
				}
			}
		} else if err := os.Mkdir(record.Directory, 0700); err != nil && !os.IsExist(err) {
			return "", err
		} else if err == nil {
			created = true
		}
	}
	if info, err := os.Stat(record.Directory); err != nil || !info.IsDir() {
		return "", errors.New("会话工作目录已不存在")
	}
	if record.Managed {
		if err := store.checkManagedPath(record.Directory); err != nil {
			return "", err
		}
	}
	if !exists {
		next := store.copyRecords()
		next[key] = record
		if err := store.save(next); err != nil {
			if created {
				_ = os.Remove(record.Directory)
			}
			return "", err
		}
	}
	store.used[key]++
	store.generation.Add(1)
	return record.Directory, nil
}

func (store *workbenchWorkspaces) isManagedDirectory(path string) bool {
	return filepath.Dir(path) == filepath.Join(store.root, "directories") && validPairingSecret(filepath.Base(path))
}

// 关联已有对话时登记目录引用；替换前的目录留到工作台 Session 删除时统一清理。
func (store *workbenchWorkspaces) adopt(key, directory, legacyDirectory string) error {
	if !workbenchWorkspaceKey.MatchString(key) {
		return errors.New("工作台会话标识无效")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	managed, known := false, directory == legacyDirectory
	for _, record := range store.records {
		for _, dir := range workspaceDirectories(record) {
			if dir.Directory == directory {
				managed, known = dir.Managed, true
			}
		}
	}
	if !known {
		return errors.New("关联会话目录未登记")
	}
	next := store.copyRecords()
	record, exists := next[key]
	if exists && record.Directory != directory {
		record.Retained = append(append([]workbenchWorkspaceDirectory(nil), record.Retained...), workbenchWorkspaceDirectory{record.Directory, record.Managed})
	}
	record.Directory, record.Managed = directory, managed
	next[key] = record
	if err := store.save(next); err != nil {
		return err
	}
	store.used[key]++
	store.generation.Add(1)
	return nil
}

func (store *workbenchWorkspaces) release(key string) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.used[key] > 0 {
		store.used[key]--
		store.generation.Add(1)
	}

}

func (store *workbenchWorkspaces) copyRecords() map[string]workbenchWorkspace {
	next := make(map[string]workbenchWorkspace, len(store.records))
	for k, v := range store.records {
		next[k] = v
	}
	return next
}

func (store *workbenchWorkspaces) checkManagedPath(path string) error {
	// 校验实际目录及祖先，防止替换成符号链接后清理其他路径。
	for _, p := range []string{store.root, filepath.Join(store.root, "directories"), path} {
		real, err := filepath.EvalSymlinks(p)
		if err != nil || real != p {
			return errors.New("自动会话目录路径发生变化，已停止操作")
		}
	}
	return nil
}

func (store *workbenchWorkspaces) remove(key string) error {
	if !workbenchWorkspaceKey.MatchString(key) {
		return errors.New("工作台会话标识无效")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.removeLocked(key)
}

func (store *workbenchWorkspaces) removeLocked(key string) error {
	record, exists := store.records[key]
	if !exists {
		return nil
	}
	if store.used[key] > 0 {
		return errors.New("会话仍在运行，请先结束运行会话")
	}
	staged := map[string]string{}
	committed := false
	defer func() {
		if !committed {
			for original, temporary := range staged {
				_ = os.Rename(temporary, original)
			}
		}
	}()
	for _, dir := range workspaceDirectories(record) {
		if !dir.Managed {
			continue
		}
		referenced := false
		for otherKey, other := range store.records {
			if otherKey != key {
				for _, ref := range workspaceDirectories(other) {
					if ref.Directory == dir.Directory {
						referenced = true
					}
				}
			}
		}
		if referenced {
			continue
		}
		if _, err := os.Lstat(dir.Directory); err == nil {
			if err := store.checkManagedPath(dir.Directory); err != nil {
				return err
			}
			temporary := dir.Directory + ".deleting-" + newUUID()
			if err := os.Rename(dir.Directory, temporary); err != nil {
				return err
			}
			staged[dir.Directory] = temporary
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	next := store.copyRecords()
	delete(next, key)
	if err := store.save(next); err != nil {
		return err
	}
	committed = true
	store.generation.Add(1)
	delete(store.used, key)
	for _, temporary := range staged {
		if err := os.RemoveAll(temporary); err != nil {
			return err
		}
	}
	return nil
}

// 清理先暂存目录，记录提交后再删除；重启时根据记录恢复或完成清理。
func (store *workbenchWorkspaces) recoverRemovals() error {
	parent := filepath.Join(store.root, "directories")
	if err := store.checkManagedPath(parent); err != nil {
		return err
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name, id, staged := strings.Cut(entry.Name(), ".deleting-")
		if !staged || !validPairingSecret(name) || !validWorkbenchID(id) {
			continue
		}
		temporary := filepath.Join(parent, entry.Name())
		original := filepath.Join(parent, name)
		if err := store.checkManagedPath(temporary); err != nil {
			return err
		}
		needed := false
		for _, record := range store.records {
			for _, dir := range workspaceDirectories(record) {
				if dir.Directory == original {
					needed = true
				}
			}
		}
		if needed {
			if _, err := os.Lstat(original); !os.IsNotExist(err) {
				return errors.New("会话目录清理恢复出现冲突")
			}
			if err := os.Rename(temporary, original); err != nil {
				return err
			}
		} else if err := os.RemoveAll(temporary); err != nil {
			return err
		}
	}
	return nil
}

func (store *workbenchWorkspaces) reconcile(active []string, expected ...uint64) error {
	live := map[string]bool{}
	for _, key := range active {
		if !workbenchWorkspaceKey.MatchString(key) {
			return errors.New("工作台会话清单无效")
		}
		live[key] = true
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(expected) > 0 && store.generation.Load() != expected[0] {
		return nil
	}
	obsolete := []string{}
	for key := range store.records {
		if !live[key] && store.used[key] == 0 {
			obsolete = append(obsolete, key)
		}
	}
	for _, key := range obsolete {
		if err := store.removeLocked(key); err != nil {
			return err
		}
	}
	return nil
}
