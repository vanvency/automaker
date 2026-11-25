import {
  hasFeatureAttentionError,
  type Feature,
  type WorktreeProgressItem,
} from '@automaker/types';
import { createFeatureMap, getBlockingDependenciesFromMap } from '@automaker/dependency-resolver';

export interface RoutineFinding {
  title: string;
  reason: string;
  featureId?: string;
  branch?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** Read-only summaries of recorded evidence; counts never imply a passed audit. */
export function summarizeProjectRoutines(
  features: Feature[],
  worktrees: WorktreeProgressItem[],
  runningFeatureIds: ReadonlySet<string>,
  now: number
) {
  const tasks = features.filter((feature) => !feature.archive && !feature.supersededBy);
  const trees = worktrees.filter((tree) => !tree.checkoutMissing && !tree.manuallyArchived);
  const done = (feature: Feature) => ['verified', 'completed'].includes(feature.status ?? '');
  const active = (feature: Feature) =>
    ['in_progress', 'running'].includes(feature.status ?? '') ||
    feature.status?.startsWith('pipeline_');
  const recently = (date: string | undefined | null, days: number) => {
    const time = Date.parse(date ?? '');
    return Number.isFinite(time) && time <= now && time >= now - days * DAY;
  };
  const finding = (feature: Feature, reason: string): RoutineFinding => ({
    title: feature.title || feature.jiraKey || feature.id,
    reason,
    featureId: feature.id,
    branch: feature.branchName || undefined,
  });
  const treeFinding = (tree: WorktreeProgressItem, reason: string): RoutineFinding => ({
    title: tree.branch,
    branch: tree.branch,
    reason,
  });
  const featureMap = createFeatureMap(features);
  const blockers = (feature: Feature) => [
    ...getBlockingDependenciesFromMap(feature, featureMap),
    ...(feature.dependencies ?? []).filter((id) => !featureMap.has(id)),
  ];
  const blocked = tasks.filter((feature) => !done(feature) && blockers(feature).length > 0);
  const failedValidation = tasks.filter(
    (feature) =>
      feature.passes === false ||
      feature.acceptanceEvidence?.status === 'failed' ||
      feature.acceptanceEvidence?.checks.some((check) => check.status === 'failed')
  );
  const conflicts = trees.filter((tree) => tree.hasConflicts);
  const dirty = trees.filter((tree) => tree.hasChanges);
  const attention = tasks.filter(
    (feature) =>
      ['failed', 'error', 'interrupted', 'merge_conflict'].includes(feature.status ?? '') ||
      hasFeatureAttentionError(feature) ||
      feature.acceptanceEvidence?.status === 'blocked'
  );
  const deliveryFailures = tasks.filter(
    (feature) => feature.deliveryCompletion?.status === 'failed'
  );
  const waiting = tasks.filter((feature) => feature.status === 'waiting_approval');
  const missingMrs = tasks.filter(
    (feature) =>
      ['waiting_approval', 'verified'].includes(feature.status ?? '') &&
      !(feature.mergeRequests?.length || feature.changedProjects?.some((project) => project.mrUrl))
  );
  const recent = tasks.filter((feature) => recently(feature.updatedAt, 1));
  const missingEvidence = recent.filter((feature) => !feature.acceptanceEvidence);
  const recentTips = trees.filter((tree) => recently(tree.head?.date, 1));
  // ponytail: 24h since recorded task activity is a triage hint, not an agent heartbeat.
  const stale = tasks.filter((feature) => {
    const time = Date.parse(feature.updatedAt || feature.startedAt || '');
    return active(feature) && !feature.worktreeSnooze && Number.isFinite(time) && now - time >= DAY;
  });
  const untracked = tasks.filter(
    (feature) => active(feature) && !feature.worktreeSnooze && !runningFeatureIds.has(feature.id)
  );
  return [
    {
      metrics: [
        ['Tasks blocked by dependencies', blocked.length],
        ['Recorded validation failures', failedValidation.length],
        ['Worktrees with conflicts', conflicts.length],
        ['Worktrees with local changes', dirty.length],
      ] as const,
      findings: [
        ...conflicts.map((tree) => treeFinding(tree, 'Unresolved Git conflict')),
        ...failedValidation.map((feature) => finding(feature, 'Recorded validation failed')),
        ...blocked.map((feature) =>
          finding(feature, `${blockers(feature).length} unresolved task dependencies`)
        ),
        ...dirty.map((tree) => treeFinding(tree, `${tree.changedFilesCount} changed files`)),
      ],
      note: 'Task dependencies and recorded validation only. Package vulnerabilities have not been scanned.',
    },
    {
      metrics: [
        [
          'Tasks updated in the last 7 days',
          tasks.filter((feature) => recently(feature.updatedAt, 7)).length,
        ],
        ['Tasks awaiting review', waiting.length],
        ['Failed delivery workflows', deliveryFailures.length],
        ['Review / verified tasks without recorded MR', missingMrs.length],
      ] as const,
      findings: [
        ...deliveryFailures.map((feature) => finding(feature, 'Delivery workflow failed')),
        ...attention.map((feature) => finding(feature, 'Needs attention before delivery')),
        ...missingMrs.map((feature) => finding(feature, 'No PR / MR recorded on the task')),
        ...waiting.map((feature) => finding(feature, 'Human review pending')),
      ],
      note: 'Project-wide release risks, including older blockers. Live MR approval, CI and mergeability have not been checked.',
    },
    {
      metrics: [
        ['Tasks updated in the last 24 hours', recent.length],
        ['Recent tasks without acceptance evidence', missingEvidence.length],
        ['Recent tasks with tests skipped', recent.filter((feature) => feature.skipTests).length],
        ['Worktrees with a tip commit in 24 hours', recentTips.length],
      ] as const,
      findings: [
        ...recent.map((feature) =>
          finding(
            feature,
            !feature.acceptanceEvidence
              ? 'No recorded acceptance evidence'
              : `Recorded acceptance: ${feature.acceptanceEvidence.status}`
          )
        ),
        ...recentTips.map((tree) =>
          treeFinding(tree, `Tip ${tree.head!.sha}: ${tree.head!.subject}`)
        ),
      ],
      note: 'Activity and evidence gaps to review. This is not a completed correctness, UX or test coverage assessment.',
    },
    {
      metrics: [
        ['Tasks needing attention', attention.length],
        ['Active tasks without a tracked agent', untracked.length],
        ['Active tasks unchanged for 24 hours', stale.length],
        ['Recorded validation failures', failedValidation.length],
      ] as const,
      findings: [
        ...untracked.map((feature) =>
          finding(feature, 'No tracked agent; inspect the session before retrying')
        ),
        ...stale.map((feature) =>
          finding(feature, 'No recorded task update for 24 hours; may still be working')
        ),
        ...attention.map((feature) => finding(feature, 'Task requires attention')),
        ...failedValidation.map((feature) => finding(feature, 'Recorded validation failed')),
      ],
      note: 'Agent tracking and task timestamps are triage signals. Generated-file freshness has not been checked.',
    },
  ];
}
