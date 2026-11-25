import type { EventEmitter } from '../lib/events.js';
import { createLogger } from '@automaker/utils';
import type { FeatureLoader } from './feature-loader.js';
import { WorktreeResolver } from './worktree-resolver.js';
import { worktreePreviewService } from './worktree-preview-service.js';

const logger = createLogger('AutoPreviewOnCompletion');

/** A completed Agent run redeploys only its own configured task worktree. */
export class AutoPreviewOnCompletion {
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    events: EventEmitter,
    private readonly features: Pick<FeatureLoader, 'get'>,
    private readonly worktrees: Pick<
      WorktreeResolver,
      'findWorktreeForBranch'
    > = new WorktreeResolver(),
    private readonly previews: Pick<
      typeof worktreePreviewService,
      'config' | 'status' | 'start'
    > = worktreePreviewService
  ) {
    events.subscribe((type, payload) => {
      if (type !== 'auto-mode:event') return;
      const event = payload as {
        type?: string;
        featureId?: string;
        projectPath?: string;
        status?: string;
      };
      if (
        event.type !== 'feature_status_changed' ||
        !['waiting_approval', 'verified'].includes(event.status ?? '') ||
        !event.projectPath ||
        !event.featureId
      )
        return;
      void this.schedule(event.projectPath, event.featureId).catch((error) =>
        logger.warn(`Could not schedule preview for ${event.featureId}:`, error)
      );
    });
  }

  private async schedule(project: string, featureId: string) {
    const feature = await this.features.get(project, featureId);
    if (!feature?.lastExecutionCompletedAt || !feature.branchName || feature.archive) return;
    const worktree = await this.worktrees.findWorktreeForBranch(project, feature.branchName);
    if (!worktree) return;
    const key = `${project}\0${worktree}`;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        void this.deploy(project, worktree, featureId).catch((error) =>
          logger.warn(`Automatic preview deployment failed for ${featureId}:`, error)
        );
      }, 2000)
    );
  }

  private async deploy(project: string, worktree: string, featureId: string): Promise<void> {
    const feature = await this.features.get(project, featureId);
    if (
      !feature?.lastExecutionCompletedAt ||
      feature.archive ||
      !['waiting_approval', 'verified'].includes(feature.status ?? '') ||
      (await this.worktrees.findWorktreeForBranch(project, feature.branchName ?? '')) !==
        worktree ||
      !(await this.previews.config(project, worktree))
    )
      return;
    const { preview } = await this.previews.status(project, worktree);
    if (preview?.status === 'deploying' || preview?.status === 'stopping') {
      this.pending.set(
        `${project}\0${worktree}`,
        setTimeout(() => {
          this.pending.delete(`${project}\0${worktree}`);
          void this.deploy(project, worktree, featureId).catch((error) =>
            logger.warn(`Automatic preview deployment failed for ${featureId}:`, error)
          );
        }, 5000)
      );
      return;
    }
    const lastAttempt = preview?.deploymentStartedAt ?? preview?.updatedAt;
    if (lastAttempt && Date.parse(lastAttempt) >= Date.parse(feature.lastExecutionCompletedAt))
      return;
    await this.previews.start(project, worktree);
  }
}
