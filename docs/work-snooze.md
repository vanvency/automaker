# Snoozed Works

Use **Work Board → Snooze** on a work card or table row to set non-urgent work aside.
An optional reason explains when or why it should be picked up again.

- Snooze applies to the entire project branch, including tasks imported or created later.
- Stop running tasks and agents first. The server rejects snoozing active work.
- Snoozed work is hidden from active Work Board lanes. Open **Snoozed Works** in the
  header's **⋯** menu to search, inspect tasks, or choose **Resume Worktree**.
- The project filter applies to the snoozed list. Task Kanban cards show the pause
  reason and link back to Work Board.
- Task statuses, code, local changes, branches and conversations are preserved.
  Snooze does not archive tasks, merge code, close Jira, or release the checkout.
- Automatic dispatch and platform-managed task execution stay paused until resumed.
  Jira metadata may still synchronize. Resume removes the pause; it does not start
  an agent immediately or restart the worktree's stopped auto loop.

Snooze state lives in the project's `.automaker/work-snoozes.json`, separate from
task JSON and Jira-owned fields. The authenticated `POST /api/worktree/snooze`
endpoint accepts `projectPath`, `branchName`, `snoozed` and an optional `reason`
(up to 500 characters). Task responses expose the branch state as `worktreeSnooze`.

This version uses manual resume. It does not schedule reminders or automatically
resume work on a date.
