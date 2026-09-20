---
name: go-viper-k8s-devbridge
description: Set up and validate safe, request-scoped local debugging for Go services that load config.yaml or app.yaml through Viper and depend on Kubernetes-only DNS, environment variables, mounted Secrets, databases, and internal services. Use when a developer wants one-command debugging against a shared non-production cluster without replacing a Deployment image or globally changing gateway routes.
---

# Go Viper Kubernetes Devbridge

Use the bundled `devbridge` tool to build local Go source, execute it on an SSH development host through mirrord in a selected workload's Kubernetes context, and route only one developer session's HTTP requests to it.

## Workflow

1. Inspect repository instructions, Git status, the Viper initialization path, Deployment/container configuration, public gateway prefix, and startup functions. Preserve unrelated changes and never put developer credentials or cluster overrides into the tracked application YAML.
2. Read [safe-mode-checklist.md](references/safe-mode-checklist.md). Implement an opt-in API-only environment flag before attempting a live session. The flag must be read outside Viper's config-file key set so it cannot be accidentally persisted in `config.yaml`.
3. Copy [devbridge.example.yaml](assets/devbridge.example.yaml) to the repository root as `.devbridge.yaml`, then fill in the SSH alias, namespace, workload/container target, public gateway URL, service prefix, build command, ports, Viper environment prefix, and required mounted-file paths. Include `KUBERNETES_*` when the service constructs an in-cluster Kubernetes client. Never put Secret values in this file.
4. Add `.devbridge` to `.gitignore`. If the skill is installed at the repository-standard path, copy [devbridge-wrapper.sh](assets/devbridge-wrapper.sh) to `scripts/devbridge`; otherwise adjust only `skill_dir` in that wrapper.
5. Run `scripts/devbridge doctor`. Resolve every failing precondition before `up`. Treat missing Pod creation permission, missing container runtime access, an unreachable gateway, a multi-replica target, or a production context as explicit review points. Enable `recovery.auto_reattach` only for a one-replica Deployment target.
6. Run `scripts/devbridge up`. Wait for the API-only readiness endpoint. Configure the local frontend's gateway target to the printed loopback proxy, normally `http://127.0.0.1:18080`. If the browser-facing frontend path contains a public prefix such as `/gateway`, set `gateway.strip_prefix` so the proxy removes it before matching `route_paths` and forwarding upstream. The proxy injects the session selector only for allowlisted service prefixes.
7. Verify the routing matrix: no selector reaches the shared service, a wrong selector reaches the shared service, the generated selector reaches the developer process, and other service prefixes never receive the internal selector. Exercise WebSocket, gRPC, uploads, or streaming separately when the project uses them.
8. Stop with Ctrl-C and run `scripts/devbridge down` if cleanup was interrupted. Confirm the mirrord agent Pod and `/tmp/devbridge-*` session directory are gone and the shared Deployment image/replicas were never changed. If an exited agent leaves `MRDIN_*`/`MRDSTD_*` rules and the target returns connection refused, first prove that no mirrord agent Pod or Job is active, then run `scripts/devbridge clean`; it removes only those orphaned chains from the single Ready Deployment Pod. Keep caches across normal sessions; use `scripts/devbridge clean-cache` only for explicit invalidation or disk cleanup.

## Tool boundaries

- The bundled source is under `scripts/devbridge`; run its unit tests with `go -C <skill-dir>/scripts/devbridge test ./...`.
- For a `go build` command, the tool resolves modules against session-local `devbridge.mod` and `devbridge.sum` copies. It never lets build-time module resolution edit the project's tracked `go.mod` or `go.sum`.
- When both hosts provide `zstd`, the tool compresses the application binary at level 1 for transfer and expands it in the isolated remote session directory. It transparently falls back to a raw upload otherwise.
- For `go build`, the tool caches the final binary from the build command, Go toolchain/CGO settings, the project worktree, and local `replace` repositories. It caches zstd output by binary SHA-256 and verified remote runtime/application files by checksum. Session cleanup does not remove these caches.
- With `recovery.auto_reattach`, the tool records the selected Pod UID. It reattaches only after that Pod is gone, terminating, or unready; it refuses to create a possible duplicate when the original target remains healthy.
- `devbridge` supports Linux amd64 remote execution in v1. It downloads checksum-pinned mirrord client/layer artifacts with resumable `wget` or `curl` when available, and preloads the pinned agent image when the development host cannot pull it.
- The generated mirrord config sets explicit agent CPU and memory requests/limits. Do not rely on mirrord's small default memory limit for traffic-stealing sessions; an OOM-killed agent can leave redirection rules in the target Pod until `scripts/devbridge clean` runs.
- Mounted Secrets stay remote and read-only through filesystem interception. The tool does not export Secret values or generate local environment files.
- The browser never supplies an upstream URL. Its requests go through a loopback proxy; a random route ID is mapped to the configured workload and removed from unrelated prefixes.
- Use this only in an authorized non-production namespace. Mirrord's agent needs privileged Pod capabilities and suitable RBAC.

## Adapting another Go service

Keep the tooling generic and make project-specific safety changes in the service. For a Viper environment prefix such as `FOO`, prefer a dedicated flag like `FOO_DEVBRIDGE_API_ONLY=true`. In that mode, initialize clients and API managers needed by request handlers, but suppress startup-time mutations and background ownership. Add a readiness endpoint that exists only in API-only mode and echoes `DEVBRIDGE_ROUTE_ID` in `X-Devbridge-Route` so `devbridge up` can prove that traffic reached the intended process.

Do not claim completion based only on a successful mirrord probe. Build and start the actual service, inspect logs for forbidden startup actions, call one real read endpoint through the public gateway, and verify cleanup.
