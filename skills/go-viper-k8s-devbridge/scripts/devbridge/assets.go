package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type mirrordAssets struct {
	Binary string
	Layer  string
}

func ensureMirrordAssets(ctx context.Context, cfg *config) (*mirrordAssets, error) {
	cacheRoot, err := os.UserCacheDir()
	if err != nil {
		return nil, fmt.Errorf("resolve user cache: %w", err)
	}
	dir := filepath.Join(cacheRoot, "devbridge", "mirrord", cfg.Mirrord.Version, "linux-x86_64")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	baseURL := "https://github.com/metalbear-co/mirrord/releases/download/" + cfg.Mirrord.Version + "/"
	binary := filepath.Join(dir, "mirrord")
	layer := filepath.Join(dir, "libmirrord_layer.so")
	if err := ensureDownload(ctx, baseURL+"mirrord_linux_x86_64", binary, cfg.Mirrord.BinarySHA256, 0o700); err != nil {
		return nil, err
	}
	if err := ensureDownload(ctx, baseURL+"libmirrord_layer_linux_x86_64.so", layer, cfg.Mirrord.LayerSHA256, 0o600); err != nil {
		return nil, err
	}
	return &mirrordAssets{Binary: binary, Layer: layer}, nil
}

func ensureDownload(ctx context.Context, sourceURL, target, wantSHA string, mode os.FileMode) error {
	if got, err := fileSHA256(target); err == nil && got == wantSHA {
		_ = os.Remove(target + ".part")
		return os.Chmod(target, mode)
	}
	part := target + ".part"
	if wget, err := exec.LookPath("wget"); err == nil {
		fmt.Printf("downloading %s with resumable wget...\n", filepath.Base(target))
		cmd := exec.CommandContext(ctx, wget, "--continue", "--tries=10", "--timeout=30", "--output-document="+part, sourceURL)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("download %s with wget (partial file preserved): %w", sourceURL, err)
		}
		return verifyDownloadedFile(part, target, wantSHA, mode, sourceURL)
	}
	if curl, err := exec.LookPath("curl"); err == nil {
		fmt.Printf("downloading %s with resumable curl...\n", filepath.Base(target))
		cmd := exec.CommandContext(ctx, curl, "--fail", "--location", "--retry", "10", "--retry-all-errors", "--connect-timeout", "20", "--continue-at", "-", "--output", part, sourceURL)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("download %s with curl (partial file preserved): %w", sourceURL, err)
		}
		return verifyDownloadedFile(part, target, wantSHA, mode, sourceURL)
	}

	_ = os.Remove(part)
	client := &http.Client{Timeout: 10 * time.Minute}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return fmt.Errorf("create download request %s: %w", sourceURL, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", sourceURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %s", sourceURL, resp.Status)
	}
	f, err := os.OpenFile(part, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(f, h), resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(part)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(part)
		return closeErr
	}
	got := fmt.Sprintf("%x", h.Sum(nil))
	return installVerifiedFile(part, target, wantSHA, got, mode, sourceURL)
}

func verifyDownloadedFile(part, target, wantSHA string, mode os.FileMode, sourceURL string) error {
	got, err := fileSHA256(part)
	if err != nil {
		_ = os.Remove(part)
		return err
	}
	return installVerifiedFile(part, target, wantSHA, got, mode, sourceURL)
}

func installVerifiedFile(part, target, wantSHA, gotSHA string, mode os.FileMode, sourceURL string) error {
	if gotSHA != wantSHA {
		_ = os.Remove(part)
		return fmt.Errorf("checksum mismatch for %s: got %s", sourceURL, gotSHA)
	}
	if err := os.Rename(part, target); err != nil {
		return err
	}
	return os.Chmod(target, mode)
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", h.Sum(nil)), nil
}

func ensureAgentArchive(cfg *config) (string, error) {
	cacheRoot, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cacheRoot, "devbridge", "images")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	archive := filepath.Join(dir, strings.NewReplacer("/", "_", ":", "_").Replace(cfg.Mirrord.AgentImage)+".tar")
	if info, err := os.Stat(archive); err == nil && info.Size() > 0 {
		return archive, nil
	}
	part := archive + ".part"
	_ = os.Remove(part)
	if skopeo, err := exec.LookPath("skopeo"); err == nil {
		cmd := exec.Command(skopeo, "copy", "--override-os=linux", "--override-arch=amd64", "docker://"+cfg.Mirrord.AgentImage, "docker-archive:"+part+":"+cfg.Mirrord.AgentImage)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			_ = os.Remove(part)
			return "", fmt.Errorf("create agent archive with skopeo: %w", err)
		}
	} else if docker, err := exec.LookPath("docker"); err == nil {
		pull := exec.Command(docker, "pull", "--platform=linux/amd64", cfg.Mirrord.AgentImage)
		pull.Stdout, pull.Stderr = os.Stdout, os.Stderr
		if err := pull.Run(); err != nil {
			return "", fmt.Errorf("pull agent image: %w", err)
		}
		save := exec.Command(docker, "save", "-o", part, cfg.Mirrord.AgentImage)
		save.Stdout, save.Stderr = os.Stdout, os.Stderr
		if err := save.Run(); err != nil {
			_ = os.Remove(part)
			return "", fmt.Errorf("save agent image: %w", err)
		}
	} else {
		return "", fmt.Errorf("agent image is absent remotely; install skopeo or docker locally")
	}
	if err := os.Rename(part, archive); err != nil {
		return "", err
	}
	return archive, nil
}

func platformSummary() string {
	return runtime.GOOS + "/" + runtime.GOARCH
}
