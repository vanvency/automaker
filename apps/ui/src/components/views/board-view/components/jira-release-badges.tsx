import { cn } from '@/lib/utils';

interface JiraReleaseBadgesProps {
  /** All Jira labels of the card; only `release-*` labels are rendered. */
  labels?: string[] | null;
  className?: string;
  'data-testid'?: string;
}

/** Jira labels that mark the release an issue is planned for. */
export function releaseLabels(labels?: string[] | null): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => String(label).trim())
    .filter((label) => label.toLowerCase().startsWith('release-'));
}

/** The label that means "release not decided yet". */
const RELEASE_TBD = 'release-tbd';

export interface JiraReleasePriority {
  /** `high` when the issue carries a concrete release label, otherwise `tbd` */
  kind: 'high' | 'tbd';
  /** Concrete release labels that made the issue high priority */
  releases: string[];
}

/**
 * Release label = priority.
 *
 * - a concrete `release-*` label (anything but `release-tbd`) → 高优
 * - `release-tbd`, no release label at all → 待定
 */
export function releasePriority(labels?: string[] | null): JiraReleasePriority {
  const releases = releaseLabels(labels).filter((label) => label.toLowerCase() !== RELEASE_TBD);
  return releases.length > 0 ? { kind: 'high', releases } : { kind: 'tbd', releases: [] };
}

/**
 * Priority badge derived from the release label, plus the concrete release labels
 * (`release-20260917` …) for high-priority cards.
 *
 * Jira keeps the release a task belongs to in a label, which the board otherwise
 * loses: the category only says `Jira AIP / dodo` and the description is the full
 * agent prompt.
 */
export function JiraReleaseBadges({ labels, className, ...rest }: JiraReleaseBadgesProps) {
  const priority = releasePriority(labels);
  const isHigh = priority.kind === 'high';

  return (
    <span
      className={cn('inline-flex flex-wrap items-center gap-1', className)}
      data-testid={rest['data-testid']}
    >
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded border px-1 py-px text-[9px] font-semibold tracking-wide',
          isHigh
            ? 'border-red-500/30 bg-red-500/15 text-red-500'
            : 'border-border bg-secondary/60 text-muted-foreground'
        )}
        title={
          isHigh ? `高优：${priority.releases.join(', ')}` : '待定：无 release 标签或 release-tbd'
        }
        data-testid={rest['data-testid'] ? `${rest['data-testid']}-priority` : undefined}
      >
        {isHigh ? '高优' : '待定'}
      </span>
      {priority.releases.map((release) => (
        <span
          key={release}
          className="inline-flex shrink-0 items-center rounded border border-red-500/30 bg-red-500/15 px-1 py-px text-[9px] font-semibold tracking-wide text-red-500"
          title={`Jira label ${release}`}
          data-testid={`jira-release-${release}`}
        >
          {release}
        </span>
      ))}
    </span>
  );
}
