package app

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestStaticAssetsGzipETagRevalidationAndHEAD(t *testing.T) {
	content := strings.Repeat("const repeatedAsset = 'compressible';\n", 100)
	server := &Server{assets: fstest.MapFS{"lib/web/app.js": &fstest.MapFile{Data: []byte(content)}}}
	get := func(method, encoding, etag, byteRange string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "/app.js", nil)
		request.Header.Set("Accept-Encoding", encoding)
		request.Header.Set("If-None-Match", etag)
		request.Header.Set("Range", byteRange)
		recorder := httptest.NewRecorder()
		noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { server.serveStaticAsset(w, r, "lib/web/app.js") })).ServeHTTP(recorder, request)
		return recorder
	}
	compressed := get(http.MethodGet, "gzip", "", "")
	if compressed.Code != 200 || compressed.Header().Get("Content-Encoding") != "gzip" || compressed.Header().Get("Cache-Control") != "no-cache" || compressed.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("bad compressed response: %d %#v", compressed.Code, compressed.Header())
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || string(decoded) != content {
		t.Fatal("gzip content differs")
	}
	identity := get(http.MethodGet, "gzip;q=0, *;q=1", "", "")
	if identity.Code != 200 || identity.Header().Get("Content-Encoding") != "" || identity.Body.String() != content || identity.Header().Get("ETag") == compressed.Header().Get("ETag") {
		t.Fatal("encoding quality or representation ETags incorrect")
	}
	for _, encoding := range []string{"", "gzip"} {
		first := identity
		if encoding != "" {
			first = compressed
		}
		notModified := get(http.MethodGet, encoding, first.Header().Get("ETag"), "")
		if notModified.Code != 304 || notModified.Body.Len() != 0 {
			t.Fatalf("conditional %s: %d", encoding, notModified.Code)
		}
	}
	head := get(http.MethodHead, "gzip", "", "")
	if head.Code != 200 || head.Body.Len() != 0 || head.Header().Get("Content-Encoding") != "gzip" || head.Header().Get("Content-Length") == "" {
		t.Fatal("HEAD did not preserve gzip metadata")
	}
	ranged := get(http.MethodGet, "gzip", "", "bytes=0-4")
	if ranged.Code != 206 || ranged.Header().Get("Content-Encoding") != "" || ranged.Body.String() != content[:5] {
		t.Fatal("range was served as partial compressed data")
	}
	updated := &Server{assets: fstest.MapFS{"lib/web/app.js": &fstest.MapFile{Data: []byte(content + "//new build")}}}
	request := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	request.Header.Set("If-None-Match", identity.Header().Get("ETag"))
	response := httptest.NewRecorder()
	updated.serveStaticAsset(response, request, "lib/web/app.js")
	if response.Code != 200 || response.Header().Get("ETag") == identity.Header().Get("ETag") {
		t.Fatal("new build reused stale content ETag")
	}
	if server.staticAssets.order.Len() != 1 {
		t.Fatal("representation requests did not share one cached asset")
	}
}

func TestStaticAssetCacheIsBoundedAndAPIStaysUncached(t *testing.T) {
	files := fstest.MapFS{}
	for i := 0; i < staticAssetCacheEntries+20; i++ {
		files[fmt.Sprintf("file-%d.js", i)] = &fstest.MapFile{Data: []byte("const small = true;")}
	}
	cache := &staticAssetCache{}
	for filename := range files {
		if _, err := cache.get(files, filename); err != nil {
			t.Fatal(err)
		}
	}
	if len(cache.items) > staticAssetCacheEntries || cache.bytes > staticAssetCacheBytes {
		t.Fatal("unbounded static cache")
	}
	request := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	recorder := httptest.NewRecorder()
	noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respondJSON(w, 200, map[string]bool{"success": true}) })).ServeHTTP(recorder, request)
	if !strings.Contains(recorder.Header().Get("Cache-Control"), "no-store") || recorder.Header().Get("ETag") != "" {
		t.Fatal("API response became cacheable")
	}
}
