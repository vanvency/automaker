# Task archival

Task Kanban card actions, list actions, Graph View and bulk selection use **Archive Task**
instead of permanent deletion. The form requires:

- **Reason type**: Duplicate task, Not proceeding for now, Requirement no longer valid,
  Conflicting requirements, **Done**, or **Already taken (completed by someone else)**.
- **Detailed description**: optional, with no character count requirement.
  Archive Work defaults to Already taken.
- **Duplicate of**: required for duplicates, referencing an existing task outside the
  archive selection. The target cannot already be archived or superseded.

The record stores the related task ID/title/Jira key, original status and archive time.
The task, files, screenshots, conversation and code remain intact. Jira and MRs are
unchanged; use Work Board → Similar Works for separately reviewed external cleanup.
`Already taken` records that someone else has completed the work; Archive Work
allows an empty description and needs no duplicate-task link. It does not update Jira
fields, comments or workflow status, and archived tasks are excluded from managed Jira writeback.
`Done` is also a local archival reason; it does not confirm delivery, merge MRs,
close Jira issues, or satisfy task dependencies. Archive Work opens immediately
with the worktree's task summary, then checks the full task list before enabling submission.

Successful delivery uses **Complete → Approve MR → Confirm**. After explicit
confirmation, preview release, MR merge and Jira closure run in that order; only
full success writes the `Delivery completed` archive reason. This reason cannot
be selected through the manual archive API. See [delivery progress](task-delivery-progress.md).

Archived Tasks shows the reason, description and duplicate reference. Restore returns
the task to its prior resting status; the archive history remains with a restoration
timestamp. A task archived as deferred/obsolete/conflicting is not counted as completed
for dependency satisfaction; a confirmed delivery archive does satisfy dependencies.
Archived tasks are excluded from Agent dispatch, Jira
synchronization and similarity candidates until restored.

Restoring a completed delivery returns it to Done (`verified`), including legacy
`completed` tasks without an archive record. The existing delivery receipt is retained;
restoration does not undo MR merges, reopen Jira or rerun delivery. For Jira tasks,
the review gate accepts recorded, human-confirmed merged MRs only when their
repositories, branches and current source revisions still match. New changes still
require a new Draft delivery.

Running tasks/conversations must be stopped before archival. A bulk request validates
all selected tasks before applying updates; a filesystem failure may leave earlier
items archived, and retry preserves their existing records without duplication.
An active consolidation lock also blocks archival. A historical `supersededBy`
coverage record does not: local archival preserves that relationship, code, MRs
and conversations. Restoring a covered task still requires resolving its
consolidation first; archival cannot reactivate it or change external delivery.

API:

```json
POST /api/features/archive
{
  "projectPath": "/workspace/project",
  "featureIds": ["task-a"],
  "archive": {
    "reason": "duplicate",
    "description": "The export requirements are covered by task-b.",
    "duplicateOf": "task-b"
  }
}
```

`POST /api/features/restore-archive` accepts `projectPath` and `featureId`.
Legacy `/delete` and `/bulk-delete` HTTP endpoints now require the same `archive`
payload and perform archival; requests without a reason fail without deleting files.
Low-level internal feature storage cleanup is separate from these user actions.
