# Task delivery progress

Confirm Complete records three ordered steps on `feature.deliveryCompletion`:

1. **MR merge**: validate the reviewed source revisions, mark drafts ready and
   squash-merge subproject MRs before the root MR. Already merged MRs are read,
   not merged a second time.
2. **Jira close**: use the reviewed terminal transition and required fields.
   Already closed issues are read, not transitioned again.
3. **Release preview**: remove only Automaker-owned Deployment, Service and
   Ingress resources of the task's worktree via the preview service. Keep shared
   previews while another unarchived task in the worktree is unfinished. Source
   files, branches, worktrees, manual deployments and external environments are
   never removed by this step.

Each step persists its state and explanation before/after execution. Failures
leave the task in Done, with previously completed steps visible. The operator can
inspect any segment, send a repair request to the task's Agent, or refresh and
retry Complete. Agent repair diagnoses/fixes prerequisites; it must not perform
MR merges or Jira transitions. Code changes require acceptance again. Retries
re-read actual GitLab/Jira state before acting.

Successful completion leaves a three-step receipt on the Done card until the
operator explicitly archives it. Historical tasks completed before this feature
remain in the existing completed-task view; no cleanup is run retroactively.

Endpoints (authenticated, project-path validated):

- `POST /api/features/complete`: existing preview/apply contract, now with progress
  persistence and preview cleanup.
- `POST /api/features/completion-progress`: returns persisted progress; an
  interrupted running operation is marked failed when no live execution owns it.
- `POST /api/features/completion-repair`: accepts `projectPath`, `featureId`,
  `stepId`, optional `instruction`; dispatches only failed steps to the task agent.
