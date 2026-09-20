/**
 * @automaker/git-utils
 * Git operations utilities for AutoMaker
 */

// Export command execution utilities
export { execGitCommand } from './exec.js';

// Export types and constants
export {
  BINARY_EXTENSIONS,
  GIT_STATUS_MAP,
  type FileStatus,
  type MergeStateInfo,
} from './types.js';

// Export status utilities
export { isGitRepo, parseGitStatus, detectMergeState, detectMergeCommit } from './status.js';

// Export diff utilities
export {
  generateSyntheticDiffForNewFile,
  appendUntrackedFileDiffs,
  listAllFilesInDirectory,
  generateDiffsForNonGitDirectory,
  getGitRepositoryDiffs,
  getGitRepositoryDiffsWithOptions,
  getCommittedBranchDiffs,
  collectRangeSubmoduleDiffs,
  collectBranchSubmoduleDiffs,
  collectWorkingTreeSubmoduleDiffs,
  collectCommitSetDiffs,
  parseRawGitlinkChanges,
  prefixSubmoduleDiff,
  parseShortstat,
  truncateToUtf8Bytes,
  normalizeCommitText,
  extractChildIndex,
  extractChildIndexes,
  resolveTaskCommitMatcher,
  deriveJiraKeyFromId,
  matchesTaskCommit,
  isParentTask,
  selectTaskCommits,
  resolveMergeBase,
  listBranchCommits,
  DEFAULT_MAX_DIFF_BYTES,
  type SubmoduleDiffSummary,
  type SubmoduleChangeStatus,
  type GitlinkChange,
  type BranchCommit,
  type TaskCommitMatcher,
  type TaskScopeInfo,
  type TaskScopeFeature,
} from './diff.js';

// Export conflict utilities
export { getConflictFiles } from './conflict.js';

// Export branch utilities
export { getCurrentBranch } from './branch.js';
