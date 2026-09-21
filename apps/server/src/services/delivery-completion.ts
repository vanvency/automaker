import type { Feature, FeatureDelivery } from '@automaker/types';
import type { FeatureLoader } from './feature-loader.js';
import { WorktreeResolver } from './worktree-resolver.js';
import { worktreePreviewService } from './worktree-preview-service.js';

export const activeDeliveryProjects = new Set<string>();
export const activeCompletions = new Set<string>();
export const activeCompletionRepairs = new Set<string>();
export const completionKey = (project: string, id: string) => `${project}:${id}`;
export const deliverySteps = ['merge', 'jira', 'preview'] as const;

export function newDelivery(previous?: FeatureDelivery): FeatureDelivery {
  return {
    status: 'running',
    updatedAt: new Date().toISOString(),
    steps: deliverySteps.map((id) => {
      const prior = previous?.steps.find((step) => step.id === id);
      return prior && prior.status !== 'running' ? prior : { id, status: 'pending' };
    }),
  };
}

/** Stop only the preview owned by this worktree, never another task's shared environment. */
export async function releaseDeliveryPreview(
  loader: FeatureLoader,
  project: string,
  feature: Feature
) {
  const resolver = new WorktreeResolver();
  const trees = await resolver.listWorktrees(project);
  const tree = feature.branchName
    ? trees.find((t) => t.branch === feature.branchName)
    : trees.find((t) => t.isMain);
  if (!tree)
    throw new Error('找不到任务 worktree，无法确认预览资源是否已释放。请恢复 worktree 后重试。');
  const others = (await loader.getAll(project)).filter(
    (f) =>
      f.id !== feature.id &&
      (f.branchName
        ? trees.find((candidate) => candidate.branch === f.branchName)?.path
        : trees.find((candidate) => candidate.isMain)?.path) === tree.path &&
      !f.archive &&
      !f.supersededBy &&
      f.status !== 'completed'
  );
  if (others.length)
    return {
      status: 'skipped' as const,
      message: `预览由同 worktree 的 ${others.length} 个未完成任务共用，保留供它们验收。`,
    };
  const state = await worktreePreviewService.stop(project, tree.path);
  return {
    status: state ? ('succeeded' as const) : ('skipped' as const),
    message: state
      ? '已释放此 worktree 的 Automaker 托管预览 Deployment、Service 和 Ingress；保留源码与分支。'
      : '此 worktree 没有 Automaker 托管预览资源。外部手工部署不在自动回收范围内。',
  };
}
