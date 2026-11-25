import type { Request, Response } from 'express';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import type { AutoModeServiceCompat } from '../../../services/auto-mode/index.js';
import { getErrorMessage, logError } from '../common.js';
import path from 'node:path';
import { isValidBranchName } from '../common.js';
import { WorktreeResolver } from '../../../services/worktree-resolver.js';
import { getHerdrTaskService } from '../../../services/herdr-task-service.js';
import {
  changingWorkSnoozes,
  readWorkSnoozes,
  writeWorkSnoozes,
} from '../../../services/work-snooze.js';

/** Pause or resume every task attached to one worktree branch. */
export function createSnoozeHandler(
  featureLoader: FeatureLoader,
  autoModeService?: AutoModeServiceCompat
) {
  return async (req: Request, res: Response): Promise<void> => {
    let lock: string | undefined;
    try {
      const { projectPath, branchName, snoozed, reason } = req.body ?? {};
      if (
        typeof projectPath !== 'string' ||
        !projectPath ||
        typeof branchName !== 'string' ||
        !isValidBranchName(branchName) ||
        typeof snoozed !== 'boolean' ||
        (reason !== undefined && (typeof reason !== 'string' || reason.length > 500))
      ) {
        res.status(400).json({
          success: false,
          error: 'projectPath, branchName and snoozed are required',
        });
        return;
      }
      const project = path.resolve(projectPath);
      if (changingWorkSnoozes.has(project)) {
        res.status(409).json({ success: false, error: 'A work snooze update is already running' });
        return;
      }
      changingWorkSnoozes.add(project);
      lock = project;
      const trees = await new WorktreeResolver().listWorktrees(project);
      const tree = trees.find((tree) => tree.branch === branchName);
      const snoozes = await readWorkSnoozes(project);
      if (tree?.isMain || (!tree && !Object.hasOwn(snoozes, branchName))) {
        res.status(400).json({ success: false, error: 'Select an existing non-main worktree' });
        return;
      }
      const features = (await featureLoader.getAll(projectPath)).filter(
        (feature) => feature.branchName === branchName
      );
      if (snoozed) {
        const running = await autoModeService?.getRunningAgents();
        if (
          running?.some(
            (agent) => agent.projectPath === project && agent.branchName === branchName
          ) ||
          features.some(
            (feature) =>
              feature.status === 'in_progress' ||
              feature.status?.startsWith('pipeline_') ||
              running?.some(
                (agent) => agent.projectPath === project && agent.featureId === feature.id
              )
          )
        ) {
          res.status(409).json({
            success: false,
            error: 'Stop the running task or agent before snoozing this worktree',
          });
          return;
        }
        const herdr = getHerdrTaskService(project);
        if (await herdr.isAvailable()) {
          const agents = await herdr.getClient().listAgents();
          if (
            agents.some(
              (agent) =>
                !['idle', 'done'].includes(agent.agent_status) &&
                ((tree &&
                  [agent.cwd, agent.foreground_cwd].some(
                    (cwd) =>
                      cwd &&
                      (path.resolve(cwd) === path.resolve(tree.path) ||
                        path.resolve(cwd).startsWith(path.resolve(tree.path) + path.sep))
                  )) ||
                  features.some(
                    (feature) =>
                      feature.herdrWorkspaceId === agent.workspace_id &&
                      (!feature.herdrTabId || feature.herdrTabId === agent.tab_id)
                  ))
            )
          ) {
            res.status(409).json({
              success: false,
              error: 'Stop the running agent before snoozing this worktree',
            });
            return;
          }
        }
        await autoModeService?.createFacade(projectPath).stopAutoLoop(branchName);
      }
      const value = snoozed
        ? {
            snoozedAt: new Date().toISOString(),
            ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
          }
        : undefined;
      delete snoozes[branchName];
      await writeWorkSnoozes(project, value ? { ...snoozes, [branchName]: value } : snoozes);
      res.json({ success: true, branchName, snoozed });
    } catch (error) {
      logError(error, 'Worktree snooze failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    } finally {
      if (lock) changingWorkSnoozes.delete(lock);
    }
  };
}
