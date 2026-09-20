package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBuildCacheKeyChangesWithSource(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "go.mod"), "module example.test/cache\n\ngo 1.23\n")
	mainPath := filepath.Join(root, "main.go")
	writeTestFile(t, mainPath, "package main\nfunc main() {}\n")
	runTestCommand(t, root, "git", "init", "-q")
	runTestCommand(t, root, "git", "add", "go.mod", "main.go")

	cfg := &config{}
	cfg.App.Build = []string{"go", "build", "-o", "{{output}}", "."}
	first, err := buildCacheKey(context.Background(), cfg, root)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, mainPath, "package main\nfunc main() { println(\"changed\") }\n")
	second, err := buildCacheKey(context.Background(), cfg, root)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("build cache key did not change after a source change")
	}
}

func TestBuildCacheStoreAndRestore(t *testing.T) {
	root := t.TempDir()
	output := filepath.Join(t.TempDir(), "app")
	writeTestFile(t, output, "binary-content")
	sha, err := fileSHA256(output)
	if err != nil {
		t.Fatal(err)
	}
	artifact := &buildArtifact{Path: output, SHA256: sha}
	key := "0123456789abcdef"
	if err := storeCachedBuild(root, key, "app", artifact); err != nil {
		t.Fatal(err)
	}
	restoredPath := filepath.Join(t.TempDir(), "restored-app")
	restored, hit, err := restoreCachedBuild(root, key, "app", restoredPath)
	if err != nil {
		t.Fatal(err)
	}
	if !hit || !restored.CacheHit || restored.SHA256 != sha {
		t.Fatalf("unexpected restored artifact: hit=%v artifact=%+v", hit, restored)
	}
	data, err := os.ReadFile(restoredPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "binary-content" {
		t.Fatalf("restored content = %q", data)
	}
}

func TestLocalReplacementDirs(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "go.mod"), `module example.test/cache

replace (
	example.test/one => ../one
	example.test/versioned => example.test/versioned v1.2.3
)
replace example.test/two => /tmp/two
`)
	paths, err := localReplacementDirs(root)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"/tmp/two": true,
		filepath.Clean(filepath.Join(root, "../one")): true,
	}
	if len(paths) != 2 || !want[paths[0]] || !want[paths[1]] || paths[0] == paths[1] {
		t.Fatalf("unexpected replacement paths: %#v", paths)
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func runTestCommand(t *testing.T, dir, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s failed: %v: %s", name, err, output)
	}
}
