package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRenderMirrordConfigUsesScopedHeaderAndReadOnlyFiles(t *testing.T) {
	cfg, _, err := loadConfig("../../assets/devbridge.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	data, err := renderMirrordConfig(cfg, "route.a", "s-123", "pod/replacement/container/backend")
	if err != nil {
		t.Fatal(err)
	}
	var got mirrordConfig
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Feature.Network.Incoming.Mode != "steal" {
		t.Fatalf("incoming mode = %q", got.Feature.Network.Incoming.Mode)
	}
	if got.Target.Path != "pod/replacement/container/backend" {
		t.Fatalf("target path = %q", got.Target.Path)
	}
	if got.Agent.Namespace != cfg.Remote.Namespace {
		t.Fatalf("agent namespace = %q, want %q", got.Agent.Namespace, cfg.Remote.Namespace)
	}
	if got.Agent.CleanIPTablesOnStart != cfg.Mirrord.CleanIPTablesOnStart {
		t.Fatalf("clean iptables = %t, want %t", got.Agent.CleanIPTablesOnStart, cfg.Mirrord.CleanIPTablesOnStart)
	}
	if got.Agent.Resources != cfg.Mirrord.AgentResources {
		t.Fatalf("agent resources = %+v, want %+v", got.Agent.Resources, cfg.Mirrord.AgentResources)
	}
	if !strings.Contains(got.Feature.Network.Incoming.HTTPFilter.HeaderFilter, `route\.a`) {
		t.Fatalf("header filter is not escaped: %q", got.Feature.Network.Incoming.HTTPFilter.HeaderFilter)
	}
	if got.Feature.FS.Mode != "localwithoverrides" || len(got.Feature.FS.ReadOnly) == 0 {
		t.Fatalf("remote files are not read-only: %+v", got.Feature.FS)
	}
	if got.Feature.Env.Override["MY_SERVICE_DEVBRIDGE_API_ONLY"] != "true" || got.Feature.Env.Override["DEVBRIDGE_ROUTE_ID"] != "route.a" {
		t.Fatalf("missing safe overrides: %+v", got.Feature.Env.Override)
	}
}

func TestShellQuote(t *testing.T) {
	if got, want := shellQuote("a'b"), `'a'"'"'b'`; got != want {
		t.Fatalf("shellQuote = %q, want %q", got, want)
	}
}
