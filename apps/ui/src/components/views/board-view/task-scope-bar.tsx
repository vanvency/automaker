/**
 * Task scope bar (level 2).
 *
 * The board is scoped to one worktree, which is usually one big task. This bar
 * says which task the board is showing, how its cards are progressing, and links
 * back to the level-1 task overview - so the two levels are never ambiguous.
 */

import { ArrowLeft, ExternalLink, FolderGit2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface BoardTaskScope {
  /** Branch of the selected work line */
  branch: string;
  /** Task title (the parent card when the scope has children) */
  title: string;
  jiraKey?: string;
  jiraUrl?: string;
  /** Cards on the branch: the task itself plus every child */
  totalCards: number;
  completedCards: number;
  runningCards: number;
  waitingCards: number;
  failedCards: number;
  /** Whether this task has child cards on the board */
  hasChildren: boolean;
}

export function TaskScopeBar({
  task,
  onBackToOverview,
  className,
}: {
  task: BoardTaskScope;
  onBackToOverview: () => void;
  className?: string;
}) {
  const percent =
    task.totalCards === 0 ? 0 : Math.round((task.completedCards / task.totalCards) * 100);
  const signals = [
    task.runningCards > 0 ? `${task.runningCards} 进行中` : null,
    task.waitingCards > 0 ? `${task.waitingCards} 待验收` : null,
    task.failedCards > 0 ? `${task.failedCards} 异常` : null,
  ].filter(Boolean) as string[];

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 bg-card/60 px-3 py-2',
        className
      )}
      data-testid="task-scope-bar"
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-1.5 text-xs text-muted-foreground"
        onClick={onBackToOverview}
        data-testid="task-scope-back"
      >
        <ArrowLeft className="mr-1 h-3.5 w-3.5" />
        任务总览
      </Button>

      <span className="text-muted-foreground/40">/</span>

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium" title={task.title}>
          {task.title}
        </span>
        {task.hasChildren && (
          <span className="shrink-0 rounded bg-brand-500/15 px-1 text-[10px] text-brand-500">
            含子任务
          </span>
        )}
        {task.jiraKey &&
          (task.jiraUrl ? (
            <a
              href={task.jiraUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-brand-500 hover:underline"
              data-testid="task-scope-jira"
            >
              {task.jiraKey}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ) : (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {task.jiraKey}
            </span>
          ))}
      </div>

      <span
        className="inline-flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground"
        title={task.branch}
      >
        <FolderGit2 className="h-3 w-3 shrink-0" />
        <span className="truncate">{task.branch}</span>
      </span>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          卡片 {task.completedCards}/{task.totalCards} 完成 · {percent}%
        </span>
        <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full',
              task.failedCards > 0 ? 'bg-[var(--status-warning)]' : 'bg-[var(--status-success)]'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        {signals.length > 0 && (
          <span className="hidden text-[11px] text-muted-foreground lg:inline">
            {signals.join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}
