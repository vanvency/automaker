package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestIsolateGoBuildModule(t *testing.T) {
	root := t.TempDir()
	session := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.test/app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "go.sum"), []byte("example.test/mod v1.0.0 h1:test\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := isolateGoBuildModule([]string{"go", "build", "-o", "/tmp/app", "."}, root, session)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"go", "build", "-mod=mod", "-modfile=" + filepath.Join(session, "devbridge.mod"), "-o", "/tmp/app", "."}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
	for _, name := range []string{"devbridge.mod", "devbridge.sum"} {
		info, err := os.Stat(filepath.Join(session, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %o, want 600", name, info.Mode().Perm())
		}
	}
}

func TestIsolateGoBuildModuleLeavesOtherCommandsAlone(t *testing.T) {
	args := []string{"make", "build", "OUTPUT={{output}}"}
	got, err := isolateGoBuildModule(args, t.TempDir(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, args) {
		t.Fatalf("args = %#v, want %#v", got, args)
	}
}
