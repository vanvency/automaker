/**
 * POST /approve-plan endpoint - Approve or reject a generated plan/spec
 */

import type { Request, Response } from 'express';
import type { AutoModeServiceCompat } from '../../../services/auto-mode/index.js';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import { createLogger } from '@automaker/utils';
import { parseTasksFromSpec } from '../../../services/spec-parser.js';
import { getErrorMessage, logError } from '../common.js';

const logger = createLogger('AutoMode');

export function createApprovePlanHandler(
  autoModeService: AutoModeServiceCompat,
  featureLoader?: FeatureLoader
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { featureId, approved, editedPlan, feedback, projectPath } = req.body as {
        featureId: string;
        approved: boolean;
        editedPlan?: string;
        feedback?: string;
        projectPath: string;
      };

      if (!featureId) {
        res.status(400).json({
          success: false,
          error: 'featureId is required',
        });
        return;
      }

      if (typeof approved !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'approved must be a boolean',
        });
        return;
      }

      if (!projectPath) {
        res.status(400).json({
          success: false,
          error: 'projectPath is required',
        });
        return;
      }

      // Note: We no longer check hasPendingApproval here because resolvePlanApproval
      // can handle recovery when pending approval is not in Map but feature has planSpec.status='generated'
      // This supports cases where the server restarted while waiting for approval

      logger.info(
        `[AutoMode] Plan ${approved ? 'approved' : 'rejected'} for feature ${featureId}${
          editedPlan ? ' (with edits)' : ''
        }${feedback ? ` - Feedback: ${feedback}` : ''}`
      );

      // A plan that came from a herdr dispatch is not an auto-mode run: approving
      // it means "create the Jira sub-tasks", not "resume the executor". The
      // monitor creates them (it is the only Jira writer) and dispatches the
      // sub-tasks afterwards.
      const feature = featureLoader ? await featureLoader.get(projectPath, featureId) : null;
      if (feature && featureLoader && feature.decompositionRequest?.status === 'proposed') {
        const request = feature.decompositionRequest;
        const tasks =
          approved && editedPlan !== undefined ? parseTasksFromSpec(editedPlan) : request.tasks;
        if (
          approved &&
          (!tasks.length || new Set(tasks.map((task) => task.id)).size !== tasks.length)
        ) {
          res.status(400).json({
            success: false,
            error: 'The approved plan must contain uniquely numbered tasks',
          });
          return;
        }
        await featureLoader.update(projectPath, featureId, {
          planSpec: feature.planSpec
            ? {
                ...feature.planSpec,
                ...(editedPlan !== undefined ? { content: editedPlan } : {}),
                tasks: tasks.map((task) => ({ ...task, status: 'pending' as const })),
                tasksTotal: tasks.length,
                status: approved ? 'approved' : 'rejected',
              }
            : feature.planSpec,
          decompositionRequest: {
            ...request,
            tasks,
            status: approved ? 'creating-jira' : 'rejected',
            ...(approved ? { approvedAt: new Date().toISOString() } : {}),
          },
        });
        logger.info(
          `[Herdr] Decomposition ${approved ? 'approved' : 'rejected'} for ${featureId}` +
            (approved ? ' - waiting for the Jira sub-tasks' : '')
        );
        res.json({
          success: true,
          approved,
          message: approved
            ? 'Plan approved - Jira sub-tasks will be created, then dispatched'
            : 'Plan rejected - nothing was created',
        });
        return;
      }

      // Resolve the pending approval (with recovery support)
      const result = await autoModeService.resolvePlanApproval(
        projectPath,
        featureId,
        approved,
        editedPlan,
        feedback
      );

      if (!result.success) {
        res.status(500).json({
          success: false,
          error: result.error,
        });
        return;
      }

      res.json({
        success: true,
        approved,
        message: approved
          ? 'Plan approved - implementation will continue'
          : 'Plan rejected - feature execution stopped',
      });
    } catch (error) {
      logError(error, 'Approve plan failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
