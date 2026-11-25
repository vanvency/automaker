# Work archives

Work Board automatically moves a work into **Archived Works** once every task on
its branch has been Done for seven days. Open the button in the upper-right
corner to search the archived list by project, branch, task title or Jira key.
The project filter applies to the archive list as well.

The work retains its **Done** status. Archiving does not change task status,
create task archive records, merge code, close Jira issues or delete files.
The archive date is calculated from the latest task completion/delivery timestamp
plus seven days whenever progress refreshes; it does not need a separate scheduler.
Adding an unfinished task or reopening a task makes the work active again.

Main worktrees, works with unfinished tasks, unresolved delivery failures,
conflicts or uncommitted changes stay on the board. Running agents remain visible.
Cancelled/deferred task archives do not count as completed delivery. Missing or
invalid completion timestamps do not trigger automatic archiving.

The existing worktree-retention job independently checks whether local checkout
files can be safely released. An archived work can therefore still have its local
checkout. If the checkout was released, the archive list reconstructs the work
from retained task records and shows its task history without recreating files.

Validation:

```bash
npx vitest run --project=server apps/server/tests/unit/routes/worktree/progress.test.ts
npx vitest run --project=ui apps/ui/tests/unit/components/archived-works.test.tsx
```
