package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

const toolVersion = "0.3.0"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "devbridge:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return errors.New("a command is required")
	}
	if args[0] == "version" {
		fmt.Println("devbridge", toolVersion)
		return nil
	}
	if args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		usage()
		return nil
	}

	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	defaultConfig := os.Getenv("DEVBRIDGE_CONFIG")
	if defaultConfig == "" {
		defaultConfig = ".devbridge.yaml"
	}
	configPath := flags.String("f", defaultConfig, "project devbridge configuration")
	rootFlag := flags.String("root", "", "source worktree (defaults to configuration directory)")
	stateFlag := flags.String("state-dir", "", "session directory (defaults to <root>/.devbridge)")
	listen := flags.String("listen", "", "override loopback proxy address; port 0 allocates a free port")
	frontend := flags.String("frontend-url", "", "frontend URL for a combined worktree preview")
	previewListen := flags.String("preview-listen", "127.0.0.1:0", "combined preview listen address")
	managed := flags.Bool("managed", false, "stop and clean up when the parent closes stdin")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	absConfig, err := filepath.Abs(*configPath)
	if err != nil {
		return err
	}
	projectRoot := filepath.Dir(absConfig)
	if *rootFlag != "" {
		projectRoot, err = filepath.Abs(*rootFlag)
		if err != nil {
			return err
		}
	}
	stateDir := filepath.Join(projectRoot, ".devbridge")
	if *stateFlag != "" {
		stateDir, err = filepath.Abs(*stateFlag)
		if err != nil {
			return err
		}
	}

	switch args[0] {
	case "down":
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return down(ctx, stateDir)
	case "doctor", "up", "clean", "clean-cache":
		cfg, _, err := loadConfig(absConfig)
		if err != nil {
			return err
		}
		if *listen != "" {
			cfg.Gateway.Listen = *listen
			if err := cfg.validate(); err != nil {
				return err
			}
		}
		if args[0] == "doctor" {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			return doctor(ctx, cfg, projectRoot)
		}
		if args[0] == "clean-cache" {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			return cleanCache(ctx, cfg, projectRoot)
		}
		if args[0] == "clean" {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			return cleanOrphanedMirrordRules(ctx, cfg, projectRoot)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if *managed {
			go func() {
				_, _ = io.Copy(io.Discard, os.Stdin)
				stop()
			}()
		}
		return up(ctx, cfg, absConfig, projectRoot, stateDir, *frontend, *previewListen)
	default:
		usage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `Usage:
  devbridge doctor [-f .devbridge.yaml]
  devbridge up     [-f .devbridge.yaml]
  devbridge down   [-f .devbridge.yaml]
  devbridge clean  [-f .devbridge.yaml]
  devbridge clean-cache [-f .devbridge.yaml]
  devbridge version

Managed worktree previews:
  devbridge up -f /project/.devbridge.yaml -root /worktree \
    -state-dir /project/.automaker/previews/wt-id.devbridge \
    -listen 127.0.0.1:0 -frontend-url http://node:32001 -preview-listen 0.0.0.0:0

"up" builds the local Go source, runs it on the configured SSH development
host in the selected Kubernetes workload context, and starts a loopback gateway
proxy that adds a per-session request selector.`)
}
