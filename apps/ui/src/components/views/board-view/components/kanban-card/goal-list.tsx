import { memo } from 'react';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';

/** One goal as the executor reports it on the card. */
export interface GoalProgress {
  goal: string;
  status?: 'pending' | 'in_progress' | 'done' | 'blocked';
  note?: string;
}

/**
 * Merge work is not a development goal.
 *
 * A task's goals describe what has to be built and verified; MR review and the
 * merge into `dev` happen in the Verified lane, after a human presses Complete.
 * Agents kept adding them to `goals`, which made progress look unfinished while
 * the implementation was already done, so they are split out here.
 */
const MERGE_GOAL_PATTERN =
  /(\bMR\b|\bPR\b|merge request|merge into|自动合并|合入|合并到|评审并合入|评审.*合并)/i;

export function isMergeGoal(goal: GoalProgress): boolean {
  return MERGE_GOAL_PATTERN.test(goal.goal ?? '');
}

export function splitGoals(goals: GoalProgress[]): {
  development: GoalProgress[];
  merge: GoalProgress[];
} {
  const development: GoalProgress[] = [];
  const merge: GoalProgress[] = [];
  for (const goal of goals) (isMergeGoal(goal) ? merge : development).push(goal);
  return { development, merge };
}

function statusDotClass(status: GoalProgress['status']): string {
  switch (status) {
    case 'done':
      return 'bg-[var(--status-success)]';
    case 'in_progress':
      return 'bg-[var(--status-warning)] animate-pulse';
    case 'blocked':
      return 'bg-[var(--status-error)]';
    default:
      return 'bg-muted-foreground/40';
  }
}

function statusLabel(status: GoalProgress['status']): string {
  switch (status) {
    case 'done':
      return '完成';
    case 'in_progress':
      return '进行中';
    case 'blocked':
      return '阻塞';
    default:
      return '待办';
  }
}

/**
 * Compact goal progress for the card face.
 *
 * The full list lives in the details dialog: cards with ten goals would
 * otherwise be as tall as their plan.
 */
export const GoalSummaryBar = memo(function GoalSummaryBar({
  goals,
  onOpenDetails,
}: {
  goals: GoalProgress[];
  onOpenDetails?: () => void;
}) {
  // Only development goals progress the card; merge work belongs to the Verified
  // lane and would otherwise keep the bar short of 100% forever.
  const { development, merge } = splitGoals(goals);
  const done = development.filter((goal) => goal.status === 'done').length;
  const inProgress = development.filter((goal) => goal.status === 'in_progress').length;
  const blocked = development.filter((goal) => goal.status === 'blocked').length;
  const total = development.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const allDone = total > 0 && done === total;

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpenDetails?.();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      disabled={!onOpenDetails}
      className={cn(
        'mb-2 w-full space-y-1 rounded-md px-1.5 py-1 text-left transition-colors',
        onOpenDetails && 'hover:bg-muted/60 cursor-pointer'
      )}
      title={onOpenDetails ? '查看全部目标' : undefined}
      data-testid={`goal-progress-${(goals[0]?.goal ?? '').slice(0, 12)}`}
    >
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium">Goals</span>
        <span>
          {done}/{total}
        </span>
        <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full transition-all',
              allDone ? 'bg-[var(--status-success)]' : 'bg-brand-500'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        {(inProgress > 0 || blocked > 0) && (
          <span className="shrink-0">
            {inProgress > 0 && `${inProgress} 进行中`}
            {inProgress > 0 && blocked > 0 && ' · '}
            {blocked > 0 && <span className="text-[var(--status-error)]">{blocked} 阻塞</span>}
          </span>
        )}
        {merge.length > 0 && (
          <span className="shrink-0 text-muted-foreground/60">+{merge.length} 合并</span>
        )}
        {onOpenDetails && <ChevronRight className="w-3 h-3 shrink-0" />}
      </div>
    </button>
  );
});

/** Merge-phase goals, shown under their own heading - never in the goal list. */
export const MergeGoalList = memo(function MergeGoalList({ goals }: { goals: GoalProgress[] }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground/70">
        MR 评审与合入 dev 发生在 Verified 泳道、人工点 Complete 之后，因此不计入开发目标。
      </p>
      <GoalList goals={goals} />
    </div>
  );
});

/** Full goal list, used inside the details dialog. */
export const GoalList = memo(function GoalList({ goals }: { goals: GoalProgress[] }) {
  return (
    <ul className="space-y-2">
      {goals.map((goal, index) => (
        <li key={index} className="flex items-start gap-2 text-xs leading-relaxed">
          <span
            className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(goal.status))}
          />
          <div className="min-w-0 space-y-0.5">
            <p
              className={cn(
                'break-words',
                goal.status === 'done' && 'text-muted-foreground/60 line-through'
              )}
            >
              {goal.goal}
            </p>
            {goal.note && (
              <p className="break-words text-[11px] text-muted-foreground/70">{goal.note}</p>
            )}
          </div>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
            {statusLabel(goal.status)}
          </span>
        </li>
      ))}
    </ul>
  );
});
