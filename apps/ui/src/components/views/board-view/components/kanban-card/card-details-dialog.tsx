import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AcceptanceEvidence as AcceptanceEvidenceData,
  JiraChange,
  JiraSubtask,
} from '@automaker/types';
import { Feature } from '@/store/app-store';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/ui/markdown';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getElectronAPI } from '@/lib/electron';
import { queryKeys } from '@/lib/query-keys';
import { ImagePlus } from 'lucide-react';
import { ChangedProjectList, getChangedProjects } from './changed-projects';
import { JiraSubtaskList } from './jira-subtask-list';
import { JiraChangeList } from './jira-change-list';
import { GoalList, MergeGoalList, splitGoals, type GoalProgress } from './goal-list';
import { ChildTaskSummary } from './child-task-summary';
import { getChildFeaturesForParent } from '../../lib/child-features';
import { HerdrStatusBadge } from './herdr-status-badge';
import { JiraSyncHistory } from '../jira-sync-history';
import { AcceptanceEvidence } from '../acceptance-evidence';

const STATUS_LABELS: Record<string, string> = {
  backlog: '待办',
  ready: '待启动',
  in_progress: '开发中',
  waiting_approval: '待验收',
  verified: '已验证',
  completed: '已完成',
  failed: '失败',
  error: '出错',
  interrupted: '已中断',
  merge_conflict: '合并冲突',
};

const ACCEPTANCE_LABELS: Record<string, string> = {
  passed: '通过',
  failed: '失败',
  blocked: '受阻',
};

interface CardDetailsDialogProps {
  feature: Feature;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath?: string;
  /** Needed for the child-task progress in the overview */
  allFeatures?: Feature[];
  onLocateChild?: (featureId: string) => void;
}

/** One basic-info cell in the overview. */
function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  const shown = items.filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
      {shown.map(([label, value], index) => (
        <div key={index} className="flex min-w-0 gap-2">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Everything that is too long for the card face.
 *
 * The card keeps the summary line, the goal progress and the task notice; the
 * full description, the goal list, the Jira history and the evidence live here,
 * so a card with a long requirement text stays the same height as a short one.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function CardDetailsDialog({
  feature,
  isOpen,
  onOpenChange,
  projectPath,
  allFeatures,
  onLocateChild,
}: CardDetailsDialogProps) {
  const queryClient = useQueryClient();
  const [evidenceState, setEvidenceState] = useState<
    | { status: 'idle' }
    | { status: 'busy' }
    | { status: 'done' }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const collectEvidence = async () => {
    const api = getElectronAPI();
    if (!api.features?.collectAcceptanceEvidence || !projectPath) return;
    setEvidenceState({ status: 'busy' });
    try {
      const result = await api.features.collectAcceptanceEvidence(projectPath, feature.id);
      if (!result?.success) {
        setEvidenceState({ status: 'error', message: result?.error ?? '收集验收材料失败' });
        return;
      }
      setEvidenceState({ status: 'done' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.features.all(projectPath) });
    } catch (error) {
      setEvidenceState({
        status: 'error',
        message: error instanceof Error ? error.message : '收集验收材料失败',
      });
    }
  };
  const goals = Array.isArray(feature.goals) ? (feature.goals as GoalProgress[]) : [];
  const { development: developmentGoals, merge: mergeGoals } = splitGoals(goals);
  const changedProjects = getChangedProjects(feature);
  const description = feature.description || feature.summary || '';
  // The UI Feature type is a thin wrapper; these come straight from the shared type.
  const jiraChanges = feature.jiraChanges as JiraChange[] | undefined;
  const subtasks = feature.jiraSubtasks as JiraSubtask[] | undefined;
  const evidence = feature.acceptanceEvidence as AcceptanceEvidenceData | undefined;
  // The UI Feature type is a thin wrapper around the shared type; read the rest
  // through explicit shapes so the overview stays typed.
  const jiraKey = feature.jiraKey as string | undefined;
  const jiraUrl = feature.jiraUrl as string | undefined;
  const branchName = feature.branchName as string | undefined;
  const model = feature.model as string | undefined;
  const assignee = feature.jiraAssignee as string | undefined;
  const createdAt = feature.createdAt as string | undefined;
  const updatedAt = feature.updatedAt as string | undefined;
  const plan = feature.planSpec as { tasks?: unknown[]; tasksCompleted?: number } | undefined;
  // Only show the child section when this card really is a parent.
  const hasChildren = !!allFeatures && getChildFeaturesForParent(feature, allFeatures).length > 0;
  const hasJiraChanges = (jiraChanges?.length ?? 0) > 0;
  const hasSubtasks = (subtasks?.length ?? 0) > 0;
  const hasEvidence = !!evidence;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        aria-describedby={undefined}
        data-testid={`card-details-${feature.id}`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <DialogHeader className="shrink-0 space-y-2">
          <DialogTitle className="pr-6 text-sm leading-snug">
            {feature.title || feature.id}
          </DialogTitle>
          {/* The overview: status, live agent state and progress, so the whole
              task is understandable without opening anything else. */}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className="rounded-full border border-border/60 px-2 py-0.5 text-muted-foreground"
              data-testid={`details-status-${feature.id}`}
            >
              {STATUS_LABELS[feature.status as keyof typeof STATUS_LABELS] ?? feature.status}
            </span>
            {projectPath && <HerdrStatusBadge projectPath={projectPath} featureId={feature.id} />}
            {developmentGoals.length > 0 && (
              <span className="rounded-full border border-border/60 px-2 py-0.5 text-muted-foreground">
                目标 {developmentGoals.filter((goal) => goal.status === 'done').length}/
                {developmentGoals.length}
              </span>
            )}
            {mergeGoals.length > 0 && (
              <span className="rounded-full border border-border/60 px-2 py-0.5 text-muted-foreground">
                待合并 {mergeGoals.filter((goal) => goal.status !== 'done').length}
              </span>
            )}
            {evidence && (
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5',
                  evidence.status === 'passed'
                    ? 'border-green-600/40 text-green-600'
                    : 'border-amber-600/40 text-amber-600'
                )}
              >
                验收 · {ACCEPTANCE_LABELS[evidence.status]}
              </span>
            )}
          </div>
          <Facts
            items={[
              [
                'Jira',
                jiraKey ? (
                  <a
                    href={jiraUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-500 hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {jiraKey}
                  </a>
                ) : (
                  feature.id
                ),
              ],
              ['分支', branchName ? <code>{branchName}</code> : undefined],
              ['模型', model ? <code>{model}</code> : undefined],
              ['负责人', assignee],
              ['创建', createdAt ? new Date(createdAt).toLocaleString() : undefined],
              ['更新', updatedAt ? new Date(updatedAt).toLocaleString() : undefined],
              ['MR', changedProjects.length > 0 ? `${changedProjects.length} 个仓库` : undefined],
              [
                '计划',
                plan?.tasks?.length
                  ? `${plan.tasksCompleted ?? 0}/${plan.tasks.length}`
                  : undefined,
              ],
            ]}
          />
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          {hasChildren && allFeatures && (
            <Section title="子任务进度">
              <ChildTaskSummary
                feature={feature}
                allFeatures={allFeatures}
                onLocateChild={onLocateChild}
              />
            </Section>
          )}
          {description && (
            <Section title="任务描述">
              <div className="rounded-lg border border-border/50 bg-card p-3 text-xs">
                <Markdown>{description}</Markdown>
              </div>
            </Section>
          )}

          {developmentGoals.length > 0 && (
            <Section
              title={`目标清单 ${developmentGoals.filter((goal) => goal.status === 'done').length}/${developmentGoals.length}`}
            >
              <GoalList goals={developmentGoals} />
            </Section>
          )}

          {mergeGoals.length > 0 && (
            <Section title={`合并 / 评审 ${mergeGoals.length}`}>
              <MergeGoalList goals={mergeGoals} />
            </Section>
          )}

          {hasSubtasks && (
            <Section title="Jira 子任务">
              <JiraSubtaskList feature={feature} />
            </Section>
          )}

          {hasJiraChanges && (
            <Section title="Jira 变更">
              <JiraChangeList changes={jiraChanges} />
            </Section>
          )}

          {changedProjects.length > 0 && (
            <Section title="改动的仓库">
              <ChangedProjectList featureId={feature.id} projects={changedProjects} />
            </Section>
          )}

          <Section title="Jira 同步">
            <JiraSyncHistory feature={feature} />
          </Section>

          <Section title="验收证据">
            {hasEvidence ? (
              <AcceptanceEvidence evidence={evidence} projectPath={projectPath ?? ''} />
            ) : (
              <div className="space-y-2 rounded-lg border border-dashed border-border/60 p-3">
                <p className="text-xs text-muted-foreground">
                  这项任务还没有验收材料。开发 Agent 结束时应在 worktree 写
                  <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[10px]">
                    .automaker/acceptance/{feature.id}/manifest.json
                  </code>
                  （原型图 + 真实截图 + 检查项）；已有材料可直接收集上来。
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[11px]"
                    disabled={evidenceState.status === 'busy' || !projectPath}
                    onClick={(event) => {
                      event.stopPropagation();
                      void collectEvidence();
                    }}
                    data-testid={`collect-acceptance-${feature.id}`}
                  >
                    {evidenceState.status === 'busy' ? (
                      <Spinner className="mr-1 h-3 w-3" />
                    ) : (
                      <ImagePlus className="mr-1 h-3 w-3" />
                    )}
                    补录验收材料
                  </Button>
                  {evidenceState.status === 'done' && (
                    <span className="text-[11px] text-[var(--status-success)]">已收集</span>
                  )}
                  {evidenceState.status === 'error' && (
                    <span className="text-[11px] text-[var(--status-error)]">
                      {evidenceState.message}
                    </span>
                  )}
                </div>
              </div>
            )}
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
