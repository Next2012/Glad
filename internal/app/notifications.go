package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	sessioncore "glad-web/internal/session"
)

type ServerChanSettings struct {
	SendKey    string `json:"sendKey"`
	ClientType string `json:"clientType"`
}
type NotificationService struct {
	config       *ConfigStore
	client       *http.Client
	mu           sync.Mutex
	seen         map[string]map[string]bool
	deliveries   chan notificationDelivery
	sessions     *SessionManager
	subscription *sessioncore.Subscription
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	startOnce    sync.Once
	closeOnce    sync.Once
}

type notificationDelivery struct {
	settings    ServerChanSettings
	title       string
	description string
}

func NewNotificationService(config *ConfigStore, sessions *SessionManager) *NotificationService {
	service := &NotificationService{
		config:     config,
		client:     &http.Client{Timeout: 10 * time.Second},
		seen:       map[string]map[string]bool{},
		deliveries: make(chan notificationDelivery, 64),
		sessions:   sessions,
	}
	return service
}

func (service *NotificationService) Start(parent context.Context) {
	service.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		service.cancel = cancel
		service.subscription = service.sessions.Events().Subscribe("", 2048)
		service.wg.Add(2)
		go service.consumeEvents(ctx)
		go service.deliver(ctx)
	})
}

func (service *NotificationService) consumeEvents(ctx context.Context) {
	defer service.wg.Done()
	for {
		select {
		case event := <-service.subscription.Events():
			if stringValue(event.Payload["type"]) == "session-closed" {
				service.mu.Lock()
				delete(service.seen, event.SessionID)
				service.mu.Unlock()
				continue
			}
			if current := service.sessions.Get(event.SessionID); current != nil {
				service.HandleEvent(current, event.Payload)
			}
		case <-service.subscription.Done():
			return
		case <-ctx.Done():
			return
		}
	}
}

func (service *NotificationService) deliver(ctx context.Context) {
	defer service.wg.Done()
	for {
		select {
		case delivery := <-service.deliveries:
			if err := service.Send(delivery.settings, delivery.title, delivery.description); err != nil {
				logDebug("[serverchan] notification failed: %v", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (service *NotificationService) Close() {
	service.closeOnce.Do(func() {
		if service.cancel != nil {
			service.cancel()
		}
		if service.subscription != nil {
			service.subscription.Close()
		}
		service.wg.Wait()
		service.mu.Lock()
		service.seen = map[string]map[string]bool{}
		service.mu.Unlock()
	})
}
func (service *NotificationService) settings() ServerChanSettings {
	result := ServerChanSettings{ClientType: "wechat"}
	bytes, _ := json.Marshal(service.config.Get("serverChan"))
	_ = json.Unmarshal(bytes, &result)
	if result.ClientType != "pushdeer" {
		result.ClientType = "wechat"
	}
	return result
}
func publicServerChan(settings ServerChanSettings) map[string]any {
	mask := ""
	if settings.SendKey != "" {
		prefix := settings.SendKey
		if len(prefix) > 3 {
			prefix = prefix[:3]
		}
		mask = prefix + strings.Repeat("•", 10)
	}
	return map[string]any{"configured": settings.SendKey != "", "maskedKey": mask, "clientType": settings.ClientType}
}
func validateServerChan(input map[string]any, existing ServerChanSettings) (ServerChanSettings, error) {
	key := strings.TrimSpace(stringValue(input["sendKey"]))
	if key == "" {
		key = existing.SendKey
	}
	if len(key) < 8 || len(key) > 512 || strings.ContainsAny(key, " \t\r\n") {
		return ServerChanSettings{}, errors.New("请输入有效的 Server酱 SendKey")
	}
	client := firstNonEmpty(stringValue(input["clientType"]), existing.ClientType, "wechat")
	if client != "wechat" && client != "pushdeer" {
		return ServerChanSettings{}, errors.New("接收客户端必须是微信或 PushDeer")
	}
	return ServerChanSettings{SendKey: key, ClientType: client}, nil
}
func (service *NotificationService) Send(settings ServerChanSettings, title, description string) error {
	values := url.Values{"title": {truncate(strings.ReplaceAll(title, "\n", " "), 64)}, "desp": {description}}
	request, err := http.NewRequestWithContext(
		context.Background(),
		http.MethodPost,
		"https://sctapi.ftqq.com/"+url.PathEscape(settings.SendKey)+".send",
		strings.NewReader(values.Encode()),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := service.client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return errors.New("Server酱请求超时")
		}
		return errors.New("Server酱请求失败")
	}
	defer response.Body.Close()
	var payload map[string]any
	_ = json.NewDecoder(response.Body).Decode(&payload)
	if response.StatusCode < 200 || response.StatusCode >= 300 || numberInt64(payload["code"]) != 0 {
		return fmt.Errorf("Server酱发送失败: HTTP %d", response.StatusCode)
	}
	return nil
}
func (service *NotificationService) HandleEvent(session *Session, event map[string]any) {
	session.mu.RLock()
	enabled := session.ServerChanNotificationEnabled
	session.mu.RUnlock()
	if !enabled {
		return
	}
	kind := ""
	eventType := stringValue(event["type"])
	if eventType == "permission-request" {
		kind = "待审批"
	}
	if eventType == "runtime-disconnected" {
		kind = "连接中断"
	}
	message := mapValue(event["message"])
	if eventType == "message" && stringValue(message["kind"]) == "turn-end" {
		status := firstNonEmpty(stringValue(message["turnStatus"]), stringValue(message["status"]), "completed")
		if status == "cancelled" {
			return
		}
		if status == "failed" {
			kind = "执行失败"
		} else {
			kind = "已完成"
		}
	}
	if kind == "" {
		return
	}
	key := eventType + ":" + firstNonEmpty(
		stringValue(message["turnId"]),
		stringValue(mapValue(event["request"])["id"]),
		stringValue(message["id"]),
	)
	service.mu.Lock()
	seen := service.seen[session.ID]
	if seen == nil {
		seen = map[string]bool{}
		service.seen[session.ID] = seen
	}
	if seen[key] {
		service.mu.Unlock()
		return
	}
	seen[key] = true
	if len(seen) > 100 {
		for oldest := range seen {
			delete(seen, oldest)
			break
		}
	}
	service.mu.Unlock()
	settings := service.settings()
	if settings.SendKey == "" {
		return
	}
	title, description := formatNotification(kind, session, numberInt64(message["durationMs"]), settings.ClientType)
	select {
	case service.deliveries <- notificationDelivery{settings: settings, title: title, description: description}:
	default:
		logDebug("[serverchan] notification queue is full; dropping %s", key)
	}
}
func formatNotification(kind string, session *Session, duration int64, client string) (string, string) {
	session.mu.RLock()
	name := session.Name
	directory := session.WorkingDirectory
	tool := session.Tool.DisplayName
	started := session.StartTime
	session.mu.RUnlock()
	title := kind + "｜" + truncate(name, 20)
	rows := []string{
		"类型：" + tool,
		"会话：" + name,
		"创建：" + time.UnixMilli(started).Format("2006-01-02 15:04:05"),
		"目录：" + directory,
	}
	if duration > 0 {
		rows = append(rows, fmt.Sprintf("本轮耗时：%d秒", duration/1000))
	}
	if client == "pushdeer" {
		for index, row := range rows {
			parts := strings.SplitN(row, "：", 2)
			if len(parts) == 2 {
				rows[index] = "**" + parts[0] + "：** " + parts[1]
			}
		}
	}
	return title, strings.Join(rows, "\n\n")
}
func truncate(value string, max int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= max {
		return string(runes)
	}
	return string(runes[:max-1]) + "…"
}
func (server *Server) registerNotificationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/notifications/serverchan", func(w http.ResponseWriter, r *http.Request) {
		respondJSON(w, 200, publicServerChan(server.notifications.settings()))
	})
	mux.HandleFunc("PUT /api/notifications/serverchan", server.saveServerChan)
	mux.HandleFunc("DELETE /api/notifications/serverchan", server.clearServerChan)
	mux.HandleFunc("POST /api/notifications/serverchan/test", server.testServerChan)
	mux.HandleFunc("PUT /api/sessions/{id}/notifications/serverchan", server.enableServerChan)
}
func (server *Server) saveServerChan(w http.ResponseWriter, r *http.Request) {
	var input map[string]any
	_ = decodeJSON(r, &input)
	settings, err := validateServerChan(input, server.notifications.settings())
	if err != nil {
		respondError(w, 400, err)
		return
	}
	if err := server.config.Set("serverChan", settings); err != nil {
		respondError(w, 500, err)
		return
	}
	respondJSON(w, 200, map[string]any{"success": true, "settings": publicServerChan(settings)})
}
func (server *Server) clearServerChan(w http.ResponseWriter, r *http.Request) {
	settings := ServerChanSettings{ClientType: "wechat"}
	if err := server.config.Set("serverChan", settings); err != nil {
		respondError(w, 500, err)
		return
	}
	server.sessions.mu.RLock()
	for _, session := range server.sessions.sessions {
		session.mu.Lock()
		session.ServerChanNotificationEnabled = false
		session.mu.Unlock()
	}
	server.sessions.mu.RUnlock()
	respondJSON(w, 200, map[string]any{"success": true, "settings": publicServerChan(settings)})
}
func (server *Server) testServerChan(w http.ResponseWriter, r *http.Request) {
	var input map[string]any
	_ = decodeJSON(r, &input)
	settings, err := validateServerChan(input, server.notifications.settings())
	if err != nil {
		respondError(w, 400, err)
		return
	}
	session := server.sessions.Get(stringValue(input["sessionId"]))
	if session == nil {
		tool, _ := toolByKey("codex")
		session = newSession(newUUID(), "Glad 测试会话", "codex-structured", tool, server.baseDir)
	}
	title, description := formatNotification("通知测试", session, 0, settings.ClientType)
	if err := server.notifications.Send(settings, title, description); err != nil {
		respondError(w, 502, err)
		return
	}
	respondJSON(w, 200, map[string]any{"success": true})
}
func (server *Server) enableServerChan(w http.ResponseWriter, r *http.Request) {
	session := server.sessions.Get(r.PathValue("id"))
	if session == nil {
		notFound(w, "Session not found")
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input)
	enabled := boolValue(input["enabled"])
	settings := server.notifications.settings()
	if enabled && settings.SendKey == "" {
		respondJSON(w, 409, map[string]any{"error": "请先配置 Server酱", "code": "SERVERCHAN_NOT_CONFIGURED"})
		return
	}
	session.mu.Lock()
	session.ServerChanNotificationEnabled = enabled
	session.mu.Unlock()
	respondJSON(
		w,
		200,
		map[string]any{
			"success": true,
			"state":   map[string]any{"enabled": enabled, "configured": settings.SendKey != ""},
		},
	)
}
