# Platform audit — 21 September 2026

The tested core workflows work, but the repository does **not** currently have a green end-to-end quality gate. Most browser failures come from tests that still expect older navigation and controls. Live Jira, model execution, remote delivery, and cluster deployment were not certified by this audit.

## Scope and isolation

- Baseline: commit `f88f1cb4`, plus working-tree changes captured at the start of the audit.
- Deployed address: `http://172.16.251.159:3007/`.
- Unit, Python, lint, and type checks ran against the working tree. Builds and browser workflows ran in a separate checkout under `/tmp/automaker-audit-20260921/repo`.
- Browser tests used separate application data, disposable projects, and ports 3417/3418 and 3427/3428. The production application was not rebuilt or restarted.
- Source edits to the preview/devbridge integration continued during the audit. Results describe the captured versions, not changes made after those checks.
- No production Jira issues, merge requests, task states, or preview deployments were changed.

## Check results

| Check                            | Result                                         | Qualification                                                                                                           |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| TypeScript unit tests            | **4,071 passed; 23 skipped**                   | 219 test files; no failing executed tests.                                                                              |
| UI unit tests                    | **498 passed**                                 | Included in the TypeScript total.                                                                                       |
| Server unit tests                | **2,843 passed; 23 skipped**                   | Included in the TypeScript total.                                                                                       |
| Shared-package tests             | **730 passed**                                 | Included in the TypeScript total.                                                                                       |
| Python workflow tests            | **145 passed**                                 | All discovered `scripts/test_*.py` tests.                                                                               |
| Go devbridge tests               | **Passed**                                     | `go test ./...` in the devbridge module.                                                                                |
| UI TypeScript check              | **Passed**                                     | `npm run typecheck`.                                                                                                    |
| Shared-package and server builds | **Passed**                                     | Built in the isolated checkout.                                                                                         |
| UI production build              | **Passed**                                     | Built in the isolated checkout; includes Electron entry compilation, not desktop packaging.                             |
| Server lint                      | **Passed**                                     | Error-level check.                                                                                                      |
| UI lint                          | **Failed: 9 errors**                           | Missing browser globals in ESLint configuration.                                                                        |
| Lockfile check                   | **Passed**                                     | Checks prohibited Git SSH URLs, not dependency vulnerabilities.                                                         |
| Existing Playwright suite        | **43 passed; 28 failed; 2 skipped; 1 not run** | 74 cases across 25 files.                                                                                               |
| Diagnostic Playwright rerun      | **19 passed; 4 failed**                        | 23 affected cases; navigation/selectors adjusted only in the audit copy. This does not make the checked-in suite green. |
| Page/settings smoke checks       | **53 checked; no page JavaScript exceptions**  | 52 stayed on their requested route; `/overview` intentionally redirects to `/worktrees`.                                |
| Current task workflow            | **6 checks passed**                            | Create, Reply dialog, human Verify, Logs, archive validation, and restore.                                              |
| Deployed UI/API health           | **Passed**                                     | UI and direct/proxied health endpoints return HTTP 200.                                                                 |
| Deployed authentication boundary | **Passed for checked endpoints**               | Direct/proxied `/api/settings/status` return HTTP 401 without authentication.                                           |

The first full browser run used installed Chromium build 1228 with Playwright 1.57. The diagnostic rerun used the matching Chromium build 1200. Failures were investigated against source and page snapshots; they were not classified solely from timeouts.

## Findings

### 1. Browser tests are out of sync with current product behavior

The original 28 failures fall into these groups:

| Group                          | Failures | Evidence                                                                                                           |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| Logs button selector           | 17       | Tests search for `view-output-verified-*`; the visible card still has a working **Logs** button.                   |
| Former project overview        | 6        | `/overview` redirects to Work Board; tests expect `overview-view` and the old Dashboard navigation item.           |
| Homepage startup behavior      | 2        | Tests expect startup to open the board, or omit `home-view` from the accepted loaded states.                       |
| Human verification             | 1        | Test expects the old `mark-as-verified-*` button. Current flow is **Verify → acceptance dialog → confirm Verify**. |
| Agent/model selection          | 1        | Test searches for Claude Opus before choosing Claude in the new agent selector.                                    |
| Deep-linked output description | 1        | Output modal opens, but the test waits for a description element that no longer exists.                            |

Diagnostic adjustments preserved application code and used the current controls. Human verification, Claude thinking-level persistence, startup settings preservation, logout preservation, board-background restoration, and 13 of 14 responsive modal cases passed.

**Recommended action:** update the checked-in E2E tests and shared selectors to match the current workflows. Prefer accessible names scoped to a task card. Keep explicit assertions for task identity and persistence.

Relevant files:

- `apps/ui/tests/features/responsive/agent-output-modal-responsive.spec.ts`
- `apps/ui/tests/features/success-log-contrast.spec.ts`
- `apps/ui/tests/features/feature-manual-review-flow.spec.ts`
- `apps/ui/tests/features/opus-thinking-level-none.spec.ts`
- `apps/ui/tests/features/feature-deep-link.spec.ts`
- `apps/ui/tests/projects/overview-dashboard.spec.ts`
- `apps/ui/tests/projects/board-background-persistence.spec.ts`
- `apps/ui/tests/settings/settings-startup-sync-race.spec.ts`

### 2. Agent Output no longer displays the task description

The modal header in `apps/ui/src/components/views/board-view/dialogs/agent-output-modal.tsx` displays the generic **Agent Output** title and view controls. It does not render the former task-description element.

After fixing the Logs selector in the audit copy, four diagnostic tests still failed at description assertions. Logs and view controls rendered successfully. The original deep-link test fails for the same missing description.

**Impact:** users inspecting a deep link have less visible task context, and tests cannot verify the selected task using the old description.

**Recommended action:** decide whether the modal should show task title/key/description. If omission is intentional, verify task identity through the current UI/API contract instead of retaining dead description selectors.

### 3. The Overview entry is misleading

`apps/ui/src/components/views/dashboard-view.tsx` still exposes **Overview** / **Projects Overview**. Its target `/overview` redirects to `/worktrees` in `apps/ui/src/routes/overview.tsx`.

**Impact:** clicking the entry opens Work Board rather than the former aggregate project dashboard. The redirect is explicit in source, not a browser crash.

**Recommended action:** rename the entry to Work Board if that is the intended replacement, or restore a separate overview route if aggregate project statistics remain a supported feature.

### 4. UI lint blocks the quality gate

Nine `no-undef` errors remain:

- `kanban-card.tsx:287`: `Node`.
- `recent-worktrees.test.ts`: `Storage` and `DOMException` across eight references.

The UI ESLint configuration enumerates browser globals manually and omits these names. Type checking and unit tests pass, so these errors do not by themselves establish runtime defects.

**Recommended action:** align `apps/ui/eslint.config.mjs` with the browser environment and TypeScript linting conventions.

### 5. Test isolation and coverage need attention

- `apps/ui/scripts/setup-e2e-fixtures.mjs` writes to `apps/server/data/settings.json` using a fixed workspace-relative path. Running the ordinary pretest script in a live checkout can overwrite that checkout's settings. This audit used a separate checkout.
- Twenty-two MCP SDK transport tests are skipped. One deprecated Claude usage test is skipped.
- Profile creation and list-priority browser tests are explicitly skipped.
- The original logout-preservation test did not run because the preceding serial test failed. It passed in the diagnostic rerun.
- `libs/spec-parser` builds, but has no standalone test project discovered by the root Vitest configuration. Related server spec-parsing tests pass.

**Recommended action:** make E2E data paths explicit and isolated by default, then restore skipped coverage where the feature remains supported.

## Feature coverage

“Page checked” means the view loaded without an uncaught JavaScript exception. It does not mean every action or external integration on that page was exercised.

| Feature area                   | Evidence                                                                                     | Remaining limit                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Home and navigation            | Root page, project entry points, all main routes checked                                     | Homepage content remains Chinese; the audit and report are in English.                    |
| Project creation/opening       | Existing E2E cases pass                                                                      | Desktop native file-picker behavior not exercised.                                        |
| Task creation/editing          | Existing E2E cases pass                                                                      | Large-scale task volume not load-tested.                                                  |
| Kanban and task states         | Unit tests, running-card E2E, current human Verify workflow pass                             | Full real-agent execution across every lane not run.                                      |
| Planning and dependencies      | Resolver/orchestrator tests; planning-selector E2E passes                                    | No live model-generated plan approved or executed.                                        |
| Reply and Conversation         | Reply dialog checked; Herdr service/provider/reattach tests pass                             | No live task prompt sent; native Herdr/Pi session continuity not certified.               |
| Task logs and deep links       | Logs open; deep link opens modal; responsive diagnostic checks mostly pass                   | Missing description and stale assertions documented above.                                |
| Archive and restore            | Invalid archive rejected; valid archive retains files; restore preserves verified status     | External duplicate cleanup not executed.                                                  |
| Work Board and Git operations  | Page checked; Git/worktree service and route tests pass                                      | No real remote push, merge, rebase, or PR creation.                                       |
| Jira import/sync/decomposition | Settings page checked; Python and server sync/decomposition tests pass                       | No live Jira import, polling dispatch, comment writeback, or workflow transition.         |
| GitLab completion              | Completion/conflict/progress/merge unit tests pass                                           | No real MR merged, Jira issue closed, or preview released.                                |
| Preview environments           | Preview service tests and Go tests pass                                                      | No cluster build/deployment; concurrent devbridge work requires its own final validation. |
| Acceptance evidence            | Evidence service, route, and UI tests; human confirmation checked                            | No new real application screenshots generated as delivery evidence.                       |
| Agent providers and models     | Provider tests pass; all seven provider panels load; Claude thinking-level diagnostic passes | No paid model execution; authentication and quotas not certified for every provider.      |
| Running agents/notifications   | Pages and related tests checked                                                              | Cross-process delivery under sustained load not tested.                                   |
| Context files/images           | Nine context E2E cases pass                                                                  | External model-based image description not exercised.                                     |
| Memory                         | Desktop memory E2E and page check pass                                                       | Long-running memory-generation behavior not exercised.                                    |
| Spec and ideation              | Pages, parsing/resolver/prompt tests checked                                                 | Live spec generation and ideation runs not started.                                       |
| Graph and file editor          | Pages checked; relevant state/logic tests pass                                               | Full editing and graph interactions not covered by this browser suite.                    |
| Terminal                       | Page checked; terminal-related unit coverage passes                                          | Interactive production shell commands not sent.                                           |
| Global/project settings        | 24 global settings panels and 9 project panels checked; event-hook E2E cases pass            | Real webhook delivery and provider credential changes not performed.                      |
| GitHub Issues/PRs              | Pages show the fixture's missing-remote condition without crashing                           | Fixture has no GitHub remote; real authenticated issue/PR operations unverified.          |
| Similar Works                  | Page and consolidation service tests checked                                                 | No external issue/MR cleanup applied.                                                     |
| Authentication/security        | Unit checks and selected live unauthenticated rejection checks pass                          | Not a penetration test or a dependency-vulnerability audit.                               |
| Electron/Docker                | Electron entry compilation succeeds                                                          | No packaged desktop launch, platform installer, or container deployment test.             |

## Evidence and reproduction

Audit artifacts are stored locally under `/tmp/automaker-audit-20260921/`:

- `vitest.json`: individual TypeScript test results.
- `python.log`, `go.log`: auxiliary workflow tests.
- `typecheck.log`, `ui-lint.log`, `server-lint.log`, `lockfile.log`: static checks.
- `build-server.log`, `build-ui.log`: successful isolated builds.
- `playwright.json`: original 74-case suite results.
- `playwright-diagnostic.json`: 23-case diagnostic rerun results.
- `smoke.json`: 53 route/panel checks, including HTTP failures.
- `task-flow.json`: six current-workflow checks.
- `smoke.cjs`, `task-flow.cjs`: runnable browser checks against the disposable audit services.
- `repo/apps/ui/test-results/`: diagnostic failure screenshots and page snapshots.

The artifacts are temporary local files, not committed credentials or production data. Preserve them elsewhere if long-term retention is required.

Commands used for the main checks:

```bash
npm run test:unit -- --maxWorkers=4
python3 -m unittest discover -s scripts -p 'test_*.py'
npm run typecheck
npm run lint:errors
npm run lint:server:errors
npm run lint:lockfile
```

Builds and Playwright should be reproduced in an isolated checkout with test-specific `DATA_DIR`, `TEST_PORT`, and `TEST_SERVER_PORT`. Do not run the fixture-reset script against the active application's data.

No application fixes or production deployment changes were made as part of this audit.
