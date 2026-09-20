import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { Feature } from '@/store/app-store';
import { ChangedProjectList, getChangedProjects } from './changed-projects';
import { getChildFeaturesForParent } from '../../lib/child-features';

interface ChildTaskSummaryProps {
  feature: Feature;
  allFeatures: Feature[];
  onLocateChild?: (childId: string) => void;
}

interface ChildStatusMeta {
  label: string;
  dotClass: string;
}

function mergeChangedProjects(projects: ReturnType<typeof getChangedProjects>[]) {
  return projects.flat().reduce<ReturnType<typeof getChangedProjects>>((result, project) => {
    const existing = result.find((item) => item.name === project.name);
    if (!existing) {
      result.push(project);
      return result;
    }
    if (!existing.mrUrl && project.mrUrl) {
      existing.mrUrl = project.mrUrl;
    }
    return result;
  }, []);
}

const STATUS_META: Record<string, ChildStatusMeta> = {
  backlog: { label: '待执行', dotClass: 'bg-[var(--status-backlog)]' },
  ready: { label: '待执行', dotClass: 'bg-[var(--status-backlog)]' },
  in_progress: { label: '执行中', dotClass: 'bg-[var(--status-in-progress)]' },
  waiting_approval: { label: '待验收', dotClass: 'bg-[var(--status-waiting)]' },
  verified: { label: '已完成', dotClass: 'bg-[var(--status-success)]' },
  completed: { label: '已完成', dotClass: 'bg-[var(--status-success)]' },
  failed: { label: '异常', dotClass: 'bg-[var(--status-error)]' },
  error: { label: '异常', dotClass: 'bg-[var(--status-error)]' },
  blocked: { label: '阻塞', dotClass: 'bg-[var(--status-error)]' },
  interrupted: { label: '中断', dotClass: 'bg-[var(--status-warning)]' },
  merge_conflict: { label: '冲突', dotClass: 'bg-[var(--status-warning)]' },
};

function childStatusMeta(status: string | undefined): ChildStatusMeta {
  if (status && status.startsWith('pipeline_')) {
    return { label: '流水线', dotClass: 'bg-[var(--status-in-progress)]' };
  }
  return STATUS_META[status ?? ''] ?? { label: status ?? '未知', dotClass: 'bg-muted-foreground' };
}

/**
 * Parent task card summary: lists child features (same Jira key) with their
 * execution status and overall completion percentage.
 */
export const ChildTaskSummary = memo(function ChildTaskSummary({
  feature,
  allFeatures,
  onLocateChild,
}: ChildTaskSummaryProps) {
  const children = useMemo(() => {
    return getChildFeaturesForParent(feature, allFeatures);
  }, [allFeatures, feature]);

  if (children.length === 0) return null;

  const completed = children.filter((child) =>
    ['verified', 'completed'].includes(child.status ?? '')
  ).length;
  const total = children.length;
  const percent = Math.round((completed / total) * 100);
  const changedProjects = mergeChangedProjects(children.map(getChangedProjects));

  return (
    <div
      className="mb-2 rounded-lg border border-border/50 bg-secondary/50 px-2.5 py-2"
      data-testid={`child-task-summary-${feature.id}`}
    >
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-nav-text">子任务 {total}</span>
        <span className="shrink-0 text-module-title">
          {completed}/{total} 已完成 · {percent}%
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className="h-full rounded-full bg-[var(--status-success)] transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 space-y-1">
        {children.map((child) => {
          const meta = childStatusMeta(child.status);
          return (
            <div key={child.id} className="flex min-w-0 items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dotClass)} />
              <button
                type="button"
                className="truncate text-left text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                title={child.title || child.description}
                onClick={(event) => {
                  event.stopPropagation();
                  onLocateChild?.(child.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                data-testid={`locate-child-${child.id}`}
              >
                {child.title || child.description}
              </button>
              <span className="ml-auto shrink-0 text-[10px] text-module-title">{meta.label}</span>
            </div>
          );
        })}
      </div>
      <ChangedProjectList featureId={feature.id} projects={changedProjects} className="mt-2" />
    </div>
  );
});
