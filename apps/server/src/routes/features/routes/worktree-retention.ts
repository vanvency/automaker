/**
 * Done-lane worktree retention endpoints.
 *
 * The hourly job is the normal path. These endpoints expose the same service so
 * the board can explain what would be released (`dryRun`) and rebuild a
 * checkout the moment a card is picked up again.
 */

import type { Request, Response } from 'express';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import type { AutoModeServiceCompat } from '../../../services/auto-mode/index.js';
import {
  WorktreeRetentionService,
  type WorktreeRetentionDeps,
} from '../../../services/worktree-retention-service.js';
import { getErrorMessage, logError } from '../common.js';

/** A card with a live agent is never released. */
function runningProbe(autoModeService?: AutoModeServiceCompat) {
  return async (projectPath: string) =>
    ((await autoModeService?.getRunningAgents()) ?? [])
      .filter((agent) => agent.projectPath === projectPath)
      .map((agent) => agent.featureId);
}

export function createWorktreeRetentionService(
  loader: FeatureLoader,
  autoModeService?: AutoModeServiceCompat,
  deps: WorktreeRetentionDeps = {}
): WorktreeRetentionService {
  return new WorktreeRetentionService(loader, { running: runningProbe(autoModeService), ...deps });
}

/** POST /api/features/release-stale-worktrees - run (or preview) the retention rule. */
export function createReleaseStaleWorktreesHandler(
  loader: FeatureLoader,
  autoModeService?: AutoModeServiceCompat,
  deps: WorktreeRetentionDeps = {}
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, days, dryRun } = req.body ?? {};
      if (typeof projectPath !== 'string' || !projectPath) {
        res.status(400).json({ success: false, error: 'projectPath is required' });
        return;
      }
      const service = createWorktreeRetentionService(loader, autoModeService, deps);
      const result = await service.run(projectPath, {
        ...(typeof days === 'number' && days > 0 ? { days } : {}),
        dryRun: dryRun === true,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      logError(error, 'Release stale worktrees failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}

/** POST /api/features/rebuild-worktree - restore a released checkout from its branch. */
export function createRebuildWorktreeHandler(
  loader: FeatureLoader,
  deps: WorktreeRetentionDeps = {}
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body ?? {};
      if (typeof projectPath !== 'string' || typeof featureId !== 'string') {
        res.status(400).json({ success: false, error: 'projectPath and featureId are required' });
        return;
      }
      const feature = await loader.get(projectPath, featureId);
      if (!feature) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }
      const workDir = await createWorktreeRetentionService(loader, undefined, deps).ensureWorktree(
        projectPath,
        feature
      );
      if (!workDir) {
        res.status(409).json({
          success: false,
          error: '任务没有关联分支，无法重建 worktree',
        });
        return;
      }
      res.json({ success: true, workDir });
    } catch (error) {
      logError(error, 'Rebuild worktree failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
