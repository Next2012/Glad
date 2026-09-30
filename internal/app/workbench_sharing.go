package app

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// 每个安装保存自己的身份和连接意图；启动只尝试一次，不循环重连。
var deployIdentityPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type WorkbenchTarget struct {
	ID               string `json:"id"`
	URL              string `json:"url"`
	Token            string `json:"token"`
	CACertificate    string `json:"caCertificate,omitempty"`
	WorkingDirectory string `json:"workingDirectory"`
	MCPURL           string `json:"mcpUrl,omitempty"`
	MCPTokenFile     string `json:"mcpTokenFile,omitempty"`
	AutoConnect      bool   `json:"autoConnect"`
	WorkbenchID      string `json:"workbenchId,omitempty"`
	WorkbenchAlias   string `json:"workbenchAlias,omitempty"`
}

type WorkbenchSharingConfig struct {
	GladID      string            `json:"gladId"`
	Alias       string            `json:"alias"`
	Workbenches []WorkbenchTarget `json:"workbenches"`
}

type workbenchRuntime struct {
	cancel             context.CancelFunc
	done               chan struct{}
	state              string
	errorText          string
	bridge             *workbenchBridge
	reconnectRequested bool
}

type WorkbenchSharing struct {
	mu           sync.Mutex
	path         string
	config       WorkbenchSharingConfig
	baseDir      string
	assets       fs.FS
	globalConfig *ConfigStore
	ctx          context.Context
	runtimes     map[string]*workbenchRuntime
}

func OpenWorkbenchSharing(baseDir string, assets fs.FS) (*WorkbenchSharing, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	sharing := &WorkbenchSharing{path: filepath.Join(home, ".glad", "agent-workbench.json"), baseDir: baseDir,
		assets: assets, ctx: context.Background(), runtimes: map[string]*workbenchRuntime{}}
	data, err := os.ReadFile(sharing.path)
	if err == nil {
		if err = json.Unmarshal(data, &sharing.config); err != nil {
			return nil, errors.New("AgentWorkbench 配置格式无效")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	changed := false
	if sharing.config.GladID == "" {
		sharing.config.GladID = newUUID()
		changed = true
	}
	if !validWorkbenchID(sharing.config.GladID) {
		return nil, errors.New("Glad 唯一 ID 格式无效")
	}
	if sharing.config.Alias == "" {
		sharing.config.Alias = "Glad " + sharing.config.GladID[:8]
		changed = true
	}
	if sharing.config.Workbenches == nil {
		sharing.config.Workbenches = []WorkbenchTarget{}
		changed = true
	}
	if !validWorkbenchID(sharing.config.GladID) {
		return nil, errors.New("Glad 唯一 ID 格式无效")
	}
	seen := map[string]bool{}
	for index := range sharing.config.Workbenches {
		target := &sharing.config.Workbenches[index]
		if target.ID == "" {
			target.ID = newUUID()
			changed = true
		}
		if seen[target.ID] {
			return nil, errors.New("工作台配置 ID 重复")
		}
		seen[target.ID] = true
		if err = sharing.validateTarget(target); err != nil {
			return nil, err
		}
	}
	if changed {
		err = sharing.saveLocked()
	}
	return sharing, err
}

func validWorkbenchID(value string) bool {
	return len(value) == 36 && strings.Count(value, "-") == 4 && deployIdentityPattern.MatchString(value)
}

func (sharing *WorkbenchSharing) nextConfig() WorkbenchSharingConfig {
	next := sharing.config
	next.Workbenches = append([]WorkbenchTarget{}, sharing.config.Workbenches...)
	return next
}

func (sharing *WorkbenchSharing) saveLocked() error { return sharing.commitLocked(sharing.config) }

func (sharing *WorkbenchSharing) commitLocked(next WorkbenchSharingConfig) error {
	if err := os.MkdirAll(filepath.Dir(sharing.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	temporary := sharing.path + ".tmp"
	if err = os.WriteFile(temporary, append(data, '\n'), 0o600); err != nil {
		return err
	}
	if err = os.Chmod(temporary, 0o600); err != nil {
		return err
	}
	if err = os.Rename(temporary, sharing.path); err != nil {
		return err
	}
	sharing.config = next
	return nil
}

func normalizeWorkbenchURL(value string) (string, error) {
	endpoint, err := url.Parse(strings.TrimSpace(value))
	if err != nil || endpoint.Scheme != "wss" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return "", errors.New("连接地址必须为 wss://工作台地址")
	}
	if endpoint.Path == "" || endpoint.Path == "/" {
		endpoint.Path = "/api/assistant-connections/ws"
	}
	if endpoint.Path != "/api/assistant-connections/ws" {
		return "", errors.New("工作台连接入口路径无效")
	}
	return endpoint.String(), nil
}

func (sharing *WorkbenchSharing) validateTarget(target *WorkbenchTarget) error {
	address, err := normalizeWorkbenchURL(target.URL)
	if err != nil {
		return err
	}
	target.URL = address
	target.Token = strings.TrimSpace(target.Token)
	if len(target.Token) < 32 || strings.ContainsAny(target.Token, "\r\n") {
		return errors.New("连接凭据至少需要 32 个字符")
	}
	if target.WorkingDirectory == "" {
		target.WorkingDirectory = sharing.baseDir
	}
	target.WorkingDirectory, err = filepath.Abs(target.WorkingDirectory)
	if err != nil {
		return err
	}
	if info, e := os.Stat(target.WorkingDirectory); e != nil || !info.IsDir() {
		return errors.New("Glad 本地工作目录不存在")
	}
	if (target.MCPURL == "") != (target.MCPTokenFile == "") {
		return errors.New("MCPHub 地址和凭据文件需要同时填写")
	}
	_, err = workbenchTLSClientPEM([]byte(target.CACertificate))
	return err
}

func (sharing *WorkbenchSharing) snapshot() map[string]any {
	sharing.mu.Lock()
	defer sharing.mu.Unlock()
	items := []map[string]any{}
	for _, target := range sharing.config.Workbenches {
		state, message := "disconnected", ""
		if runtime := sharing.runtimes[target.ID]; runtime != nil {
			state, message = runtime.state, runtime.errorText
		}
		items = append(items, map[string]any{"id": target.ID, "url": target.URL, "workingDirectory": target.WorkingDirectory,
			"mcpUrl": target.MCPURL, "mcpTokenFile": target.MCPTokenFile, "autoConnect": target.AutoConnect,
			"workbenchId": target.WorkbenchID, "workbenchAlias": target.WorkbenchAlias, "state": state, "error": message,
			"hasToken": target.Token != "", "hasCertificate": target.CACertificate != ""})
	}
	return map[string]any{"gladId": sharing.config.GladID, "alias": sharing.config.Alias, "workbenches": items, "configPath": sharing.path, "defaultWorkingDirectory": sharing.baseDir}
}

func (sharing *WorkbenchSharing) Add(target WorkbenchTarget) error {
	if err := sharing.validateTarget(&target); err != nil {
		return err
	}
	sharing.mu.Lock()
	for _, existing := range sharing.config.Workbenches {
		if existing.URL == target.URL {
			sharing.mu.Unlock()
			return errors.New("这个工作台已添加")
		}
	}
	target.ID = newUUID()
	next := sharing.nextConfig()
	next.Workbenches = append(next.Workbenches, target)
	err := sharing.commitLocked(next)
	sharing.mu.Unlock()
	if err == nil && target.AutoConnect {
		sharing.connect(target.ID)
	}
	return err
}

func (sharing *WorkbenchSharing) SetAlias(alias string) error {
	alias = strings.TrimSpace(alias)
	if alias == "" || len(alias) > 128 {
		return errors.New("别名需为 1–128 个字符")
	}
	sharing.mu.Lock()
	next := sharing.nextConfig()
	next.Alias = alias
	err := sharing.commitLocked(next)
	bridges := []*workbenchBridge{}
	for _, runtime := range sharing.runtimes {
		if runtime.bridge != nil {
			bridges = append(bridges, runtime.bridge)
		}
	}
	sharing.mu.Unlock()
	if err == nil {
		for _, bridge := range bridges {
			_ = bridge.write(map[string]any{"type": "client_state", "name": alias})
		}
	}
	return err
}

func (sharing *WorkbenchSharing) SetEnabled(id string, enabled bool) error {
	sharing.mu.Lock()
	next := sharing.nextConfig()
	found := false
	for index := range next.Workbenches {
		if next.Workbenches[index].ID == id {
			next.Workbenches[index].AutoConnect = enabled
			found = true
			break
		}
	}
	if !found {
		sharing.mu.Unlock()
		return errors.New("工作台不存在")
	}
	err := sharing.commitLocked(next)
	runtime := sharing.runtimes[id]
	if err == nil && !enabled && runtime != nil && (runtime.state == "connected" || runtime.state == "connecting") {
		runtime.state = "disconnecting"
	}
	sharing.mu.Unlock()
	if err != nil {
		return err
	}
	if enabled {
		sharing.connect(id)
	} else if runtime != nil {
		runtime.cancel()
	}
	return nil
}

func (sharing *WorkbenchSharing) Delete(id string) error {
	sharing.mu.Lock()
	next := sharing.nextConfig()
	found := false
	for index, item := range next.Workbenches {
		if item.ID == id {
			next.Workbenches = append(next.Workbenches[:index], next.Workbenches[index+1:]...)
			found = true
			break
		}
	}
	if !found {
		sharing.mu.Unlock()
		return errors.New("工作台不存在")
	}
	if err := sharing.commitLocked(next); err != nil {
		sharing.mu.Unlock()
		return err
	}
	runtime := sharing.runtimes[id]
	delete(sharing.runtimes, id)
	sharing.mu.Unlock()
	if runtime != nil {
		runtime.cancel()
	}
	return nil
}

func (sharing *WorkbenchSharing) Start(ctx context.Context) {
	sharing.mu.Lock()
	sharing.ctx = ctx
	ids := []string{}
	for _, target := range sharing.config.Workbenches {
		if target.AutoConnect {
			ids = append(ids, target.ID)
		}
	}
	sharing.mu.Unlock()
	for _, id := range ids {
		sharing.connect(id)
	}
}

func (sharing *WorkbenchSharing) connect(id string) {
	sharing.mu.Lock()
	if current := sharing.runtimes[id]; current != nil {
		if current.state == "disconnecting" {
			// 用户在关闭尚未完成时再次开启，旧连接清理后执行这一次新意图。
			current.reconnectRequested = true
			sharing.mu.Unlock()
			return
		}
		if current.state == "connected" || current.state == "connecting" {
			sharing.mu.Unlock()
			return
		}
	}
	var target WorkbenchTarget
	for _, item := range sharing.config.Workbenches {
		if item.ID == id {
			target = item
			break
		}
	}
	if target.ID == "" {
		sharing.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(sharing.ctx)
	runtime := &workbenchRuntime{cancel: cancel, done: make(chan struct{}), state: "connecting"}
	sharing.runtimes[id] = runtime
	options := workbenchConnectOptions{URL: target.URL, Token: target.Token, CACertificate: target.CACertificate, Directory: target.WorkingDirectory,
		MCPURL: target.MCPURL, MCPTokenFile: target.MCPTokenFile, GladID: sharing.config.GladID, Alias: sharing.config.Alias, Config: sharing.globalConfig}
	sharing.mu.Unlock()
	go func() {
		defer close(runtime.done)
		err := connectWorkbench(ctx, options, sharing.assets, func(bridge *workbenchBridge, peerID, peerAlias string) {
			sharing.mu.Lock()
			defer sharing.mu.Unlock()
			if sharing.runtimes[id] != runtime {
				return
			}
			runtime.state, runtime.bridge = "connected", bridge
			next := sharing.nextConfig()
			for index := range next.Workbenches {
				item := &next.Workbenches[index]
				if item.ID == id && peerID != "" && (item.WorkbenchID != peerID || item.WorkbenchAlias != peerAlias) {
					item.WorkbenchID, item.WorkbenchAlias = peerID, peerAlias
					if saveErr := sharing.commitLocked(next); saveErr != nil {
						runtime.errorText = "工作台身份保存失败"
					}
				}
			}
		})
		sharing.mu.Lock()
		if sharing.runtimes[id] != runtime {
			sharing.mu.Unlock()
			return
		}
		runtime.state, runtime.bridge = "disconnected", nil
		if err != nil {
			runtime.errorText = err.Error()
		}
		again := runtime.reconnectRequested && sharing.ctx.Err() == nil
		enabled := false
		for _, target := range sharing.config.Workbenches {
			if target.ID == id {
				enabled = target.AutoConnect
				break
			}
		}
		sharing.mu.Unlock()
		if again && enabled {
			sharing.connect(id)
		}

	}()
}

func (sharing *WorkbenchSharing) Stop(ctx context.Context) {
	sharing.mu.Lock()
	runtimes := []*workbenchRuntime{}
	for _, runtime := range sharing.runtimes {
		runtimes = append(runtimes, runtime)
		runtime.cancel()
	}
	sharing.mu.Unlock()
	for _, runtime := range runtimes {
		select {
		case <-runtime.done:
		case <-ctx.Done():
			return
		}
	}
}
