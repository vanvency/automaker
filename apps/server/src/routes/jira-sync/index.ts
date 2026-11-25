import { Router } from 'express';
import { validatePathParams } from '../../middleware/validate-paths.js';
import type { JiraSyncService } from '../../services/jira-sync-service.js';

export function createJiraSyncRoutes(service: JiraSyncService) {
  const router = Router();
  for (const [action, execute] of [
    ['reset-preview', false],
    ['reset-work', true],
  ] as const) {
    router.post(`/${action}`, validatePathParams('projectPath'), async (req, res) => {
      try {
        const { projectPath, featureId, snapshot } = req.body ?? {};
        if (typeof projectPath !== 'string' || !projectPath)
          throw new Error('projectPath required');
        if (execute && typeof snapshot !== 'string')
          throw new Error('Preview token required before resetting the work');
        res.json({
          success: true,
          result: await service.resetWork(projectPath, featureId, execute ? snapshot : undefined),
        });
      } catch (error) {
        res.status(400).json({ success: false, error: (error as Error).message });
      }
    });
  }
  for (const action of ['status', 'save', 'migrate', 'test', 'preview', 'sync'] as const) {
    router.post(`/${action}`, validatePathParams('projectPath'), async (req, res) => {
      try {
        const { projectPath, config } = req.body ?? {};
        if (typeof projectPath !== 'string' || !projectPath) {
          res.status(400).json({ success: false, error: 'projectPath is required' });
          return;
        }
        const result =
          action === 'status'
            ? await service.status(projectPath)
            : action === 'save'
              ? await service.save(projectPath, config)
              : action === 'migrate'
                ? await service.migrate(projectPath)
                : await service.startRun(projectPath, action, config);
        res.json({ success: true, result });
      } catch (error) {
        res.status(400).json({ success: false, error: (error as Error).message });
      }
    });
  }
  return router;
}
