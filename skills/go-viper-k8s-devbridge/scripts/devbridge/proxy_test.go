package main

import (
	"net/http"
	"testing"
)

func TestLocalProxyInjectsHeaderOnlyForConfiguredPaths(t *testing.T) {
	cfg := &config{}
	cfg.Gateway.Upstream = "http://gateway.example"
	cfg.Gateway.StripPrefix = "/gateway"
	cfg.Gateway.RouteHeader = "X-Dev-Route"
	cfg.Gateway.RoutePaths = []string{"/cv/api/knowlhub/"}
	cfg.Gateway.HealthPath = "/cv/api/devbridge/status"
	proxy, err := newGatewayProxy(cfg, "mine")
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		path     string
		wantPath string
		want     string
	}{
		{path: "/cv/api/knowlhub/blueprints", wantPath: "/cv/api/knowlhub/blueprints", want: "mine"},
		{path: "/gateway/cv/api/knowlhub/blueprints", wantPath: "/cv/api/knowlhub/blueprints", want: "mine"},
		{path: "/gateway/cv/api/devbridge/status", wantPath: "/cv/api/devbridge/status", want: "mine"},
		{path: "/gateway/cv/api/assets", wantPath: "/cv/api/assets", want: ""},
		{path: "/gatewayish/cv/api/knowlhub/blueprints", wantPath: "/gatewayish/cv/api/knowlhub/blueprints", want: ""},
		{path: "/other/api", wantPath: "/other/api", want: ""},
	}
	for _, tt := range tests {
		req, _ := http.NewRequest(http.MethodGet, "http://local"+tt.path, nil)
		req.Header.Set("X-Dev-Route", "attacker-controlled")
		proxy.Director(req)
		if req.URL.Path != tt.wantPath {
			t.Errorf("path %s forwarded as %q, want %q", tt.path, req.URL.Path, tt.wantPath)
		}
		if got := req.Header.Get("X-Dev-Route"); got != tt.want {
			t.Errorf("path %s header = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestStripGatewayPrefix(t *testing.T) {
	tests := map[string]string{
		"/gateway":         "/",
		"/gateway/cv/api":  "/cv/api",
		"/gatewayish/cv":   "/gatewayish/cv",
		"/cv/api/knowlhub": "/cv/api/knowlhub",
	}
	for input, want := range tests {
		if got := stripGatewayPrefix(input, "/gateway"); got != want {
			t.Errorf("stripGatewayPrefix(%q) = %q, want %q", input, got, want)
		}
	}
}
