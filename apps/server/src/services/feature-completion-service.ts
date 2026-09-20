/**
 * Orchestrates "Complete" for a verified feature that delivered merge requests.
 *
 * The order is deliberate and must not be shuffled:
 *   1. resolve conflicts on the MR source branches
 *   2. run local verification on the conflict-resolved trees
 *   3. mark the MRs ready (drop the `Draft:` prefix)
 *   4. merge them one by one, subprojects before the root repository
 *
 * Verification runs before step 3 so a broken conflict resolution leaves every
 * MR as a draft and keeps the target branch untouched.
 */

import { createLogger } from '@automaker/utils';
import type { MergePlanEntry } from './feature-merge-plan.js';
import type { GitLabMergeService, MergeRequestState } from './gitlab-merge-service.js';

const logger = createLogger('FeatureCompletionService');

export type CompletionStage = 'conflicts' | 'verify' | 'ready' | 'merge' | 'done';

export interface CompletionResult {
  ok: boolean;
  stage: CompletionStage;
  /** MR URLs that are now merged. */
  merged: string[];
  /** Projects whose merge requests were already merged before this run. */
  alreadyMerged: string[];
  /** Verification output, when verification ran. */
  verificationLog?: string;
  error?: string;
}

export interface CompletionDependencies {
  gitlab: GitLabMergeService;
  /**
   * Resolve the conflict for one project, pushing the resolution back to that
   * merge request's source branch.
   *
   * The main task dispatches this per conflicted project so the work goes to the
   * sub-task that owns that repository, rather than having one agent try to fix
   * every repository at once. The main task keeps ownership of verification.
   */
  resolveConflict: (
    entry: MergePlanEntry,
    state: MergeRequestState
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Run the per-repository verification commands on the resolved trees. */
  runVerification: (
    entries: MergePlanEntry[]
  ) => Promise<{ ok: boolean; log?: string; error?: string }>;
  onProgress?: (message: string) => void;
}

/**
 * Run the completion pipeline. Stops at the first failing stage and reports
 * which stage failed so the caller can keep the feature in Verified.
 */
export async function completeFeatureMergeRequests(
  plan: MergePlanEntry[],
  deps: CompletionDependencies
): Promise<CompletionResult> {
  const merged: string[] = [];
  const alreadyMerged: string[] = [];
  const progress = (message: string) => {
    logger.info(message);
    deps.onProgress?.(message);
  };

  if (plan.length === 0) {
    return { ok: true, stage: 'done', merged, alreadyMerged };
  }

  // --- gather state -------------------------------------------------------
  const pending: Array<{ entry: MergePlanEntry; state: MergeRequestState }> = [];
  for (const entry of plan) {
    const state = await deps.gitlab.getMergeRequest(entry.mrUrl);
    if (!state) {
      return {
        ok: false,
        stage: 'conflicts',
        merged,
        alreadyMerged,
        error: `Could not read merge request ${entry.mrUrl}`,
      };
    }
    if (state.state === 'merged') {
      alreadyMerged.push(entry.mrUrl);
      continue;
    }
    if (state.state !== 'opened') {
      return {
        ok: false,
        stage: 'merge',
        merged,
        alreadyMerged,
        error: `Merge request ${entry.mrUrl} is ${state.state}, not open`,
      };
    }
    pending.push({ entry, state });
  }

  if (pending.length === 0) {
    return { ok: true, stage: 'done', merged, alreadyMerged };
  }

  // --- 1. conflicts, before anything reaches the target branch ------------
  const conflicted = pending.filter((item) => item.state.hasConflicts);
  if (conflicted.length > 0) {
    // Dispatch one conflict-resolution task per affected project and wait for
    // each before moving on, so a failure is attributable to one repository.
    for (const item of conflicted) {
      progress(`Dispatching conflict resolution for ${item.entry.name}`);
      const resolved = await deps.resolveConflict(item.entry, item.state);
      if (!resolved.ok) {
        return {
          ok: false,
          stage: 'conflicts',
          merged,
          alreadyMerged,
          error: `Conflict resolution failed for ${item.entry.name}: ${
            resolved.error ?? 'unknown error'
          }`,
        };
      }
      const recheck = await deps.gitlab.getMergeRequest(item.entry.mrUrl);
      if (!recheck) {
        return {
          ok: false,
          stage: 'conflicts',
          merged,
          alreadyMerged,
          error: `Could not re-read merge request ${item.entry.mrUrl} after conflict resolution`,
        };
      }
      if (recheck.hasConflicts) {
        return {
          ok: false,
          stage: 'conflicts',
          merged,
          alreadyMerged,
          error: `Merge request for ${item.entry.name} still has conflicts`,
        };
      }
      // The resolution was pushed to the source branch, so the head moved. Keep
      // the refreshed state: the ready/merge steps below must use the new sha
      // (GitLab rejects a merge whose `sha` no longer matches the branch head)
      // and the current draft/title.
      item.state = recheck;
    }
  }

  // --- 2. local verification on the resolved trees ------------------------
  progress('Running local verification');
  const verification = await deps.runVerification(pending.map((item) => item.entry));
  if (!verification.ok) {
    return {
      ok: false,
      stage: 'verify',
      merged,
      alreadyMerged,
      verificationLog: verification.log,
      error: verification.error ?? 'Local verification failed',
    };
  }

  // --- 3. mark ready ------------------------------------------------------
  for (const item of pending) {
    if (!item.state.draft) continue;
    const ready = await deps.gitlab.markReady(item.entry.mrUrl, item.state.title);
    if (!ready.ok) {
      return {
        ok: false,
        stage: 'ready',
        merged,
        alreadyMerged,
        verificationLog: verification.log,
        error: `Could not mark ${item.entry.name} ready: ${ready.error ?? 'unknown error'}`,
      };
    }
  }

  // --- 4. merge one by one, in plan order --------------------------------
  for (const item of pending) {
    progress(`Merging ${item.entry.name} (!${item.entry.iid})`);
    const result = await deps.gitlab.merge(item.entry.mrUrl, { sha: item.state.sha });
    if (!result.ok) {
      return {
        ok: false,
        stage: 'merge',
        merged,
        alreadyMerged,
        verificationLog: verification.log,
        error: `Merge failed for ${item.entry.name}: ${result.error ?? 'unknown error'}`,
      };
    }
    merged.push(item.entry.mrUrl);
  }

  return { ok: true, stage: 'done', merged, alreadyMerged, verificationLog: verification.log };
}
