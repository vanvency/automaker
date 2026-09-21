/**
 * POST /progress endpoint - Aggregate progress for every git worktree of a project.
 *
 * Powers the "Worktree Progress" view: one row per worktree with the feature it
 * belongs to, its lifecycle stage, branch position (ahead/behind the base
 * branch), uncommitted changes, conflicts and the linked pull request.
 *
 * All git work for the branch statistics is done with a single
 * `git for-each-ref` call; only the per-worktree working-directory state
 * (uncommitted files, in-progress merges) needs one command per worktree and is
 * run with bounded concurrency.
 */

import type { Request, Response } from 'express';
import { createLogger } from '@automaker/utils';
import { isGitRepo } from '@automaker/git-utils';
import {
  getChildFeaturesForParent,
  hasChildFeatures,
  hasFeatureAttentionError,
} from '@automaker/types';
import type {
  Feature,
  WorktreePRInfo,
  WorktreeProgressAttention,
  WorktreeProgressCommit,
  WorktreeProgressCounts,
  WorktreeProgressFeature,
  WorktreeProgressItem,
  WorktreeProgressStage,
  WorktreeProgressTask,
} from '@automaker/types';
import { readAllWorktreeMetadata } from '../../../lib/worktree-metadata.js';
import { WorktreeResolver, type WorktreeInfo } from '../../../services/worktree-resolver.js';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import { execGitCommand, getErrorMessage, logError } from '../common.js';
import { detectConflictState } from './list.js';

const logger = createLogger('WorktreeProgress');

/** Unit separator - cannot appear in branch names, authors or commit subjects. */
const FIELD_SEP = '\x1f';

/** Fresh branches to try, in order, when no base branch is configured. */
const BASE_BRANCH_CANDIDATES = ['dev', 'main', 'master'];

/** How many worktrees are inspected concurrently (git spawns are the bottleneck). */
const CHANGE_STATE_CONCURRENCY = 8;

/** Max length of the commit subject sent to the UI. */
const MAX_SUBJECT_LENGTH = 160;

export interface WorktreeBranchStat {
  sha: string;
  subject: string;
  author: string;
  date: string;
  ahead: number;
  behind: number;
}

export interface WorktreeChangeState {
  hasChanges: boolean;
  changedFilesCount: number;
  hasConflicts: boolean;
  conflictType?: 'merge' | 'rebase' | 'cherry-pick';
  conflictFiles?: string[];
}

export interface WorktreeProgressInput {
  worktrees: WorktreeInfo[];
  features: Feature[];
  branchStats: Map<string, WorktreeBranchStat>;
  changes: Map<string, WorktreeChangeState>;
  prs: Map<string, WorktreePRInfo>;
}

/** Feature status → coarse lifecycle stage. */
const STATUS_STAGES: Record<string, WorktreeProgressStage> = {
  backlog: 'backlog',
  pending: 'backlog',
  ready: 'backlog',
  queued: 'backlog',
  planning: 'in_progress',
  running: 'in_progress',
  in_progress: 'in_progress',
  executing: 'in_progress',
  implementing: 'in_progress',
  waiting_approval: 'waiting_approval',
  ready_for_review: 'waiting_approval',
  review: 'waiting_approval',
  verified: 'complete',
  completed: 'complete',
  complete: 'complete',
  done: 'complete',
  merged: 'complete',
  failed: 'failed',
  error: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  // These also need a human, so they belong in the "Needs Attention" lane
  // instead of falling through to `unknown` (which the board groups as Backlog).
  merge_conflict: 'failed',
  interrupted: 'failed',
  needs_input: 'failed',
};

/** Higher wins when a branch carries several features. */
const STAGE_PRIORITY: Record<WorktreeProgressStage, number> = {
  in_progress: 6,
  waiting_approval: 5,
  failed: 4,
  complete: 3,
  backlog: 2,
  unknown: 1,
  empty: 0,
};

/** Strip refs/heads, remote prefixes and whitespace from a branch name. */
export function normalizeBranchName(branchName: string | null | undefined): string | null {
  if (!branchName) return null;
  const normalized = branchName
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^(origin|upstream)\//, '');
  return normalized || null;
}

/** Map a raw feature status onto a progress stage. */
export function classifyStage(status: string | undefined | null): WorktreeProgressStage {
  if (!status) return 'backlog';
  const key = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return STATUS_STAGES[key] ?? 'unknown';
}

/** Parse `git for-each-ref` output into branch statistics. */
export function parseBranchStats(stdout: string): Map<string, WorktreeBranchStat> {
  const stats = new Map<string, WorktreeBranchStat>();

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const parts = line.split(FIELD_SEP);
    if (parts.length < 6) continue;

    const [branch, sha, date, author, aheadBehind, ...subjectParts] = parts;
    if (!branch || !sha) continue;

    const [aheadRaw, behindRaw] = (aheadBehind ?? '').trim().split(/\s+/);
    const ahead = Number.parseInt(aheadRaw ?? '', 10);
    const behind = Number.parseInt(behindRaw ?? '', 10);
    const subject = subjectParts.join(FIELD_SEP).trim();

    stats.set(branch, {
      sha,
      date,
      author,
      subject:
        subject.length > MAX_SUBJECT_LENGTH ? `${subject.slice(0, MAX_SUBJECT_LENGTH)}…` : subject,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    });
  }

  return stats;
}

/** Count `git status --porcelain` lines, ignoring the trailing blank line. */
export function countChangedFiles(statusOutput: string): number {
  return statusOutput.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Pick the feature that best represents a worktree branch: the most advanced
 * stage wins, ties are broken by the most recently updated feature.
 */
export function pickPrimaryFeature(features: Feature[]): Feature | null {
  if (features.length === 0) return null;

  return [...features].sort((a, b) => {
    const byStage =
      STAGE_PRIORITY[classifyStage(b.status)] - STAGE_PRIORITY[classifyStage(a.status)];
    if (byStage !== 0) return byStage;

    const aTime = Date.parse(a.updatedAt ?? '') || 0;
    const bTime = Date.parse(b.updatedAt ?? '') || 0;
    if (aTime !== bTime) return bTime - aTime;

    return a.id.localeCompare(b.id);
  })[0];
}

/** Convert a feature into its progress summary. */
export function toFeatureSummary(feature: Feature): WorktreeProgressFeature {
  return {
    id: feature.id,
    title: feature.title,
    status: feature.status,
    category: feature.category,
    jiraKey: typeof feature.jiraKey === 'string' ? feature.jiraKey : undefined,
    jiraUrl: typeof feature.jiraUrl === 'string' ? feature.jiraUrl : undefined,
    updatedAt: feature.updatedAt,
  };
}

/** Latest of two optional ISO timestamps. */
function latestTimestamp(...values: Array<string | undefined>): string | null {
  let best: string | null = null;
  let bestTime = -Infinity;

  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (time > bestTime) {
      bestTime = time;
      best = value;
    }
  }

  return best;
}

/** Join worktrees, features and git state into the rows rendered by the UI. */
/** Card counts of one worktree branch, used for the "x/y done" rollup. */
export function countTaskStages(features: Feature[]): WorktreeProgressCounts {
  const counts: WorktreeProgressCounts = {
    total: features.length,
    completed: 0,
    running: 0,
    waiting: 0,
    failed: 0,
    backlog: 0,
  };

  for (const feature of features) {
    switch (classifyStage(feature.status)) {
      case 'complete':
        counts.completed += 1;
        break;
      case 'in_progress':
        counts.running += 1;
        break;
      case 'waiting_approval':
        counts.waiting += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      default:
        // backlog / empty / unknown cards are still work waiting to be started
        counts.backlog += 1;
        break;
    }
  }

  return counts;
}

/**
 * Why a human should look at this worktree, highest priority first.
 *
 * Conflicts block the branch from landing, a card carrying `error` is waiting on
 * an answer, a failed run needs a retry, and waiting_approval needs a review.
 */
export function deriveAttention(
  features: Feature[],
  hasConflicts: boolean
): WorktreeProgressAttention | null {
  if (hasConflicts) return 'conflicts';
  if (features.some(hasFeatureAttentionError)) {
    return 'needs_input';
  }
  if (features.some((feature) => classifyStage(feature.status) === 'failed')) return 'failed';
  if (features.some((feature) => classifyStage(feature.status) === 'waiting_approval')) {
    return 'waiting_review';
  }
  return null;
}

/**
 * Every card on the branch with its child links, parents first.
 *
 * Children are resolved against the whole project (not just the branch) because
 * a child card may live in its own worktree.
 */
export function toProgressTasks(
  candidateFeatures: Feature[],
  allFeatures: Feature[]
): WorktreeProgressTask[] {
  const tasks = candidateFeatures.map((feature) => {
    const children = getChildFeaturesForParent(feature, allFeatures);
    return {
      id: feature.id,
      title: feature.title,
      status: feature.status,
      stage: classifyStage(feature.status),
      jiraKey: typeof feature.jiraKey === 'string' ? feature.jiraKey : undefined,
      jiraType: typeof feature.jiraType === 'string' ? feature.jiraType : undefined,
      isParent: children.length > 0,
      childIds: children.map((child) => child.id),
    };
  });

  // The overview card reads the worktree's task first, then its children.
  return [...tasks].sort((left, right) => Number(right.isParent) - Number(left.isParent));
}

export function buildWorktreeProgress(input: WorktreeProgressInput): WorktreeProgressItem[] {
  const featuresByBranch = new Map<string, Feature[]>();
  for (const feature of input.features) {
    const branch = normalizeBranchName(feature.branchName);
    if (!branch) continue;
    const bucket = featuresByBranch.get(branch);
    if (bucket) {
      bucket.push(feature);
    } else {
      featuresByBranch.set(branch, [feature]);
    }
  }

  return input.worktrees.map((worktree) => {
    const branch = worktree.branch ?? '(detached)';
    const candidateFeatures = worktree.branch ? (featuresByBranch.get(worktree.branch) ?? []) : [];
    const primaryFeature = pickPrimaryFeature(candidateFeatures);
    const stat = input.branchStats.get(branch) ?? null;
    const change = input.changes.get(worktree.path);

    const head: WorktreeProgressCommit | null = stat
      ? { sha: stat.sha, subject: stat.subject, author: stat.author, date: stat.date }
      : null;

    return {
      path: worktree.path,
      branch,
      isMain: worktree.isMain,
      stage: primaryFeature ? classifyStage(primaryFeature.status) : 'empty',
      feature: primaryFeature ? toFeatureSummary(primaryFeature) : null,
      featureCount: candidateFeatures.length,
      // The worktree's task rollup: every card on the branch (the task and the
      // children folded under it), plus the reason it may need a human.
      tasks: candidateFeatures.length > 0 ? toProgressTasks(candidateFeatures, input.features) : [],
      counts: countTaskStages(candidateFeatures),
      attention: deriveAttention(candidateFeatures, change?.hasConflicts ?? false),
      head,
      ahead: stat?.ahead ?? 0,
      behind: stat?.behind ?? 0,
      hasChanges: change?.hasChanges ?? false,
      changedFilesCount: change?.changedFilesCount ?? 0,
      hasConflicts: change?.hasConflicts ?? false,
      conflictType: change?.conflictType,
      conflictFiles: change?.conflictFiles,
      pr: input.prs.get(worktree.branch ?? '') ?? null,
      lastActivityAt: latestTimestamp(stat?.date, primaryFeature?.updatedAt),
    };
  });
}

/** Run an async mapper over a list with bounded concurrency. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Resolve the reference branch used for ahead/behind counts:
 * explicit request → origin/HEAD → origin/<candidate> → local <candidate> → main worktree branch.
 */
export async function resolveBaseBranch(
  projectPath: string,
  worktrees: WorktreeInfo[],
  requested?: string
): Promise<string | null> {
  const candidates: string[] = [];

  const requestedBranch = normalizeBranchName(requested);
  if (requestedBranch) candidates.push(requestedBranch);

  try {
    const originHead = (
      await execGitCommand(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], projectPath)
    ).trim();
    // refs/remotes/origin/dev → origin/dev (keep the remote prefix so the ref still resolves)
    const normalized = originHead.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '');
    if (normalized) candidates.push(normalized);
  } catch {
    // No origin/HEAD (no remote, or never fetched) - fall through to the name list.
  }

  for (const candidate of BASE_BRANCH_CANDIDATES) {
    candidates.push(`origin/${candidate}`, candidate);
  }

  const mainBranch = normalizeBranchName(worktrees.find((w) => w.isMain)?.branch);
  if (mainBranch) candidates.push(mainBranch);

  for (const candidate of candidates) {
    // The candidate is embedded in a git format string later, so keep it simple.
    if (!/^[A-Za-z0-9._/-]+$/.test(candidate)) continue;
    try {
      await execGitCommand(
        ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
        projectPath
      );
      return candidate;
    } catch {
      // Not a usable ref - try the next candidate.
    }
  }

  return null;
}

/** Read tip commit and ahead/behind for every local branch in one git call. */
export async function readBranchStats(
  projectPath: string,
  baseBranch: string | null
): Promise<Map<string, WorktreeBranchStat>> {
  const fields = [
    '%(refname:short)',
    '%(objectname:short)',
    '%(committerdate:iso-strict)',
    '%(authorname)',
  ];

  if (baseBranch) {
    fields.push(`%(ahead-behind:${baseBranch})`);
  } else {
    fields.push('0 0');
  }
  fields.push('%(subject)');

  try {
    const stdout = await execGitCommand(
      ['for-each-ref', `--format=${fields.join('%1f')}`, 'refs/heads/'],
      projectPath
    );
    return parseBranchStats(stdout);
  } catch (error) {
    logger.warn(`Failed to read branch stats: ${getErrorMessage(error)}`);
    return new Map();
  }
}

/** Read uncommitted changes and conflict state for every worktree. */
export async function readChangeStates(
  worktrees: WorktreeInfo[]
): Promise<Map<string, WorktreeChangeState>> {
  const entries = await mapWithConcurrency(
    worktrees,
    CHANGE_STATE_CONCURRENCY,
    async (worktree): Promise<[string, WorktreeChangeState]> => {
      let changedFilesCount = 0;
      try {
        changedFilesCount = countChangedFiles(
          await execGitCommand(['status', '--porcelain'], worktree.path)
        );
      } catch {
        changedFilesCount = 0;
      }

      let conflict: Awaited<ReturnType<typeof detectConflictState>> = { hasConflicts: false };
      try {
        conflict = await detectConflictState(worktree.path);
      } catch {
        // Conflict detection is best-effort - a broken worktree should not fail the page.
      }

      return [
        worktree.path,
        {
          hasChanges: changedFilesCount > 0,
          changedFilesCount,
          hasConflicts: conflict.hasConflicts,
          conflictType: conflict.conflictType,
          conflictFiles: conflict.conflictFiles,
        },
      ];
    }
  );

  return new Map(entries);
}

/** Collect PR info for every branch that has worktree metadata. */
export function collectPRs(
  metadata: Map<string, { pr?: WorktreePRInfo }>
): Map<string, WorktreePRInfo> {
  const prs = new Map<string, WorktreePRInfo>();
  for (const [branch, meta] of metadata) {
    if (meta?.pr) prs.set(branch, meta.pr);
  }
  return prs;
}

export function createWorktreeProgressHandler(featureLoader?: FeatureLoader) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        projectPath,
        baseBranch: requestedBaseBranch,
        includeGitDetails = true,
      } = req.body as {
        projectPath: string;
        baseBranch?: string;
        includeGitDetails?: boolean;
      };

      if (!(await isGitRepo(projectPath))) {
        res.json({
          success: true,
          projectPath,
          baseBranch: null,
          generatedAt: new Date().toISOString(),
          worktrees: [],
        });
        return;
      }

      const worktrees = await new WorktreeResolver().listWorktrees(projectPath);
      const baseBranch = await resolveBaseBranch(projectPath, worktrees, requestedBaseBranch);

      const [branchStats, features, metadata] = await Promise.all([
        readBranchStats(projectPath, baseBranch),
        featureLoader ? featureLoader.getAll(projectPath) : Promise.resolve<Feature[]>([]),
        readAllWorktreeMetadata(projectPath),
      ]);

      const changes = includeGitDetails
        ? await readChangeStates(worktrees)
        : new Map<string, WorktreeChangeState>();

      const items = buildWorktreeProgress({
        worktrees,
        features,
        branchStats,
        changes,
        prs: collectPRs(metadata),
      });

      res.json({
        success: true,
        projectPath,
        baseBranch,
        generatedAt: new Date().toISOString(),
        worktrees: items,
      });
    } catch (error) {
      logError(error, 'Worktree progress failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
