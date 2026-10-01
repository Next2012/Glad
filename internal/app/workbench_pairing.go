package app

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

func pairingSecret() string {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		panic(err)
	}
	return hex.EncodeToString(data)
}

func validPairingSecret(value string) bool {
	data, err := hex.DecodeString(value)
	return err == nil && len(data) == 32 && strings.ToLower(value) == value
}

func pairingProof(secret, role string, fields ...string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.Join(append([]string{"glad-pairing/v1", role}, fields...), "\n")))
	return hex.EncodeToString(mac.Sum(nil))
}

func pairingTLSClient(pin string, fingerprint *string) *http.Client {
	config := &tls.Config{MinVersion: tls.VersionTLS12,
		// 私有证书的身份随后通过凭据证明验证，证明绑定本次 TLS 证书；验证前不发送密钥或开放会话。
		InsecureSkipVerify: true,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("工作台未提供证书")
			}
			cert := state.PeerCertificates[0]
			if time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
				return errors.New("工作台证书已过期或尚未生效")
			}
			digest := sha256.Sum256(cert.Raw)
			*fingerprint = hex.EncodeToString(digest[:])
			if pin != "" && !hmac.Equal([]byte(pin), []byte(*fingerprint)) {
				return errors.New("工作台证书已变化，请删除连接后重新配对")
			}
			return nil
		},
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: config,
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second,
		DialContext: (&net.Dialer{Timeout: 15 * time.Second}).DialContext},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func authenticateWorkbenchPairing(ctx context.Context, connection *websocket.Conn, options workbenchConnectOptions, fingerprint string, tools []string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	nonce := pairingSecret()
	if err := writeWSJSON(ctx, connection, map[string]any{"type": "hello", "protocol": "glad-pairing/v1",
		"glad_id": options.GladID, "name": options.Alias, "tools": tools, "nonce": nonce}); err != nil {
		return err
	}
	_, data, err := connection.Read(ctx)
	if err != nil {
		return err
	}
	var challenge struct {
		Type           string `json:"type"`
		Nonce          string `json:"nonce"`
		Fingerprint    string `json:"certificate_fingerprint"`
		Proof          string `json:"proof"`
		WorkbenchID    string `json:"workbench_id"`
		WorkbenchAlias string `json:"workbench_alias"`
	}
	if json.Unmarshal(data, &challenge) != nil || challenge.Type != "pair_challenge" ||
		!validPairingSecret(challenge.Nonce) || !validWorkbenchID(challenge.WorkbenchID) ||
		challenge.Fingerprint != fingerprint || (options.WorkbenchID != "" && options.WorkbenchID != challenge.WorkbenchID) {
		return errors.New("工作台配对身份无效")
	}
	fields := []string{options.GladID, nonce, challenge.Nonce, challenge.WorkbenchID, fingerprint}
	if !hmac.Equal([]byte(challenge.Proof), []byte(pairingProof(options.Token, "server", fields...))) {
		return errors.New("工作台连接凭据验证失败")
	}
	// 每个工作台使用独立的身份密钥，服务器无法据此冒充 Glad 连接其他工作台。
	key := pairingProof(options.PairingKey, "identity", challenge.WorkbenchID)
	if options.OnPeerVerified != nil {
		if err := options.OnPeerVerified(fingerprint, challenge.WorkbenchID, challenge.WorkbenchAlias); err != nil {
			return err
		}
	}
	return writeWSJSON(ctx, connection, map[string]any{"type": "pair_auth", "key": key,
		"proof": pairingProof(options.Token, "client", append(fields, key)...)})
}
