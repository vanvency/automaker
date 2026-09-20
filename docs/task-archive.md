# Task archival

Task Kanban card actions, list actions, Graph View and bulk selection use **Archive Task**
instead of permanent deletion. The form requires:

- **Reason type**: Duplicate task, Not proceeding for now, Requirement no longer valid,
  or Conflicting requirements.
- **Detailed description**: 5–8000 characters explaining the decision.
- **Duplicate of**: required for duplicates, referencing an existing task outside the
  archive selection. The target cannot already be archived or superseded.

The record stores the related task ID/title/Jira key, original status and archive time.
The task, files, screenshots, conversation and code remain intact. Jira and MRs are
unchanged; use Work Board → Similar Works for separately reviewed external cleanup.

Archived Tasks shows the reason, description and duplicate reference. Restore returns
the task to its prior resting status; the archive history remains with a restoration
timestamp. A task archived as deferred/obsolete/conflicting is not counted as completed
for dependency satisfaction. Archived tasks are excluded from Agent dispatch, Jira
synchronization and similarity candidates until restored.

Running tasks/conversations must be stopped before archival. A bulk request validates
all selected tasks before applying updates; a filesystem failure may leave earlier
items archived, and retry preserves their existing records without duplication.

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
