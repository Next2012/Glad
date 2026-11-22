package app

import (
	"compress/gzip"
	"net/http"
	"strings"
)

const dynamicJSONCompressionThreshold = 2 << 10

// Private API responses are compressed per request, never retained in the static
// asset cache. Resource ranges, upgrades and legacy workbench responses bypass it.
func dynamicJSONCompression(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || !strings.HasPrefix(request.URL.Path, "/api/") || request.Header.Get("Range") != "" || request.Header.Get("Upgrade") != "" {
			next.ServeHTTP(writer, request)
			return
		}
		writer.Header().Add("Vary", "Accept-Encoding")
		if !acceptsStaticGzip(request.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(writer, request)
			return
		}
		compressed := &dynamicJSONWriter{ResponseWriter: writer}
		defer compressed.finish()
		next.ServeHTTP(compressed, request)
	})
}

type dynamicJSONWriter struct {
	http.ResponseWriter
	status  int
	started bool
	buffer  []byte
	gzip    *gzip.Writer
}

func (writer *dynamicJSONWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *dynamicJSONWriter) WriteHeader(status int) {
	if writer.status == 0 {
		writer.status = status
	}
}

func (writer *dynamicJSONWriter) start(compress bool) {
	if writer.started {
		return
	}
	writer.started = true
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	headers := writer.Header()
	if compress && strings.Contains(strings.ToLower(headers.Get("Content-Type")), "application/json") && headers.Get("Content-Encoding") == "" && headers.Get("Content-Disposition") == "" && writer.status != http.StatusNoContent && writer.status != http.StatusNotModified {
		writer.gzip, _ = gzip.NewWriterLevel(writer.ResponseWriter, gzip.BestSpeed)
		headers.Set("Content-Encoding", "gzip")
		headers.Del("Content-Length")
		headers.Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
	}
	writer.ResponseWriter.WriteHeader(writer.status)
	if len(writer.buffer) != 0 {
		if writer.gzip != nil {
			_, _ = writer.gzip.Write(writer.buffer)
		} else {
			_, _ = writer.ResponseWriter.Write(writer.buffer)
		}
		writer.buffer = nil
	}
}

func (writer *dynamicJSONWriter) Write(data []byte) (int, error) {
	if !writer.started {
		if len(writer.buffer)+len(data) < dynamicJSONCompressionThreshold {
			writer.buffer = append(writer.buffer, data...)
			return len(data), nil
		}
		writer.start(true)
	}
	if writer.gzip != nil {
		return writer.gzip.Write(data)
	}
	return writer.ResponseWriter.Write(data)
}

func (writer *dynamicJSONWriter) finish() {
	writer.start(false)
	if writer.gzip != nil {
		_ = writer.gzip.Close()
	}
}

func (writer *dynamicJSONWriter) Flush() {
	writer.start(false)
	if writer.gzip != nil {
		_ = writer.gzip.Flush()
	}
	_ = http.NewResponseController(writer.ResponseWriter).Flush()
}
