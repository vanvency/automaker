import type { Request, Response } from 'express';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import type { AutoModeServiceCompat } from '../../../services/auto-mode/index.js';
import {
  activeCompletions,
  activeDeliveryProjects,
  activeCompletionRepairs,
  completionKey,
} from '../../../services/delivery-completion.js';

export function createCompletionProgressHandler(loader: FeatureLoader) {
  return async (req: Request, res: Response) => {
    try {
      const { projectPath, featureId } = req.body ?? {};
      if (typeof projectPath !== 'string' || typeof featureId !== 'string')
        throw new Error('Project and task required');
      const feature = await loader.get(projectPath, featureId);
      if (!feature) throw new Error('Task not found');
      let progress = feature.deliveryCompletion;
      if (
        progress?.status === 'running' &&
        !activeCompletions.has(completionKey(projectPath, featureId))
      ) {
        // A process restart can interrupt after an external action succeeded.
        // Mark uncertainty explicitly; retry always re-reads GitLab/Jira first.
        const target =
          progress.steps.find((step) => step.status === 'running') ??
          progress.steps.find((step) => step.status === 'pending');
        progress = {
          ...progress,
          status: 'failed',
          updatedAt: new Date().toISOString(),
          steps: progress.steps.map((step) =>
            step.id === target?.id
              ? {
                  ...step,
                  status: 'failed',
                  message:
                    'Complete 执行已中断，请重试以核对外部实际状态；已成功的操作不会盲目重复。',
                }
              : step
          ),
        };
        await loader.update(projectPath, featureId, { deliveryCompletion: progress });
      }
      res.json({ success: true, progress: progress ?? null, featureStatus: feature.status });
    } catch (error) {
      res.status(400).json({ success: false, error: (error as Error).message });
    }
  };
}

export function createCompletionRepairHandler(
  loader: FeatureLoader,
  executor?: AutoModeServiceCompat
) {
  const repairs = activeCompletionRepairs;
  return async (req: Request, res: Response) => {
    const { projectPath, featureId, stepId, instruction = '' } = req.body ?? {};
    const key = completionKey(projectPath, featureId);
    let claimed = false;
    try {
      if (
        typeof projectPath !== 'string' ||
        typeof featureId !== 'string' ||
        typeof instruction !== 'string' ||
        instruction.length > 8000
      )
        throw new Error('Invalid repair request');
      if (!executor) throw new Error('Agent executor unavailable');
      if (repairs.has(key) || activeCompletions.has(key) || activeDeliveryProjects.has(projectPath))
        throw new Error('此任务正在执行，请稍后重试');
      repairs.add(key);
      claimed = true;
      const feature = await loader.get(projectPath, featureId);
      const reconciliation = feature?.deliveryCompletion?.reconciliationError;
      const failed =
        reconciliation && reconciliation.stepId === stepId
          ? { message: reconciliation.message }
          : feature?.deliveryCompletion?.steps.find(
              (step) => step.id === stepId && step.status === 'failed'
            );
      if (
        !feature ||
        feature.archive ||
        feature.supersededBy ||
        feature.consolidationPlanId ||
        !failed
      )
        throw new Error('此步骤没有可修复的失败记录');
      const agents = await executor.getRunningAgents();
      if (
        agents.some((agent) => agent.projectPath === projectPath && agent.featureId === featureId)
      )
        throw new Error('任务 Agent 正在运行');
      const prompt = [
        `Fix the failed Complete step for task ${feature.jiraKey || feature.id}.`,
        `Step: ${stepId}. Failure: ${failed.message || 'Unknown error'}`,
        'First inspect actual external state. Earlier steps may already be completed; do not undo or repeat successful operations.',
        'Work only in this task worktree and relevant repositories. Diagnose the failure and fix its prerequisites; preserve all source files and evidence.',
        'Do not merge MRs or change Jira status. Do not delete branches/worktrees or shared deployments. Preview cleanup must remain scoped to Automaker-owned resources of this worktree.',
        'Report the root cause, changes, verification and any human action needed. The operator will retry Complete after reviewing your fix.',
        instruction ? `Additional user request: ${instruction}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      void executor
        .followUpFeature(projectPath, featureId, prompt, undefined, true)
        .catch(async (error: Error) => {
          const latest = await loader.get(projectPath, featureId);
          if (latest?.deliveryCompletion)
            await loader.update(projectPath, featureId, {
              deliveryCompletion: {
                ...latest.deliveryCompletion,
                steps: latest.deliveryCompletion.steps.map((step) =>
                  step.id === stepId
                    ? {
                        ...step,
                        message: `${step.message || ''}\nAgent 修复请求失败：${error.message}`,
                      }
                    : step
                ),
              },
            });
        })
        .catch(() => {})
        .finally(() => repairs.delete(key));
      res.json({ success: true });
    } catch (error) {
      if (claimed) repairs.delete(key);
      res.status(409).json({ success: false, error: (error as Error).message });
    }
  };
}
