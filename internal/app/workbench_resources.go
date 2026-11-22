package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
)

const maxWorkbenchHTTPBodyBytes = 8 << 20

var errWorkbenchHTTPBodyLimit = errors.New("响应超过连接大小限制；大文件需要支持 Range 的工作台客户端")

// The remote protocol remains a bounded base64 response, not a streaming tunnel.
// Stop copying at the limit instead of first buffering an arbitrarily large file.
type workbenchResponseLimitWriter struct {
	*httptest.ResponseRecorder
	overflow bool
}

func (writer *workbenchResponseLimitWriter) Write(data []byte) (int, error) {
	if len(data) > maxWorkbenchHTTPBodyBytes-writer.Body.Len() {
		writer.overflow = true
		return 0, errWorkbenchHTTPBodyLimit
	}
	return writer.ResponseRecorder.Write(data)
}

func (writer *workbenchResponseLimitWriter) WriteString(data string) (int, error) {
	if len(data) > maxWorkbenchHTTPBodyBytes-writer.Body.Len() {
		writer.overflow = true
		return 0, errWorkbenchHTTPBodyLimit
	}
	return writer.ResponseRecorder.WriteString(data)
}

// Preserve resource isolation, download and conditional/range metadata only.
// Content-Encoding is intentionally absent: incoming Accept-Encoding is not
// forwarded, so legacy workbenches keep receiving identity representation bytes.
func workbenchResourceResponseHeaders(headers http.Header) map[string]string {
	result := map[string]string{}
	for _, name := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Content-Disposition", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified", "Vary"} {
		if value := headers.Get(name); value != "" && len(value) <= 4096 && !strings.ContainsAny(value, "\r\n") {
			result[name] = value
		}
	}
	return result
}
func workbenchResourceRequestHeaders(headers map[string]string) http.Header {
	result := http.Header{}
	for name, value := range headers {
		switch http.CanonicalHeaderKey(name) {
		case "Range", "If-Range", "If-None-Match", "If-Modified-Since":
			if len(value) <= 4096 && !strings.ContainsAny(value, "\r\n") {
				result.Set(name, value)
			}
		}
	}
	return result
}
