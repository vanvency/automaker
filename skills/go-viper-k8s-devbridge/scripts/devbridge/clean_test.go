package main

import (
	"strings"
	"testing"
)

func TestOrphanedMirrordCleanupCommandIsScoped(t *testing.T) {
	cfg, _, err := loadConfig("../../assets/devbridge.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	target := &targetPod{Name: "my-go-service-abc", UID: "pod-uid", Ready: true}
	command, err := orphanedMirrordCleanupCommand(cfg, target)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"MRD(IN|STD)_[0-9a-f]+",
		"MRDIN_*) hook=PREROUTING",
		"MRDSTD_*) hook=OUTPUT",
		"iptables-legacy-save",
		"iptables-nft-save",
		"io.kubernetes.pod.uid=pod-uid",
		"target Pod UID changed; refusing cleanup",
		"refusing cleanup while mirrord agent resources exist",
	} {
		if !strings.Contains(command, required) {
			t.Errorf("cleanup command is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"iptables-legacy -t nat -F;",
		"iptables-nft -t nat -F;",
		"kubectl delete pod",
	} {
		if strings.Contains(command, forbidden) {
			t.Errorf("cleanup command contains unsafe operation %q", forbidden)
		}
	}
}

func TestOrphanedMirrordCleanupCommandRejectsPodTarget(t *testing.T) {
	cfg, _, err := loadConfig("../../assets/devbridge.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Remote.Target = "pod/my-go-service-abc/container/backend"
	if _, err := orphanedMirrordCleanupCommand(cfg, &targetPod{}); err == nil {
		t.Fatal("expected pod target to be rejected")
	}
}
