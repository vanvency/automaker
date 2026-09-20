import { Router } from 'express';
import { validatePathParams } from '../../middleware/validate-paths.js';
import type { TaskConsolidationService } from '../../services/task-consolidation-service.js';

export function createTaskConsolidationRoutes(service: TaskConsolidationService) {
  const router = Router();
  for (const action of ['list', 'plan', 'apply', 'cancel'] as const) {
    router.post(`/${action}`, validatePathParams('projectPath'), async (req, res) => {
      try {
        const { projectPath, keepId, retireId, reason, planId, selection, confirmation } =
          req.body ?? {};
        if (typeof projectPath !== 'string' || !projectPath)
          throw new Error('projectPath required');
        const result =
          action === 'list'
            ? await service.list(projectPath)
            : action === 'plan'
              ? await service.plan(projectPath, keepId, retireId, reason)
              : action === 'cancel'
                ? await service.cancel(projectPath, planId, confirmation)
                : await service.apply(projectPath, planId, selection, confirmation);
        res.json({ success: true, result });
      } catch (error) {
        res.status(400).json({ success: false, error: (error as Error).message });
      }
    });
  }
  return router;
}
