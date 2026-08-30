package app

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

type SkillHubSettings struct {
	BaseURL string
	Token   string
}
type SkillHubService struct {
	config    *ConfigStore
	sessions  *SessionManager
	client    *http.Client
	root      string
	mu        sync.Mutex
	available bool
}

func NewSkillHubService(config *ConfigStore, sessions *SessionManager) *SkillHubService {
	root := os.Getenv("GLAD_SKILL_SESSION_ROOT")
	if root == "" {
		root = "/run/glad-skill-sessions"
	}
	service := &SkillHubService{
		config:   config,
		sessions: sessions,
		client:   &http.Client{Timeout: 15 * time.Second},
		root:     root,
	}
	service.initialize()
	return service
}
func (service *SkillHubService) initialize() {
	if runtime.GOOS != "linux" {
		return
	}
	_ = os.MkdirAll(service.root, 0o700)
	if !service.tmpfsMounted() {
		command := exec.Command(
			"mount",
			"-t",
			"tmpfs",
			"-o",
			fmt.Sprintf("rw,nosuid,nodev,noexec,size=128m,mode=0700,uid=%d,gid=%d", os.Getuid(), os.Getgid()),
			"tmpfs",
			service.root,
		)
		_ = command.Run()
	}
	service.available = service.tmpfsMounted()
	if service.available {
		entries, _ := os.ReadDir(service.root)
		for _, entry := range entries {
			if entry.IsDir() && uuidPattern.MatchString(entry.Name()) {
				_ = os.RemoveAll(filepath.Join(service.root, entry.Name()))
			}
		}
	}
}
func (service *SkillHubService) tmpfsMounted() bool {
	bytes, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(bytes), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && strings.ReplaceAll(fields[1], `\040`, " ") == service.root && fields[2] == "tmpfs" {
			return true
		}
	}
	return false
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

func (service *SkillHubService) encryptionKey() ([]byte, error) {
	filename := os.Getenv("GLAD_SKILLHUB_KEY_FILE")
	if filename == "" {
		return nil, errors.New("Glad 未配置 SkillHub Token 加密密钥")
	}
	bytes, err := os.ReadFile(filename)
	if err != nil {
		return nil, errors.New("Glad 无法读取 SkillHub Token 加密密钥")
	}
	text := strings.TrimSpace(string(bytes))
	if decoded, err := hex.DecodeString(text); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if decoded, err := base64.StdEncoding.DecodeString(text); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if len(bytes) == 32 {
		return bytes, nil
	}
	return nil, errors.New("SkillHub Token 加密密钥必须是 32 字节")
}
func (service *SkillHubService) encrypt(token string) (map[string]any, error) {
	key, err := service.encryptionKey()
	if err != nil {
		return nil, err
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	_, _ = rand.Read(nonce)
	sealed := gcm.Seal(nil, nonce, []byte(token), nil)
	overhead := gcm.Overhead()
	return map[string]any{
		"ciphertext": base64.StdEncoding.EncodeToString(sealed[:len(sealed)-overhead]),
		"iv":         base64.StdEncoding.EncodeToString(nonce),
		"authTag":    base64.StdEncoding.EncodeToString(sealed[len(sealed)-overhead:]),
	}, nil
}
func (service *SkillHubService) decrypt(envelope map[string]any) (string, error) {
	if stringValue(envelope["ciphertext"]) == "" {
		return "", nil
	}
	key, err := service.encryptionKey()
	if err != nil {
		return "", err
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	nonce, err := base64.StdEncoding.DecodeString(stringValue(envelope["iv"]))
	if err != nil {
		return "", err
	}
	sealed, err := base64.StdEncoding.DecodeString(stringValue(envelope["ciphertext"]))
	if err != nil {
		return "", err
	}
	if tag := stringValue(envelope["authTag"]); tag != "" {
		decodedTag, decodeErr := base64.StdEncoding.DecodeString(tag)
		if decodeErr != nil {
			return "", decodeErr
		}
		sealed = append(sealed, decodedTag...)
	}
	plain, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		return "", errors.New("SkillHub Token 解密失败，请重新配置")
	}
	return string(plain), nil
}
func (service *SkillHubService) settings() (SkillHubSettings, error) {
	stored := mapValue(service.config.Get("skillHub"))
	token, err := service.decrypt(mapValue(stored["token"]))
	if err != nil {
		return SkillHubSettings{}, err
	}
	return SkillHubSettings{BaseURL: stringValue(stored["baseUrl"]), Token: token}, nil
}
func validateSkillHubSettings(input map[string]any, existing SkillHubSettings) (SkillHubSettings, error) {
	base := strings.TrimSpace(stringValue(input["baseUrl"]))
	if base == "" {
		base = existing.BaseURL
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") {
		return SkillHubSettings{}, errors.New("请输入有效的 SkillHub 地址")
	}
	local := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1" ||
		parsed.Hostname() == "skillhub"
	if parsed.Scheme == "http" && !local {
		return SkillHubSettings{}, errors.New("远程 SkillHub 必须使用 HTTPS")
	}
	token := strings.TrimSpace(stringValue(input["token"]))
	if token == "" {
		token = existing.Token
	}
	if len(token) < 12 || len(token) > 2048 || strings.ContainsAny(token, " \t\r\n") {
		return SkillHubSettings{}, errors.New("请输入有效的 SkillHub API Token")
	}
	return SkillHubSettings{BaseURL: strings.TrimRight(parsed.String(), "/"), Token: token}, nil
}
func publicSkillHub(settings SkillHubSettings) map[string]any {
	mask := ""
	if settings.Token != "" {
		prefix := settings.Token
		if len(prefix) > 7 {
			prefix = prefix[:7]
		}
		mask = prefix + strings.Repeat("•", 10)
	}
	return map[string]any{
		"configured":  settings.BaseURL != "" && settings.Token != "",
		"baseUrl":     settings.BaseURL,
		"maskedToken": mask,
	}
}
func (service *SkillHubService) save(settings SkillHubSettings) (map[string]any, error) {
	encrypted, err := service.encrypt(settings.Token)
	if err != nil {
		return nil, err
	}
	if err := service.config.Set("skillHub", map[string]any{"baseUrl": settings.BaseURL, "token": encrypted}); err != nil {
		return nil, err
	}
	return publicSkillHub(settings), nil
}

func (service *SkillHubService) request(
	ctx context.Context,
	settings SkillHubSettings,
	method, pathname string,
	body any,
	accept string,
) (*http.Response, error) {
	target := strings.TrimRight(settings.BaseURL, "/") + "/" + strings.TrimLeft(pathname, "/")
	var reader io.Reader
	if body != nil {
		payloadBytes, _ := json.Marshal(body)
		reader = bytes.NewReader(payloadBytes)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+settings.Token)
	request.Header.Set("Accept", accept)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := service.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("无法连接 SkillHub：%w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return nil, fmt.Errorf("SkillHub 返回 HTTP %d", response.StatusCode)
	}
	return response, nil
}
func (service *SkillHubService) whoami(ctx context.Context, settings SkillHubSettings) (map[string]any, error) {
	response, err := service.request(ctx, settings, "GET", "/api/v1/whoami", nil, "application/json")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var result map[string]any
	err = json.NewDecoder(response.Body).Decode(&result)
	return result, err
}
func (service *SkillHubService) list(ctx context.Context) ([]any, error) {
	settings, err := service.settings()
	if err != nil {
		return nil, err
	}
	items := []any{}
	cursor := ""
	for page := 0; page < 100; page++ {
		query := url.Values{"limit": {"100"}, "order": {"updated_at_desc"}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		response, err := service.request(
			ctx,
			settings,
			"GET",
			"/api/runtime/skills?"+query.Encode(),
			nil,
			"application/json",
		)
		if err != nil {
			return nil, err
		}
		var payload map[string]any
		err = json.NewDecoder(response.Body).Decode(&payload)
		response.Body.Close()
		if err != nil {
			return nil, err
		}
		items = append(items, sliceValue(payload["data"])...)
		cursor = stringValue(payload["nextCursor"])
		if cursor == "" {
			return items, nil
		}
	}
	return nil, errors.New("SkillHub Skill 列表分页过多")
}

type skillManifestFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func (service *SkillHubService) prepare(
	ctx context.Context,
	sessionID string,
	selection map[string]any,
) (map[string]any, error) {
	if !service.available {
		return nil, errors.New("Skill暂不可用")
	}
	settings, err := service.settings()
	if err != nil {
		return nil, err
	}
	id := stringValue(selection["id"])
	query := url.Values{"include": {"manifest,skillMd"}}
	if value := stringValue(selection["version"]); value != "" {
		query.Set("version", value)
	}
	if value := stringValue(selection["digest"]); value != "" {
		query.Set("digest", value)
	}
	response, err := service.request(
		ctx,
		settings,
		"GET",
		"/api/runtime/skills/by-id/"+url.PathEscape(id)+"?"+query.Encode(),
		nil,
		"application/json",
	)
	if err != nil {
		return nil, err
	}
	var detail map[string]any
	err = json.NewDecoder(response.Body).Decode(&detail)
	response.Body.Close()
	if err != nil {
		return nil, err
	}
	version, digest := stringValue(detail["version"]), stringValue(detail["digest"])
	bundleQuery := url.Values{"id": {id}, "format": {"zip"}, "version": {version}, "digest": {digest}}
	bundleResponse, err := service.request(
		ctx,
		settings,
		"GET",
		"/api/runtime/skills/bundle?"+bundleQuery.Encode(),
		nil,
		"application/zip",
	)
	if err != nil {
		return nil, err
	}
	bundle, err := io.ReadAll(io.LimitReader(bundleResponse.Body, 20<<20+1))
	bundleResponse.Body.Close()
	if err != nil || len(bundle) > 20<<20 {
		return nil, errors.New("Skill bundle 超过 20 MB")
	}
	if expected := bundleResponse.Header.Get("x-saker-bundle-sha256"); expected != "" {
		actual := fmt.Sprintf("%x", sha256.Sum256(bundle))
		if actual != strings.ToLower(expected) {
			return nil, errors.New("Skill bundle SHA256 校验失败")
		}
	}
	manifest := mapValue(detail["manifest"])
	var files []skillManifestFile
	manifestBytes, _ := json.Marshal(manifest["files"])
	_ = json.Unmarshal(manifestBytes, &files)
	destination := filepath.Join(service.root, sessionID, "skills", id)
	if err := extractSkillBundle(bundle, files, destination); err != nil {
		return nil, err
	}
	skillMD, err := os.ReadFile(filepath.Join(destination, "SKILL.md"))
	if err != nil {
		return nil, err
	}
	match := regexp.MustCompile(`(?m)^name\s*:\s*["']?([a-zA-Z0-9._-]+)`).FindStringSubmatch(string(skillMD))
	if len(match) < 2 {
		return nil, errors.New("SKILL.md 缺少 name")
	}
	defaultPrompt := ""
	if metadata, err := os.ReadFile(filepath.Join(destination, "agents", "openai.yaml")); err == nil &&
		len(metadata) <= 64<<10 {
		promptMatch := regexp.MustCompile(`(?m)^\s*default_prompt\s*:\s*["']?(.*?)["']?\s*$`).
			FindStringSubmatch(string(metadata))
		if len(promptMatch) > 1 && len(promptMatch[1]) <= 8000 {
			defaultPrompt = strings.TrimSpace(promptMatch[1])
		}
	}
	return map[string]any{
		"id":            id,
		"name":          match[1],
		"version":       version,
		"digest":        digest,
		"defaultPrompt": defaultPrompt,
		"skillsRoot":    filepath.Join(service.root, sessionID, "skills"),
		"path":          filepath.Join(destination, "SKILL.md"),
	}, nil
}
func extractSkillBundle(bundle []byte, manifest []skillManifestFile, destination string) error {
	if len(manifest) == 0 || len(manifest) > 256 {
		return errors.New("Skill manifest 文件数无效")
	}
	expected := map[string]skillManifestFile{}
	for _, file := range manifest {
		clean := filepath.ToSlash(filepath.Clean(file.Path))
		if clean == "." || strings.HasPrefix(clean, "../") || filepath.IsAbs(clean) || file.Size > 10<<20 {
			return errors.New("Skill manifest 文件声明无效")
		}
		expected[clean] = file
	}
	reader, err := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if err != nil {
		return err
	}
	_ = os.MkdirAll(destination, 0o700)
	written := map[string]bool{}
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		name := filepath.ToSlash(filepath.Clean(entry.Name))
		if _, ok := expected[name]; !ok {
			if index := strings.Index(name, "/"); index > 0 {
				if _, nestedOK := expected[name[index+1:]]; nestedOK {
					name = name[index+1:]
				}
			}
		}
		declared, ok := expected[name]
		if !ok || written[name] || entry.Mode()&os.ModeSymlink != 0 {
			return errors.New("Skill bundle 包含未声明或不安全文件")
		}
		stream, err := entry.Open()
		if err != nil {
			return err
		}
		content, err := io.ReadAll(io.LimitReader(stream, 10<<20+1))
		stream.Close()
		if err != nil || int64(len(content)) != declared.Size ||
			fmt.Sprintf("%x", sha256.Sum256(content)) != strings.ToLower(declared.SHA256) {
			return errors.New("Skill 文件校验失败：" + name)
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		mode := os.FileMode(0o600)
		if entry.Mode()&0o111 != 0 {
			mode = 0o700
		}
		if err := os.WriteFile(target, content, mode); err != nil {
			return err
		}
		written[name] = true
	}
	if len(written) != len(expected) {
		return errors.New("Skill bundle 缺少文件")
	}
	return nil
}
func (server *Server) registerSkillHubRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/skillhub/status", func(w http.ResponseWriter, r *http.Request) {
		respondJSON(w, 200, map[string]any{"available": server.skillhub.available})
	})
	mux.HandleFunc("GET /api/skillhub/settings", server.getSkillHubSettings)
	mux.HandleFunc("PUT /api/skillhub/settings", server.saveSkillHubSettings)
	mux.HandleFunc("DELETE /api/skillhub/settings", server.clearSkillHubSettings)
	mux.HandleFunc("POST /api/skillhub/settings/test", server.testSkillHubSettings)
	mux.HandleFunc("GET /api/skillhub/skills", server.listSkillHub)
	mux.HandleFunc("POST /api/skillhub/sessions", server.createSkillHubSession)
}
func (server *Server) getSkillHubSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := server.skillhub.settings()
	if err != nil {
		respondError(w, 503, err)
		return
	}
	respondJSON(w, 200, publicSkillHub(settings))
}
func (server *Server) saveSkillHubSettings(w http.ResponseWriter, r *http.Request) {
	var input map[string]any
	_ = decodeJSON(r, &input)
	existing, _ := server.skillhub.settings()
	settings, err := validateSkillHubSettings(input, existing)
	if err != nil {
		respondError(w, 400, err)
		return
	}
	user, err := server.skillhub.whoami(r.Context(), settings)
	if err != nil {
		respondError(w, 502, err)
		return
	}
	public, err := server.skillhub.save(settings)
	if err != nil {
		respondError(w, 503, err)
		return
	}
	respondJSON(w, 200, map[string]any{"success": true, "settings": public, "user": user})
}
func (server *Server) clearSkillHubSettings(w http.ResponseWriter, r *http.Request) {
	_ = server.config.Set("skillHub", map[string]any{"baseUrl": "", "token": map[string]any{}})
	respondJSON(w, 200, map[string]any{"success": true, "settings": publicSkillHub(SkillHubSettings{})})
}
func (server *Server) testSkillHubSettings(w http.ResponseWriter, r *http.Request) {
	var input map[string]any
	_ = decodeJSON(r, &input)
	existing, _ := server.skillhub.settings()
	settings, err := validateSkillHubSettings(input, existing)
	if err != nil {
		respondError(w, 400, err)
		return
	}
	user, err := server.skillhub.whoami(r.Context(), settings)
	if err != nil {
		respondError(w, 502, err)
		return
	}
	respondJSON(w, 200, map[string]any{"success": true, "user": user})
}
func (server *Server) listSkillHub(w http.ResponseWriter, r *http.Request) {
	items, err := server.skillhub.list(r.Context())
	if err != nil {
		respondError(w, 502, err)
		return
	}
	respondJSON(w, 200, map[string]any{"success": true, "skills": items})
}
func (server *Server) createSkillHubSession(w http.ResponseWriter, r *http.Request) {
	var input map[string]any
	_ = decodeJSON(r, &input)
	if stringValue(input["toolKey"]) != "codex" {
		respondError(w, 400, errors.New("SkillHub Session 当前只支持 Codex"))
		return
	}
	id := newUUID()
	skill, err := server.skillhub.prepare(r.Context(), id, mapValue(input["skill"]))
	if err != nil {
		respondError(w, 503, err)
		return
	}
	request := CreateSessionRequest{
		ID:               id,
		ToolKey:          "codex",
		WorkingDirectory: stringValue(input["workingDirectory"]),
		Name:             stringValue(skill["name"]),
		CodexOptions:     map[string]any{"activeSkill": skill, "extraSkillRoots": []any{skill["skillsRoot"]}},
	}
	session, err := server.sessions.Create(r.Context(), request)
	if err != nil {
		_ = os.RemoveAll(filepath.Join(server.skillhub.root, id))
		respondError(w, 400, err)
		return
	}
	session.dispose = func() { _ = os.RemoveAll(filepath.Join(server.skillhub.root, id)) }
	prompt := firstNonEmpty(
		stringValue(skill["defaultPrompt"]),
		"请先用中文介绍这个 Skill 能完成什么、适合哪些任务，以及用户接下来应该如何使用。这一轮只做使用引导。",
	)
	_ = session.Provider.Send(
		r.Context(),
		ProviderInput{
			Text:      "$" + stringValue(skill["name"]) + "\n\n" + prompt,
			AgentText: "$" + stringValue(skill["name"]) + "\n\n" + prompt,
			Skills:    []map[string]any{skill},
		},
	)
	respondJSON(w, 201, map[string]any{"id": session.ID, "name": session.Name})
}
