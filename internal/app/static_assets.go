package app

import (
	"bytes"
	"compress/gzip"
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const staticAssetCacheBytes = 64 << 20
const staticAssetEntryBytes = 8 << 20
const staticAssetCacheEntries = 256

type staticAsset struct {
	filename, contentType, tag, gzipTag string
	identity, compressed                []byte
}

func (asset *staticAsset) size() int { return len(asset.identity) + len(asset.compressed) }

type staticAssetCache struct {
	mu    sync.Mutex
	items map[string]*list.Element
	order *list.List
	bytes int
}

func staticAssetTag(data []byte) string {
	sum := sha256.Sum256(data)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}
func staticCompressible(contentType string) bool {
	return strings.HasPrefix(contentType, "text/") || strings.Contains(contentType, "javascript") || strings.Contains(contentType, "json") || strings.Contains(contentType, "svg")
}

// Assets are immutable within a compiled daemon. Compress once on first use;
// bound retained bytes and metadata, and stream unusually large files instead.
func (cache *staticAssetCache) get(files fs.FS, filename string) (*staticAsset, error) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.items == nil {
		cache.items = map[string]*list.Element{}
		cache.order = list.New()
	}
	if element := cache.items[filename]; element != nil {
		cache.order.MoveToFront(element)
		return element.Value.(*staticAsset), nil
	}
	info, err := fs.Stat(files, filename)
	if err != nil {
		return nil, err
	}
	asset := &staticAsset{filename: filename, contentType: mime.TypeByExtension(filepath.Ext(filename))}
	if info.Size() > staticAssetEntryBytes {
		file, err := files.Open(filename)
		if err != nil {
			return nil, err
		}
		hash := sha256.New()
		_, err = io.Copy(hash, file)
		file.Close()
		if err != nil {
			return nil, err
		}
		asset.tag = `"` + hex.EncodeToString(hash.Sum(nil)) + `"`
	} else {
		asset.identity, err = fs.ReadFile(files, filename)
		if err != nil {
			return nil, err
		}
		asset.tag = staticAssetTag(asset.identity)
		if asset.contentType == "" {
			asset.contentType = http.DetectContentType(asset.identity)
		}
		if staticCompressible(asset.contentType) && len(asset.identity) >= 256 {
			var compressed bytes.Buffer
			writer, _ := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
			_, err = writer.Write(asset.identity)
			if err == nil {
				err = writer.Close()
			}
			if err != nil {
				return nil, err
			}
			if compressed.Len() < len(asset.identity) {
				asset.compressed = compressed.Bytes()
				asset.gzipTag = staticAssetTag(asset.compressed)
			}
		}
	}
	for cache.order.Len() > 0 && (cache.bytes+asset.size() > staticAssetCacheBytes || cache.order.Len() >= staticAssetCacheEntries) {
		last := cache.order.Back()
		old := last.Value.(*staticAsset)
		cache.bytes -= old.size()
		delete(cache.items, old.filename)
		cache.order.Remove(last)
	}
	cache.items[filename] = cache.order.PushFront(asset)
	cache.bytes += asset.size()
	return asset, nil
}
func acceptsStaticGzip(header string) bool {
	wildcard := false
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		name := strings.ToLower(strings.TrimSpace(fields[0]))
		quality := 1.0
		for _, field := range fields[1:] {
			key, value, found := strings.Cut(strings.TrimSpace(field), "=")
			if found && strings.EqualFold(key, "q") {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || parsed < 0 || parsed > 1 {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		if name == "gzip" {
			return quality > 0
		}
		if name == "*" {
			wildcard = quality > 0
		}
	}
	return wildcard
}

func (server *Server) serveStaticAsset(writer http.ResponseWriter, request *http.Request, filename string) {
	asset, err := server.staticAssets.get(server.assets, filename)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Del("Pragma")
	writer.Header().Set("Vary", "Accept-Encoding")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	if asset.contentType != "" {
		writer.Header().Set("Content-Type", asset.contentType)
	}
	writer.Header().Set("ETag", asset.tag)
	body := asset.identity
	if len(asset.compressed) > 0 && request.Header.Get("Range") == "" && acceptsStaticGzip(request.Header.Get("Accept-Encoding")) {
		writer.Header().Set("Content-Encoding", "gzip")
		writer.Header().Set("Content-Length", strconv.Itoa(len(asset.compressed)))
		writer.Header().Set("ETag", asset.gzipTag)
		body = asset.compressed
	}
	if body != nil {
		http.ServeContent(writer, request, filepath.Base(filename), time.Time{}, bytes.NewReader(body))
		return
	}
	file, err := server.assets.Open(filename)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	defer file.Close()
	seeker, ok := file.(io.ReadSeeker)
	if !ok {
		http.Error(writer, "Static asset cannot be streamed", http.StatusInternalServerError)
		return
	}
	http.ServeContent(writer, request, filepath.Base(filename), time.Time{}, seeker)
}

// Compatibility entry point used by direct embedded-file tests. Real routes
// pass the incoming request for encoding negotiation and conditional responses.
func (server *Server) serveEmbedded(writer http.ResponseWriter, filename string) {
	server.serveStaticAsset(writer, &http.Request{Method: http.MethodGet, Header: make(http.Header)}, filename)
}
