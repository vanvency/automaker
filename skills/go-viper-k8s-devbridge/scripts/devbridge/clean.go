package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// cleanOrphanedMirrordRules removes only orphaned mirrord NAT chains from the
// current target Pod. It is deliberately manual: automatically cleaning rules
// on startup can disrupt another developer's active mirrord session.
func cleanOrphanedMirrordRules(ctx context.Context, cfg *config, projectRoot string) error {
	statePath := filepath.Join(projectRoot, ".devbridge", "session.json")
	if _, err := os.Stat(statePath); err == nil {
		return fmt.Errorf("an active devbridge session is recorded; run devbridge down first")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !strings.HasPrefix(cfg.Remote.Target, "deployment/") {
		return fmt.Errorf("devbridge clean currently requires a deployment target")
	}

	target, err := currentTargetPod(ctx, cfg)
	if err != nil {
		return fmt.Errorf("resolve cleanup target: %w", err)
	}
	command, err := orphanedMirrordCleanupCommand(cfg, target)
	if err != nil {
		return err
	}
	out, err := capture(ctx, "ssh", cfg.Remote.SSH, command)
	if err != nil {
		return fmt.Errorf("clean orphaned mirrord rules: %w: %s", err, strings.TrimSpace(out))
	}
	fmt.Print(out)
	return nil
}

func orphanedMirrordCleanupCommand(cfg *config, target *targetPod) (string, error) {
	parts := strings.Split(cfg.Remote.Target, "/")
	if len(parts) != 4 || parts[0] != "deployment" || parts[2] != "container" {
		return "", fmt.Errorf("unsupported cleanup target %q", cfg.Remote.Target)
	}
	containerName := parts[3]
	chainExtractor := shellQuote(`$1 ~ /^:MRD(IN|STD)_[0-9a-f]+$/ { sub(/^:/, "", $1); print $1 }`)

	return strings.Join([]string{
		"set -eu",
		"active=$( { kubectl get pods -A --no-headers -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase' | awk '$2 ~ /^mirrord-agent-/ && $3 ~ /^(Pending|Running|Unknown)$/ { print $1 \"/\" $2 \" phase=\" $3 }'; kubectl get jobs -A --no-headers -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name' | awk '$2 ~ /^mirrord-agent-/ { print $1 \"/\" $2 }'; } )",
		"if test -n \"$active\"; then echo \"refusing cleanup while mirrord agent resources exist:\" >&2; echo \"$active\" >&2; exit 1; fi",
		"current_uid=$(kubectl -n " + shellQuote(cfg.Remote.Namespace) + " get pod " + shellQuote(target.Name) + " -o jsonpath='{.metadata.uid}')",
		"test \"$current_uid\" = " + shellQuote(target.UID) + " || { echo 'target Pod UID changed; refusing cleanup' >&2; exit 1; }",
		"set -- $(sudo -n crictl ps -q --label " + shellQuote("io.kubernetes.pod.uid="+target.UID) + " --name " + shellQuote(containerName) + ")",
		"test \"$#\" -eq 1 || { echo \"expected one running target container, found $#\" >&2; exit 1; }",
		"pid=$(sudo -n crictl inspect -o go-template --template '{{.info.pid}}' \"$1\")",
		"case \"$pid\" in ''|*[!0-9]*) echo 'invalid target container pid' >&2; exit 1 ;; esac",
		"cleaned=0",
		"backends=0",
		"clean_backend() { tool=$1; saver=$2; command -v \"$tool\" >/dev/null 2>&1 || return 0; command -v \"$saver\" >/dev/null 2>&1 || return 0; backends=$((backends + 1)); chains=$(sudo -n nsenter -t \"$pid\" -n \"$saver\" -t nat 2>/dev/null | awk " + chainExtractor + "); for chain in $chains; do case \"$chain\" in MRDIN_*) hook=PREROUTING ;; MRDSTD_*) hook=OUTPUT ;; *) echo \"unsafe chain name $chain\" >&2; exit 1 ;; esac; while sudo -n nsenter -t \"$pid\" -n \"$tool\" -t nat -C \"$hook\" -j \"$chain\" 2>/dev/null; do sudo -n nsenter -t \"$pid\" -n \"$tool\" -t nat -D \"$hook\" -j \"$chain\"; done; sudo -n nsenter -t \"$pid\" -n \"$tool\" -t nat -F \"$chain\"; sudo -n nsenter -t \"$pid\" -n \"$tool\" -t nat -X \"$chain\"; cleaned=$((cleaned + 1)); done; }",
		"clean_backend iptables-legacy iptables-legacy-save",
		"clean_backend iptables-nft iptables-nft-save",
		"test \"$backends\" -gt 0 || { echo 'no supported iptables backend found' >&2; exit 1; }",
		"echo \"devbridge clean: removed $cleaned orphaned mirrord chain(s) from pod " + target.Name + " uid=" + target.UID + "\"",
	}, "; "), nil
}
