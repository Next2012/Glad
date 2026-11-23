package app

import (
	"bufio"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const browserWSIPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const browserWSIPadDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
const browserWSChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
const browserWSFirefox = "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0"

func TestBrowserWSCompressionMode(t *testing.T) {
	for _, test := range []struct {
		name, agent string
		disabled    bool
	}{
		{"iphone safari", browserWSIPhone, true},
		{"ipad safari", strings.Replace(browserWSIPhone, "iPhone", "iPad", 1), true},
		{"ipad desktop agent or mac safari", browserWSIPadDesktop, true},
		{"ipad desktop mobile agent", strings.Replace(browserWSIPadDesktop, "Safari/", "Mobile/15E148 Safari/", 1), true},
		{"ios chrome", strings.Replace(browserWSIPhone, "Version/18.0", "CriOS/142.0.0.0", 1), true},
		{"ios firefox", strings.Replace(browserWSIPhone, "Version/18.0", "FxiOS/145.0", 1), true},
		{"ios edge", strings.Replace(browserWSIPhone, "Version/18.0", "EdgiOS/142.0", 1), true},
		{"wkwebview without safari product", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", true},
		{"desktop embedded webkit", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko)", true},
		{"windows chrome", browserWSChrome, false},
		{"mac chrome", strings.Replace(browserWSChrome, "Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7", 1), false},
		{"linux chromium", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/142.0.0.0 Safari/537.36", false},
		{"chromebook", "Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36", false},
		{"desktop edge", browserWSChrome + " Edg/142.0.0.0", false},
		{"edge token", "Mozilla/5.0 AppleWebKit/537.36 Edg/142.0.0.0", false},
		{"opera token", "Mozilla/5.0 AppleWebKit/537.36 OPR/125.0.0.0", false},
		{"android chrome", strings.Replace(browserWSChrome, "Windows NT 10.0; Win64; x64", "Linux; Android 15", 1) + " Mobile/", false},
		{"ios identity takes precedence over chrome token", strings.Replace(browserWSChrome, "Windows NT 10.0; Win64; x64", "iPhone; CPU iPhone OS 18_0 like Mac OS X", 1), true},
		{"mobile mac takes precedence over chrome token", strings.Replace(browserWSChrome, "Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15", 1) + " Mobile/15E148", true},
		{"firefox", browserWSFirefox, false},
		{"unknown client", "Go-http-client/1.1", false},
		{"absent agent", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			want := websocket.CompressionNoContextTakeover
			if test.disabled {
				want = websocket.CompressionDisabled
			}
			if got := browserWSCompressionMode(test.agent); got != want {
				t.Fatalf("compression mode = %v, want %v", got, want)
			}
		})
	}
}

func TestBrowserWSAppleHandshakeDisablesCompressionAndSendsSingleFrame(t *testing.T) {
	for _, test := range []struct {
		name, agent string
		apple       bool
	}{
		{"iphone", browserWSIPhone, true},
		{"ipad desktop or mac safari", browserWSIPadDesktop, true},
		{"embedded webview", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", true},
		{"desktop chromium", browserWSChrome, false},
		{"android chromium", strings.Replace(browserWSChrome, "Windows NT 10.0; Win64; x64", "Linux; Android 15", 1) + " Mobile/", false},
		{"firefox", browserWSFirefox, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			session := newSession("browser-compression", "Browser compression", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
			text := strings.Repeat("Browser snapshot 中文🌙 ", 300) + "SNAPSHOT_END"
			session.appendMessage(map[string]any{"kind": "assistant", "text": text})
			manager := NewSessionManager(t.TempDir())
			manager.sessions[session.ID] = session
			server := &Server{sessions: manager}
			done := make(chan struct{})
			host := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				defer close(done)
				server.websocket(writer, request)
			}))
			connection, err := net.DialTimeout("tcp", strings.TrimPrefix(host.URL, "http://"), 3*time.Second)
			if err != nil {
				host.Close()
				session.cancel()
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = connection.Close()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Error("browser handshake handler did not finish")
				}
				host.Close()
				session.cancel()
			})
			_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
			_, err = fmt.Fprintf(connection, "GET /?sessionId=%s HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\nUser-Agent: %s\r\n\r\n", session.ID, strings.TrimPrefix(host.URL, "http://"), test.agent)
			if err != nil {
				t.Fatal(err)
			}
			reader := bufio.NewReader(connection)
			response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
			if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
				t.Fatal("WebSocket upgrade did not succeed")
			}
			extensions := response.Header.Get("Sec-WebSocket-Extensions")
			if test.apple && extensions != "" {
				t.Fatal("Apple WebKit still negotiated compression")
			}
			if !test.apple && (!strings.Contains(extensions, "permessage-deflate") || !strings.Contains(extensions, "server_no_context_takeover") || !strings.Contains(extensions, "client_no_context_takeover")) {
				t.Fatal("ordinary browser lost no-context compression")
			}
			var payload []byte
			compressed, frames := false, 0
			for {
				var header [2]byte
				if _, err := io.ReadFull(reader, header[:]); err != nil {
					t.Fatal(err)
				}
				frames++
				if header[1]&0x80 != 0 || header[0]&0x30 != 0 || frames > 128 {
					t.Fatal("invalid or excessive server snapshot framing")
				}
				if frames == 1 {
					compressed = header[0]&0x40 != 0
					if header[0]&0x0f != 1 {
						t.Fatal("snapshot did not begin with a text frame")
					}
				} else if header[0]&0x4f != 0 {
					t.Fatal("snapshot continuation opcode or RSV1 was invalid")
				}
				length := uint64(header[1] & 0x7f)
				if length == 126 {
					var extended uint16
					if err := binary.Read(reader, binary.BigEndian, &extended); err != nil {
						t.Fatal(err)
					}
					length = uint64(extended)
				} else if length == 127 {
					if err := binary.Read(reader, binary.BigEndian, &length); err != nil {
						t.Fatal(err)
					}
				}
				if length > 1<<20 {
					t.Fatal("snapshot frame exceeded fixture bounds")
				}
				data := make([]byte, int(length))
				if _, err := io.ReadFull(reader, data); err != nil {
					t.Fatal(err)
				}
				payload = append(payload, data...)
				if header[0]&0x80 != 0 {
					break
				}
			}
			if test.apple && (frames != 1 || compressed) {
				t.Fatal("Apple snapshot was compressed or fragmented")
			}
			if !test.apple && !compressed {
				t.Fatal("large ordinary-browser snapshot bypassed compression")
			}
			if compressed {
				// Restore RFC 7692's stripped sync-flush tail and terminate the
				// independent fixture stream so the standard inflater reaches EOF.
				payload = append(payload, 0, 0, 255, 255, 1, 0, 0, 255, 255)
				inflater := flate.NewReader(bytes.NewReader(payload))
				payload, err = io.ReadAll(inflater)
				_ = inflater.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			var message map[string]any
			if json.Unmarshal(payload, &message) != nil || message["type"] != "codex-snapshot" {
				t.Fatal("snapshot was not valid JSON after frame decoding")
			}
			messages := sliceValue(mapValue(message["snapshot"])["messages"])
			if len(messages) != 1 || mapValue(messages[0])["text"] != text {
				t.Fatal("snapshot body changed across browser compression policies")
			}
		})
	}
}
