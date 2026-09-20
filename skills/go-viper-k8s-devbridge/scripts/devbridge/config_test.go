package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadProjectConfig(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", ".."))
	cfg, gotRoot, err := loadConfig(filepath.Join(root, "assets", "devbridge.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	wantRoot, _ := filepath.Abs(filepath.Join(root, "assets"))
	if gotRoot != wantRoot {
		t.Fatalf("root = %q, want %q", gotRoot, wantRoot)
	}
	if cfg.Remote.SSH != "dev-cluster-host" || cfg.App.LocalPort != 8620 {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadConfigRejectsUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".devbridge.yaml")
	if err := os.WriteFile(path, []byte("version: 1\nunknown: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), "field unknown not found") {
		t.Fatalf("expected unknown field error, got %v", err)
	}
}

func TestConfigRejectsInvalidGatewayStripPrefix(t *testing.T) {
	cfg, _, err := loadConfig(filepath.Join("..", "..", "assets", "devbridge.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, prefix := range []string{"/", "gateway", "/gateway/", "/gateway//cv", "/gateway/../cv"} {
		cfg.Gateway.StripPrefix = prefix
		if err := cfg.validate(); err == nil {
			t.Errorf("expected gateway.strip_prefix %q to be rejected", prefix)
		}
	}
}

func TestAgentResourceDefaultsAndValidation(t *testing.T) {
	defaults := &config{}
	applyDefaults(defaults)
	want := mirrordResourceRequirements{
		Requests: mirrordResourceList{CPU: "100m", Memory: "256Mi"},
		Limits:   mirrordResourceList{CPU: "1", Memory: "1Gi"},
	}
	if defaults.Mirrord.AgentResources != want {
		t.Fatalf("default agent resources = %+v, want %+v", defaults.Mirrord.AgentResources, want)
	}

	cfg, _, err := loadConfig(filepath.Join("..", "..", "assets", "devbridge.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mirrord.AgentResources != want {
		t.Fatalf("example agent resources = %+v, want %+v", cfg.Mirrord.AgentResources, want)
	}

	cfg.Mirrord.AgentResources.Limits.Memory = "100MB"
	if err := cfg.validate(); err == nil || !strings.Contains(err.Error(), "agent_resources.limits.memory") {
		t.Fatalf("expected invalid memory quantity error, got %v", err)
	}
}

func TestValidateRelativePath(t *testing.T) {
	for _, path := range []string{"", ".", "../etc", "/etc"} {
		if err := validateRelativePath(path); err == nil {
			t.Errorf("expected %q to be rejected", path)
		}
	}
	if err := validateRelativePath("etc/app.yaml"); err != nil {
		t.Fatal(err)
	}
}
