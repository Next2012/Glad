package app

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDynamicJSONCompressionIsNegotiatedPrivateAndPreservesBytes(t *testing.T) {
	value := map[string]any{"text": strings.Repeat("private conversation text 汉字", 500)}
	handler := noCache(dynamicJSONCompression(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respondJSON(w, 200, value) })))
	request := httptest.NewRequest(http.MethodGet, "/api/sessions/example", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	compressed := httptest.NewRecorder()
	handler.ServeHTTP(compressed, request)
	compressedBytes := compressed.Body.Len()
	if compressed.Header().Get("Content-Encoding") != "gzip" || !strings.Contains(compressed.Header().Get("Cache-Control"), "no-store") || !strings.Contains(compressed.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatal("dynamic compression lost privacy or negotiation headers")
	}
	reader, err := gzip.NewReader(compressed.Body)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	identity := httptest.NewRecorder()
	plain := httptest.NewRequest(http.MethodGet, "/api/sessions/example", nil)
	handler.ServeHTTP(identity, plain)
	if string(decoded) != identity.Body.String() || compressedBytes >= identity.Body.Len() {
		t.Fatal("compression changed JSON or did not reduce transfer")
	}
	if identity.Header().Get("Content-Encoding") != "" {
		t.Fatal("legacy identity request was compressed")
	}
}

func TestDynamicJSONCompressionBypassesRangesUpgradesFilesSmallBodiesAndDisabledGzip(t *testing.T) {
	for _, item := range []struct {
		name, method, path, accept, rangeHeader, upgrade, contentType, disposition string
		small                                                                      bool
	}{
		{name: "range", method: "GET", path: "/api/sessions/example", accept: "gzip", rangeHeader: "bytes=0-100", contentType: "application/json"},
		{name: "upgrade", method: "GET", path: "/api/sessions/example", accept: "gzip", upgrade: "websocket", contentType: "application/json"},
		{name: "disabled", method: "GET", path: "/api/sessions/example", accept: "gzip;q=0, *;q=1", contentType: "application/json"},
		{name: "post", method: "POST", path: "/api/sessions/example", accept: "gzip", contentType: "application/json"},
		{name: "head", method: "HEAD", path: "/api/sessions/example", accept: "gzip", contentType: "application/json"},
		{name: "file", method: "GET", path: "/api/sessions/example/workspace-resource", accept: "gzip", contentType: "application/json", disposition: "attachment; filename=data.json"},
		{name: "static", method: "GET", path: "/vendor/example.js", accept: "gzip", contentType: "application/json"},
		{name: "small", method: "GET", path: "/api/config", accept: "gzip", contentType: "application/json", small: true},
	} {
		t.Run(item.name, func(t *testing.T) {
			handler := dynamicJSONCompression(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", item.contentType)
				w.Header().Set("Content-Disposition", item.disposition)
				if item.small {
					_, _ = w.Write([]byte(`{"success":true}`))
				} else {
					_, _ = w.Write([]byte(strings.Repeat("x", 4096)))
				}
			}))
			request := httptest.NewRequest(item.method, item.path, nil)
			request.Header.Set("Accept-Encoding", item.accept)
			request.Header.Set("Range", item.rangeHeader)
			request.Header.Set("Upgrade", item.upgrade)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Header().Get("Content-Encoding") != "" {
				t.Fatal("ineligible response was compressed")
			}
		})
	}
}
