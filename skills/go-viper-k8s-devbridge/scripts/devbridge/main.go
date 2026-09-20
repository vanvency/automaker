package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
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
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	absConfig, err := filepath.Abs(*configPath)
	if err != nil {
		return err
	}
	projectRoot := filepath.Dir(absConfig)

	switch args[0] {
	case "down":
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return down(ctx, projectRoot)
	case "doctor", "up", "clean", "clean-cache":
		cfg, root, err := loadConfig(absConfig)
		if err != nil {
			return err
		}
		if args[0] == "doctor" {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			return doctor(ctx, cfg, root)
		}
		if args[0] == "clean-cache" {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			return cleanCache(ctx, cfg, root)
		}
		if args[0] == "clean" {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			return cleanOrphanedMirrordRules(ctx, cfg, root)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return up(ctx, cfg, absConfig, root)
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

"up" builds the local Go source, runs it on the configured SSH development
host in the selected Kubernetes workload context, and starts a loopback gateway
proxy that adds a per-session request selector.`)
}
