/**
 * POST /diffs endpoint - Get diffs for a worktree
 */

import type { Request, Response } from 'express';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as secureFs from '../../../lib/secure-fs.js';
import { getErrorMessage, logError } from '../common.js';
import {
  DEFAULT_MAX_DIFF_BYTES,
  collectBranchSubmoduleDiffs,
  collectCommitSetDiffs,
  deriveJiraKeyFromId,
  getCommittedBranchDiffs,
  getGitRepositoryDiffsWithOptions,
  isParentTask,
  listBranchCommits,
  resolveMergeBase,
  resolveTaskCommitMatcher,
  selectTaskCommits,
  type TaskScopeFeature,
  type TaskScopeInfo,
} from '../../common.js';
import type { FeatureLoader } from '../../../services/feature-loader.js';

const execAsync = promisify(exec);
const MAX_DIFF_BYTES = DEFAULT_MAX_DIFF_BYTES;

/**
 * Jira monitor worktrees are named `<jira-key>-<label>` (for example
 * `aip-114859-dodo`) while the feature id is `jira-<label>-<jira-key>`. Derive the
 * monitor-style directory name so diffs can be resolved for those cards too.
 */
function monitorWorktreeNames(featureId: string): string[] {
  const match = /^jira-([a-z0-9]+)-(.+)$/i.exec(featureId);
  if (!match) return [];
  const [, label, key] = match;
  return [`${key}-${label}`];
}

async function listWorktrees(
  projectPath: string
): Promise<Array<{ path: string; branch: string | null }>> {
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', {
      cwd: projectPath,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 15000,
    });
    const entries: Array<{ path: string; branch: string | null }> = [];
    let currentPath: string | null = null;
    let currentBranch: string | null = null;
    const flush = () => {
      if (currentPath) entries.push({ path: currentPath, branch: currentBranch });
      currentPath = null;
      currentBranch = null;
    };
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        currentBranch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (line.trim() === '') {
        flush();
      }
    }
    flush();
    return entries;
  } catch {
    return [];
  }
}

/**
 * Find the worktree that actually backs a card.
 *
 * Resolution order: the legacy `<project>/.worktrees/<featureId>` convention, the
 * feature's own branch name, then monitor-style directory names. Without this the
 * route silently fell back to diffing the whole main repository, which for a large
 * monorepo produced a ~168 MB payload and left the UI stuck on "Loading changes".
 */
async function resolveWorktreePath(
  projectPath: string,
  featureId: string,
  featureLoader?: FeatureLoader
): Promise<{ worktreePath: string | null; expectsWorktree: boolean }> {
  const sanitizedFeatureId = featureId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const conventional = path.join(projectPath, '.worktrees', sanitizedFeatureId);
  try {
    await secureFs.access(conventional);
    return { worktreePath: conventional, expectsWorktree: true };
  } catch {
    /* fall through to worktree list discovery */
  }

  let branchName: string | null = null;
  if (featureLoader) {
    try {
      const feature = await featureLoader.get(projectPath, featureId);
      branchName = feature?.branchName ?? null;
    } catch {
      /* feature lookup is best-effort */
    }
  }

  const wantedNames = new Set([sanitizedFeatureId, ...monitorWorktreeNames(featureId)]);
  const worktrees = await listWorktrees(projectPath);
  const byBranch = branchName ? worktrees.find((entry) => entry.branch === branchName) : undefined;
  if (byBranch) return { worktreePath: byBranch.path, expectsWorktree: true };

  const byName = worktrees.find((entry) =>
    wantedNames.has(path.basename(entry.path.replace(/\/+$/, '')))
  );
  if (byName) return { worktreePath: byName.path, expectsWorktree: true };

  // Monitor-created sub-tasks (`aip-114878-child-1`) belong to the epic's shared
  // worktree even though they have no feature file or their own branch.
  const jiraKey = deriveJiraKeyFromId(featureId);
  if (jiraKey) {
    const key = jiraKey.toLowerCase();
    const byBranch = worktrees.find((entry) => entry.branch?.toLowerCase().includes(key));
    if (byBranch) return { worktreePath: byBranch.path, expectsWorktree: true };

    const byDirectory = worktrees.find((entry) =>
      path.basename(entry.path.replace(/\/+$/, '')).toLowerCase().startsWith(`${key}-`)
    );
    if (byDirectory) return { worktreePath: byDirectory.path, expectsWorktree: true };
  }

  return { worktreePath: null, expectsWorktree: Boolean(branchName) };
}

/** Target branches tried when a worktree has no uncommitted changes. */
const FALLBACK_BASE_REFS = ['origin/dev', 'dev', 'origin/main', 'main'];

async function respondWithDiffs(
  res: Response,
  repoPath: string,
  options: {
    includeCommittedBranchDiff?: boolean;
    /** Commits that belong to the card's task (narrowed by Jira key) */
    taskScope?: {
      feature: TaskScopeFeature | null;
      allFeatures: TaskScopeFeature[];
      forceBranchScope: boolean;
    };
  } = {}
): Promise<void> {
  try {
    const result = await getGitRepositoryDiffsWithOptions(repoPath, {
      maxDiffBytes: MAX_DIFF_BYTES,
    });
    let { diff, files, hasChanges } = result;
    let submodules = result.submodules;
    let scope: TaskScopeInfo | undefined;

    /**
     * Work out which commits of the branch belong to this card. A finished task is
     * already committed, and several tasks can share one branch, so the branch
     * diff must be narrowed to this task's commits unless it is a parent task.
     */
    const resolveScopedCommits = async (): Promise<{
      shas: string[];
      matched: boolean;
      info?: TaskScopeInfo;
    }> => {
      const scopeOptions = options.taskScope;
      if (!scopeOptions) return { shas: [], matched: false };

      for (const baseRef of FALLBACK_BASE_REFS) {
        const mergeBase = await resolveMergeBase(repoPath, baseRef);
        if (!mergeBase) continue;

        const commits = await listBranchCommits(repoPath, mergeBase);
        if (commits.length === 0) continue;

        const selection = selectTaskCommits(commits, {
          matcher: resolveTaskCommitMatcher(scopeOptions.feature),
          isParent: isParentTask(scopeOptions.feature, scopeOptions.allFeatures),
          forceBranchScope: scopeOptions.forceBranchScope,
        });

        return {
          shas: selection.commits.map((commit) => commit.sha),
          matched: selection.mode === 'task',
          info: selection.info,
        };
      }

      return { shas: [], matched: false };
    };

    // A finished feature is already committed, so the working-tree diff is empty
    // even though the branch delivered real changes. Fall back to the branch diff
    // against its target so reviewers can still see what changed.
    if (!hasChanges && options.includeCommittedBranchDiff) {
      const scoped = await resolveScopedCommits();

      if (scoped.matched) {
        const taskResult = await collectCommitSetDiffs(repoPath, scoped.shas, {
          maxDiffBytes: MAX_DIFF_BYTES,
        });
        if (taskResult.hasChanges) {
          diff = taskResult.diff;
          files = taskResult.files;
          hasChanges = true;
          submodules = taskResult.summaries;
          scope = scoped.info;
        }
      }

      if (!hasChanges) {
        for (const baseRef of FALLBACK_BASE_REFS) {
          const branchResult = await getCommittedBranchDiffs(repoPath, baseRef, MAX_DIFF_BYTES);
          if (branchResult.hasChanges) {
            diff = branchResult.diff;
            files = branchResult.files;
            hasChanges = true;
            submodules = branchResult.submodules;
            scope = scoped.info ?? {
              mode: 'branch',
              reason: 'no-matching-commits',
            };
            break;
          }
        }
      }
    } else if (options.includeCommittedBranchDiff) {
      // The worktree has uncommitted edits, but submodule work committed on the
      // branch is not part of the working-tree diff. Merge it in so reviewers see
      // the submodule's real changes instead of only a "Subproject commit" move.
      //
      // Only this card's commits are considered when the card is a sub-task.
      const scoped = await resolveScopedCommits();
      const remainingBudget = Math.max(0, MAX_DIFF_BYTES - Buffer.byteLength(diff, 'utf8'));
      const branchSubmodules = scoped.matched
        ? await collectCommitSetDiffs(repoPath, scoped.shas, {
            maxDiffBytes: remainingBudget,
            submodulesOnly: true,
          })
        : await collectBranchSubmoduleDiffs(repoPath, FALLBACK_BASE_REFS, {
            maxDiffBytes: remainingBudget,
          });
      scope = scoped.info;

      if (branchSubmodules.summaries.length > 0) {
        const knownFiles = new Set(files.map((file) => file.path));
        for (const file of branchSubmodules.files) {
          if (knownFiles.has(file.path)) continue;
          knownFiles.add(file.path);
          files.push(file);
        }
        diff += branchSubmodules.diff;

        const merged = new Map<string, NonNullable<typeof submodules>[number]>();
        for (const summary of [...(submodules ?? []), ...branchSubmodules.summaries]) {
          // Keep the first entry per submodule path (working-tree state wins).
          if (!merged.has(summary.path)) merged.set(summary.path, summary);
        }
        submodules = [...merged.values()];
      }
    }

    res.json({
      success: true,
      diff,
      files,
      hasChanges,
      // Submodule gitlink moves expanded into the submodule's real changes
      ...(submodules && submodules.length > 0 ? { submodules } : {}),
      ...(scope ? { scope } : {}),
      ...(result.mergeState ? { mergeState: result.mergeState } : {}),
    });
  } catch (error) {
    logError(error, `Get diffs failed for ${repoPath}`);
    res.json({ success: true, diff: '', files: [], hasChanges: false });
  }
}

export function createDiffsHandler(featureLoader?: FeatureLoader) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        projectPath,
        featureId,
        useWorktrees,
        taskScope: requestedTaskScope,
      } = req.body as {
        projectPath: string;
        featureId: string;
        useWorktrees?: boolean;
        /** 'auto' (default) narrows to this card's commits, 'branch' shows everything */
        taskScope?: 'auto' | 'branch';
      };

      if (!projectPath || !featureId) {
        res.status(400).json({
          success: false,
          error: 'projectPath and featureId required',
        });
        return;
      }

      // If worktrees aren't enabled, don't probe .worktrees at all.
      // This avoids noisy logs that make it look like features are "running in worktrees".
      if (useWorktrees === false) {
        await respondWithDiffs(res, projectPath);
        return;
      }

      // Which commits belong to this card? Sub-tasks filter by Jira key + child
      // index; parent tasks own the whole branch.
      const feature = featureLoader ? await featureLoader.get(projectPath, featureId) : null;
      const allFeatures = featureLoader ? await featureLoader.getAll(projectPath) : [];
      const taskScope = {
        // Fall back to the id when the feature file is gone (monitor-created cards)
        // so the Jira key and child index can still be derived.
        feature: feature ?? { id: featureId },
        allFeatures,
        forceBranchScope: requestedTaskScope === 'branch',
      };

      const { worktreePath, expectsWorktree } = await resolveWorktreePath(
        projectPath,
        featureId,
        featureLoader
      );

      if (worktreePath) {
        await respondWithDiffs(res, worktreePath, {
          includeCommittedBranchDiff: true,
          taskScope,
        });
        return;
      }

      // The feature declares a branch but its worktree is gone. Diffing the main
      // repository here is wrong (and very expensive for monorepos), so report no
      // changes instead of falling back to the entire project.
      if (expectsWorktree) {
        res.json({
          success: true,
          diff: '',
          files: [],
          hasChanges: false,
          worktreeMissing: true,
        });
        return;
      }

      await respondWithDiffs(res, projectPath);
    } catch (error) {
      logError(error, 'Get worktree diffs failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
