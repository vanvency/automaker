/**
 * MR conflicts on the Done lane.
 *
 * A verified card stays in Done until its delivery merge requests can actually
 * be merged. GitLab is the only place that knows a branch conflicts, so the board
 * asks these two endpoints: one reports which merge requests conflict, the other
 * hands the fix to the agent of the task that owns the repository.
 *
 * The fix belongs to the sub-task that changed the repository (the Complete flow
 * merges subprojects before the root), so the dispatch reuses the same owner
 * routing.
 */

import path from 'node:path';
import type { Request, Response } from 'express';
import type { Feature } from '@automaker/types';
import { createLogger } from '@automaker/utils';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import type { SettingsService } from '../../../services/settings-service.js';
import type { AutoModeServiceCompat } from '../../../services/auto-mode/index.js';
import { buildFeatureMergePlan } from '../../../services/feature-merge-plan.js';
import { GitLabMergeService, resolveGitLabToken } from '../../../services/gitlab-merge-service.js';
import {
  buildConflictResolutionPrompt,
  findConflictOwner,
  type ConflictedMergeRequest,
} from '../../../services/conflict-resolution.js';
import { resolveFeatureWorkDir } from './opencode-session.js';
import { getErrorMessage, logError } from '../common.js';

const logger = createLogger('features/merge-conflicts');

/** GitLab client factory, injectable so tests need neither token nor network. */
export type GitLabFactory = () => Promise<GitLabMergeService>;

export interface MergeConflictDeps {
  gitlab?: GitLabFactory;
  /** Runs one agent turn on the owning task; injectable for tests. */
  followUp?: (projectPath: string, featureId: string, prompt: string) => Promise<void>;
}

/** Conflict as the board renders it. */
export interface MergeConflictSummary {
  /** Project label recorded on the card, e.g. `frontend/saas-frontend`. */
  name: string;
  mrUrl: string;
  iid: number;
  sourceBranch: string;
  targetBranch: string;
}

async function defaultGitLab(): Promise<GitLabMergeService> {
  const token = await resolveGitLabToken();
  if (!token) throw new Error('GitLab credentials unavailable');
  return new GitLabMergeService(token);
}

/**
 * The feature's merge requests that GitLab reports as conflicting.
 *
 * Only MRs on the project's configured GitLab host are read: the URL is stored
 * on the card, so without that check a card could make the server call an
 * unrelated host.
 */
async function conflictedMergeRequests(params: {
  settings?: SettingsService;
  projectPath: string;
  feature: Feature;
  gitlab: GitLabMergeService;
}): Promise<ConflictedMergeRequest[]> {
  const { settings, projectPath, feature, gitlab } = params;
  const plan = buildFeatureMergePlan({ ...feature, rootProjectName: path.basename(projectPath) });
  if (plan.length === 0) return [];

  const host = (await settings?.getProjectSettings(projectPath))?.jiraSync?.gitlabHost;
  if (!host) return [];
  const states = await Promise.all(
    plan.map(async (entry) => {
      try {
        if (new URL(entry.mrUrl).host !== host) return null;
      } catch {
        return null;
      }
      return gitlab.getMergeRequest(entry.mrUrl);
    })
  );
  return plan.flatMap((entry, index) => {
    const state = states[index];
    return state && state.state !== 'merged' && state.hasConflicts ? [{ entry, state }] : [];
  });
}

function summarize(conflicts: ConflictedMergeRequest[]): MergeConflictSummary[] {
  return conflicts.map(({ entry, state }) => ({
    name: entry.name,
    mrUrl: entry.mrUrl,
    iid: entry.iid,
    sourceBranch: state.sourceBranch,
    targetBranch: state.targetBranch,
  }));
}

/** POST /api/features/mr-conflicts - does this card's delivery conflict? */
export function createMergeConflictCheckHandler(
  loader: FeatureLoader,
  settings?: SettingsService,
  deps: MergeConflictDeps = {}
) {
  const gitlabFactory = deps.gitlab ?? defaultGitLab;
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body ?? {};
      if (typeof projectPath !== 'string' || typeof featureId !== 'string') {
        res.status(400).json({ success: false, error: 'projectPath and featureId are required' });
        return;
      }
      const feature = await loader.get(projectPath, featureId);
      if (!feature) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }
      const conflicts = await conflictedMergeRequests({
        settings,
        projectPath,
        feature,
        gitlab: await gitlabFactory(),
      });
      res.json({ success: true, conflicts: summarize(conflicts) });
    } catch (error) {
      logError(error, 'Merge conflict check failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}

/**
 * POST /api/features/resolve-conflicts - let the owning task's agent fix them.
 *
 * The agent turn takes minutes, so the HTTP answer only reports what was
 * dispatched; the card follows the run through its normal status.
 */
export function createResolveConflictsHandler(
  loader: FeatureLoader,
  settings?: SettingsService,
  autoModeService?: AutoModeServiceCompat,
  deps: MergeConflictDeps = {}
) {
  const gitlabFactory = deps.gitlab ?? defaultGitLab;
  const followUp =
    deps.followUp ??
    (autoModeService
      ? (projectPath: string, featureId: string, prompt: string) =>
          autoModeService.followUpFeature(projectPath, featureId, prompt, undefined, true)
      : undefined);

  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body ?? {};
      if (typeof projectPath !== 'string' || typeof featureId !== 'string') {
        res.status(400).json({ success: false, error: 'projectPath and featureId are required' });
        return;
      }
      if (!followUp) {
        res.status(503).json({ success: false, error: 'Task execution is unavailable' });
        return;
      }
      const resolved = await resolveFeatureWorkDir(loader, projectPath, featureId);
      if (!resolved) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }
      const { feature } = resolved;
      if (
        feature.status !== 'verified' ||
        feature.archive ||
        feature.supersededBy ||
        feature.consolidationPlanId
      ) {
        res.status(409).json({
          success: false,
          error: '只有 Done 中已验收的任务可以派发冲突修复',
        });
        return;
      }

      const conflicts = await conflictedMergeRequests({
        settings,
        projectPath,
        feature,
        gitlab: await gitlabFactory(),
      });
      if (conflicts.length === 0) {
        res.status(409).json({ success: false, error: '当前没有需要处理的 MR 冲突' });
        return;
      }

      // One agent turn per owning card, carrying every repository it owns.
      const groups = new Map<string, { feature: Feature; conflicts: ConflictedMergeRequest[] }>();
      const allFeatures = await loader.getAll(projectPath);
      for (const conflict of conflicts) {
        const owner = findConflictOwner(feature, allFeatures, conflict.entry, conflict.entry.name);
        const group = groups.get(owner.id) ?? { feature: owner, conflicts: [] };
        group.conflicts.push(conflict);
        groups.set(owner.id, group);
      }

      const dispatched = [];
      for (const group of groups.values()) {
        const target = await resolveFeatureWorkDir(loader, projectPath, group.feature.id);
        const prompt = buildConflictResolutionPrompt(
          group.conflicts,
          target?.workDir ?? projectPath
        );
        void followUp(projectPath, group.feature.id, prompt).catch((error) =>
          logger.error(
            `Conflict resolution for ${group.feature.id} failed: ${(error as Error).message}`
          )
        );
        dispatched.push({
          featureId: group.feature.id,
          title: group.feature.title || group.feature.id,
          repositories: group.conflicts.map((conflict) => conflict.entry.name),
        });
      }
      logger.info(
        `Dispatched conflict resolution for ${featureId} to ${dispatched
          .map((item) => `${item.featureId} (${item.repositories.join(', ')})`)
          .join('; ')}`
      );
      res.json({ success: true, conflicts: summarize(conflicts), dispatched });
    } catch (error) {
      logError(error, 'Resolve conflicts failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
