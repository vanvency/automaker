import type { Request, Response } from 'express';
import type { TaskArchiveService } from '../../../services/task-archive-service.js';

export function createArchiveHandler(service: TaskArchiveService, restore = false) {
  return async (req: Request, res: Response) => {
    try {
      const { projectPath, featureId, featureIds, archive } = req.body ?? {};
      if (typeof projectPath !== 'string' || !projectPath) throw new Error('projectPath required');
      if (restore) {
        if (typeof featureId !== 'string' || !/^[\w-]+$/.test(featureId))
          throw new Error('Valid featureId required');
        res.json({ success: true, feature: await service.restore(projectPath, featureId) });
      } else {
        const features = await service.archive(projectPath, featureIds ?? [featureId], archive);
        res.json({ success: true, features, archivedCount: features.length });
      }
    } catch (error) {
      res.status(400).json({ success: false, error: (error as Error).message });
    }
  };
}
