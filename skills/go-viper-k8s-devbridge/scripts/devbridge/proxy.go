package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"time"
)

type localProxy struct {
	server   *http.Server
	listener net.Listener
}

// The public preview never accepts a browser-selected upstream or route ID.
// API traffic goes through this session's loopback proxy; all other traffic
// goes to the worktree's frontend. No shared-service fallback is configured.
func startPreviewProxy(cfg *config, routeID, frontendURL, listen string) (*localProxy, error) {
	handler, err := newPreviewHandler(cfg, routeID, frontendURL)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return nil, err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return &localProxy{server: server, listener: listener}, nil
}

func newPreviewHandler(cfg *config, routeID, frontendURL string) (http.Handler, error) {
	frontend, err := url.Parse(frontendURL)
	if err != nil || frontend == nil || (frontend.Scheme != "http" && frontend.Scheme != "https") ||
		frontend.Host == "" || frontend.User != nil || frontend.RawQuery != "" || frontend.Fragment != "" {
		return nil, fmt.Errorf("frontend-url must be an http(s) URL without credentials, query or fragment")
	}
	ui := httputil.NewSingleHostReverseProxy(frontend)
	api, err := newGatewayProxy(cfg, routeID)
	if err != nil {
		return nil, err
	}
	// Managed previews require the API-only middleware to echo its route on
	// every API response, including errors and WebSocket upgrades.
	api.ModifyResponse = func(resp *http.Response) error {
		if resp.Header.Get("X-Devbridge-Route") != routeID {
			return fmt.Errorf("response did not come from this worktree")
		}
		return nil
	}
	client := &http.Client{
		Timeout:       3 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		clean := path.Clean(req.URL.Path)
		if (clean != req.URL.Path && clean+"/" != req.URL.Path) || strings.ContainsAny(req.URL.Path, "\\%") {
			http.Error(w, "invalid preview path", http.StatusBadRequest)
			return
		}
		req.Header.Del(cfg.Gateway.RouteHeader)
		apiPath := stripGatewayPrefix(req.URL.Path, cfg.Gateway.StripPrefix)
		selected := apiPath == cfg.Gateway.HealthPath
		for _, prefix := range cfg.Gateway.RoutePaths {
			selected = selected || apiPath == strings.TrimSuffix(prefix, "/") || strings.HasPrefix(apiPath, strings.TrimSuffix(prefix, "/")+"/")
		}
		if selected {
			// ponytail: one readiness request per API request; cache only if the
			// shared backend rejects stale selectors before performing writes.
			probe, _ := http.NewRequestWithContext(req.Context(), http.MethodGet, "http://"+cfg.Gateway.Listen+cfg.Gateway.HealthPath, nil)
			resp, err := client.Do(probe)
			if err != nil {
				http.Error(w, "worktree backend unavailable", http.StatusServiceUnavailable)
				return
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK || resp.Header.Get("X-Devbridge-Route") != routeID {
				http.Error(w, "worktree backend unavailable", http.StatusServiceUnavailable)
				return
			}
			api.ServeHTTP(w, req)
			return
		}
		// A configured gateway prefix is reserved: never let the frontend
		// forward an unselected service to a shared backend.
		if cfg.Gateway.StripPrefix != "" && (req.URL.Path == cfg.Gateway.StripPrefix || strings.HasPrefix(req.URL.Path, cfg.Gateway.StripPrefix+"/")) {
			http.NotFound(w, req)
			return
		}
		ui.ServeHTTP(w, req)
	}), nil
}

func startLocalProxy(cfg *config, routeID string) (*localProxy, error) {
	proxy, err := newGatewayProxy(cfg, routeID)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", cfg.Gateway.Listen)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", cfg.Gateway.Listen, err)
	}
	server := &http.Server{Handler: proxy}
	go func() { _ = server.Serve(listener) }()
	return &localProxy{server: server, listener: listener}, nil
}

func newGatewayProxy(cfg *config, routeID string) (*httputil.ReverseProxy, error) {
	upstream, err := url.Parse(cfg.Gateway.Upstream)
	if err != nil {
		return nil, err
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		req.URL.Path = stripGatewayPrefix(req.URL.Path, cfg.Gateway.StripPrefix)
		req.URL.RawPath = ""
		originalDirector(req)
		req.Header.Del(cfg.Gateway.RouteHeader)
		if req.URL.Path == cfg.Gateway.HealthPath {
			req.Header.Set(cfg.Gateway.RouteHeader, routeID)
			return
		}
		for _, prefix := range cfg.Gateway.RoutePaths {
			if strings.HasPrefix(req.URL.Path, prefix) {
				req.Header.Set(cfg.Gateway.RouteHeader, routeID)
				break
			}
		}
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, "devbridge gateway proxy: "+err.Error(), http.StatusBadGateway)
	}
	return proxy, nil
}

func stripGatewayPrefix(requestPath, prefix string) string {
	if prefix == "" {
		return requestPath
	}
	if requestPath == prefix {
		return "/"
	}
	if strings.HasPrefix(requestPath, prefix+"/") {
		return strings.TrimPrefix(requestPath, prefix)
	}
	return requestPath
}

func (p *localProxy) Close(ctx context.Context) error {
	if p == nil {
		return nil
	}
	return p.server.Shutdown(ctx)
}
