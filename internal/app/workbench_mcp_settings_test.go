package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkbenchMCPConfigurationPreservesTargetIdentity(t *testing.T) {
	lifecycleHome(t)
	sharing, err := OpenWorkbenchSharing(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := sharing.Add(WorkbenchTarget{URL: "wss://workbench.example", Token: strings.Repeat("a", 40)}); err != nil {
		t.Fatal(err)
	}
	before := sharing.config.Workbenches[0]
	tokenFile := filepath.Join(t.TempDir(), "original-owner.token")
	if err := sharing.SetMCP(before.ID, "http://hub.example/mcp", tokenFile); err != nil {
		t.Fatal(err)
	}
	after := sharing.config.Workbenches[0]
	if after.ID != before.ID || after.Token != before.Token || after.URL != before.URL || after.AutoConnect != before.AutoConnect || after.MCPTokenFile != tokenFile {
		t.Fatal("resource access update changed target identity or connection intent")
	}
	sharing.runtimes[before.ID] = &workbenchRuntime{state: "connected"}
	if err := sharing.SetMCP(before.ID, "http://other-hub.example/mcp", tokenFile); err == nil {
		t.Fatal("connected target identity changed during live sessions")
	}
	if sharing.config.Workbenches[0].MCPURL != "http://hub.example/mcp" {
		t.Fatal("rejected update changed saved configuration")
	}
}

func TestWorkbenchMCPResourceRejectsForeignConnectionSession(t *testing.T) {
	server := &Server{sessions: NewSessionManager(t.TempDir())}
	mux := http.NewServeMux()
	server.registerWorkspaceRoutes(mux)
	bridge := &workbenchBridge{server: server, mux: mux, ctx: context.Background(), owned: map[string]bool{"own": true}}
	response := httptest.NewRecorder()
	err := bridge.serveRequest(response, workbenchMessage{Method: "GET", Path: "/api/sessions/foreign/mcp-resource?uri=botlink-hub://resource/software/pdf/old"})
	if err == nil {
		t.Fatal("foreign connection could request another session's resource identity")
	}
}

func TestWorkbenchResponseOnlyForwardsAllowedSecurityHeaders(t *testing.T) {
	header := http.Header{}
	header.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Disposition", "inline; filename=original.pdf")
	header.Set("Set-Cookie", "untrusted=true")
	header.Set("Location", "https://untrusted.invalid")
	forwarded := workbenchResourceResponseHeaders(header)
	if len(forwarded) != 3 || forwarded["X-Content-Type-Options"] != "nosniff" {
		t.Fatal("resource headers were lost or arbitrary headers allowed")
	}
}
