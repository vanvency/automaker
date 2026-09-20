# Automaker workflow review (2026-09-20)

Scope: the complete uncommitted Herdr/Pi, Jira orchestration, worktree preview,
acceptance/delivery, task archive/consolidation and board UI changes on top of
`3316e9dd`.

## Review corrections

- Do not resume a sibling's Pi transcript when a worktree contains a single
  nonmatching session. Non-Pi execution session IDs remain separate from the
  Herdr Pi viewer session.
- Validate both project and requested execution directory before Herdr dispatch.
- Conflict repair runs in the owning task's worktree, and ownership is restricted
  to actual children rather than unrelated tasks modifying the same repository.
- Automatically verified tasks have a human acceptance entry before Complete.
  Non-Jira local tasks do not require GitLab MR metadata.
- Identify the root delivery repository from the MR URL, not free-form receipt
  labels. Deduplicate equivalent MR URLs and merge subprojects before the root.
- Include staged submodule edits in change review. Accumulate newest-first task
  commits in chronological order when expanding gitlink changes.
- Migration scripts preserve dirty checkouts, divergent submodule histories and
  source conflicts; a refused worktree removal never falls back to recursive
  directory deletion.
- Permission failure tests inject EACCES instead of assuming a non-root runner;
  interrupted tasks remain visible in Needs Attention after a run finishes.

- Decomposition dispatch resolves the assigned worktree; edited approvals are
  parsed into the task list that Jira actually creates, and managed synchronization
  processes human-approved splits without the retired legacy timer.
- Pi honors explicit tool allowlists (including no tools), and read-only queries
  cannot invoke shell/edit/write tools.
- Task IDs distinguish Herdr tabs even when display titles are identical or
  truncated; persisted tab ownership is checked before reuse. A new run invalidates earlier human acceptance. Insufficient-output
  runs emit failed completion events instead of firing success hooks.

## Validation

- Full Vitest suite: 4,029 passed (plus the final tab-ownership regression: 34 targeted tests passed), 23 skipped (existing conditional suites).
- Python scripts: 138 passed.
- Go devbridge: `go test ./...` passed.
- Shared packages and server build; UI typecheck and production build passed.
- Lockfile validation and whitespace checks passed.
- Actual MR merges, Jira transitions, deployments and migration execution are not
  performed by this review. Their external mutations are covered with mocks.

`codex review --uncommitted` is run before and after the corrections. Review
findings are checked against the implementation and covered by regression tests.

Final targeted Codex follow-up: fixes verified; no remaining concrete defects in
the listed corrections. The final Pi tool restriction regression (27 tests) and
Herdr tab ownership regression (34 tests) passed after the full-suite run.
