package main

import (
	"encoding/json"
	"fmt"
	"regexp"
)

type mirrordConfig struct {
	Target  mirrordTarget  `json:"target"`
	Agent   mirrordAgent   `json:"agent"`
	Feature mirrordFeature `json:"feature"`
}

type mirrordTarget struct {
	Path      string `json:"path"`
	Namespace string `json:"namespace"`
}

type mirrordAgent struct {
	Namespace            string                      `json:"namespace"`
	Image                string                      `json:"image"`
	ImagePullPolicy      string                      `json:"image_pull_policy"`
	TTL                  int                         `json:"ttl"`
	CleanIPTablesOnStart bool                        `json:"clean_iptables_on_start"`
	Resources            mirrordResourceRequirements `json:"resources"`
	Labels               map[string]string           `json:"labels"`
}

type mirrordFeature struct {
	Env     mirrordEnv     `json:"env"`
	FS      mirrordFS      `json:"fs"`
	Network mirrordNetwork `json:"network"`
}

type mirrordEnv struct {
	Include  string            `json:"include"`
	Override map[string]string `json:"override"`
}

type mirrordFS struct {
	Mode     string   `json:"mode"`
	ReadOnly []string `json:"read_only"`
}

type mirrordNetwork struct {
	Incoming mirrordIncoming `json:"incoming"`
	Outgoing bool            `json:"outgoing"`
	DNS      bool            `json:"dns"`
}

type mirrordIncoming struct {
	Mode        string            `json:"mode"`
	HTTPFilter  mirrordHTTPFilter `json:"http_filter"`
	PortMapping [][2]int          `json:"port_mapping"`
}

type mirrordHTTPFilter struct {
	HeaderFilter string `json:"header_filter"`
	Ports        []int  `json:"ports"`
}

func renderMirrordConfig(cfg *config, routeID, labelValue, targetPath string) ([]byte, error) {
	if targetPath == "" {
		targetPath = cfg.Remote.Target
	}
	overrides := make(map[string]string, len(cfg.App.Env)+1)
	for key, value := range cfg.App.Env {
		overrides[key] = value
	}
	overrides["DEVBRIDGE_ROUTE_ID"] = routeID
	mc := mirrordConfig{
		Target: mirrordTarget{Path: targetPath, Namespace: cfg.Remote.Namespace},
		Agent: mirrordAgent{
			Namespace:            cfg.Remote.Namespace,
			Image:                cfg.Mirrord.AgentImage,
			ImagePullPolicy:      "Never",
			TTL:                  cfg.Mirrord.AgentTTLSeconds,
			CleanIPTablesOnStart: cfg.Mirrord.CleanIPTablesOnStart,
			Resources:            cfg.Mirrord.AgentResources,
			Labels:               map[string]string{sessionLabelKey: labelValue},
		},
		Feature: mirrordFeature{
			Env: mirrordEnv{Include: cfg.RemoteContext.EnvInclude, Override: overrides},
			FS:  mirrordFS{Mode: "localwithoverrides", ReadOnly: cfg.RemoteContext.ReadOnly},
			Network: mirrordNetwork{
				Incoming: mirrordIncoming{
					Mode: "steal",
					HTTPFilter: mirrordHTTPFilter{
						HeaderFilter: fmt.Sprintf("^%s: %s$", regexp.QuoteMeta(cfg.Gateway.RouteHeader), regexp.QuoteMeta(routeID)),
						Ports:        []int{cfg.App.RemotePort},
					},
					PortMapping: [][2]int{{cfg.App.LocalPort, cfg.App.RemotePort}},
				},
				Outgoing: true,
				DNS:      true,
			},
		},
	}
	return json.MarshalIndent(mc, "", "  ")
}
