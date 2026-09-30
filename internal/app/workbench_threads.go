package app

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// 原生对话 ID 按工作台入口和客户端身份保存在本地，重连时不开放其他本地历史。
func (bridge *workbenchBridge) loadThreads(endpoint, clientID string) error {
	if clientID == "" {
		return errors.New("工作台未返回客户端身份")
	}
	configRoot, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	key := sha256.Sum256([]byte(endpoint + "\n" + clientID + "\n" + bridge.server.baseDir))
	bridge.threadFile = filepath.Join(configRoot, "glad-workbench", fmt.Sprintf("%x.json", key))
	data, err := os.ReadFile(bridge.threadFile)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取连接的本地对话记录: %w", err)
	}
	if json.Unmarshal(data, &bridge.threads) != nil || bridge.threads == nil {
		return errors.New("连接的本地对话记录无效")
	}
	return nil
}

func (bridge *workbenchBridge) knowsThread(threadID string) bool {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return threadID != "" && bridge.threads[threadID]
}

func (bridge *workbenchBridge) rememberThread(session *Session, notify bool) {
	session.mu.RLock()
	threadID := firstNonEmpty(stringValue(session.State["threadId"]), stringValue(session.State["claudeSessionId"]))
	session.mu.RUnlock()
	if threadID == "" {
		return
	}
	bridge.mu.Lock()
	if bridge.threads == nil {
		bridge.threads = map[string]bool{}
	}
	changed := !bridge.threads[threadID]
	bridge.threads[threadID] = true
	bridge.threadsDirty = bridge.threadsDirty || changed
	if bridge.threadsDirty && bridge.threadFile != "" {
		data, err := json.Marshal(bridge.threads)
		if err == nil {
			err = os.MkdirAll(filepath.Dir(bridge.threadFile), 0700)
		}
		if err == nil {
			err = os.WriteFile(bridge.threadFile+".tmp", data, 0600)
		}
		if err == nil {
			err = os.Rename(bridge.threadFile+".tmp", bridge.threadFile)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "GLAD_WORKBENCH_THREAD_RECORD_FAILED")
		} else {
			bridge.threadsDirty = false
		}
	}
	bridge.mu.Unlock()
	if notify {
		_ = bridge.write(workbenchMessage{Type: "session_state", SessionID: session.ID,
			ThreadID: threadID, ToolKey: session.Tool.Key})
	}
}

func (bridge *workbenchBridge) observeThread(session *Session) {
	subscription, _ := session.subscribeWithSnapshot(64)
	bridge.rememberThread(session, true)
	bridge.tasks.Add(1)
	go func() {
		defer bridge.tasks.Done()
		defer subscription.Close()
		for {
			select {
			case event := <-subscription.Events():
				if stringValue(event.Payload["type"]) == "state" {
					bridge.rememberThread(session, true)
				}
			case <-subscription.Done():
				return
			case <-bridge.ctx.Done():
				return
			}
		}
	}()
}

func (bridge *workbenchBridge) rememberAllThreads() {
	bridge.mu.Lock()
	ids := make([]string, 0, len(bridge.owned))
	for id := range bridge.owned {
		ids = append(ids, id)
	}
	bridge.mu.Unlock()
	for _, id := range ids {
		if session := bridge.server.sessions.Get(id); session != nil {
			bridge.rememberThread(session, false)
		}
	}
}
