package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

type localProxy struct {
	server   *http.Server
	listener net.Listener
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
