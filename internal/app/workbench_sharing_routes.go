package app

import (
	"errors"
	"net/http"
)

func (server *Server) registerWorkbenchSharingRoutes(mux *http.ServeMux) {
	if server.sharing == nil {
		return
	}
	mux.HandleFunc("GET /api/agent-workbench", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		respondJSON(writer, 200, server.sharing.snapshot())
	})
	mutate := func(handler func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
		return func(writer http.ResponseWriter, request *http.Request) {
			// 浏览器控制接口只接受本页发起的写请求。
			if request.Header.Get("Sec-Fetch-Site") == "cross-site" || (request.Header.Get("Origin") != "" && request.Header.Get("Origin") != requestScheme(request)+"://"+request.Host) {
				respondError(writer, 403, errors.New("连接设置需从 Glad 页面修改"))
				return
			}
			if err := handler(writer, request); err != nil {
				respondError(writer, 400, err)
				return
			}
			writer.Header().Set("Cache-Control", "no-store")
			respondJSON(writer, 200, server.sharing.snapshot())
		}
	}
	mux.HandleFunc("PATCH /api/agent-workbench", mutate(func(_ http.ResponseWriter, request *http.Request) error {
		var input struct {
			Alias string `json:"alias"`
		}
		if err := decodeJSON(request, &input); err != nil {
			return err
		}
		return server.sharing.SetAlias(input.Alias)
	}))
	mux.HandleFunc("POST /api/agent-workbench/targets", mutate(func(_ http.ResponseWriter, request *http.Request) error {
		var input WorkbenchTarget
		if err := decodeJSON(request, &input); err != nil {
			return err
		}
		return server.sharing.Add(input)
	}))
	mux.HandleFunc("PATCH /api/agent-workbench/targets/{id}", mutate(func(_ http.ResponseWriter, request *http.Request) error {
		var input struct {
			Enabled      *bool   `json:"enabled"`
			MCPURL       *string `json:"mcpUrl"`
			MCPTokenFile *string `json:"mcpTokenFile"`
		}
		if err := decodeJSON(request, &input); err != nil {
			return err
		}
		if input.MCPURL != nil || input.MCPTokenFile != nil {
			if input.Enabled != nil || input.MCPURL == nil || input.MCPTokenFile == nil {
				return errors.New("MCP 地址和凭据路径需一起保存")
			}
			return server.sharing.SetMCP(request.PathValue("id"), *input.MCPURL, *input.MCPTokenFile)
		}
		if input.Enabled == nil {
			return errors.New("需要连接开关或 MCP 配置")
		}
		return server.sharing.SetEnabled(request.PathValue("id"), *input.Enabled)
	}))
	mux.HandleFunc("DELETE /api/agent-workbench/targets/{id}", mutate(func(_ http.ResponseWriter, request *http.Request) error {
		return server.sharing.Delete(request.PathValue("id"))
	}))
}

func requestScheme(request *http.Request) string {
	if request.TLS != nil {
		return "https"
	}
	return "http"
}
