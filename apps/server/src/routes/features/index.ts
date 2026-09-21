import {
  createCompletionProgressHandler,
  createCompletionRepairHandler,
} from './routes/completion-progress.js';
/**
 * Features routes - HTTP API for feature management
 */

import { Router } from 'express';
import { FeatureLoader } from '../../services/feature-loader.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { AutoModeServiceCompat } from '../../services/auto-mode/index.js';
import type { EventEmitter } from '../../lib/events.js';
import { validatePathParams } from '../../middleware/validate-paths.js';
import { createListHandler } from './routes/list.js';
import { TaskArchiveService } from '../../services/task-archive-service.js';
import { createArchiveHandler } from './routes/archive.js';
import { createAcceptanceEvidenceHandler } from './routes/acceptance-evidence.js';
import { createCompleteHandler } from './routes/complete.js';
import {
  createMergeConflictCheckHandler,
  createResolveConflictsHandler,
} from './routes/merge-conflicts.js';
import { createGetHandler } from './routes/get.js';
import { createCreateHandler } from './routes/create.js';
import { createUpdateHandler } from './routes/update.js';
import { createBulkUpdateHandler } from './routes/bulk-update.js';
import { createAgentOutputHandler, createRawOutputHandler } from './routes/agent-output.js';
import { createOpenCodeWebHandler } from './routes/opencode-web.js';
import { createPiWebHandler } from './routes/pi-web.js';
import { createHerdrWebHandler } from './routes/herdr-web.js';
import { createHerdrDispatchHandler, createHerdrTaskStatusHandler } from './routes/herdr-task.js';
import { createFeatureTimelineHandler } from './routes/timeline.js';
import { createConversationSearchHandler } from './routes/conversation-search.js';
import { createGenerateTitleHandler } from './routes/generate-title.js';
import { createExportHandler } from './routes/export.js';
import { createImportHandler, createConflictCheckHandler } from './routes/import.js';
import {
  createOrphanedListHandler,
  createOrphanedResolveHandler,
  createOrphanedBulkResolveHandler,
} from './routes/orphaned.js';

export function createFeaturesRoutes(
  featureLoader: FeatureLoader,
  settingsService?: SettingsService,
  events?: EventEmitter,
  autoModeService?: AutoModeServiceCompat
): Router {
  const router = Router();
  router.use(['/update', '/bulk-update'], async (req, res, next) => {
    const updates = req.body?.updates;
    if (updates && ('archive' in updates || 'archiveHistory' in updates)) {
      res.status(400).json({
        success: false,
        error: 'Use the archive/restore-archive endpoints to change archive records',
      });
      return;
    }
    next();
  });
  const archives = new TaskArchiveService(featureLoader, async (project) =>
    ((await autoModeService?.getRunningAgents()) ?? [])
      .filter((agent) => agent.projectPath === project)
      .map((agent) => agent.featureId)
  );
  router.post('/archive', validatePathParams('projectPath'), createArchiveHandler(archives));
  router.post(
    '/restore-archive',
    validatePathParams('projectPath'),
    createArchiveHandler(archives, true)
  );
  // Legacy public deletion endpoints now require archive metadata and preserve all files.
  router.post('/delete', validatePathParams('projectPath'), createArchiveHandler(archives));
  router.post('/bulk-delete', validatePathParams('projectPath'), createArchiveHandler(archives));

  router.post(
    '/acceptance-evidence',
    validatePathParams('projectPath'),
    createAcceptanceEvidenceHandler(featureLoader)
  );

  router.post(
    '/list',
    validatePathParams('projectPath'),
    createListHandler(featureLoader, autoModeService)
  );
  router.get(
    '/list',
    validatePathParams('projectPath'),
    createListHandler(featureLoader, autoModeService)
  );
  router.post(
    '/complete',
    validatePathParams('projectPath'),
    createCompleteHandler(featureLoader, settingsService, async (project) =>
      ((await autoModeService?.getRunningAgents()) ?? [])
        .filter((agent) => agent.projectPath === project)
        .map((agent) => agent.featureId)
    )
  );
  router.post(
    '/completion-progress',
    validatePathParams('projectPath'),
    createCompletionProgressHandler(featureLoader)
  );
  router.post(
    '/completion-repair',
    validatePathParams('projectPath'),
    createCompletionRepairHandler(featureLoader, autoModeService)
  );
  router.post('/get', validatePathParams('projectPath'), createGetHandler(featureLoader));
  router.post(
    '/mr-conflicts',
    validatePathParams('projectPath'),
    createMergeConflictCheckHandler(featureLoader, settingsService)
  );
  router.post(
    '/resolve-conflicts',
    validatePathParams('projectPath'),
    createResolveConflictsHandler(featureLoader, settingsService, autoModeService)
  );
  router.post(
    '/create',
    validatePathParams('projectPath'),
    createCreateHandler(featureLoader, events)
  );
  router.post(
    '/update',
    validatePathParams('projectPath'),
    createUpdateHandler(featureLoader, events, settingsService)
  );
  router.post(
    '/bulk-update',
    validatePathParams('projectPath'),
    createBulkUpdateHandler(featureLoader)
  );
  router.post('/agent-output', createAgentOutputHandler(featureLoader));
  router.post('/opencode-web', createOpenCodeWebHandler(featureLoader));
  router.post('/pi-web', createPiWebHandler(featureLoader));
  router.post('/herdr-web', createHerdrWebHandler(featureLoader, events));
  router.get('/herdr-task', createHerdrTaskStatusHandler(featureLoader));
  router.post('/herdr-dispatch', createHerdrDispatchHandler(featureLoader, events));
  router.post('/timeline', createFeatureTimelineHandler(featureLoader));
  router.post(
    '/conversation-search',
    validatePathParams('projectPath'),
    createConversationSearchHandler()
  );
  router.post('/raw-output', createRawOutputHandler(featureLoader));
  router.post('/generate-title', createGenerateTitleHandler(settingsService));
  router.post('/export', validatePathParams('projectPath'), createExportHandler(featureLoader));
  router.post('/import', validatePathParams('projectPath'), createImportHandler(featureLoader));
  router.post(
    '/check-conflicts',
    validatePathParams('projectPath'),
    createConflictCheckHandler(featureLoader)
  );
  router.post(
    '/orphaned',
    validatePathParams('projectPath'),
    createOrphanedListHandler(featureLoader, autoModeService)
  );
  router.post(
    '/orphaned/resolve',
    validatePathParams('projectPath'),
    createOrphanedResolveHandler(featureLoader, autoModeService)
  );
  router.post(
    '/orphaned/bulk-resolve',
    validatePathParams('projectPath'),
    createOrphanedBulkResolveHandler(featureLoader)
  );

  return router;
}
