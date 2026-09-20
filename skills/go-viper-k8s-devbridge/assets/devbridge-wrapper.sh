#!/usr/bin/env sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
skill_dir="$repo_dir/.agents/skills/go-viper-k8s-devbridge"

export DEVBRIDGE_CONFIG="$repo_dir/.devbridge.yaml"
exec go -C "$skill_dir/scripts/devbridge" run . "$@"
