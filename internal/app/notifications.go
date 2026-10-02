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
	seen         map[string]*notificationHistory
	deliveries   chan notificationDelivery
	sessions     *SessionManager
	rooms        *RoomManager
	subscription *sessioncore.Subscription
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	startOnce    sync.Once
	closeOnce    sync.Once
}

// 保留最近 100 个已入队事件，按顺序淘汰，避免随机删除刚插入的去重键。
type notificationHistory struct {
	keys  map[string]bool
	order []string
}

type notificationDelivery struct {
	settings    ServerChanSettings
	title       string
	description string
}

func NewNotificationService(config *ConfigStore, sessions *SessionManager, rooms *RoomManager) *NotificationService {
	service := &NotificationService{
		config:     config,
		client:     &http.Client{Timeout: 10 * time.Second},
		seen:       map[string]*notificationHistory{},
		deliveries: make(chan notificationDelivery, 64),
		sessions:   sessions,
		rooms:      rooms,
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
				service.HandleRoomEvent(current, event.Payload)
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
		service.seen = map[string]*notificationHistory{}
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

type classifiedNotification struct {
	kind, eventType, id string
	message             map[string]any
}

func classifyNotification(session *Session, event map[string]any) (classifiedNotification, bool) {
	result := classifiedNotification{eventType: stringValue(event["type"]), message: mapValue(event["message"])}
	switch result.eventType {
	case "permission-request":
		result.kind = "待审批"
	case "runtime-disconnected":
		result.kind = "连接中断"
	case "question-request":
		result.kind = "待回复"
	case "message":
		if stringValue(result.message["kind"]) != "turn-end" {
			return classifiedNotification{}, false
		}
		// 等待自动续跑的中间失败保留历史，最终结果再通知。
		if boolValue(result.message["retryScheduled"]) {
			return classifiedNotification{}, false
		}
		// 主任务可能仍在运行，不能把子任务或旧轮次的结束当成整轮完成。
		if session.Kind == "codex-structured" && !boolValue(result.message["isRootTurn"]) {
			return classifiedNotification{}, false
		}
		switch firstNonEmpty(stringValue(result.message["turnStatus"]), stringValue(result.message["status"])) {
		case "completed":
			result.kind = "已完成"
		case "failed":
			result.kind = "执行失败"
		default:
			return classifiedNotification{}, false
		}
	default:
		return classifiedNotification{}, false
	}
	result.id = notificationEventID(event, result.message)
	return result, result.id != ""
}

func (service *NotificationService) enqueue(scope, key string, delivery notificationDelivery) {
	service.mu.Lock()
	defer service.mu.Unlock()
	seen := service.seen[scope]
	if seen != nil && seen.keys[key] {
		return
	}
	select {
	case service.deliveries <- delivery:
		if seen == nil {
			seen = &notificationHistory{keys: map[string]bool{}}
			service.seen[scope] = seen
		}
		seen.keys[key] = true
		seen.order = append(seen.order, key)
		if len(seen.order) > 100 {
			delete(seen.keys, seen.order[0])
			seen.order = seen.order[1:]
		}
	default:
		logDebug("[serverchan] notification queue is full; dropping %s", scope+":"+key)
	}
}

func (service *NotificationService) HandleEvent(session *Session, event map[string]any) {
	session.mu.RLock()
	enabled := session.ServerChanNotificationEnabled
	session.mu.RUnlock()
	classified, ok := classifyNotification(session, event)
	if !enabled || !ok {
		return
	}
	settings := service.settings()
	if settings.SendKey == "" {
		return
	}
	title, description := formatNotification(classified.kind, session, numberInt64(classified.message["durationMs"]), settings.ClientType)
	if classified.eventType == "question-request" {
		description += "\n\n模型有新问题，请打开 Glad 会话回复。"
	}
	service.enqueue(session.ID, classified.eventType+":"+classified.id, notificationDelivery{settings: settings, title: title, description: description})
}

func (service *NotificationService) HandleRoomEvent(session *Session, event map[string]any) {
	classified, ok := classifyNotification(session, event)
	if service.rooms == nil || !ok {
		return
	}
	// Disk-backed room membership is consulted only for notification-worthy
	// events, never for token/message delta traffic.
	targets := service.rooms.NotificationTargets(
		session.ID,
		stringValue(classified.message["turnId"]),
		classified.kind == "已完成",
	)
	if len(targets) == 0 {
		return
	}
	settings := service.settings()
	if settings.SendKey == "" {
		return
	}
	for _, target := range targets {
		title, description := formatRoomNotification(classified.kind, target, session, numberInt64(classified.message["durationMs"]), settings.ClientType)
		if classified.eventType == "question-request" {
			description += "\n\n模型有新问题，请打开 Glad 群聊回复。"
		}
		service.enqueue("room:"+target.RoomID, classified.eventType+":"+classified.id, notificationDelivery{settings: settings, title: title, description: description})
	}
}

func notificationEventID(event, message map[string]any) string {
	switch stringValue(event["type"]) {
	case "permission-request":
		// 内部事件携带 Permission 结构体，JSON 事件则携带 map。
		switch request := event["request"].(type) {
		case Permission:
			return request.ID
		case *Permission:
			if request != nil {
				return request.ID
			}
		default:
			return stringValue(mapValue(request)["id"])
		}
	case "runtime-disconnected":
		return firstNonEmpty(stringValue(event["turnId"]), stringValue(event["id"]))
	case "question-request":
		// Cards in the same turn need separate reminders and completion keys.
		return stringValue(event["id"])
	default:
		if turn := stringValue(message["turnId"]); turn != "" {
			return stringValue(message["threadId"]) + ":" + turn
		}
		return stringValue(message["id"])
	}
	return ""
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

func formatRoomNotification(kind string, target RoomNotificationTarget, session *Session, duration int64, client string) (string, string) {
	session.mu.RLock()
	tool := session.Tool.DisplayName
	directory := session.WorkingDirectory
	sessionName := session.Name
	session.mu.RUnlock()
	progress := fmt.Sprintf("%d/%d", target.RoundCompleted, target.RoundTotal)
	title := kind + "｜" + truncate(target.RoomName, 16) + "｜" + progress
	sessionLabel := "当前会话："
	if kind == "已完成" {
		sessionLabel = "完成会话："
	} else if kind == "执行失败" {
		sessionLabel = "失败会话："
	}
	rows := []string{
		"群聊：" + target.RoomName,
		sessionLabel + target.MemberName,
		"类型：" + firstNonEmpty(target.ToolName, tool),
		"本轮进度：" + progress,
		fmt.Sprintf("群成员：%d个", target.ActiveMembers),
		"会话：" + sessionName,
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
	mux.HandleFunc("PUT /api/rooms/{id}/notifications/serverchan", server.enableRoomServerChan)
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
	server.rooms.DisableServerChanNotifications()
	respondJSON(w, 200, map[string]any{"success": true, "settings": publicServerChan(settings)})
}

func (server *Server) enableRoomServerChan(w http.ResponseWriter, r *http.Request) {
	if _, err := server.rooms.GetRecord(r.PathValue("id")); err != nil {
		server.writeRoomError(w, err)
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
	if err := server.rooms.SetServerChanNotification(r.PathValue("id"), enabled); err != nil {
		server.writeRoomError(w, err)
		return
	}
	respondJSON(w, 200, map[string]any{
		"success": true,
		"state":   map[string]any{"enabled": enabled, "configured": settings.SendKey != ""},
	})
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
