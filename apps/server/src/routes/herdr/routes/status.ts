/**
 * GET /api/herdr/status - herdr readiness for the control plane.
 *
 * Reports whether herdr is usable and whether the pi integration is installed,
 * so the UI can explain a missing prerequisite instead of failing when a task is
 * dispatched. With `?projectPath=` it also checks that project's session.
 */

import type { Request, Response } from 'express';
import { getHerdrStatus } from '../../../services/herdr-bootstrap.js';

export function createHerdrStatusHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const projectPath =
        typeof req.query.projectPath === 'string' && req.query.projectPath.trim()
          ? req.query.projectPath
          : undefined;
      const status = await getHerdrStatus(projectPath);
      res.json({ success: true, status });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read herdr status',
      });
    }
  };
}
