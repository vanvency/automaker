import { memo } from 'react';
import { History } from 'lucide-react';
import { cn } from '@/lib/utils';

interface JiraChangeListProps {
  changes?: Array<{
    field: string;
    before?: string;
    after?: string;
    detectedAt?: string;
  }>;
  className?: string;
  'data-testid'?: string;
}

/** Field names as the monitor records them -> card label. */
const FIELD_LABELS: Record<string, string> = {
  requirements: '需求描述',
  subtasks: 'Jira 子任务',
  assignee: '经办人',
  labels: '标签',
  summary: '标题',
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function formatValue(value: string | undefined, max = 120): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Jira-side changes since this card was imported. New subtasks are applied
 * automatically; every other change is shown before/after so the user decides
 * whether to re-run, follow up, or accept the delivered work as-is.
 */
export const JiraChangeList = memo(function JiraChangeList({
  changes,
  className,
  'data-testid': testId,
}: JiraChangeListProps) {
  if (!changes?.length) return null;

  return (
    <div
      className={cn(
        'mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2',
        className
      )}
      data-testid={testId}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
        <History className="h-3 w-3" />
        Jira 已变更
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {changes.map((change, index) => {
          const before = formatValue(change.before);
          const after = formatValue(change.after);
          return (
            <li
              key={`${change.field}-${index}`}
              className="min-w-0 text-[10px] leading-relaxed"
              data-testid={`${testId}-item`}
            >
              <span className="font-medium text-foreground/80">{fieldLabel(change.field)}</span>
              {before && (
                <span className="ml-1 line-through text-muted-foreground/70" title={change.before}>
                  {before}
                </span>
              )}
              {before && after && <span className="mx-1 text-muted-foreground/60">→</span>}
              {after && (
                <span className="text-amber-700 dark:text-amber-300" title={change.after}>
                  {after}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
});
