import type { Request, Response } from 'express';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import { collectAcceptanceEvidence } from '../../../services/acceptance-evidence-service.js';
import { WorktreeResolver } from '../../../services/worktree-resolver.js';
import type { EventEmitter } from '../../../lib/events.js';

/** Import artifacts from the task's own worktree; the browser cannot choose source files. */
export function createAcceptanceEvidenceHandler(
  featureLoader: FeatureLoader,
  events?: EventEmitter
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body ?? {};
      if (
        typeof projectPath !== 'string' ||
        typeof featureId !== 'string' ||
        !/^[a-zA-Z0-9_-]+$/.test(featureId)
      ) {
        res
          .status(400)
          .json({ success: false, error: 'projectPath and a valid featureId are required' });
        return;
      }
      const feature = await featureLoader.get(projectPath, featureId);
      if (!feature) {
        res.status(404).json({ success: false, error: 'Feature not found' });
        return;
      }
      const worktrees = await new WorktreeResolver().listWorktrees(projectPath);
      const worktree = feature.branchName
        ? worktrees.find((tree) => tree.branch === feature.branchName)
        : worktrees.find((tree) => tree.isMain);
      if (!worktree) throw new Error('Feature worktree not found');
      const evidence = await collectAcceptanceEvidence(projectPath, featureId, worktree.path);
      if (!evidence) {
        res
          .status(404)
          .json({ success: false, error: 'No acceptance manifest found for this task' });
        return;
      }
      const updated = await featureLoader.update(projectPath, featureId, {
        acceptanceEvidence: evidence,
        ...(feature.error?.startsWith('Acceptance evidence could not be imported:')
          ? { error: undefined }
          : {}),
        ...(feature.executionNotice?.message.startsWith(
          'Acceptance evidence could not be imported:'
        )
          ? { executionNotice: undefined }
          : {}),
      });
      // Other open boards must refresh too; importing through one dialog or API
      // should not leave a previous import error cached in another browser.
      events?.emit('auto-mode:event', {
        type: 'features_reconciled',
        projectPath,
        featureId,
        reconciledCount: 1,
        reconciledFeatureIds: [featureId],
        reason: 'acceptance_evidence_imported',
      });
      res.json({ success: true, feature: updated });
    } catch (error) {
      res.status(400).json({ success: false, error: (error as Error).message });
    }
  };
}
