import { memo, useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Feature, JiraSubtask } from '@automaker/types';

interface JiraSubtaskListProps {
  feature: Feature;
}

/** Jira workflow statuses that mean the subtask is finished. */
const DONE_STATUS_TOKENS = ['完成', 'done', 'closed', 'resolved', '已解决'];
/** Jira workflow statuses that mean somebody is working on it. */
const ACTIVE_STATUS_TOKENS = ['progress', '进行', 'review', '评审'];

function statusMeta(status: string | undefined) {
  const value = (status ?? '').toLowerCase();
  if (DONE_STATUS_TOKENS.some((token) => value.includes(token))) {
    return { label: status || '完成', dotClass: 'bg-[var(--status-success)]' };
  }
  if (ACTIVE_STATUS_TOKENS.some((token) => value.includes(token))) {
    return { label: status || '进行中', dotClass: 'bg-[var(--status-in-progress)]' };
  }
  return { label: status || '待办', dotClass: 'bg-[var(--status-backlog)]' };
}

function isDone(subtask: JiraSubtask): boolean {
  const value = (subtask.status ?? '').toLowerCase();
  return DONE_STATUS_TOKENS.some((token) => value.includes(token));
}

/**
 * Jira subtasks covered by this card's single worktree.
 *
 * The subtasks are deliberately not separate Automaker cards: one worktree and
 * one branch deliver all of them. This block keeps them visible on the parent
 * card, with a Jira link per subtask.
 */
export const JiraSubtaskList = memo(function JiraSubtaskList({ feature }: JiraSubtaskListProps) {
  const subtasks = useMemo(
    () => (Array.isArray(feature.jiraSubtasks) ? feature.jiraSubtasks : []),
    [feature.jiraSubtasks]
  );

  if (subtasks.length === 0) return null;

  const done = subtasks.filter(isDone).length;
  const total = subtasks.length;
  const percent = Math.round((done / total) * 100);
  const jiraBase =
    (typeof feature.jiraUrl === 'string' && feature.jiraUrl.replace(/\/browse\/.*$/, '')) ||
    'https://jira.transwarp.io';

  return (
    <div
      className="mb-2 rounded-lg border border-border/50 bg-secondary/50 px-2.5 py-2"
      data-testid={`jira-subtasks-${feature.id}`}
    >
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-nav-text">Jira 子任务 {total}</span>
        <span className="shrink-0 text-module-title">
          {done}/{total} 已完成 · {percent}%
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className="h-full rounded-full bg-[var(--status-success)] transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 space-y-1">
        {subtasks.map((subtask) => {
          const meta = statusMeta(subtask.status);
          return (
            <div key={subtask.key} className="flex min-w-0 items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dotClass)} />
              <a
                href={`${jiraBase}/browse/${subtask.key}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-brand-500 hover:underline"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                data-testid={`jira-subtask-link-${feature.id}-${subtask.key}`}
                title={`Open ${subtask.key} in Jira`}
              >
                {subtask.key}
                <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
              </a>
              <span
                className="truncate text-[10px] text-muted-foreground"
                title={`${subtask.type ? `[${subtask.type}] ` : ''}${subtask.summary ?? ''}`}
              >
                {subtask.summary}
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-module-title">{meta.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
