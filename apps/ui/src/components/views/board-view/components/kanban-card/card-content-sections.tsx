// @ts-nocheck - content section prop typing with feature data extraction
import { memo } from 'react';
import { Feature } from '@/store/app-store';
import { GitPullRequest, ExternalLink } from 'lucide-react';
import { TaskNotice } from '../task-notice';
import { GoalSummaryBar, type GoalProgress } from './goal-list';
import { ChangedProjectList, getChangedProjects } from './changed-projects';

interface CardContentSectionsProps {
  feature: Feature;
  /** Opens the card details dialog (full description, goals, Jira records) */
  onOpenDetails?: () => void;
}

export const CardContentSections = memo(function CardContentSections({
  feature,
  onOpenDetails,
}: CardContentSectionsProps) {
  const goals = Array.isArray(feature.goals) ? (feature.goals as GoalProgress[]) : null;
  const changedProjects = getChangedProjects(feature);

  return (
    <>
      {/* Visible status message. `error` carries the question a task is waiting
          on (needs_input), so it must be readable on the card itself rather than
          hidden behind the badge tooltip. */}
      <TaskNotice feature={feature} />
      {feature.supersededBy && (
        <div className="mb-2 rounded border px-2 py-1.5 text-xs" data-testid="task-superseded">
          已由 {feature.supersededBy.jiraKey || feature.supersededBy.featureId} 覆盖
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
            {feature.supersededBy.reason}
          </p>
        </div>
      )}
      {feature.consolidationPlanId && (
        <p className="mb-2 text-xs text-muted-foreground">
          任务整合中，请到“相似任务”查看清理结果。
        </p>
      )}

      {goals && goals.length > 0 && <GoalSummaryBar goals={goals} onOpenDetails={onOpenDetails} />}

      {/* Changed repositories are listed in full: the card is already scoped to
          this worktree, so hiding the names behind a count added a click. */}
      {changedProjects.length > 0 && (
        <ChangedProjectList
          featureId={feature.id}
          projects={changedProjects}
          showLabel={false}
          className="mb-2"
        />
      )}

      {/* PR URL Display */}
      {typeof feature.prUrl === 'string' &&
        /^https?:\/\//i.test(feature.prUrl) &&
        (() => {
          const prNumber = feature.prUrl.split('/').pop();
          return (
            <div className="mb-2">
              <a
                href={feature.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 text-[11px] text-purple-500 hover:text-purple-400 transition-colors"
                title={feature.prUrl}
                data-testid={`pr-url-${feature.id}`}
              >
                <GitPullRequest className="w-3 h-3 shrink-0" />
                <span className="truncate max-w-[150px]">
                  {prNumber ? `Pull Request #${prNumber}` : 'Pull Request'}
                </span>
                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
              </a>
            </div>
          );
        })()}
    </>
  );
});
