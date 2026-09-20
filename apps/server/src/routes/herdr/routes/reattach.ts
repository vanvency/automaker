import path from 'node:path';
import type { Request, Response } from 'express';
import { validatePath } from '@automaker/platform';
import { execGitCommand } from '../../../lib/git.js';
import { getTerminalService } from '../../../services/terminal-service.js';
import { getHerdrService } from '../../../services/herdr-service.js';

/**
 * Recreate only the browser's PTY attachment. Never restart Pi or submit a prompt.
 * Old URLs contain only dir/name: derive the project from Git's common directory
 * rather than trusting a caller-provided herdr session name.
 */
export function createHerdrReattachHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, workDir } = req.body ?? {};
      if (
        typeof workDir !== 'string' ||
        !workDir ||
        (projectPath !== undefined && (typeof projectPath !== 'string' || !projectPath))
      ) {
        res.status(400).json({ success: false, error: 'workDir is required' });
        return;
      }
      validatePath(workDir);
      let project = projectPath as string | undefined;
      if (!project) {
        const common = (
          await execGitCommand(['rev-parse', '--path-format=absolute', '--git-common-dir'], workDir)
        ).trim();
        project = path.basename(common) === '.git' ? path.dirname(common) : workDir;
      }
      validatePath(project);
      const attach = await getHerdrService(getTerminalService()).attachWorktreeSession({
        projectPath: project,
        workDir,
      });
      res.json({ success: true, ...attach, projectPath: project });
    } catch (error) {
      res.status(400).json({ success: false, error: (error as Error).message });
    }
  };
}
