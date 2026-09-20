/**
 * POST /api/herdr/preview - attach a herdr workspace to the in-app preview.
 *
 * The Agent sidebar entry is now a live preview of the herdr workspace that
 * manages the current project/worktree. Unlike the feature deep link, there is
 * no feature id here: the UI supplies the project and (optional) worktree path
 * directly and receives the PTY session to embed.
 */

import { existsSync } from 'fs';
import type { Request, Response } from 'express';
import { getTerminalService } from '../../../services/terminal-service.js';
import { getHerdrService, isHerdrAvailable } from '../../../services/herdr-service.js';
import { getErrorMessage } from '../../common.js';

export function createHerdrPreviewHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, workDir, cols, rows } = req.body as {
        projectPath?: string;
        workDir?: string;
        cols?: number;
        rows?: number;
      };

      if (!projectPath || !existsSync(projectPath)) {
        res
          .status(400)
          .json({ success: false, error: 'projectPath must be an existing directory' });
        return;
      }
      if (!isHerdrAvailable()) {
        res.status(503).json({
          success: false,
          error: 'herdr is not installed on this machine (install herdr or set HERDR_BIN)',
        });
        return;
      }

      const directory = workDir && existsSync(workDir) ? workDir : projectPath;
      const herdrService = getHerdrService(getTerminalService());
      const attach = await herdrService.attachWorktreeSession({
        projectPath,
        workDir: directory,
        cols: typeof cols === 'number' && cols > 0 ? cols : undefined,
        rows: typeof rows === 'number' && rows > 0 ? rows : undefined,
      });

      res.json({
        success: true,
        sessionName: attach.sessionName,
        terminalSessionId: attach.terminalSessionId,
        workDir: directory,
        reused: attach.reused,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
