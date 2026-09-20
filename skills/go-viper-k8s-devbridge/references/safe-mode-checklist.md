# API-only safe-mode checklist

Apply this checklist to the actual startup call graph. Function names differ by project.

## Must remain enabled

- Viper configuration loading and environment overlays.
- Existing-database connections and generated query registration.
- Client construction required by request handlers.
- Stateless API manager and serializer initialization.
- The HTTP listener and only the API route modules audited for the current task.
- Normal side effects explicitly triggered by a developer's API request.

## Must be disabled at startup

- `CREATE DATABASE`, `CREATE EXTENSION`, `AutoMigrate`, schema upgrades, migration locks, constraint changes, index repair, and backfills.
- Demo/example seed writes, default-rule upserts, bucket creation, configuration persistence, and task recovery that marks shared tasks failed.
- Cron jobs, queue consumers, outbox relays, Redis subscribers, Kubernetes watchers, health repair loops, periodic reconciliation, and leader-like schedulers.
- Extra listeners such as gRPC when they are not part of the selected intercept.
- License/config polling whose callback repeatedly mounts or unmounts API routes. Mount routes directly only inside the explicit non-production mode.
- Legacy API manager constructors that start workers, task recovery, cron jobs, project seed data, or subscribers. Do not mount a complete API bundle until every constructor has been audited; prefer a minimal selected module.
- Expanded configuration logging after Pod environment values have been inherited. Log only a redacted mode summary.

## Database connection rule

Do not implement safe mode by merely skipping `AutoMigrate`. Existing connector helpers may create databases, extensions, schemas, indexes, or tables before returning a client. Refactor them so API-only mode directly opens the configured existing database and performs no DDL.

## Mounted files and Secrets

- Use mirrord `localwithoverrides` and explicit `read_only` patterns for required mounts.
- Include the ServiceAccount token directory and `/etc/resolv.conf` only when the service/Kubernetes client needs them.
- Do not copy Secret volumes with `kubectl cp`, write inherited credentials to `.env`, or print expanded configuration.
- Keep session state under the gitignored `.devbridge/` directory with mode `0600`.

## Request routing

- Use a random session ID in a fixed header such as `X-Dev-Route`.
- Inject it from a loopback frontend proxy only for configured service prefixes.
- Never accept an arbitrary URL/IP from the browser and never forward the selector to unrelated services.
- Verify the existing gateway preserves the header. If it strips the header, add an allowlisted, authenticated server-side mapping rather than a general-purpose proxy header.
- Header filtering is request-scoped, but a Service with multiple replicas can send a request to a Pod other than the selected mirrord target. Start with a one-replica development workload or introduce an explicit per-developer in-cluster relay.
- If automatic reattachment is enabled, record the concrete target Pod UID. Restart only after the original Pod is absent, terminating, or unready; never infer that an SSH error alone authorizes a second debug process.
- Cache only binaries and checksum-pinned runtime assets. Do not cache expanded Pod environment, inherited credentials, per-session route configuration, or Secret file contents.
