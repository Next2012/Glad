package app

import (
	"strings"

	"github.com/coder/websocket"
)

// Apple browsers and embedded WebViews use a different WebSocket stack from
// Linux WebKit. Avoid their compressed-message fragmentation compatibility
// issues; ordinary clients still negotiate bounded no-context compression.
func browserWSCompressionMode(userAgent string) websocket.CompressionMode {
	agent := strings.ToLower(userAgent)
	ios := strings.Contains(agent, "iphone") || strings.Contains(agent, "ipad") || strings.Contains(agent, "ipod") || strings.Contains(agent, "crios/") || strings.Contains(agent, "edgios/") || strings.Contains(agent, "fxios/") || (strings.Contains(agent, "macintosh") && strings.Contains(agent, "mobile/"))
	if ios {
		return websocket.CompressionDisabled
	}
	if !strings.Contains(agent, "applewebkit") {
		return websocket.CompressionNoContextTakeover
	}
	chromium := strings.Contains(agent, "chrome/") || strings.Contains(agent, "chromium/") || strings.Contains(agent, "edg/") || strings.Contains(agent, "opr/")
	if chromium {
		return websocket.CompressionNoContextTakeover
	}
	return websocket.CompressionDisabled
}
