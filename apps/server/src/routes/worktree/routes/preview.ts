import type { Request, Response } from 'express';
import { worktreePreviewService } from '../../../services/worktree-preview-service.js';

export function createPreviewHandler(action: 'status' | 'start' | 'stop') {
  return async (req: Request, res: Response): Promise<void> => {
    const { projectPath, worktreePath } = req.body ?? {};
    if (
      typeof projectPath !== 'string' ||
      !projectPath ||
      typeof worktreePath !== 'string' ||
      !worktreePath
    ) {
      res.status(400).json({ success: false, error: 'projectPath and worktreePath are required' });
      return;
    }
    try {
      if (action === 'status') {
        res.json(await worktreePreviewService.status(projectPath, worktreePath));
      } else {
        const preview = await worktreePreviewService[action](projectPath, worktreePath);
        res.status(action === 'start' ? 202 : 200).json({ success: true, preview });
      }
    } catch (error) {
      res.status(400).json({ success: false, error: (error as Error).message });
    }
  };
}
