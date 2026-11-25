# Work Board

Work Board shows one card per worktree in the selected project. Board and table
views share the same search and filters.

- Press **/** to focus search, as in Task Kanban. Search matches work titles,
  branches, Jira IDs, reporter and assignee names/accounts, and commit information.
  The shortcut does not interrupt typing or an open dialog.
- Use **All reporters** and **All assignees** to filter by Jira people. Both filters
  combine with search and stage filters. Missing metadata appears as **Not available**
  or **Unassigned**. **Clear filters** resets the people filters.
- **Snooze Work** and **Archive Work** are in the upper-right corner of each card.
  Running work must be stopped first. Snooze keeps task statuses and code intact;
  Archive opens the existing reason form for all active tasks on that branch.
- Jira information has its own row. **Copy Jira ID** copies only the issue key.
- Reporter and assignee labels refer to the task represented by the card.
  Jira synchronization refreshes the stable account identifiers and display names.
- A configured preview without a deployment shows **Preview not deployed** and
  **Deploy Preview**. Missing configuration and failed deployments show their own
  status text.

The compact header keeps **New Work** directly accessible. Open **More work actions**
(the **⋯** menu) for **Archived Works**, **Snoozed Works**, and **Similar Works**.
The refresh control also displays the last update time.

Use **Snoozed Works** to resume paused work. **Archived Works** includes both
explicitly archived work and the existing seven-day Done retention history;
manually archived work is labelled **Archived**, not **Done**. New or restored
active tasks return the work to the board.

See [Snoozed Works](work-snooze.md), [Task archival](task-archive.md), and
[Worktree previews](worktree-previews.md).
