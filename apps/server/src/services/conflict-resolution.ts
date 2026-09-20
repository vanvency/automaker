/**
 * Conflict dispatch for the Complete flow.
 *
 * A verified card whose merge requests conflict cannot be completed: the branch
 * has to be merged with its target and pushed again first. These helpers decide
 * which card owns a conflicted repository and what that card's agent is told to
 * do, so the fix runs on the task that changed the repository instead of on a
 * human.
 */

import { getChildFeaturesForParent, type Feature } from '@automaker/types';
import type { MergePlanEntry } from './feature-merge-plan.js';
import type { MergeRequestState } from './gitlab-merge-service.js';

/** One merge request GitLab reports as conflicting. */
export interface ConflictedMergeRequest {
  entry: MergePlanEntry;
  state: MergeRequestState;
}

function changedProjectNames(feature: Feature): string[] {
  const raw = (feature as { changedProjects?: unknown }).changedProjects;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return String((item as { name?: unknown }).name ?? '');
      return '';
    })
    .map((name) => name.trim())
    .filter(Boolean);
}

function sameRepository(left: string, right: string): boolean {
  const leaf = (value: string) => value.split('/').filter(Boolean).pop() ?? value;
  return leaf(left).toLowerCase() === leaf(right).toLowerCase();
}

/**
 * Pick the feature that should resolve a repository's conflict.
 *
 * Sub-tasks of the same Jira issue record the repositories they changed, so the
 * one naming this repository wins. When nothing matches (a single-task feature,
 * or an older receipt without per-project data) the main feature handles it
 * itself so the flow still completes.
 */
export function findConflictOwner(
  mainFeature: Feature,
  allFeatures: Feature[],
  entry: MergePlanEntry,
  mergeRequestName: string
): Feature {
  const children = getChildFeaturesForParent(mainFeature, allFeatures);
  const candidates = children.filter((candidate) => {
    if (candidate.archive || candidate.supersededBy || candidate.consolidationPlanId) return false;
    if (
      mainFeature.branchName &&
      candidate.branchName &&
      candidate.branchName !== mainFeature.branchName
    )
      return false;
    return changedProjectNames(candidate).some((name) => sameRepository(name, mergeRequestName));
  });

  return candidates[0] ?? mainFeature;
}

/**
 * Instruction sent to the owning feature. It states the repositories, the branch
 * pairs and the required outcome, and forbids touching anything else, because the
 * surrounding merge sequence depends on the other repositories staying put.
 */
export function buildConflictResolutionPrompt(
  conflicts: ConflictedMergeRequest[],
  worktreePath: string
): string {
  const repositories = conflicts.map(
    ({ entry, state }) =>
      `- \`${entry.name}\` (MR !${entry.iid}: ${entry.mrUrl}) — merge \`origin/${state.targetBranch}\` into \`${state.sourceBranch}\``
  );
  const names = conflicts.map(({ entry }) => `\`${entry.name}\``).join(', ');
  return [
    '## Resolve merge conflicts before this task can be completed',
    '',
    'These delivery merge requests cannot be merged because their branches conflict:',
    ...repositories,
    '',
    `Work in \`${worktreePath}\`, and change nothing outside ${names}:`,
    '',
    '1. `git fetch origin <target branch>`',
    "2. Merge `origin/<target branch>` into the merge request's source branch and resolve",
    "   every conflict so the result is correct — keep both sides' intent, do not drop",
    '   either side\'s work, and do not "resolve" by discarding hunks you do not understand.',
    "3. Run each repository's tests and make them pass.",
    "4. Commit each resolution and push it back to that merge request's source branch.",
    '5. Confirm the merge requests no longer report conflicts.',
    '',
    'Do not touch other repositories or other merge requests, and do not merge the merge',
    'requests yourself — the main task merges them after verification. If a conflict needs a',
    'product decision you cannot make, stop and report exactly which files and hunks are',
    'ambiguous instead of guessing.',
  ].join('\n');
}
