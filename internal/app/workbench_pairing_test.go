package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestPairingAuthenticatesPrivateCertificateWithoutSendingToken(t *testing.T) {
	for _, forged := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "forged-proof"}[forged], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			authenticated := make(chan bool, 1)
			var server *httptest.Server
			server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" {
					t.Error("首次认证前发送了凭据")
				}
				c, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()
				_, data, err := c.Read(ctx)
				if err != nil {
					return
				}
				var hello map[string]any
				if json.Unmarshal(data, &hello) != nil {
					return
				}
				digest := sha256.Sum256(server.Certificate().Raw)
				fp := hex.EncodeToString(digest[:])
				fields := []string{stringValue(hello["glad_id"]), stringValue(hello["nonce"]), pairingSecret(), "b7034dfc-f278-476f-9610-0fa039cfbd45", fp}
				secret := lifecycleToken
				if forged {
					secret = "attacker-does-not-know-the-token"
				}
				_ = writeWSJSON(ctx, c, map[string]any{"type": "pair_challenge", "nonce": fields[2], "workbench_id": fields[3], "certificate_fingerprint": fp, "proof": pairingProof(secret, "server", fields...)})
				_, data, err = c.Read(ctx)
				var auth map[string]any
				if err != nil {
					authenticated <- false
					return
				}
				_ = json.Unmarshal(data, &auth)
				authenticated <- auth["proof"] == pairingProof(lifecycleToken, "client", append(fields, stringValue(auth["key"]))...)
			}))
			defer server.Close()
			fingerprint := ""
			c, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "https://", "wss://", 1), &websocket.DialOptions{HTTPClient: pairingTLSClient("", &fingerprint)})
			if err != nil {
				t.Fatal(err)
			}
			defer c.CloseNow()
			saved := false
			err = authenticateWorkbenchPairing(ctx, c, workbenchConnectOptions{Token: lifecycleToken, GladID: "c617c272-5ccc-43ec-becd-bfc6144d4980", Alias: "验证", PairingKey: strings.Repeat("a", 64), OnPeerVerified: func(fp, id, alias string) error { saved = fp == fingerprint; return nil }}, fingerprint, []string{"codex"})
			if forged {
				if err == nil || saved {
					t.Fatal("伪造服务器证明被接受")
				}
				_ = c.CloseNow()
				if <-authenticated {
					t.Fatal("向伪造服务器发送了连接密钥")
				}
			} else if err != nil || !saved || !<-authenticated {
				t.Fatalf("私有证书配对失败: %v", err)
			}
		})
	}
}

func TestPairingRejectsChangedPinnedCertificate(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("证书变化后仍发起了请求") }))
	defer server.Close()
	fingerprint := ""
	_, err := pairingTLSClient(strings.Repeat("f", 64), &fingerprint).Get(server.URL)
	if err == nil || !strings.Contains(err.Error(), "证书已变化") {
		t.Fatalf("替换证书未拒绝: %v", err)
	}
}

func TestPairingIdentityKeyIsScopedToWorkbench(t *testing.T) {
	root := pairingSecret()
	if pairingProof(root, "identity", "workbench-a") == pairingProof(root, "identity", "workbench-b") {
		t.Fatal("不同工作台使用了同一身份密钥")
	}
}
