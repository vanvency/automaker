package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

type config struct {
	Version int `yaml:"version"`
	Project struct {
		Name string `yaml:"name"`
	} `yaml:"project"`
	Remote struct {
		SSH           string `yaml:"ssh"`
		Namespace     string `yaml:"namespace"`
		Target        string `yaml:"target"`
		BaseDir       string `yaml:"base_dir"`
		NonProduction bool   `yaml:"non_production"`
	} `yaml:"remote"`
	Gateway struct {
		Upstream    string   `yaml:"upstream"`
		Listen      string   `yaml:"listen"`
		StripPrefix string   `yaml:"strip_prefix"`
		RouteHeader string   `yaml:"route_header"`
		RoutePaths  []string `yaml:"route_paths"`
		HealthPath  string   `yaml:"health_path"`
	} `yaml:"gateway"`
	Recovery struct {
		AutoReattach      bool `yaml:"auto_reattach"`
		MaxAttempts       int  `yaml:"max_attempts"`
		TargetWaitSeconds int  `yaml:"target_wait_seconds"`
	} `yaml:"recovery"`
	App struct {
		Name       string            `yaml:"name"`
		LocalPort  int               `yaml:"local_port"`
		RemotePort int               `yaml:"remote_port"`
		Build      []string          `yaml:"build"`
		Args       []string          `yaml:"args"`
		Sync       []string          `yaml:"sync"`
		Env        map[string]string `yaml:"env"`
	} `yaml:"app"`
	RemoteContext struct {
		EnvInclude string   `yaml:"env_include"`
		ReadOnly   []string `yaml:"read_only"`
	} `yaml:"remote_context"`
	Mirrord struct {
		Version              string                      `yaml:"version"`
		BinarySHA256         string                      `yaml:"binary_sha256"`
		LayerSHA256          string                      `yaml:"layer_sha256"`
		AgentImage           string                      `yaml:"agent_image"`
		AgentTTLSeconds      int                         `yaml:"agent_ttl_seconds"`
		CleanIPTablesOnStart bool                        `yaml:"clean_iptables_on_start"`
		AgentResources       mirrordResourceRequirements `yaml:"agent_resources"`
	} `yaml:"mirrord"`
}

type mirrordResourceRequirements struct {
	Requests mirrordResourceList `yaml:"requests" json:"requests"`
	Limits   mirrordResourceList `yaml:"limits" json:"limits"`
}

type mirrordResourceList struct {
	CPU    string `yaml:"cpu" json:"cpu"`
	Memory string `yaml:"memory" json:"memory"`
}

var (
	safeNameRE       = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
	sshTargetRE      = regexp.MustCompile(`^[a-zA-Z0-9._@-]+$`)
	headerNameRE     = regexp.MustCompile(`^[A-Za-z0-9-]+$`)
	targetRE         = regexp.MustCompile(`^(pod|deployment)/[a-z0-9]([-a-z0-9.]*[a-z0-9])?/container/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)
	sha256RE         = regexp.MustCompile(`^[a-f0-9]{64}$`)
	envNameRE        = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)
	cpuQuantityRE    = regexp.MustCompile(`^(?:[1-9][0-9]*m|[1-9][0-9]*)$`)
	memoryQuantityRE = regexp.MustCompile(`^[1-9][0-9]*(?:Ki|Mi|Gi)$`)
)

func loadConfig(path string) (*config, string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, "", err
	}
	f, err := os.Open(abs)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()

	var cfg config
	dec := yaml.NewDecoder(f)
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return nil, "", fmt.Errorf("decode %s: %w", path, err)
	}
	applyDefaults(&cfg)
	if err := cfg.validate(); err != nil {
		return nil, "", fmt.Errorf("validate %s: %w", path, err)
	}
	return &cfg, filepath.Dir(abs), nil
}

func applyDefaults(cfg *config) {
	if cfg.Version == 0 {
		cfg.Version = 1
	}
	if cfg.Remote.BaseDir == "" {
		cfg.Remote.BaseDir = "/tmp"
	}
	if cfg.Gateway.Listen == "" {
		cfg.Gateway.Listen = "127.0.0.1:18080"
	}
	if cfg.Gateway.RouteHeader == "" {
		cfg.Gateway.RouteHeader = "X-Dev-Route"
	}
	if cfg.Gateway.HealthPath == "" {
		cfg.Gateway.HealthPath = "/cv/api/devbridge/status"
	}
	if cfg.Recovery.MaxAttempts == 0 {
		cfg.Recovery.MaxAttempts = 5
	}
	if cfg.Recovery.TargetWaitSeconds == 0 {
		cfg.Recovery.TargetWaitSeconds = 900
	}
	if cfg.App.Name == "" {
		cfg.App.Name = cfg.Project.Name
	}
	if cfg.App.LocalPort == 0 {
		cfg.App.LocalPort = 8620
	}
	if cfg.App.RemotePort == 0 {
		cfg.App.RemotePort = 80
	}
	if cfg.App.Env == nil {
		cfg.App.Env = make(map[string]string)
	}
	if cfg.Mirrord.AgentTTLSeconds == 0 {
		cfg.Mirrord.AgentTTLSeconds = 60
	}
	if cfg.Mirrord.AgentResources.Requests.CPU == "" {
		cfg.Mirrord.AgentResources.Requests.CPU = "100m"
	}
	if cfg.Mirrord.AgentResources.Requests.Memory == "" {
		cfg.Mirrord.AgentResources.Requests.Memory = "256Mi"
	}
	if cfg.Mirrord.AgentResources.Limits.CPU == "" {
		cfg.Mirrord.AgentResources.Limits.CPU = "1"
	}
	if cfg.Mirrord.AgentResources.Limits.Memory == "" {
		cfg.Mirrord.AgentResources.Limits.Memory = "1Gi"
	}
}

func (cfg *config) validate() error {
	if cfg.Version != 1 {
		return fmt.Errorf("unsupported version %d", cfg.Version)
	}
	if !safeNameRE.MatchString(cfg.Project.Name) {
		return fmt.Errorf("project.name must match %s", safeNameRE)
	}
	if !sshTargetRE.MatchString(cfg.Remote.SSH) {
		return fmt.Errorf("remote.ssh must be a host or SSH alias without options")
	}
	if !safeNameRE.MatchString(cfg.Remote.Namespace) {
		return fmt.Errorf("remote.namespace is invalid")
	}
	if !targetRE.MatchString(cfg.Remote.Target) {
		return fmt.Errorf("remote.target must look like deployment/name/container/name or pod/name/container/name")
	}
	if cfg.Remote.BaseDir != "/tmp" {
		return fmt.Errorf("remote.base_dir is restricted to /tmp in v1")
	}
	if !cfg.Remote.NonProduction {
		return fmt.Errorf("remote.non_production must be true; devbridge is forbidden against production")
	}
	u, err := url.Parse(cfg.Gateway.Upstream)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return fmt.Errorf("gateway.upstream must be an http(s) URL without credentials")
	}
	host, _, err := net.SplitHostPort(cfg.Gateway.Listen)
	if err != nil {
		return fmt.Errorf("gateway.listen: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("gateway.listen must bind a loopback IP")
	}
	if !headerNameRE.MatchString(cfg.Gateway.RouteHeader) {
		return fmt.Errorf("gateway.route_header is invalid")
	}
	if prefix := cfg.Gateway.StripPrefix; prefix != "" {
		if prefix == "/" || !strings.HasPrefix(prefix, "/") || strings.HasSuffix(prefix, "/") ||
			strings.Contains(prefix, "..") || strings.Contains(prefix, "//") || strings.ContainsAny(prefix, "?#") {
			return fmt.Errorf("gateway.strip_prefix must be a clean absolute path without a trailing slash")
		}
	}
	if len(cfg.Gateway.RoutePaths) == 0 {
		return fmt.Errorf("gateway.route_paths must contain at least one service prefix")
	}
	for _, prefix := range cfg.Gateway.RoutePaths {
		if !strings.HasPrefix(prefix, "/") || strings.Contains(prefix, "..") {
			return fmt.Errorf("invalid gateway.route_paths entry %q", prefix)
		}
	}
	if !strings.HasPrefix(cfg.Gateway.HealthPath, "/") {
		return fmt.Errorf("gateway.health_path must begin with /")
	}
	if cfg.Recovery.MaxAttempts < 1 || cfg.Recovery.MaxAttempts > 20 {
		return fmt.Errorf("recovery.max_attempts must be between 1 and 20")
	}
	if cfg.Recovery.TargetWaitSeconds < 30 || cfg.Recovery.TargetWaitSeconds > 3600 {
		return fmt.Errorf("recovery.target_wait_seconds must be between 30 and 3600")
	}
	if cfg.Recovery.AutoReattach && !strings.HasPrefix(cfg.Remote.Target, "deployment/") {
		return fmt.Errorf("recovery.auto_reattach currently requires a deployment target")
	}
	if !safeNameRE.MatchString(cfg.App.Name) {
		return fmt.Errorf("app.name is invalid")
	}
	if cfg.App.LocalPort < 1 || cfg.App.LocalPort > 65535 || cfg.App.RemotePort < 1 || cfg.App.RemotePort > 65535 {
		return fmt.Errorf("app ports must be between 1 and 65535")
	}
	if len(cfg.App.Build) == 0 {
		return fmt.Errorf("app.build must not be empty")
	}
	foundOutput := false
	for _, part := range cfg.App.Build {
		foundOutput = foundOutput || strings.Contains(part, "{{output}}")
	}
	if !foundOutput {
		return fmt.Errorf("app.build must contain {{output}}")
	}
	for _, rel := range cfg.App.Sync {
		if err := validateRelativePath(rel); err != nil {
			return fmt.Errorf("app.sync %q: %w", rel, err)
		}
	}
	for key := range cfg.App.Env {
		if !envNameRE.MatchString(key) {
			return fmt.Errorf("app.env key %q is invalid", key)
		}
	}
	if cfg.RemoteContext.EnvInclude == "" {
		return fmt.Errorf("remote_context.env_include must not be empty")
	}
	if !safeNameRE.MatchString(cfg.Mirrord.Version) {
		return fmt.Errorf("mirrord.version is invalid")
	}
	if !sha256RE.MatchString(cfg.Mirrord.BinarySHA256) || !sha256RE.MatchString(cfg.Mirrord.LayerSHA256) {
		return fmt.Errorf("mirrord checksums must be lowercase SHA-256 values")
	}
	if !strings.HasPrefix(cfg.Mirrord.AgentImage, "ghcr.io/metalbear-co/mirrord:") || strings.ContainsAny(cfg.Mirrord.AgentImage, " ;'\"") {
		return fmt.Errorf("mirrord.agent_image must be a pinned official image")
	}
	if cfg.Mirrord.AgentTTLSeconds < 30 || cfg.Mirrord.AgentTTLSeconds > 600 {
		return fmt.Errorf("mirrord.agent_ttl_seconds must be between 30 and 600")
	}
	for name, quantity := range map[string]string{
		"requests.cpu":    cfg.Mirrord.AgentResources.Requests.CPU,
		"limits.cpu":      cfg.Mirrord.AgentResources.Limits.CPU,
		"requests.memory": cfg.Mirrord.AgentResources.Requests.Memory,
		"limits.memory":   cfg.Mirrord.AgentResources.Limits.Memory,
	} {
		valid := cpuQuantityRE.MatchString(quantity)
		if strings.Contains(name, "memory") {
			valid = memoryQuantityRE.MatchString(quantity)
		}
		if !valid {
			return fmt.Errorf("mirrord.agent_resources.%s is invalid", name)
		}
	}
	return nil
}

func validateRelativePath(path string) error {
	if path == "" || filepath.IsAbs(path) {
		return fmt.Errorf("must be a non-empty relative path")
	}
	clean := filepath.Clean(path)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("must stay inside the project root")
	}
	return nil
}

func targetResource(target string) string {
	parts := strings.Split(target, "/")
	return parts[0] + "/" + parts[1]
}
