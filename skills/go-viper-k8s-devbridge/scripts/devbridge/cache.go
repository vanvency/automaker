package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type buildArtifact struct {
	Path     string
	SHA256   string
	CacheHit bool
}

func buildCacheKey(ctx context.Context, cfg *config, projectRoot string) (string, error) {
	if len(cfg.App.Build) < 2 || filepath.Base(cfg.App.Build[0]) != "go" || cfg.App.Build[1] != "build" {
		return "", errors.New("artifact caching currently supports go build commands only")
	}
	h := sha256.New()
	writeHashPart(h, "devbridge-build-cache-v1")
	buildJSON, _ := json.Marshal(cfg.App.Build)
	writeHashPart(h, string(buildJSON))

	goPath, err := exec.LookPath(cfg.App.Build[0])
	if err != nil {
		return "", err
	}
	writeHashPart(h, goPath)
	for _, args := range [][]string{
		{"version"},
		{"env", "GOOS", "GOARCH", "CGO_ENABLED", "GOFLAGS", "GOEXPERIMENT", "GOTOOLCHAIN", "CC", "CXX", "CGO_CFLAGS", "CGO_CPPFLAGS", "CGO_CXXFLAGS", "CGO_LDFLAGS"},
	} {
		out, commandErr := commandOutput(ctx, projectRoot, goPath, args...)
		if commandErr != nil {
			return "", commandErr
		}
		writeHashPart(h, string(out))
	}

	repositories := []string{projectRoot}
	replacements, err := localReplacementDirs(projectRoot)
	if err != nil {
		return "", err
	}
	repositories = append(repositories, replacements...)
	seen := make(map[string]struct{}, len(repositories))
	for _, repository := range repositories {
		resolved, resolveErr := filepath.EvalSymlinks(repository)
		if resolveErr != nil {
			return "", fmt.Errorf("resolve build input %s: %w", repository, resolveErr)
		}
		resolved, resolveErr = filepath.Abs(resolved)
		if resolveErr != nil {
			return "", resolveErr
		}
		if _, ok := seen[resolved]; ok {
			continue
		}
		seen[resolved] = struct{}{}
		writeHashPart(h, resolved)
		if err := hashBuildInputTree(ctx, h, resolved); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func localReplacementDirs(projectRoot string) ([]string, error) {
	f, err := os.Open(filepath.Join(projectRoot, "go.mod"))
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var result []string
	inReplaceBlock := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(strings.SplitN(scanner.Text(), "//", 2)[0])
		if line == "replace (" {
			inReplaceBlock = true
			continue
		}
		if inReplaceBlock && line == ")" {
			inReplaceBlock = false
			continue
		}
		if strings.HasPrefix(line, "replace ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "replace "))
		} else if !inReplaceBlock {
			continue
		}
		parts := strings.SplitN(line, "=>", 2)
		if len(parts) != 2 {
			continue
		}
		right := strings.Fields(strings.TrimSpace(parts[1]))
		if len(right) != 1 || (!filepath.IsAbs(right[0]) && !strings.HasPrefix(right[0], ".")) {
			continue
		}
		path := right[0]
		if !filepath.IsAbs(path) {
			path = filepath.Join(projectRoot, path)
		}
		result = append(result, filepath.Clean(path))
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	sort.Strings(result)
	return result, nil
}

func hashBuildInputTree(ctx context.Context, h hash.Hash, root string) error {
	gitRootBytes, err := commandOutput(ctx, root, "git", "rev-parse", "--show-toplevel")
	if err != nil {
		return hashPlainTree(h, root)
	}
	gitRoot := strings.TrimSpace(string(gitRootBytes))
	pathsBytes, err := commandOutput(ctx, gitRoot, "git", "ls-files", "-co", "--exclude-standard", "-z")
	if err != nil {
		return err
	}
	pathSet := make(map[string]struct{})
	for _, raw := range bytes.Split(pathsBytes, []byte{0}) {
		if len(raw) > 0 {
			pathSet[string(raw)] = struct{}{}
		}
	}
	paths := make([]string, 0, len(pathSet))
	for path := range pathSet {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, rel := range paths {
		if err := hashPath(ctx, h, gitRoot, rel); err != nil {
			return err
		}
	}
	return nil
}

func hashPlainTree(h hash.Hash, root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if entry.IsDir() && (entry.Name() == ".git" || entry.Name() == ".devbridge") {
			return filepath.SkipDir
		}
		if rel == "." {
			return nil
		}
		return hashPath(context.Background(), h, root, rel)
	})
}

func hashPath(ctx context.Context, h hash.Hash, root, rel string) error {
	full := filepath.Join(root, rel)
	info, err := os.Lstat(full)
	if errors.Is(err, os.ErrNotExist) {
		writeHashPart(h, rel+"\x00missing")
		return nil
	}
	if err != nil {
		return err
	}
	writeHashPart(h, rel)
	writeHashPart(h, info.Mode().String())
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(full)
		if err != nil {
			return err
		}
		writeHashPart(h, target)
		return nil
	}
	if info.IsDir() {
		if head, err := commandOutput(ctx, full, "git", "rev-parse", "HEAD"); err == nil {
			writeHashPart(h, string(head))
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	f, err := os.Open(full)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("hash build input %s: %w", full, err)
	}
	return nil
}

func commandOutput(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return data, nil
}

func writeHashPart(h hash.Hash, value string) {
	_, _ = io.WriteString(h, fmt.Sprintf("%d:", len(value)))
	_, _ = io.WriteString(h, value)
}

func buildCachePaths(projectRoot, key, appName string) (string, string) {
	dir := filepath.Join(projectRoot, ".devbridge", "cache", "build", key)
	return filepath.Join(dir, appName), filepath.Join(dir, appName+".sha256")
}

func restoreCachedBuild(projectRoot, key, appName, output string) (*buildArtifact, bool, error) {
	cached, checksumPath := buildCachePaths(projectRoot, key, appName)
	info, err := os.Stat(cached)
	if errors.Is(err, os.ErrNotExist) || (err == nil && (!info.Mode().IsRegular() || info.Size() == 0)) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	checksum, err := os.ReadFile(checksumPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	sha := strings.TrimSpace(string(checksum))
	if !sha256RE.MatchString(sha) {
		return nil, false, nil
	}
	actualSHA, err := fileSHA256(cached)
	if err != nil {
		return nil, false, err
	}
	if actualSHA != sha {
		return nil, false, nil
	}
	if err := linkOrCopy(cached, output, 0o700); err != nil {
		return nil, false, err
	}
	return &buildArtifact{Path: output, SHA256: sha, CacheHit: true}, true, nil
}

func storeCachedBuild(projectRoot, key, appName string, artifact *buildArtifact) error {
	cached, checksumPath := buildCachePaths(projectRoot, key, appName)
	if err := os.MkdirAll(filepath.Dir(cached), 0o700); err != nil {
		return err
	}
	if err := linkOrCopy(artifact.Path, cached+".part", 0o700); err != nil {
		return err
	}
	if err := os.Rename(cached+".part", cached); err != nil {
		return err
	}
	return os.WriteFile(checksumPath, []byte(artifact.SHA256+"\n"), 0o600)
}

func linkOrCopy(source, target string, mode os.FileMode) error {
	_ = os.Remove(target)
	if err := os.Link(source, target); err == nil {
		return os.Chmod(target, mode)
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(target)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(target)
		return closeErr
	}
	return nil
}

func ensureCompressedApp(ctx context.Context, projectRoot string, artifact *buildArtifact, zstd string) (string, bool, error) {
	dir := filepath.Join(projectRoot, ".devbridge", "cache", "compressed")
	target := filepath.Join(dir, artifact.SHA256+".zst")
	if info, err := os.Stat(target); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
		return target, true, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", false, err
	}
	part := target + ".part"
	_ = os.Remove(part)
	cmd := exec.CommandContext(ctx, zstd, "-q", "-1", "-f", artifact.Path, "-o", part)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(part)
		return "", false, fmt.Errorf("compress application binary: %w", err)
	}
	if err := os.Chmod(part, 0o600); err != nil {
		return "", false, err
	}
	if err := os.Rename(part, target); err != nil {
		return "", false, err
	}
	return target, false, nil
}

func cleanCache(ctx context.Context, cfg *config, projectRoot string) error {
	local := filepath.Join(projectRoot, ".devbridge", "cache")
	if err := os.RemoveAll(local); err != nil {
		return fmt.Errorf("remove local cache: %w", err)
	}
	remote := remoteCacheRoot(cfg)
	out, err := capture(ctx, "ssh", cfg.Remote.SSH, "rm -rf -- "+shellQuote(remote))
	if err != nil {
		return fmt.Errorf("local cache removed, remote cache cleanup failed: %w: %s", err, strings.TrimSpace(out))
	}
	fmt.Printf("devbridge caches removed: %s and %s:%s\n", local, cfg.Remote.SSH, remote)
	return nil
}

func remoteCacheRoot(cfg *config) string {
	return cfg.Remote.BaseDir + "/devbridge-cache-" + cfg.Project.Name
}
