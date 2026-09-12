# Jira → Automaker → GitLab

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

## Operations

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
