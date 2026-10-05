package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// 资源 URI 通过当前会话自己的 MCP 身份读取，浏览器不接触令牌。
func (server *Server) markdownMCPResource(writer http.ResponseWriter, request *http.Request) {
	session, ok := server.sessionForRoute(writer, request)
	if !ok {
		return
	}
	uri := request.URL.Query().Get("uri")
	if !strings.HasPrefix(uri, "botlink-hub://resource/") || len(uri) > 8192 {
		http.Error(writer, "MCP 资源 URI 无效", http.StatusBadRequest)
		return
	}
	endpoint, tokenFile := "", ""
	for _, entry := range session.environment {
		if value, found := strings.CutPrefix(entry, "GLAD_WORKBENCH_MCP_URL="); found {
			endpoint = value
		}
		if value, found := strings.CutPrefix(entry, "GLAD_WORKBENCH_MCP_TOKEN_FILE="); found {
			tokenFile = value
		}
	}
	if endpoint == "" || tokenFile == "" {
		http.Error(writer, "此连接尚未配置原用户的 MCP 资源访问身份，请在连接设置中配置", http.StatusConflict)
		return
	}
	token, err := os.ReadFile(tokenFile)
	if err != nil || len(strings.TrimSpace(string(token))) < 32 {
		http.Error(writer, "此连接的 MCP 资源访问凭据不可用", http.StatusForbidden)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 35*time.Second)
	defer cancel()
	content, status, err := readMarkdownMCPResource(ctx, endpoint, strings.TrimSpace(string(token)), uri)
	if err != nil {
		http.Error(writer, err.Error(), status)
		return
	}
	contentType := http.DetectContentType(content)
	if contentType != "application/pdf" && !strings.HasPrefix(contentType, "image/") {
		contentType = "text/plain; charset=utf-8"
	}
	filename := "mcp-resource"
	if contentType == "application/pdf" {
		filename += ".pdf"
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filename}))
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	_, _ = writer.Write(content)
}

func readMarkdownMCPResource(ctx context.Context, endpoint, token, uri string) ([]byte, int, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, http.StatusBadGateway, errors.New("此连接的 MCP 地址无效")
	}
	// 不跟随跳转，避免把原用户令牌交给别的地址。
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	// botlink-hub 资源使用 Hub 已有的现代无状态请求，避免创建或清理共享前端会话。
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": "resources/read", "method": "resources/read",
		"params": map[string]any{"uri": uri},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, http.StatusBadGateway, errors.New("无法创建 MCP 资源请求")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2026-07-28")
	response, err := client.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, errors.New("无法连接 MCP 资源服务")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return nil, http.StatusForbidden, errors.New("当前 MCP 身份无权读取此资源")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, http.StatusBadGateway, errors.New("MCP 资源服务请求失败")
	}
	envelope, err := decodeMarkdownMCPResponse(response.Body, response.Header.Get("Content-Type"), "resources/read")
	if err != nil || envelope["error"] != nil {
		// 不把上游错误原文送到浏览器，避免携带内部地址或凭据。
		return nil, http.StatusBadGateway, errors.New("MCP 资源读取失败，请检查当前身份的资源权限")
	}
	result := mapValue(envelope["result"])
	if boolValue(result["isError"]) {
		code := stringValue(mapValue(mapValue(result["structuredContent"])["error"])["code"])
		if code == "resource_not_found" || code == "task_not_found" {
			return nil, http.StatusNotFound, errors.New("原 MCP 资源不可访问或已过期")
		}
		return nil, http.StatusBadGateway, errors.New("MCP 资源读取失败")
	}
	for _, value := range sliceValue(result["contents"]) {
		resource := mapValue(value)
		if stringValue(resource["uri"]) != uri {
			continue
		}
		var content []byte
		if blob, ok := resource["blob"].(string); ok {
			content, err = base64.StdEncoding.DecodeString(blob)
		} else if text, ok := resource["text"].(string); ok {
			content = []byte(text)
		} else {
			continue
		}
		if err != nil || len(content) > maxWorkspaceFileBytes {
			return nil, http.StatusBadGateway, errors.New("MCP 资源内容无效或超过 4 MB")
		}
		return content, http.StatusOK, nil
	}
	return nil, http.StatusNotFound, errors.New("原 MCP 资源未返回，可能已过期")
}

// SSE 的多行 data 属于同一个事件；通知不能替代本次 RPC 的结果。
func decodeMarkdownMCPResponse(reader io.Reader, contentType, requestID string) (map[string]any, error) {
	limited := &io.LimitedReader{R: reader, N: 8<<20 + 1}
	decode := func(data []byte) (map[string]any, bool) {
		var result map[string]any
		if json.Unmarshal(data, &result) != nil || result == nil {
			return nil, false
		}
		id, ok := result["id"].(string)
		_, hasResult := result["result"].(map[string]any)
		_, hasError := result["error"].(map[string]any)
		return result, ok && id == requestID && result["jsonrpc"] == "2.0" && hasResult != hasError
	}
	if !strings.Contains(contentType, "text/event-stream") {
		data, err := io.ReadAll(limited)
		if err != nil || len(data) > 8<<20 {
			return nil, errors.New("MCP 响应过大或无效")
		}
		result, matched := decode(data)
		if !matched {
			return nil, errors.New("MCP 响应身份无效")
		}
		return result, nil
	}
	buffered := bufio.NewReader(limited)
	var data strings.Builder
	for {
		line, err := buffered.ReadString('\n')
		if limited.N <= 0 {
			return nil, errors.New("MCP 响应超过大小限制")
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if value, found := strings.CutPrefix(line, "data:"); found {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(value, " "))
		}
		if line == "" || err == io.EOF {
			if data.Len() > 0 {
				if result, matched := decode([]byte(data.String())); matched {
					return result, nil
				}
				data.Reset()
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil, errors.New("MCP SSE 未返回匹配的 RPC 结果")
			}
			return nil, err
		}
	}
}
