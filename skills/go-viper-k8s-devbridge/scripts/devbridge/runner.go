package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const sessionLabelKey = "devbridge.transwarp.io/session"

type sessionState struct {
	Version        int    `json:"version"`
	ConfigPath     string `json:"config_path"`
	SSH            string `json:"ssh"`
	Namespace      string `json:"namespace"`
	RemoteDir      string `json:"remote_dir"`
	LabelValue     string `json:"label_value"`
	RouteID        string `json:"route_id"`
	ProxyURL       string `json:"proxy_url"`
	PreviewAddress string `json:"preview_address,omitempty"`
	HealthPath     string `json:"health_path"`
	Ready          bool   `json:"ready"`
}

func doctor(ctx context.Context, cfg *config, projectRoot string) error {
	fmt.Printf("devbridge doctor (%s)\n", platformSummary())
	for _, tool := range []string{"ssh", "scp", cfg.App.Build[0]} {
		if _, err := exec.LookPath(tool); err != nil {
			return fmt.Errorf("required local command %q not found", tool)
		}
		fmt.Printf("  ok local command: %s\n", tool)
	}
	for _, rel := range cfg.App.Sync {
		if _, err := os.Stat(filepath.Join(projectRoot, rel)); err != nil {
			return fmt.Errorf("sync path %s: %w", rel, err)
		}
	}

	resource := targetResource(cfg.Remote.Target)
	remoteCheck := strings.Join([]string{
		"set -eu",
		"test \"$(uname -s)\" = Linux",
		"test \"$(uname -m)\" = x86_64",
		"command -v kubectl >/dev/null",
		"command -v ctr >/dev/null",
		"command -v sha256sum >/dev/null",
		"kubectl -n " + shellQuote(cfg.Remote.Namespace) + " get " + shellQuote(resource) + " >/dev/null",
		"test \"$(kubectl auth can-i create pods -n " + shellQuote(cfg.Remote.Namespace) + ")\" = yes",
		"echo remote-ok",
	}, "; ")
	if strings.HasPrefix(resource, "deployment/") {
		remoteCheck += "; kubectl -n " + shellQuote(cfg.Remote.Namespace) + " get " + shellQuote(resource) + " -o jsonpath='{.spec.replicas}' | grep -Fx 1 >/dev/null"
		remoteCheck += "; kubectl -n " + shellQuote(cfg.Remote.Namespace) + " get " + shellQuote(resource) + " -o jsonpath='{.status.readyReplicas}' | grep -Fx 1 >/dev/null"
	}
	out, err := capture(ctx, "ssh", cfg.Remote.SSH, remoteCheck)
	if err != nil {
		return fmt.Errorf("remote prerequisite check: %w: %s", err, strings.TrimSpace(out))
	}
	fmt.Printf("  ok remote: %s namespace=%s target=%s\n", cfg.Remote.SSH, cfg.Remote.Namespace, cfg.Remote.Target)
	if cfg.Recovery.AutoReattach {
		pod, err := currentTargetPod(ctx, cfg)
		if err != nil {
			return fmt.Errorf("resolve recovery target: %w", err)
		}
		fmt.Printf("  ok recovery target: %s uid=%s\n", pod.Name, pod.UID)
	}

	exists, err := remoteAgentImageExists(ctx, cfg)
	if err != nil {
		return err
	}
	if exists {
		fmt.Printf("  ok agent image cached remotely: %s\n", cfg.Mirrord.AgentImage)
	} else if _, skopeoErr := exec.LookPath("skopeo"); skopeoErr == nil {
		fmt.Println("  ok local image transport: skopeo")
	} else if _, dockerErr := exec.LookPath("docker"); dockerErr == nil {
		fmt.Println("  ok local image transport: docker")
	} else {
		return fmt.Errorf("agent image is absent remotely and neither skopeo nor docker is installed locally")
	}

	client := &http.Client{Timeout: 5 * time.Second}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Gateway.Upstream, nil)
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("gateway %s is unreachable: %w", cfg.Gateway.Upstream, err)
	}
	_ = response.Body.Close()
	fmt.Printf("  ok gateway reachable: %s (HTTP %d)\n", cfg.Gateway.Upstream, response.StatusCode)
	fmt.Println("doctor passed")
	return nil
}

func up(ctx context.Context, cfg *config, cfgPath, projectRoot, stateDir, frontendURL, previewListen string) error {
	statePath := filepath.Join(stateDir, "session.json")
	if _, err := os.Stat(statePath); err == nil {
		return fmt.Errorf("an existing session file was found; run devbridge down first")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// A SIGKILL or host reboot can bypass deferred cleanup. With no active
	// session state, every directory below this tool-owned path is stale.
	if err := os.RemoveAll(filepath.Join(stateDir, "sessions")); err != nil {
		return fmt.Errorf("remove stale local sessions: %w", err)
	}

	suffix, err := randomHex(6)
	if err != nil {
		return err
	}
	labelValue := "s-" + suffix
	routeID := "devbridge-" + localUserName() + "-" + suffix
	localDir := filepath.Join(stateDir, "sessions", suffix)
	if err := os.MkdirAll(localDir, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(localDir)

	appPath := filepath.Join(localDir, cfg.App.Name)
	artifact, err := buildApp(ctx, cfg, projectRoot, appPath)
	if err != nil {
		return err
	}
	assets, err := ensureMirrordAssets(ctx, cfg)
	if err != nil {
		return err
	}
	configPath := filepath.Join(localDir, "mirrord.json")

	remoteDir := fmt.Sprintf("%s/devbridge-%s-%s", cfg.Remote.BaseDir, cfg.Project.Name, suffix)
	state := &sessionState{
		Version: 1, ConfigPath: cfgPath, SSH: cfg.Remote.SSH, Namespace: cfg.Remote.Namespace,
		RemoteDir: remoteDir, LabelValue: labelValue, RouteID: routeID,
		HealthPath: cfg.Gateway.HealthPath,
	}
	// Persist cleanup coordinates before the first remote mutation.
	if err := writeState(statePath, state); err != nil {
		return err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// Keep the state file when cleanup fails so "down" can retry.
		if err := cleanupRemote(cleanupCtx, cfg.Remote.SSH, cfg.Remote.Namespace, remoteDir, labelValue); err == nil {
			_ = os.Remove(statePath)
		}
	}()
	if err := remotePrepare(ctx, cfg, remoteDir); err != nil {
		return err
	}

	imageExists, err := remoteAgentImageExists(ctx, cfg)
	if err != nil {
		return err
	}
	if !imageExists {
		fmt.Printf("agent image %s is not cached on %s; preparing one-time upload...\n", cfg.Mirrord.AgentImage, cfg.Remote.SSH)
		archive, err := ensureAgentArchive(cfg)
		if err != nil {
			return err
		}
		if err := uploadAndImportAgentImage(ctx, cfg, remoteDir, archive); err != nil {
			return err
		}
	}

	if err := uploadRuntime(ctx, cfg, projectRoot, remoteDir, artifact, assets); err != nil {
		return err
	}
	proxy, err := startLocalProxy(cfg, routeID)
	if err != nil {
		return err
	}
	cfg.Gateway.Listen = proxy.listener.Addr().String()
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = proxy.Close(closeCtx)
	}()

	state.ProxyURL = "http://" + cfg.Gateway.Listen
	var preview *localProxy
	if frontendURL != "" {
		preview, err = startPreviewProxy(cfg, routeID, frontendURL, previewListen)
		if err != nil {
			return err
		}
		state.PreviewAddress = preview.listener.Addr().String()
		defer func() { _ = preview.server.Close() }()
	}
	if err := writeState(statePath, state); err != nil {
		return err
	}

	fmt.Printf("route selector: %s: %s\n", cfg.Gateway.RouteHeader, routeID)
	fmt.Printf("frontend/API gateway: http://%s\n", cfg.Gateway.Listen)
	var target *targetPod
	if cfg.Recovery.AutoReattach {
		target, err = currentTargetPod(ctx, cfg)
		if err != nil {
			return fmt.Errorf("resolve initial target pod: %w", err)
		}
		fmt.Printf("target pod: %s uid=%s\n", target.Name, target.UID)
	}
	targetPath := cfg.Remote.Target
	if target != nil {
		targetPath = concretePodTarget(cfg, target)
	}
	if err := installMirrordConfig(ctx, cfg, remoteDir, configPath, routeID, labelValue, targetPath); err != nil {
		return err
	}

	recoveries := 0
	for {
		cmd := remoteAppCommand(ctx, cfg, remoteDir)
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("start remote app: %w", err)
		}
		waitCh := make(chan error, 1)
		go func() { waitCh <- cmd.Wait() }()

		fmt.Printf("waiting for the API-only process (startup can take several minutes)...\n")
		processExited, readyErr := waitReady(ctx, cfg, routeID, waitCh)
		if readyErr == nil {
			state.Ready = true
			if err := writeState(statePath, state); err != nil {
				return err
			}
			if recoveries == 0 {
				fmt.Printf("devbridge ready: http://%s%s\n", cfg.Gateway.Listen, cfg.Gateway.HealthPath)
				fmt.Println("press Ctrl-C to stop and clean up the route")
			} else {
				fmt.Printf("devbridge route restored on %s (recovery %d/%d)\n", target.Name, recoveries, cfg.Recovery.MaxAttempts)
			}
		}

		var processErr error
		if processExited {
			processErr = readyErr
		} else if readyErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			return readyErr
		} else {
			processErr = <-waitCh
		}
		if _, stateErr := os.Stat(statePath); errors.Is(stateErr, os.ErrNotExist) {
			return nil
		}
		state.Ready = false
		if err := writeState(statePath, state); err != nil {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		if processErr == nil {
			if err := cleanupRemote(context.Background(), cfg.Remote.SSH, cfg.Remote.Namespace, remoteDir, labelValue); err != nil {
				return err
			}
			return nil
		}
		if !cfg.Recovery.AutoReattach || recoveries >= cfg.Recovery.MaxAttempts {
			return fmt.Errorf("remote process exited: %w", processErr)
		}
		nextTarget, recoverable, recoveryErr := waitForRecoverableTarget(ctx, cfg, target)
		if recoveryErr != nil {
			return fmt.Errorf("remote process exited (%v); target recovery failed: %w", processErr, recoveryErr)
		}
		if !recoverable {
			return fmt.Errorf("remote process exited (%v), but target pod %s is still healthy; refusing an unsafe duplicate restart", processErr, target.Name)
		}
		recoveries++
		target = nextTarget
		fmt.Printf("reattaching to replacement target %s uid=%s (attempt %d/%d)...\n", target.Name, target.UID, recoveries, cfg.Recovery.MaxAttempts)
		if err := installMirrordConfig(ctx, cfg, remoteDir, configPath, routeID, labelValue, concretePodTarget(cfg, target)); err != nil {
			return fmt.Errorf("install recovery configuration: %w", err)
		}
	}
}

func down(ctx context.Context, stateDir string) error {
	statePath := filepath.Join(stateDir, "session.json")
	data, err := os.ReadFile(statePath)
	if errors.Is(err, os.ErrNotExist) {
		fmt.Println("no devbridge session is recorded")
		return nil
	}
	if err != nil {
		return err
	}
	var state sessionState
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("decode session state: %w", err)
	}
	if state.Version != 1 || !sshTargetRE.MatchString(state.SSH) || !safeNameRE.MatchString(state.Namespace) || !safeNameRE.MatchString(state.LabelValue) || !strings.HasPrefix(state.RemoteDir, "/tmp/devbridge-") {
		return fmt.Errorf("refusing to clean an invalid session state")
	}
	if err := cleanupRemote(ctx, state.SSH, state.Namespace, state.RemoteDir, state.LabelValue); err != nil {
		return err
	}
	if err := os.Remove(statePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Println("devbridge session cleaned")
	return nil
}

func buildApp(ctx context.Context, cfg *config, root, output string) (*buildArtifact, error) {
	fmt.Printf("computing build cache key for %s...\n", cfg.App.Name)
	cacheKey, cacheErr := buildCacheKey(ctx, cfg, root)
	if cacheErr == nil {
		if artifact, hit, err := restoreCachedBuild(root, cacheKey, cfg.App.Name, output); err != nil {
			return nil, fmt.Errorf("restore build cache: %w", err)
		} else if hit {
			fmt.Printf("build cache hit: %s\n", cacheKey[:12])
			return artifact, nil
		}
	} else {
		fmt.Printf("build cache unavailable: %v\n", cacheErr)
	}

	args := make([]string, len(cfg.App.Build))
	for i, part := range cfg.App.Build {
		part = strings.ReplaceAll(part, "{{output}}", output)
		part = strings.ReplaceAll(part, "{{root}}", root)
		args[i] = part
	}
	var err error
	args, err = isolateGoBuildModule(args, root, filepath.Dir(output))
	if err != nil {
		return nil, err
	}
	fmt.Printf("building %s...\n", cfg.App.Name)
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = root
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("build app: %w", err)
	}
	if err := os.Chmod(output, 0o700); err != nil {
		return nil, err
	}
	sha, err := fileSHA256(output)
	if err != nil {
		return nil, fmt.Errorf("hash built application: %w", err)
	}
	artifact := &buildArtifact{Path: output, SHA256: sha}
	if cacheErr == nil {
		if err := storeCachedBuild(root, cacheKey, cfg.App.Name, artifact); err != nil {
			return nil, fmt.Errorf("store build cache: %w", err)
		}
		fmt.Printf("build cache stored: %s\n", cacheKey[:12])
	}
	return artifact, nil
}

// isolateGoBuildModule makes dependency resolution disposable. A Go build may
// decide that go.mod/go.sum need updates even when the application source is
// otherwise buildable. Devbridge must never leave those mechanical changes in
// the developer's worktree, so it gives the command a session-local modfile.
func isolateGoBuildModule(args []string, root, sessionDir string) ([]string, error) {
	if len(args) < 2 || filepath.Base(args[0]) != "go" || args[1] != "build" {
		return args, nil
	}

	modulePath := filepath.Join(root, "go.mod")
	moduleData, err := os.ReadFile(modulePath)
	if err != nil {
		return nil, fmt.Errorf("read project go.mod: %w", err)
	}
	isolatedMod := filepath.Join(sessionDir, "devbridge.mod")
	if err := os.WriteFile(isolatedMod, moduleData, 0o600); err != nil {
		return nil, fmt.Errorf("write isolated go.mod: %w", err)
	}

	sumPath := filepath.Join(root, "go.sum")
	if sumData, sumErr := os.ReadFile(sumPath); sumErr == nil {
		if err := os.WriteFile(filepath.Join(sessionDir, "devbridge.sum"), sumData, 0o600); err != nil {
			return nil, fmt.Errorf("write isolated go.sum: %w", err)
		}
	} else if !errors.Is(sumErr, os.ErrNotExist) {
		return nil, fmt.Errorf("read project go.sum: %w", sumErr)
	}

	result := make([]string, 0, len(args)+2)
	result = append(result, args[:2]...)
	result = append(result, "-mod=mod", "-modfile="+isolatedMod)
	result = append(result, args[2:]...)
	return result, nil
}

func remotePrepare(ctx context.Context, cfg *config, remoteDir string) error {
	cacheRoot := remoteCacheRoot(cfg)
	command := strings.Join([]string{
		"set -e",
		"install -d -m 700 " + shellQuote(remoteDir),
		"if test -e " + shellQuote(cacheRoot) + "; then test -d " + shellQuote(cacheRoot) + " && test ! -L " + shellQuote(cacheRoot) + " && test \"$(stat -c %u " + shellQuote(cacheRoot) + ")\" = \"$(id -u)\"; else install -d -m 700 " + shellQuote(cacheRoot) + "; fi",
		"chmod 700 " + shellQuote(cacheRoot),
	}, "; ")
	return runAttached(ctx, "ssh", cfg.Remote.SSH, command)
}

func uploadRuntime(ctx context.Context, cfg *config, root, remoteDir string, artifact *buildArtifact, assets *mirrordAssets) error {
	if err := materializeRemoteApp(ctx, cfg, root, remoteDir, artifact); err != nil {
		return err
	}
	if err := materializeRemoteFile(ctx, cfg, remoteDir, assets.Binary, "mirrord", cfg.Mirrord.BinarySHA256, 0o700); err != nil {
		return err
	}
	if err := materializeRemoteFile(ctx, cfg, remoteDir, assets.Layer, "libmirrord_layer.so", cfg.Mirrord.LayerSHA256, 0o600); err != nil {
		return err
	}
	for _, rel := range cfg.App.Sync {
		if err := runAttached(ctx, "scp", "-q", "-r", filepath.Join(root, rel), cfg.Remote.SSH+":"+remoteDir+"/"); err != nil {
			return fmt.Errorf("upload sync path %s: %w", rel, err)
		}
	}
	command := "chmod 700 " + shellQuote(remoteDir+"/"+cfg.App.Name) + " " + shellQuote(remoteDir+"/mirrord") + "; chmod 600 " + shellQuote(remoteDir+"/libmirrord_layer.so")
	return runAttached(ctx, "ssh", cfg.Remote.SSH, command)
}

func installMirrordConfig(ctx context.Context, cfg *config, remoteDir, localPath, routeID, labelValue, targetPath string) error {
	data, err := renderMirrordConfig(cfg, routeID, labelValue, targetPath)
	if err != nil {
		return err
	}
	if err := os.WriteFile(localPath, data, 0o600); err != nil {
		return err
	}
	if err := runAttached(ctx, "scp", "-q", localPath, cfg.Remote.SSH+":"+remoteDir+"/mirrord.json"); err != nil {
		return fmt.Errorf("upload mirrord.json: %w", err)
	}
	return runAttached(ctx, "ssh", cfg.Remote.SSH, "chmod 600 "+shellQuote(remoteDir+"/mirrord.json"))
}

func materializeRemoteApp(ctx context.Context, cfg *config, root, remoteDir string, artifact *buildArtifact) error {
	cachePath := remoteCacheRoot(cfg) + "/apps/" + artifact.SHA256 + "/" + cfg.App.Name
	hit, err := remoteFileMatches(ctx, cfg.Remote.SSH, cachePath, artifact.SHA256)
	if err != nil {
		return fmt.Errorf("check remote application cache: %w", err)
	}
	if hit {
		fmt.Printf("remote application cache hit: %s\n", artifact.SHA256[:12])
		command := "cp -- " + shellQuote(cachePath) + " " + shellQuote(remoteDir+"/"+cfg.App.Name)
		return runAttached(ctx, "ssh", cfg.Remote.SSH, command)
	}

	localUpload := artifact.Path
	remoteUpload := remoteDir + "/" + cfg.App.Name
	decompressCommand := ""
	if localZstd, lookupErr := exec.LookPath("zstd"); lookupErr == nil {
		if _, remoteErr := capture(ctx, "ssh", cfg.Remote.SSH, "command -v zstd >/dev/null"); remoteErr == nil {
			compressed, compressionHit, compressionErr := ensureCompressedApp(ctx, root, artifact, localZstd)
			if compressionErr != nil {
				return compressionErr
			}
			if compressionHit {
				fmt.Printf("compression cache hit: %s\n", artifact.SHA256[:12])
			} else {
				fmt.Printf("compression cache stored: %s\n", artifact.SHA256[:12])
			}
			localUpload = compressed
			remoteUpload = remoteDir + "/" + cfg.App.Name + ".zst"
			decompressCommand = "zstd -q -d -f " + shellQuote(remoteUpload) + " -o " + shellQuote(remoteDir+"/"+cfg.App.Name) + "; rm -f -- " + shellQuote(remoteUpload)
		}
	}
	if err := runAttached(ctx, "scp", "-q", localUpload, cfg.Remote.SSH+":"+remoteUpload); err != nil {
		return fmt.Errorf("upload application: %w", err)
	}
	if decompressCommand != "" {
		if err := runAttached(ctx, "ssh", cfg.Remote.SSH, decompressCommand); err != nil {
			return fmt.Errorf("decompress application binary: %w", err)
		}
	}
	cachePart := cachePath + ".part-" + filepath.Base(remoteDir)
	command := strings.Join([]string{
		remoteVerifyCommand(remoteDir+"/"+cfg.App.Name, artifact.SHA256),
		"install -d -m 700 " + shellQuote(filepath.Dir(cachePath)),
		"cp -- " + shellQuote(remoteDir+"/"+cfg.App.Name) + " " + shellQuote(cachePart),
		"chmod 700 " + shellQuote(cachePart),
		"mv -f -- " + shellQuote(cachePart) + " " + shellQuote(cachePath),
	}, "; ")
	if err := runAttached(ctx, "ssh", cfg.Remote.SSH, command); err != nil {
		return fmt.Errorf("verify and store remote application cache: %w", err)
	}
	fmt.Printf("remote application cache stored: %s\n", artifact.SHA256[:12])
	return nil
}

func materializeRemoteFile(ctx context.Context, cfg *config, remoteDir, localPath, remoteName, checksum string, mode os.FileMode) error {
	cachePath := remoteCacheRoot(cfg) + "/runtime/" + cfg.Mirrord.Version + "/" + checksum + "/" + remoteName
	hit, err := remoteFileMatches(ctx, cfg.Remote.SSH, cachePath, checksum)
	if err != nil {
		return fmt.Errorf("check remote %s cache: %w", remoteName, err)
	}
	if !hit {
		upload := remoteDir + "/" + remoteName + ".upload"
		if err := runAttached(ctx, "scp", "-q", localPath, cfg.Remote.SSH+":"+upload); err != nil {
			return fmt.Errorf("upload %s: %w", remoteName, err)
		}
		cachePart := cachePath + ".part-" + filepath.Base(remoteDir)
		command := strings.Join([]string{
			remoteVerifyCommand(upload, checksum),
			"install -d -m 700 " + shellQuote(filepath.Dir(cachePath)),
			"cp -- " + shellQuote(upload) + " " + shellQuote(cachePart),
			fmt.Sprintf("chmod %o %s", mode.Perm(), shellQuote(cachePart)),
			"mv -f -- " + shellQuote(cachePart) + " " + shellQuote(cachePath),
			"rm -f -- " + shellQuote(upload),
		}, "; ")
		if err := runAttached(ctx, "ssh", cfg.Remote.SSH, command); err != nil {
			return fmt.Errorf("verify and store remote %s cache: %w", remoteName, err)
		}
		fmt.Printf("remote runtime cache stored: %s\n", remoteName)
	} else {
		fmt.Printf("remote runtime cache hit: %s\n", remoteName)
	}
	command := "cp -- " + shellQuote(cachePath) + " " + shellQuote(remoteDir+"/"+remoteName)
	return runAttached(ctx, "ssh", cfg.Remote.SSH, command)
}

func remoteFileMatches(ctx context.Context, sshHost, path, checksum string) (bool, error) {
	command := "test -f " + shellQuote(path) + " && " + remoteVerifyCommand(path, checksum)
	_, err := capture(ctx, "ssh", sshHost, command)
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, err
}

func remoteVerifyCommand(path, checksum string) string {
	return "set -- $(sha256sum -- " + shellQuote(path) + "); test \"$1\" = " + shellQuote(checksum)
}

func uploadAndImportAgentImage(ctx context.Context, cfg *config, remoteDir, archive string) error {
	remoteArchive := remoteDir + "/agent-image.tar"
	if err := runAttached(ctx, "scp", "-q", archive, cfg.Remote.SSH+":"+remoteArchive); err != nil {
		return fmt.Errorf("upload agent image: %w", err)
	}
	command := "ctr -n k8s.io images import " + shellQuote(remoteArchive) + " >/dev/null; rm -f -- " + shellQuote(remoteArchive)
	if err := runAttached(ctx, "ssh", cfg.Remote.SSH, command); err != nil {
		return fmt.Errorf("import agent image: %w", err)
	}
	return nil
}

func remoteAgentImageExists(ctx context.Context, cfg *config) (bool, error) {
	command := "if ctr -n k8s.io images ls -q | grep -Fqx -- " + shellQuote(cfg.Mirrord.AgentImage) + "; then echo yes; else echo no; fi"
	out, err := capture(ctx, "ssh", cfg.Remote.SSH, command)
	if err != nil {
		return false, fmt.Errorf("check remote agent image: %w", err)
	}
	return strings.TrimSpace(out) == "yes", nil
}

func remoteAppCommand(ctx context.Context, cfg *config, remoteDir string) *exec.Cmd {
	parts := []string{
		"cd " + shellQuote(remoteDir),
		"echo $$ > .devbridge.pid",
		"exec env MIRRORD_LAYER_FILE=" + shellQuote(remoteDir+"/libmirrord_layer.so") +
			" MIRRORD_PROGRESS_MODE=plain MIRRORD_TELEMETRY=false " +
			shellQuote(remoteDir+"/mirrord") + " exec -f " + shellQuote(remoteDir+"/mirrord.json") +
			" --disable-version-check " + shellQuote(remoteDir+"/"+cfg.App.Name),
	}
	for _, arg := range cfg.App.Args {
		parts[len(parts)-1] += " " + shellQuote(arg)
	}
	cmd := exec.CommandContext(ctx, "ssh", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", cfg.Remote.SSH, strings.Join(parts, "; "))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd
}

func waitReady(ctx context.Context, cfg *config, routeID string, processDone <-chan error) (bool, error) {
	deadline := time.NewTimer(6 * time.Minute)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	client := &http.Client{Timeout: 3 * time.Second}
	readyURL := "http://" + cfg.Gateway.Listen + cfg.Gateway.HealthPath
	for {
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case err := <-processDone:
			if err == nil {
				return true, fmt.Errorf("remote process exited before becoming ready")
			}
			return true, fmt.Errorf("remote process exited before becoming ready: %w", err)
		case <-deadline.C:
			return false, fmt.Errorf("timed out waiting for %s", readyURL)
		case <-ticker.C:
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, readyURL, nil)
			resp, err := client.Do(req)
			if err != nil {
				continue
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK && resp.Header.Get("X-Devbridge-Route") == routeID {
				return false, nil
			}
		}
	}
}

func cleanupRemote(ctx context.Context, sshHost, namespace, remoteDir, labelValue string) error {
	if !strings.HasPrefix(remoteDir, "/tmp/devbridge-") {
		return fmt.Errorf("refusing cleanup outside /tmp/devbridge-*")
	}
	command := strings.Join([]string{
		"set -e",
		"if test -f " + shellQuote(remoteDir+"/.devbridge.pid") + "; then pid=$(cat " + shellQuote(remoteDir+"/.devbridge.pid") + "); case $pid in ''|*[!0-9]*) pid='' ;; esac; if test -n \"$pid\" && test -d \"/proc/$pid\" && test \"$(readlink /proc/$pid/cwd)\" = " + shellQuote(remoteDir) + "; then kill \"$pid\" 2>/dev/null || true; fi; fi",
		"kubectl -n " + shellQuote(namespace) + " delete pod -l " + shellQuote(sessionLabelKey+"="+labelValue) + " --ignore-not-found --wait=false >/dev/null",
		"rm -rf -- " + shellQuote(remoteDir),
	}, "; ")
	out, err := capture(ctx, "ssh", sshHost, command)
	if err != nil {
		return fmt.Errorf("remote cleanup: %w: %s", err, strings.TrimSpace(out))
	}
	return nil
}

func writeState(path string, state *sessionState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func randomHex(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func localUserName() string {
	name := os.Getenv("USER")
	if name == "" {
		if current, err := user.Current(); err == nil {
			name = current.Username
		}
	}
	name = strings.ToLower(name)
	name = nonLabelRE.ReplaceAllString(name, "-")
	name = strings.Trim(name, "-.")
	if name == "" {
		return "developer"
	}
	if len(name) > 24 {
		name = name[:24]
	}
	return name
}

var nonLabelRE = regexp.MustCompile(`[^a-z0-9.-]+`)

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func runAttached(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

func capture(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	data, err := cmd.CombinedOutput()
	return string(data), err
}
