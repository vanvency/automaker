# Jira → Automaker → GitLab

> 新入口：项目设置中的 [Jira 同步](./jira-sync-settings.md) 可配置、预览并接管本页的
> 旧定时任务。迁移后 `managed-by-automaker.json` 禁止旧 poller 再次运行。
> 下文保留旧脚本和历史运维说明；新同步不运行旧的卡片状态修复逻辑。

This host polls Jira every five minutes using the existing authenticated `jira` CLI.
It selects unresolved AIP issues labeled `dodo` or `kaka`. `dodo` tasks are prepared
and started automatically. `kaka` tasks are prepared into the Automaker backlog but
wait for a human to start them; the monitor never auto-runs them. Codex implements
each started issue through Automaker, tests the changes, and opens MRs targeting `dev`
in the affected repositories under `/workspace/vibe-llmops`. Cross-project changes
have separate subproject MRs and a root gitlink MR when necessary. MRs are left for
review, never auto-merged.

The monitor dispatches one issue at a time and waits if Automaker is already busy.
Each issue has a deterministic feature ID and a durable claim written before work
starts. Failed or uncertain dispatches are recorded as blocked, not automatically
replayed. Existing user checkouts are preserved using dedicated Git worktrees.

## Issue scope: Jira subtasks win, no automatic decomposition

An issue that already carries **Jira subtasks** is not decomposed again. The subtasks
are the unit of work: the dispatched feature implements all of them in its single
worktree and on its single branch, producing one reviewed MR set for the parent key.
The prompt lists every subtask (key, type, status, summary) and forbids creating
Automaker child features. Subtasks are also dropped from the sweep when their parent is
queued in the same tick, so they cannot be dispatched a second time as their own task.

Parent-level issues **without** Jira subtasks are no longer auto-split: the run stops
and asks the reporter for an explicit decision (see below).

Epics and Stories **without** Jira subtasks are **never decomposed automatically**.
Jira remains the single source of truth for the split, so the dispatched run stops
before writing any code and files a `needs_input` receipt asking the reporter to either
split the issue into Jira subtasks (recommended) or explicitly approve an
Automaker-side split. The monitor relays that question to Jira and resumes the run with
the answer; it never creates `-child-N` features on its own. Creating those children is
a manual action.

### Branch names

The branch prefix follows the Jira issue type, so a branch says what kind of work it
carries, and the key makes it stable for the life of the issue:

| Jira issue type                                           | Branch             |
| --------------------------------------------------------- | ------------------ |
| Epic                                                      | `epic/aip-114907`  |
| Story                                                     | `story/aip-114974` |
| Improvement                                               | `impr/aip-...`     |
| Bug, Defect, Hotfix                                       | `bugfix/aip-...`   |
| Task, Backend-Task, Frontend-Task, QA-Task, ALG-Task, ... | `task/aip-...`     |

The worktree directory uses the same prefix (`.worktrees/story-aip-114974`). Map any
type differently with `branchPrefixes` in the config, for example
`{"branchPrefixes": {"story": "userstory"}}`. Set `branchIncludeLabel` to `true` to
keep the dispatch label in the name (`story/aip-114974-dodo`); it is off by default
because the label is routing metadata that can change while the issue stays the same.

### Subtasks on the card

A dispatched issue that already has Jira subtasks carries them on the feature as
`jiraSubtasks` (key, summary, Jira status, type). The card renders a **Jira 子任务 N**
block with progress and one Jira link per subtask, so the covered scope stays visible
after the separate subtask cards are collapsed. That block is independent of the
existing **子任务** block, which tracks Automaker child features of a decomposed Epic.

### Worktree type badge

Every dispatched card also carries `jiraType` - the normalized Jira work type
(`epic` / `story` / `feat` / `impr` / `bugfix` / `task`). The board renders it as a
badge on the card and next to the branch in the worktree switcher, so a legacy
`jira/<key>-<label>` branch still makes its type obvious without being renamed.
Backfill the field on cards that predate it:

```bash
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --backfill-jira-type [--apply]
```

The field is derived from the Jira issue type, so it is set on every future dispatch
and only needs the backfill for cards created earlier.

### Labels on the card

Cards also carry `jiraLabels` (the issue's Jira labels). The board hides the queue
labels (`kaka` / `dodo`) - the category chip `Jira AIP / dodo` was redundant next to the
type badge - but renders every `release-*` label as its own badge, so the release an
issue is planned for stays visible. The list view shows the same Jira metadata instead
of the raw agent prompt that the feature `description` holds.

`--backfill-jira-meta` (alias `--backfill-jira-type`) writes both the work type and the
labels onto existing cards:

```bash
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --backfill-jira-meta [--apply]
```

### Refreshing card instructions

The agent prompt lives in each card's `description`, so prompt changes do not reach
cards that were already dispatched. `--refresh-descriptions` rebuilds the instruction
text of every existing card from its current Jira issue with the current
`task_description()` rules, keeping the card's own branch, worktree and imported Jira
context header. The reviewable plan is a dry run by default:

```bash
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --refresh-descriptions [--apply]
```

It reuses `task_description()` and the shared `delivery_directive()` contract, so a
refreshed card reads exactly like a newly dispatched one. Legacy `-child-N` cards are
skipped: their description is their own scope, not the parent prompt. Automaker keeps
the previous text in `descriptionHistory`, and re-running the command is idempotent.

### MR reviewer

Dispatched issues usually have a Jira assignee, and that person reviews the MRs. The
monitor resolves the assignee account against GitLab (`gitlabTokenFile`, default
`/root/gitlab-token`) and writes the requirement into the prompt: set
`reviewer_ids: [<id>]` on the merge request. GitLab 15.0.2 has no
`merge_request.reviewer` push option, so the reviewer is always set over REST - the
same call the agent already uses for the draft title. When the assignee cannot be
mapped to a GitLab user, the prompt says so and the receipt must record it as a
blocker instead of claiming a clean delivery.

Add `reviewerOverrides` to the config when a Jira account has no matching GitLab
username (the login is the key):

```json
"reviewerOverrides": { "kai.wang": "gitlab-username" }
```

## One-off remediation (historical — do NOT run routinely)

> **These passes are not part of routine operations.** They fix data created by
> older dispatch rules and are destructive (they delete cards, rename branches,
> move commits, close merge requests or discard uncommitted changes). Run one only
> when a specific incident calls for it, always dry-run first, and only with
> explicit approval. Normal monitoring needs none of them — see
> [Operations](#operations).

### Re-aligning already scanned tasks

Tasks that were scanned before this rule can be realigned:

```bash
# dry run: print the plan, change nothing
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --reconcile-subtask-scope

# apply: rewrite descriptions, drop never-started auto-split children, restore parents
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --reconcile-subtask-scope --apply
```

The pass touches issues that have Jira subtasks: it rewrites their feature description
to the current rule, deletes auto-created `-child-N` features that never left
`backlog`, and moves a decomposed parent back to `backlog` so it can be run again
(children that already started are kept and reported instead). It takes the same
`monitor.lock` as the poller, so it never runs concurrently with a tick.

Two more one-off passes exist for tasks scanned under older rules:

```bash
# branch names: jira/<key>-<label> -> <type-prefix>/<key> (never-started, unpushed only)
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --reconcile-branch-names [--apply]

# duplicated subtask cards whose parent already delivers them in one worktree
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --collapse-subtask-cards [--apply]

# worktrees and local-only branches left behind by that collapse
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --prune-collapsed-worktrees [--apply]
```

`--reconcile-branch-names` renames the branch from inside its worktree, moves the
worktree directory and rewrites the feature description (which embeds the branch name);
each entry is all-or-nothing, and branches that were pushed, worktrees with local
changes and tasks that already started are skipped and reported. Add
`--include-started` to also rename tasks that already ran, which is allowed only while
the branch was never pushed, the worktree is clean and the receipt reports no MR (an MR
keeps pointing at the old branch name, so those are never renamed).

`--collapse-subtask-cards` deletes only cards that never started and whose branch was
never pushed; anything with an MR or existing work is kept and reported. The parent
issue is the deliverable for those subtasks. `--prune-collapsed-worktrees` then removes
their checkouts and local-only branches, again skipping anything dirty or pushed.

### Child worktree / MR consolidation (already applied, 2026-09)

Before `worktreeScope: epic` and the `[task-key]` commit convention existed, every
Jira issue was dispatched with its own worktree, branch and MR, so subtasks drifted
away from their parents. Three standalone passes cleaned that up and are kept only for
audit and re-runs:

```bash
# 1) cherry-pick child commits onto the parent branch, prefix each commit subject
#    with the child key, remove the child worktree (child branch kept + tagged)
python3 scripts/migrate-child-worktrees.py --config data/jira-monitor/config.json [--apply]

# 2) finish what pass 1 skipped: resolve submodule-pointer conflicts (descendant
#    wins, divergent takes the newer commit and is reported), discard uncommitted
#    child changes, re-point children that never committed
python3 scripts/finish-child-worktree-migration.py --config data/jira-monitor/config.json [--apply]

# 3) create/reuse one draft MR per parent branch and close the old child-branch MRs
python3 scripts/reconcile-child-merge-requests.py --config data/jira-monitor/config.json [--apply]
```

All three default to a dry run. Every removed child branch is kept on disk and tagged
`backup/<branch>-<timestamp>`. The incident they fixed must not recur because the
dispatcher now anchors every subtask on its root ancestor (`worktreeScope: epic`), the
prompt requires the `[task-key]` commit prefix, and the board folds subtask cards into
their parent card. A regression shows up as a subtask feature that owns a worktree
again — report it as a bug instead of re-running these passes.

## Hierarchy import: execute at the task level

> 本节仅适用于显式 CLI 层级导入。Automaker 正常同步使用独立的父任务交付规划器，
> 不调用这里的层级展开，不自动授权拆分。设置页的高级参数通过
> `--project-settings <project>/.automaker/settings.json` 读取。

The rules above are the _delivery_ policy of the poll loop. When product wants every
Jira task on the board instead of one card per parent issue, import the hierarchy:

```bash
# read-only plan: what would be imported for this key
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --plan-jira-tree AIP-115009

# same plan, actually created (stays dry-run without --apply)
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --import-jira-tree AIP-115009 --apply
```

Resolution follows Jira itself: a story points at its epic through the classic
Epic Link field (`customfield_10007`, override with `epicLinkField`), and a task is a
Jira subtask whose `parent` is its story. The execution unit is the **task**; the epic
and story are imported as context, never as extra scope.

- One card per task, id `jira-<label>-<key>`, with `parentJiraKey` (story),
  `epicJiraKey` (epic), `issueType` and `jiraContext` written onto the feature.
- The task prompt opens with a compact lineage block (epic, story, task keys and
  summaries plus a story excerpt); the full epic/story/task requirements are written to
  `.automaker/jira/<featureId>/context.md` in the worktree, and `jiraContext.version`
  changes whenever an ancestor is edited, so stale context is visible.
- Dependencies are imported, not inferred: tasks of one story follow the Jira subtask
  order, and a story that `is blocked by` another story makes each of its tasks depend
  on the blocker's last task. Blockers outside the import are reported as notes.
- `worktreeScope` in the config decides the branch: `story` (default) keeps one
  worktree/branch/MR per story, `epic` makes every story of the epic share the epic
  worktree. Existing cards are reused, so the original branch naming is preserved.
- A story (or epic) that Jira has **not** split imports as a single card with
  `planningMode: "full"`; its prompt explicitly authorizes decomposition, which is the
  one case where the system may split the work itself.

Issues the agent already decomposed keep that split. `<key>-child-N` cards are the
agent's own breakdown, so a Jira subtask tree added afterwards (typically
frontend/backend/QA slices that do not line up with those children) is **not**
imported: the import reports those keys as notes and leaves the existing child cards
as the execution units.

Set `keepAgentSplit: false` (the default in this deployment) to drop that legacy split
instead: the Jira hierarchy wins and the old `<key>-child-N` cards are retired.
Legacy `<key>-child-N` cards still on the board get the same delivery contract that
`task_description()` embeds: `scripts/run-all-features.py` appends it before dispatch
when the description does not already carry it.

## Execution unit

`executionUnit` decides what one explicit hierarchy-import card covers, not the normal sync policy:

- `story` (default): one card per Jira **story**. Its Jira subtasks are listed on the
  card as the scope to implement in that one worktree/branch - no task-level cards.
  Stories of an epic are linked to it through `parentJiraKey`, so the epic card is the
  container and the story is the smallest execution unit.
- `task`: the older behaviour, one card per Jira subtask (frontend/backend/QA slices).

The import reuses the label of an existing card for the same issue (`jira-kaka-...`
stays kaka) instead of creating a second card under another label, and writes the
subtask checklist onto the story card so the board shows the scope.

Imported cards are plain backlog cards: they are not part of the poll loop's job state,
so nothing dispatches them automatically yet. The loop keeps delivering the parent
issue as one card until the sweep is switched to task execution.

With `subtaskCards: true` in the config a parent issue that already has those task
cards describes itself as their **container**: the prompt lists the cards and tells the
agent not to re-implement them, so starting the parent cannot duplicate their work.
Set it to `false` to go back to "one worktree implements every Jira subtask".

### Jira changes after import

Jira keeps moving after a card is imported. The monitor only ever absorbs
_additive_ changes; everything else is surfaced on the card for a human to
decide.

| Jira change                             | Behaviour                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| New subtask on an existing story        | Applied: the card's subtask checklist grows. No notice.                                                                   |
| Subtask summary edited, subtask removed | Reported on the card as a before/after notice.                                                                            |
| Story/Task requirement text edited      | Reported as `requirements` (tracked by the `jiraContext.version` hash, so the notice is one line instead of a full diff). |
| Assignee changed                        | Reported as `assignee`. Already-created MRs keep the old reviewer; update them separately.                                |
| Labels / release label changed          | Reported as `labels`.                                                                                                     |
| Summary (title) changed                 | Reported as `summary`.                                                                                                    |

Notices are stored on the feature as `jiraChanges` and rendered on the board card
as a "Jira 已变更" block with the old and new value. They are never cleared by the
monitor itself: a later revert must not make an out-of-sync card look untouched.

Review the notices, decide (re-run through Follow Up, accept the delivered work,
or start fresh), then close them out:

```bash
# what would be cleared
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json --ack-jira-changes

# one card only, then apply
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --ack-jira-changes AIP-115287 --apply
```

Re-import an issue to pick up its latest Jira state:

```bash
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --import-jira-tree AIP-114866 --apply
```

Import is idempotent: existing cards are matched by Jira key (the label prefix is
preserved), descriptions/dependencies/context are refreshed, and execution state
plus MR records are left alone. Cards that are already delivered only get a
notice; their scope is never rewritten silently.

## Operations

**Routine operations require no manual steps**: the monitor polls, dispatches and
reports on its own. The destructive remediation passes live in
[One-off remediation](#one-off-remediation-historical--do-not-run-routinely) and are
not part of this runbook.

- Configuration: `data/jira-monitor/config.json`
- Poll state, queue, errors and job receipts: `data/jira-monitor/state.json`
- Status: `systemctl status automaker-jira-monitor.timer`
- Logs: `journalctl -u automaker-jira-monitor.service`
- Automaker logs: `journalctl -u automaker-server.service -u automaker-ui.service`
- Poll now: `systemctl start automaker-jira-monitor.service`
- Stop future polling: `systemctl stop automaker-jira-monitor.timer`
- Disable after reboot: `systemctl disable automaker-jira-monitor.timer`
- Stop a running feature separately in the Automaker UI.

Automaker API and UI are managed by `automaker-server.service` and
`automaker-ui.service`, both enabled at boot. Unit sources live in `scripts/systemd/`.
The monitor waits for API health during startup before polling/dispatching.

The API key is read from `data/.api-key` at runtime. Jira credentials remain in the
existing CLI configuration. Secrets are not embedded in the monitor or task prompts.

Each task writes `.automaker/jira-result.json` and `jira-tests.log` in its worktree.
The receipt must include passing test commands, an existing test log and actual GitLab
MR URLs before the monitor marks it `mr_reported`. This means the agent reported the
MRs; it does not mean the GitLab pipeline passed or a reviewer approved/merged them.
Jira updates use `jiraProgressMode`. The default `completion` mode posts one
deduplicated comment only when a task finishes with passing tests and real MR URLs.
Intermediate running and blocked states stay in Automaker instead of notifying Jira
watchers. Set the mode to `milestones` to also report start and blockage, or `off`
to disable monitor comments entirely. Agents may transition Jira after checking the
workflow and acceptance criteria. An MR receipt alone never marks an issue Done.

## Human input

When an agent needs a product decision, it writes outcome `needs_input` with a
`questions` array instead of guessing or reporting a generic failure. The monitor
moves the feature to Waiting Approval so the board card offers the Follow Up action,
then posts one Jira comment mentioning the issue reporter (`[~username]`) with the
question, context and options.

Replies can be sent from the Automaker Follow Up dialog or as a Jira comment. The
monitor polls comments after the question marker, ignores its own comments, and
resumes the same worktree through Follow Up with the reply injected as the decision.
Question comments are deduplicated by marker. Set `jiraHumanInputEnabled` to `false`
to disable this loop.

If a job is blocked, inspect its feature output, existing commits, remote branches,
MRs and receipt before resuming it through Automaker. Do not delete its state record
blindly: that can cause duplicate work. Polling errors are kept in `lastError` and
retried on the next timer tick. The monitor does not silently switch away from Codex.

The GitLab publishing instruction uses documented
[Git push options](https://docs.gitlab.com/topics/git/commit/) to create MRs to `dev`.
Git commands for these jobs use an explicit SSH configuration because the host's
global SSH client configuration contains an invalid `PermitRootLogin` directive.

Validation: `python3 -m unittest discover -s scripts -p test_jira_monitor.py -v`.
With no matching Jira issues, only polling and simulated dispatch tests can be
validated; real implementation, testing and MR creation await the first matching issue.
