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

export function createPreviewConfigHandler(action: 'read' | 'save') {
  return async (req: Request, res: Response): Promise<void> => {
    const { projectPath, content, revision } = req.body ?? {};
    if (typeof projectPath !== 'string' || !projectPath) {
      res.status(400).json({ success: false, error: 'projectPath is required' });
      return;
    }
    try {
      const config =
        action === 'read'
          ? await worktreePreviewService.readProjectConfig(projectPath)
          : await worktreePreviewService.saveProjectConfig(projectPath, content, revision);
      res.json({ success: true, ...config });
    } catch (error) {
      const message = (error as Error).message;
      res.status(message.includes('changed since it was opened') ? 409 : 400).json({
        success: false,
        error: message,
      });
    }
  };
}
