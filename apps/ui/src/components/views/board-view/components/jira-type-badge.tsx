import { cn } from '@/lib/utils';

interface JiraTypeMeta {
  label: string;
  className: string;
  title: string;
}

/**
 * Badge metadata for the normalized Jira work type.
 *
 * The type is stored on the card as `jiraType`, so a worktree (and its legacy
 * `jira/<key>-<label>` branch) shows which kind of Jira work it carries even
 * when the branch name itself does not say it.
 */
export const JIRA_TYPE_META: Record<string, JiraTypeMeta> = {
  epic: {
    label: 'EPIC',
    className: 'border-purple-500/30 bg-purple-500/15 text-purple-500',
    title: 'Jira Epic',
  },
  story: {
    label: 'STORY',
    className: 'border-blue-500/30 bg-blue-500/15 text-blue-500',
    title: 'Jira Story',
  },
  task: {
    label: 'TASK',
    className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600',
    title: 'Jira Task',
  },
  feat: {
    label: 'FEAT',
    className: 'border-sky-500/30 bg-sky-500/15 text-sky-500',
    title: 'Jira feature work',
  },
  impr: {
    label: 'IMPR',
    className: 'border-amber-500/30 bg-amber-500/15 text-amber-600',
    title: 'Jira improvement',
  },
  bugfix: {
    label: 'BUGFIX',
    className: 'border-red-500/30 bg-red-500/15 text-red-500',
    title: 'Jira bug fix',
  },
};

interface JiraTypeBadgeProps {
  /** Normalized work type (epic/story/feat/impr/bugfix/task) */
  type?: string | null;
  className?: string;
  'data-testid'?: string;
}

export function JiraTypeBadge({ type, className, ...rest }: JiraTypeBadgeProps) {
  const meta = type ? JIRA_TYPE_META[type] : undefined;
  if (!meta) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1 py-px text-[9px] font-semibold tracking-wide',
        meta.className,
        className
      )}
      title={meta.title}
      data-testid={rest['data-testid']}
    >
      {meta.label}
    </span>
  );
}
