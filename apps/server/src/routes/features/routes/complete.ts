/** Human acceptance and delivery are separate: only this endpoint merges and closes Jira. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import type { SettingsService } from '../../../services/settings-service.js';
import { buildFeatureMergePlan } from '../../../services/feature-merge-plan.js';
import {
  GitLabMergeService,
  parseMergeRequestUrl,
  resolveGitLabToken,
} from '../../../services/gitlab-merge-service.js';
import { consolidationExternal } from '../../../services/task-consolidation-service.js';
import type { Feature, FeatureDelivery, DeliveryStepId } from '@automaker/types';
import {
  activeCompletions,
  activeDeliveryProjects,
  activeCompletionRepairs,
  completionKey,
  newDelivery,
  releaseDeliveryPreview,
} from '../../../services/delivery-completion.js';

export function createCompleteHandler(
  loader: FeatureLoader,
  settings: SettingsService | undefined,
  running: (project: string) => Promise<string[]>,
  external = {
    jira: consolidationExternal.jira,
    gitlab: async () => {
      const token = await resolveGitLabToken();
      if (!token) throw new Error('GitLab credentials unavailable');
      return new GitLabMergeService(token);
    },
  },
  cleanup: (
    project: string,
    feature: Feature
  ) => Promise<{ status: 'succeeded' | 'skipped'; message: string }> = (project, feature) =>
    releaseDeliveryPreview(loader, project, feature)
) {
  const busy = activeCompletions;
  return async (req: Request, res: Response) => {
    const {
      projectPath,
      featureId,
      preview = true,
      fingerprint,
      transitionId,
      jiraFields = {},
    } = req.body ?? {};
    const lock = completionKey(projectPath, featureId);
    if (
      busy.has(lock) ||
      activeCompletionRepairs.has(lock) ||
      activeDeliveryProjects.has(projectPath)
    ) {
      res.status(409).json({ success: false, error: 'Completion is already running' });
      return;
    }
    busy.add(lock);
    if (!preview) activeDeliveryProjects.add(projectPath);
    let progress: FeatureDelivery | undefined;
    let currentStep: DeliveryStepId = 'merge';
    const saveStep = async (
      id: DeliveryStepId,
      status: FeatureDelivery['steps'][number]['status'],
      message?: string
    ) => {
      if (!progress) return;
      currentStep = id;
      const now = new Date().toISOString();
      progress = {
        ...progress,
        updatedAt: now,
        steps: progress.steps.map((step) =>
          step.id === id ? { id, status, message, updatedAt: now } : step
        ),
      };
      await loader.update(projectPath, featureId, { deliveryCompletion: progress });
    };
    try {
      if (typeof projectPath !== 'string' || typeof featureId !== 'string')
        throw new Error('Project and feature are required');
      const feature = await loader.get(projectPath, featureId);
      if (!feature || feature.archive || feature.supersededBy || feature.consolidationPlanId)
        throw new Error('Task not found, archived or being consolidated');
      if (feature.status !== 'verified' || feature.completionSource !== 'human')
        throw new Error('Confirm Verify before Complete');
      if ((await running(projectPath)).includes(featureId))
        throw new Error('Wait for the task agent to stop');
      if (!preview) {
        progress = newDelivery(feature.deliveryCompletion);
        await loader.update(projectPath, featureId, { deliveryCompletion: progress });
        if (progress.steps[0].status !== 'succeeded')
          await saveStep('merge', 'running', '正在核对交付 MR 与源分支…');
      }
      const config = (await settings?.getProjectSettings(projectPath))?.jiraSync;
      const plan = buildFeatureMergePlan({
        ...feature,
        rootProjectName: path.basename(projectPath),
      });
      // Missing delivery records must never silently archive a task or close Jira.
      if (!plan.length && feature.jiraKey)
        throw new Error('No merge requests recorded. Prepare the delivery MRs before Complete.');
      for (const entry of plan) {
        const url = new URL(entry.mrUrl);
        if (
          !parseMergeRequestUrl(entry.mrUrl) ||
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !config?.gitlabHost ||
          url.host !== config.gitlabHost
        )
          throw new Error('MR host does not match the project GitLab configuration');
      }
      const gitlab = plan.length ? await external.gitlab() : null;
      const entries = [];
      for (const entry of plan) {
        const state = await gitlab!.getMergeRequest(entry.mrUrl);
        if (!state) throw new Error(`Could not read ${entry.mrUrl}`);
        if (state.state !== 'merged') {
          if (state.state !== 'opened') throw new Error(`MR is ${state.state}: ${entry.mrUrl}`);
          if (!state.sha) throw new Error(`MR has no source revision: ${entry.mrUrl}`);
          if (
            !feature.branchName ||
            state.sourceBranch !== feature.branchName ||
            !config?.targetBranch ||
            state.targetBranch !== config.targetBranch
          )
            throw new Error(`MR branches do not match this task: ${entry.mrUrl}`);
        }
        entries.push({ ...entry, state });
      }
      // Conflicts are not a plain blocker: they are fixable by an agent, so the
      // board renders them with a button instead of a dead end message.
      const conflicts = entries
        .filter((e) => e.state.state !== 'merged' && e.state.hasConflicts)
        .map((e) => ({
          name: e.name,
          mrUrl: e.mrUrl,
          iid: e.iid,
          sourceBranch: e.state.sourceBranch,
          targetBranch: e.state.targetBranch,
        }));
      const blockers: string[] = [];
      let jira;
      if (feature.jiraKey) {
        currentStep = 'jira';
        if (
          !config?.jiraUrl ||
          (feature.jiraUrl && new URL(feature.jiraUrl).origin !== new URL(config.jiraUrl).origin)
        )
          throw new Error('Task Jira site differs from project configuration');
        jira = await external.jira({
          action: 'inspect',
          includeFields: 'true',
          server: config.jiraUrl,
          key: feature.jiraKey,
        });
        if (!jira.done && !jira.transitions.length)
          blockers.push('当前 Jira 状态没有可用的完成流转，请检查工作流或账号权限。');
      }
      const stamp = (value: Feature) =>
        JSON.stringify({
          ...value,
          deliveryCompletion: undefined,
          updatedAt: undefined,
          justFinishedAt: undefined,
        });
      const featureStamp = stamp(feature);
      const digest = createHash('sha256')
        .update(JSON.stringify({ featureStamp, entries, jira, config }))
        .digest('hex');
      if (preview) {
        res.json({
          success: true,
          result: {
            fingerprint: digest,
            mergeRequests: entries.map((e) => ({
              name: e.name,
              url: e.mrUrl,
              state: e.state.state,
            })),
            jira,
            blockers,
            conflicts,
          },
        });
        return;
      }
      if (fingerprint !== digest)
        throw new Error('Task, MR or Jira changed. Refresh the completion preview.');
      if (conflicts.length) {
        currentStep = 'merge';
        throw new Error(
          `MR 仍有冲突，请先让 Agent 修复：${conflicts.map((c) => c.mrUrl).join('、')}`
        );
      }
      if (blockers.length) throw new Error(blockers.join('\n'));
      if (jira && !jira.done && !jira.transitions.some((t) => t.id === transitionId))
        throw new Error('Select a Jira completion transition');
      if (jira && !jira.done) {
        const required = jira.transitions.find((t) => t.id === transitionId)?.fields ?? [];
        if (
          !jiraFields ||
          typeof jiraFields !== 'object' ||
          Array.isArray(jiraFields) ||
          Object.keys(jiraFields).some((key) => !required.some((field) => field.key === key))
        )
          throw new Error('Invalid Jira completion fields');
        for (const field of required) {
          const values = jiraFields[field.key];
          if (!field.supported) throw new Error(`请在 Jira 填写必填字段：${field.name}`);
          if (
            !Array.isArray(values) ||
            !values.length ||
            (!field.multiple && values.length !== 1) ||
            new Set(values).size !== values.length ||
            values.some(
              (value: unknown) =>
                typeof value !== 'string' ||
                !field.allowedValues.some((option) => option.id === value)
            )
          )
            throw new Error(`请选择 Jira 必填字段：${field.name}`);
        }
      }
      const assertUnchanged = async () => {
        const latest = await loader.get(projectPath, featureId);
        if (
          !latest ||
          stamp(latest) !== featureStamp ||
          (await running(projectPath)).includes(featureId)
        )
          throw new Error('Task changed or started running during completion');
      };
      await saveStep('merge', 'running', '按子项目 → 根仓库顺序 squash 合并 MR…');
      // Apply the reviewed source revisions in subproject-before-root order.
      for (const entry of entries) {
        await saveStep('merge', 'running', `${entry.name}: ${entry.mrUrl}`);
        if (entry.state.state === 'merged') continue;
        const latest = await loader.get(projectPath, featureId);
        if (
          !latest ||
          stamp(latest) !== featureStamp ||
          (await running(projectPath)).includes(featureId)
        )
          throw new Error('Task changed or started running during completion');
        const state = await gitlab!.getMergeRequest(entry.mrUrl);
        if (
          !state ||
          state.sha !== entry.state.sha ||
          state.hasConflicts ||
          state.state !== 'opened'
        )
          throw new Error(`MR changed; review again: ${entry.mrUrl}`);
        if (state.draft) {
          const ready = await gitlab!.markReady(entry.mrUrl, state.title);
          if (!ready.ok) throw new Error(ready.error || 'Could not mark MR ready');
        }
        const merged = await gitlab!.merge(entry.mrUrl, { sha: state.sha, squash: true });
        if (!merged.ok || !merged.merged)
          throw new Error(merged.error || `MR merge not confirmed: ${entry.mrUrl}`);
      }
      await saveStep(
        'merge',
        'succeeded',
        entries.length
          ? `${entries.length} 个 MR 已确认合并（新合并采用 squash）`
          : '无交付 MR，已完成本地任务核对'
      );
      await saveStep('jira', 'running', '正在确认 Jira 完成状态…');
      await assertUnchanged();
      if (jira && !jira.done) {
        try {
          jira = await external.jira({
            action: 'close',
            includeFields: 'true',
            fields: JSON.stringify(jiraFields),
            server: config!.jiraUrl,
            key: feature.jiraKey!,
            expectedUpdated: jira.updated,
            transitionId,
          });
        } catch (error) {
          throw new Error(
            `MR 已全部合并；Jira 完成状态尚未确认。请刷新 Complete 核对并收尾：${(error as Error).message}`
          );
        }
        if (!jira.done) throw new Error('Jira completion was not confirmed');
      }
      await saveStep(
        'jira',
        jira ? 'succeeded' : 'skipped',
        jira ? `Jira ${feature.jiraKey} · ${jira.status}` : '此任务未关联 Jira'
      );
      await saveStep('preview', 'running', '正在释放此任务 worktree 的托管预览资源…');
      await assertUnchanged();
      const released = await cleanup(projectPath, feature);
      await assertUnchanged();
      await saveStep('preview', released.status, released.message);
      progress = { ...progress!, status: 'succeeded', updatedAt: new Date().toISOString() };
      const updated = await loader.update(projectPath, featureId, {
        deliveryCompletion: progress,
        status: 'completed',
        completionSource: 'human',
        ...(jira ? { jiraStatus: jira.status } : {}),
      });
      res.json({ success: true, feature: updated });
    } catch (error) {
      if (progress) {
        // A preflight may fail in Jira while MR writes have not even started.
        progress = {
          ...progress,
          status: 'failed',
          steps: progress.steps.map((step) =>
            step.status === 'running' && step.id !== currentStep
              ? { ...step, status: 'pending' }
              : step
          ),
        };
        try {
          if (progress.steps.find((step) => step.id === currentStep)?.status === 'succeeded') {
            progress.reconciliationError = {
              stepId: currentStep,
              message: (error as Error).message,
            };
            await loader.update(projectPath, featureId, { deliveryCompletion: progress });
          } else await saveStep(currentStep, 'failed', (error as Error).message);
        } catch {
          /* Preserve original failure. */
        }
      }
      // Partial merges are re-read on retry. The card remains in Done until all steps succeed.
      res.status(409).json({ success: false, error: (error as Error).message });
    } finally {
      busy.delete(lock);
      if (!preview) activeDeliveryProjects.delete(projectPath);
    }
  };
}
