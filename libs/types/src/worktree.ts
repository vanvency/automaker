/**
 * Worktree and PR-related types
 * Shared across server and UI components
 */

/** GitHub PR states as returned by the GitHub API (uppercase) */
export type PRState = 'OPEN' | 'MERGED' | 'CLOSED';

/** Valid PR states for validation */
export const PR_STATES: readonly PRState[] = ['OPEN', 'MERGED', 'CLOSED'] as const;

/**
 * Validates a PR state value from external APIs (e.g., GitHub CLI).
 * Returns the validated state if it matches a known PRState, otherwise returns 'OPEN' as default.
 * This is safer than type assertions as it handles unexpected values from external APIs.
 *
 * @param state - The state string to validate (can be any string)
 * @returns A valid PRState value
 */
export function validatePRState(state: string | undefined | null): PRState {
  return PR_STATES.find((s) => s === state) ?? 'OPEN';
}

/** PR information stored in worktree metadata */
export interface WorktreePRInfo {
  number: number;
  url: string;
  title: string;
  /** PR state: OPEN, MERGED, or CLOSED */
  state: PRState;
  createdAt: string;
}

/**
 * Request payload for adding a git remote
 */
export interface AddRemoteRequest {
  /** Path to the git worktree/repository */
  worktreePath: string;
  /** Name for the remote (e.g., 'origin', 'upstream') */
  remoteName: string;
  /** URL of the remote repository (HTTPS, SSH, or git:// protocol) */
  remoteUrl: string;
}

/**
 * Result data from a successful add-remote operation
 */
export interface AddRemoteResult {
  /** Name of the added remote */
  remoteName: string;
  /** URL of the added remote */
  remoteUrl: string;
  /** Whether the initial fetch was successful */
  fetched: boolean;
  /** Human-readable status message */
  message: string;
}

/**
 * Successful response from add-remote endpoint
 */
export interface AddRemoteResponse {
  success: true;
  result: AddRemoteResult;
}

/**
 * Error response from add-remote endpoint
 */
export interface AddRemoteErrorResponse {
  success: false;
  error: string;
  /** Optional error code for specific error types (e.g., 'REMOTE_EXISTS') */
  code?: string;
}

/**
 * Merge state information for a git repository
 */
export interface MergeStateInfo {
  /** Whether a merge is currently in progress */
  isMerging: boolean;
  /** Type of merge operation: 'merge' | 'rebase' | 'cherry-pick' | null */
  mergeOperationType: 'merge' | 'rebase' | 'cherry-pick' | null;
  /** Whether the merge completed cleanly (no conflicts) */
  isCleanMerge: boolean;
  /** Files affected by the merge */
  mergeAffectedFiles: string[];
  /** Files with unresolved conflicts */
  conflictFiles: string[];
  /** Whether the current HEAD is a completed merge commit (has multiple parents) */
  isMergeCommit?: boolean;
}

// ============================================================================
// Worktree progress (Worktree Progress view)
// ============================================================================

/**
 * Coarse lifecycle stage of the feature a worktree belongs to.
 *
 * - `empty`           - worktree has no feature pointing at its branch
 * - `backlog`         - feature exists but no agent has started
 * - `in_progress`     - agent is working on it
 * - `waiting_approval`- agent stopped and a human must review
 * - `complete`        - verified / completed / merged
 * - `failed`          - agent or verification failed
 * - `unknown`         - unrecognized status value
 */
export type WorktreeProgressStage =
  | 'empty'
  | 'backlog'
  | 'in_progress'
  | 'waiting_approval'
  | 'complete'
  | 'failed'
  | 'unknown';

/** Feature summary attached to a worktree progress row */
export interface WorktreeProgressFeature {
  id: string;
  title?: string;
  status?: string;
  category?: string;
  jiraKey?: string;
  jiraUrl?: string;
  updatedAt?: string;
}

/** One card on the worktree's branch (parent or child) */
export interface WorktreeProgressTask {
  id: string;
  title?: string;
  status?: string;
  /** Lifecycle stage of this card, same mapping as the worktree stage */
  stage: WorktreeProgressStage;
  jiraKey?: string;
  jiraType?: string;
  /** True when other cards of this branch are children of this one */
  isParent: boolean;
  /** Ids of the child cards belonging to this one */
  childIds: string[];
}

/** Card counts of one worktree, used for the "x/y done" rollup */
export interface WorktreeProgressCounts {
  /** Cards on the branch (the worktree's task and its children) */
  total: number;
  completed: number;
  running: number;
  waiting: number;
  failed: number;
  backlog: number;
}

/**
 * Why a human should look at this worktree, highest priority first:
 * unresolved conflicts, an agent waiting for input, a failed run, or work
 * waiting for review.
 */
export type WorktreeProgressAttention = 'conflicts' | 'needs_input' | 'failed' | 'waiting_review';

/** Tip commit of a worktree branch */
export interface WorktreeProgressCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

/** One row of the Worktree Progress view */
export interface WorktreeProgressItem {
  /** Absolute path of the worktree directory */
  path: string;
  /** Branch checked out in the worktree, or `(detached)` */
  branch: string;
  /** Whether this is the main worktree of the repository */
  isMain: boolean;
  /** Feature lifecycle stage */
  stage: WorktreeProgressStage;
  /** Feature that best represents this worktree (highest stage, then most recent) */
  feature: WorktreeProgressFeature | null;
  /** How many features point at this worktree's branch */
  featureCount: number;
  /** Every card on the branch, parents and children alike */
  tasks?: WorktreeProgressTask[];
  /** Card counts across `tasks` (the worktree's task rollup) */
  counts?: WorktreeProgressCounts;
  /** Highest-priority reason a human should look at this worktree */
  attention?: WorktreeProgressAttention | null;
  /** Tip commit of the branch */
  head: WorktreeProgressCommit | null;
  /** Commits on the branch that the base branch does not have */
  ahead: number;
  /** Commits on the base branch that this branch does not have */
  behind: number;
  /** Uncommitted changes in the working directory */
  hasChanges: boolean;
  changedFilesCount: number;
  /** Merge/rebase/cherry-pick with unresolved conflicts */
  hasConflicts: boolean;
  conflictType?: 'merge' | 'rebase' | 'cherry-pick';
  conflictFiles?: string[];
  /** Pull/merge request opened for this branch, if any */
  pr: WorktreePRInfo | null;
  /** Most recent of the branch tip date and the feature's last update */
  lastActivityAt: string | null;
}

/** Response of `POST /api/worktree/progress` */
export interface WorktreeProgressResponse {
  success: boolean;
  projectPath?: string;
  /** Reference branch used for the ahead/behind counts */
  baseBranch?: string | null;
  generatedAt?: string;
  worktrees?: WorktreeProgressItem[];
  error?: string;
}
