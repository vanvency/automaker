# Task delivery progress

For vibe-llmops, routine delivery records the MRs for each changed submodule
and, only when root-owned files changed, an MR for the root repository itself.
Do not stage or commit submodule gitlinks or create a root MR just because
submodule checkouts moved. Gitlink updates belong to explicitly requested
integration/release version-lock tasks. Other projects retain their explicit
repository policy. Existing receipts and MRs are not rewritten automatically.
The root checkout still pins the last locked versions: merging submodule MRs
does not change what `git submodule update` checks out.

Needs Attention cards can be dragged to Backlog, In Progress, Waiting Review or
Done after a risk confirmation. Cancel leaves the task unchanged. Moving to
In Progress uses the normal Agent start action; it does not only change the status.
An explicit move to Waiting Review or Done may bypass the delivery receipt / Draft
MR gate for that move. `feature.attentionOverride` records the previous status,
execution run, blocker and server confirmation time. Done also records a human
completion decision. The override is not reused by subsequent status changes.
Running and archived tasks cannot use this override. This changes the Automaker
board only; MR merges, Jira transitions, deployment and Complete keep their own
checks and confirmation flow.

Done cards use two separate human actions:

- **Complete** fetches current MR conflicts and review discussions from GitLab,
  including all discussion pages. Resolved discussions, system notes and diff
  comments tied to older source revisions are excluded. **Fix MR** sends the
  current conflicts and feedback to the same task's Agent, which must fetch them
  again before editing and after pushing.
- **Approve MR** accepts the reviewed feedback and removes Draft. It does not
  cast a GitLab approval vote, merge code or close Jira. The approval stores the
  source revisions and feedback hashes in `feature.deliveryApproval`. New commits
  or feedback require approval again; starting another execution clears approval.
  Conflicts may be acknowledged here, but still block final delivery.

After approval the card button becomes **Confirm**. Its dialog explicitly previews
the external changes below. Only the final confirmation runs them, recording each
step on `feature.deliveryCompletion`:

1. **Release preview**: remove only Automaker-owned Deployment, Service and
   Ingress resources of the task's worktree via the preview service. Keep shared
   previews while another unarchived task in the worktree is unfinished. Source
   files, branches, worktrees, manual deployments and external environments are
   never removed by this step.
2. **MR merge**: validate the approved source revisions and current feedback, then
   squash-merge subproject MRs before the root MR. Already merged MRs are read,
   not merged a second time.
3. **Jira close**: use the reviewed terminal transition and required fields.
   Already closed issues are read, not transitioned again.

Before releasing resources, Confirm checks conflicts, required CI status,
GitLab merge conditions and Jira fields. GitLab-required approvals or unresolved
discussions cannot be bypassed by removing Draft.

Each step persists its state and explanation before/after execution. Failures
leave the task in Done, with previously completed steps visible. The operator can
inspect any segment, send a repair request to the task's Agent, or refresh and
retry Confirm. Agent repair diagnoses/fixes prerequisites; it must not perform
MR merges or Jira transitions. Code changes require acceptance again. Retries
re-read actual GitLab/Jira state before acting.

Only after all three steps succeed does the task become completed and receive a
`completed` archive record. Its receipt, sessions, evidence and code are preserved;
completed deliveries continue to satisfy dependencies. Historical tasks are not
archived or cleaned up retroactively.

Endpoints (authenticated, project-path validated):

- `POST /api/features/complete`: `action` is `preview`, `fix`, `approve` or `confirm`.
  Non-preview actions require the current preview fingerprint. Confirm additionally
  requires a current approval, Jira transition and required fields. Legacy
  `preview: false` means Confirm and cannot bypass approval.
- `POST /api/features/completion-progress`: returns persisted progress; an
  interrupted running operation is marked failed when no live execution owns it.
- `POST /api/features/completion-repair`: accepts `projectPath`, `featureId`,
  `stepId`, optional `instruction`; dispatches only failed steps to the task agent.
