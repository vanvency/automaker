import { activeDeliveryProjects } from '../../../services/delivery-completion.js';
/**
 * GET /api/features/herdr-task?projectPath=...&featureId=... - status of the
 * feature's herdr task.
 *
 * The board uses this to show leader/worker state without opening a terminal.
 * The feature stores its herdr placement under `herdrWorkspaceId` (the worktree's
 * space) and `herdrTabId` (the task's tab) when the task is dispatched, so this
 * route never guesses by label (two features can legitimately share a title).
 */

import { validateWorkingDirectory } from '../../../lib/sdk-options.js';
import type { Request, Response } from 'express';
import { FeatureLoader } from '../../../services/feature-loader.js';
import { FeatureStateManager } from '../../../services/feature-state-manager.js';
import { getHerdrTaskService, isLeaderAgentName } from '../../../services/herdr-task-service.js';
import { HerdrScheduler } from '../../../services/herdr-scheduler.js';
import { createEventEmitter, type EventEmitter } from '../../../lib/events.js';
import { TaskScopeError } from '../../../services/task-scope.js';
import { WorktreeResolver } from '../../../services/worktree-resolver.js';
import { getErrorMessage, logError } from '../common.js';

interface HerdrTaskStatus {
  workspaceId: string;
  tabId: string | null;
  label: string;
  leaderPaneId: string | null;
  agents: Array<{
    paneId: string;
    name: string | null;
    agent: string | null;
    status: string;
  }>;
}

export function createHerdrTaskStatusHandler(featureLoader: FeatureLoader) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.query as {
        projectPath?: string;
        featureId?: string;
      };
      if (!projectPath || !featureId) {
        res.status(400).json({ success: false, error: 'projectPath and featureId are required' });
        return;
      }

      const feature = await featureLoader.get(projectPath, featureId);
      if (!feature) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }

      const workspaceId = feature.herdrWorkspaceId;
      if (!workspaceId) {
        res.json({ success: true, status: null });
        return;
      }

      // A card placed by the one-space-per-task layout has no tab id; there the
      // workspace *is* the task, so listing its agents is the task's status.
      const tabId = feature.herdrTabId ?? null;
      const service = getHerdrTaskService(projectPath);
      const agents = await service.listTaskAgents(workspaceId, tabId ?? undefined);
      const leader =
        agents.find(
          (agent) => agent.agent === 'pi' && tabId !== null && isLeaderAgentName(agent.name, tabId)
        ) ?? agents.find((agent) => agent.agent === 'pi');
      const status: HerdrTaskStatus = {
        workspaceId,
        tabId,
        label: feature.title || featureId,
        leaderPaneId: leader?.pane_id ?? null,
        agents: agents.map((agent) => ({
          paneId: agent.pane_id,
          name: agent.name ?? null,
          agent: agent.agent,
          status: agent.agent_status,
        })),
      };
      res.json({ success: true, status });
    } catch (error) {
      logError(error, 'Read herdr task status failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}

/**
 * POST /api/features/herdr-dispatch - dispatch a feature through herdr.
 *
 * Experimental P3 entry point: leader plans, workers execute, and progress is
 * persisted on the feature so the existing board can follow it.
 */
export function createHerdrDispatchHandler(featureLoader: FeatureLoader, events?: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        projectPath,
        featureId,
        workDir: requestedWorkDir,
      } = req.body as {
        projectPath?: string;
        featureId?: string;
        workDir?: string;
      };
      if (!projectPath || !featureId) {
        res.status(400).json({
          success: false,
          error: 'projectPath and featureId are required',
        });
        return;
      }

      if (activeDeliveryProjects.has(projectPath))
        throw new Error('Complete is running; wait before dispatch');
      const feature = await featureLoader.get(projectPath, featureId);
      if (!feature) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }

      const assignedWorktree = feature.branchName
        ? await new WorktreeResolver().findWorktreeForBranch(projectPath, feature.branchName)
        : null;
      if (feature.branchName && !assignedWorktree && !requestedWorkDir) {
        res
          .status(409)
          .json({ success: false, error: 'Task worktree is missing; restore it before dispatch' });
        return;
      }
      const workDir = requestedWorkDir || assignedWorktree || projectPath;
      validateWorkingDirectory(projectPath);
      validateWorkingDirectory(workDir);
      if (feature.archive || feature.supersededBy || feature.consolidationPlanId) {
        res.status(409).json({ success: false, error: 'Task is covered or being consolidated' });
        return;
      }
      // FeatureStateManager subscribes to the bus on construction, so it needs a
      // real emitter - an object with only `emit` throws before dispatch starts.
      const stateManager = new FeatureStateManager(events ?? createEventEmitter(), featureLoader);
      const scheduler = new HerdrScheduler(getHerdrTaskService(projectPath), null, {
        persistTarget: async ({ projectPath, featureId, workspaceId, tabId }) => {
          await stateManager.updateFeatureFields(projectPath, featureId, {
            herdrWorkspaceId: workspaceId,
            herdrTabId: tabId,
          });
        },
        persistTasks: async (projectPath, featureId, plan, tasks) => {
          await stateManager.updateFeaturePlanSpec(projectPath, featureId, {
            status: 'approved',
            content: plan,
            tasks,
            tasksTotal: tasks.length,
            tasksCompleted: 0,
            generatedAt: new Date().toISOString(),
          });
        },
        // Jira did not split this card: keep the leader's split as a proposal and
        // wait for a human. Only after the approval are Jira sub-tasks created,
        // and only then do the workers run.
        persistProposal: async (projectPath, featureId, plan, tasks) => {
          await stateManager.updateFeaturePlanSpec(projectPath, featureId, {
            status: 'generated',
            content: plan,
            tasks,
            tasksTotal: tasks.length,
            tasksCompleted: 0,
            generatedAt: new Date().toISOString(),
          });
          await stateManager.updateFeatureFields(projectPath, featureId, {
            decompositionRequest: {
              status: 'proposed',
              createdAt: new Date().toISOString(),
              tasks: tasks.map((task) => ({
                id: task.id,
                description: task.description,
                filePath: task.filePath,
                phase: task.phase,
              })),
            },
          });
        },
        persistTaskStatus: async (projectPath, featureId, taskId, status) => {
          await stateManager.updateTaskStatus(projectPath, featureId, taskId, status);
        },
      });

      let result;
      try {
        result = await scheduler.dispatch({ projectPath, feature, workDir });
      } finally {
        // The scheduler's persist callbacks are done, so the subscription this
        // state manager added to the bus can go.
        stateManager.destroy();
      }
      res.json({
        success: true,
        status: result.status,
        workspaceId: result.workspaceId,
        tabId: result.tabId,
        tasks: result.tasks,
        ...(result.status === 'awaiting_approval'
          ? {
              message:
                'Split proposed. Approve the plan on the card; the Jira sub-tasks are ' +
                'created after that and the sub-tasks are dispatched then.',
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof TaskScopeError) {
        // The card's scope (Jira already split it, or only a human may split it)
        // forbids this dispatch - tell the caller instead of inventing a split.
        res.status(409).json({ success: false, code: error.code, error: error.message });
        return;
      }
      logError(error, 'Herdr dispatch failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
