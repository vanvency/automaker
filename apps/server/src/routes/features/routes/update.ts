/**
 * POST /update endpoint - Update a feature
 */

import type { Request, Response } from 'express';
import { FeatureLoader } from '../../../services/feature-loader.js';
import type { Feature, FeatureStatus } from '@automaker/types';
import type { EventEmitter } from '../../../lib/events.js';
import type { SettingsService } from '../../../services/settings-service.js';
import { getErrorMessage, logError } from '../common.js';
import { createLogger } from '@automaker/utils';
import { notifyRunningAgentOfJiraChanges } from '../../../services/jira-change-notifier.js';

const logger = createLogger('features/update');

// Statuses that should trigger syncing to app_spec.txt
const SYNC_TRIGGER_STATUSES: FeatureStatus[] = ['verified', 'completed'];

export function createUpdateHandler(
  featureLoader: FeatureLoader,
  events?: EventEmitter,
  settingsService?: SettingsService
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        projectPath,
        featureId,
        updates,
        descriptionHistorySource,
        enhancementMode,
        preEnhancementDescription,
      } = req.body as {
        projectPath: string;
        featureId: string;
        updates: Partial<Feature>;
        descriptionHistorySource?: 'enhance' | 'edit';
        enhancementMode?: 'improve' | 'technical' | 'simplify' | 'acceptance' | 'ux-reviewer';
        preEnhancementDescription?: string;
      };

      if (!projectPath || !featureId || !updates) {
        res.status(400).json({
          success: false,
          error: 'projectPath, featureId, and updates are required',
        });
        return;
      }

      // Get the current feature to detect status changes
      const currentFeature = await featureLoader.get(projectPath, featureId);
      if (!currentFeature) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }
      const previousStatus = currentFeature.status as FeatureStatus;
      if (currentFeature.archive) {
        res
          .status(409)
          .json({ success: false, error: 'Restore the archived task before editing it' });
        return;
      }
      const newStatus = updates.status as FeatureStatus | undefined;

      const updated = await featureLoader.update(
        projectPath,
        featureId,
        updates,
        descriptionHistorySource,
        enhancementMode,
        preEnhancementDescription
      );

      // A Jira requirement edit that lands while the card is being worked on is
      // forwarded to the running agent: herdr panes accept out-of-band messages.
      const changeKey = (change: { field?: string; before?: string; after?: string }) =>
        `${change.field ?? ''}\u0000${change.before ?? ''}\u0000${change.after ?? ''}`;
      const previousChangeKeys = new Set((currentFeature.jiraChanges ?? []).map(changeKey));
      const freshJiraChanges = (updates.jiraChanges ?? []).filter(
        (change) => !previousChangeKeys.has(changeKey(change))
      );
      if (freshJiraChanges.length > 0) {
        void notifyRunningAgentOfJiraChanges({
          projectPath,
          feature: updated,
          changes: freshJiraChanges,
          settingsService,
        })
          .then((result) => {
            if (!result.sent && result.reason) {
              logger.debug(`Jira change not delivered to the agent: ${result.reason}`);
            }
          })
          .catch((notifyError) =>
            logger.warn(
              `Could not deliver the Jira change to the agent: ${(notifyError as Error).message}`
            )
          );
      }

      // Emit completion event and sync to app_spec.txt when status transitions to verified/completed
      if (newStatus && SYNC_TRIGGER_STATUSES.includes(newStatus) && previousStatus !== newStatus) {
        events?.emit('feature:completed', {
          featureId,
          featureName: updated.title,
          projectPath,
          passes: true,
          message:
            newStatus === 'verified' ? 'Feature verified manually' : 'Feature completed manually',
          executionMode: 'manual',
        });

        try {
          const synced = await featureLoader.syncFeatureToAppSpec(projectPath, updated);
          if (synced) {
            logger.info(
              `Synced feature "${updated.title || updated.id}" to app_spec.txt on status change to ${newStatus}`
            );
          }
        } catch (syncError) {
          // Log the sync error but don't fail the update operation
          logger.error(`Failed to sync feature to app_spec.txt:`, syncError);
        }
      }

      res.json({ success: true, feature: updated });
    } catch (error) {
      logError(error, 'Update feature failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
