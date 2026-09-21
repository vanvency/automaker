/**
 * Feature types for AutoMaker feature management
 */

import type { PlanningMode, ThinkingLevel } from './settings.js';
import type { ReasoningEffort } from './provider.js';

/**
 * A single entry in the description history
 */
export interface DescriptionHistoryEntry {
  description: string;
  timestamp: string; // ISO date string
  source: 'initial' | 'enhance' | 'edit'; // What triggered this version
  enhancementMode?: 'improve' | 'technical' | 'simplify' | 'acceptance' | 'ux-reviewer'; // Only for 'enhance' source
}

export interface FeatureImagePath {
  id: string;
  path: string;
  filename: string;
  mimeType: string;
  [key: string]: unknown;
}

export interface FeatureTextFilePath {
  id: string;
  path: string;
  filename: string;
  mimeType: string;
  content: string; // Text content of the file
  [key: string]: unknown;
}

export type DeliveryStepId = 'merge' | 'jira' | 'preview';
export interface FeatureDelivery {
  reconciliationError?: { stepId: DeliveryStepId; message: string };
  status: 'running' | 'failed' | 'succeeded';
  updatedAt: string;
  steps: Array<{
    id: DeliveryStepId;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
    message?: string;
    updatedAt?: string;
  }>;
}

/** Agent-produced evidence for human acceptance; passing checks is not human approval. */
export interface AcceptanceEvidence {
  status: 'passed' | 'failed' | 'blocked';
  summary: string;
  previewUrl?: string;
  verifiedAt: string;
  importedAt: string;
  commit?: string;
  checks: Array<{
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    details?: string;
  }>;
  screenshots: Array<{
    kind: 'prototype' | 'actual';
    path: string;
    title: string;
    capturedAt: string;
    sourceUrl?: string;
  }>;
}

/**
 * A parsed task extracted from a spec/plan
 * Used for spec and full planning modes to track individual task progress
 */
export interface ParsedTask {
  /** Task ID, e.g., "T001" */
  id: string;
  /** Task description, e.g., "Create user model" */
  description: string;
  /** Optional file path for the task, e.g., "src/models/user.ts" */
  filePath?: string;
  /** Optional phase name for full mode, e.g., "Phase 1: Foundation" */
  phase?: string;
  /** Task execution status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Optional task summary, e.g., "Created User model with email and password fields" */
  summary?: string;
}

/**
 * Plan specification status for feature planning modes
 * Tracks the plan generation and approval workflow
 */
export interface PlanSpec {
  /** Current status of the plan */
  status: 'pending' | 'generating' | 'generated' | 'approved' | 'rejected';
  /** The actual spec/plan markdown content */
  content?: string;
  /** Version number for tracking plan revisions */
  version: number;
  /** ISO timestamp when the spec was generated */
  generatedAt?: string;
  /** ISO timestamp when the spec was approved */
  approvedAt?: string;
  /** True if user has reviewed the spec */
  reviewedByUser: boolean;
  /** Number of completed tasks */
  tasksCompleted?: number;
  /** Total number of tasks in the spec */
  tasksTotal?: number;
  /** ID of the task currently being worked on */
  currentTaskId?: string;
  /** Parsed tasks from the spec content */
  tasks?: ParsedTask[];
}

export interface Feature {
  archive?: import('./task-archive.js').TaskArchiveRecord;
  archiveHistory?: import('./task-archive.js').TaskArchiveRecord[];
  /** Human-confirmed coverage relation; this card must not be dispatched again. */
  supersededBy?: {
    featureId: string;
    jiraKey?: string;
    reason: string;
    planId: string;
    at: string;
  };
  /** Blocks execution while a reviewed consolidation plan is being applied. */
  consolidationPlanId?: string;
  id: string;
  title?: string;
  titleGenerating?: boolean;
  category: string;
  description: string;
  passes?: boolean;
  priority?: number;
  status?: string;
  dependencies?: string[];
  spec?: string;
  model?: string;
  imagePaths?: Array<string | FeatureImagePath | { path: string; [key: string]: unknown }>;
  textFilePaths?: FeatureTextFilePath[];
  acceptanceEvidence?: AcceptanceEvidence;
  deliveryCompletion?: FeatureDelivery;
  // Branch info - worktree path is derived at runtime from branchName
  branchName?: string | null; // Name of the feature branch (undefined/null = use current worktree)
  skipTests?: boolean;
  excludedPipelineSteps?: string[]; // Array of pipeline step IDs to skip for this feature
  thinkingLevel?: ThinkingLevel;
  reasoningEffort?: ReasoningEffort;
  providerId?: string;
  planningMode?: PlanningMode;
  requirePlanApproval?: boolean;
  planSpec?: PlanSpec;
  error?: string;
  /** Review notices do not make a task fail or require an input decision. */
  executionNotice?: {
    kind: 'error' | 'review' | 'interrupted';
    source: 'execution' | 'delivery' | 'recovery';
    message: string;
    occurredAt: string;
  };
  summary?: string;
  /** Repositories or top-level projects changed by this feature. */
  changedProjects?: ChangedProject[];
  /**
   * Jira subtasks this feature delivers as one worktree/branch. Present when the
   * issue was already split in Jira, so the card can show the covered subtasks
   * instead of relying on separate Automaker child features.
   */
  jiraSubtasks?: JiraSubtask[];
  /**
   * Normalized Jira work type of the issue (epic/story/feat/impr/bugfix/task).
   * Shown as the worktree badge so legacy `jira/<key>-<label>` branches still
   * make their type obvious.
   */
  jiraType?: JiraWorkType;
  /** Jira labels of the issue (release-* labels are shown on the card). */
  jiraLabels?: string[];
  /** Jira issue this card executes (the task, for an imported hierarchy). */
  jiraKey?: string;
  jiraIssueId?: string;
  jiraDelivery?: import('./jira-sync.js').JiraDeliveryScope;
  jiraInstanceUrl?: string;
  jiraStatus?: string;
  executionRunId?: string;
  jiraDispatchRunId?: string;
  jiraPendingDescription?: string;
  jiraSyncHistory?: Array<{
    runId: string;
    at: string;
    actor: string;
    action: string;
    fields: string[];
    reason: string;
  }>;
  /** Browsable Jira URL of `jiraKey`. */
  jiraUrl?: string;
  /**
   * Jira issue type of `jiraKey`, for example `Story` or `Backend-Task`.
   * Product owns the Epic → Story → Task breakdown, so imports keep the Jira
   * type instead of the normalized `jiraType` bucket.
   */
  issueType?: string;
  /** Parent issue key: the story for a task, the epic for a story. */
  parentJiraKey?: string;
  /**
   * Feature id of the parent card, when this card is a child in a task tree.
   * Root tasks leave this undefined; children carry both this id and
   * `parentJiraKey` so ordering, rollups and Jira deep links stay exact.
   */
  parentFeatureId?: string;
  /** Owning epic key (equal to `jiraKey` on the epic card itself). */
  epicJiraKey?: string;
  /**
   * Version and worktree-relative location of the rendered epic/story/task
   * context bundle handed to the agent for an imported card.
   */
  jiraContext?: {
    version: string;
    syncedAt: string;
    path?: string;
  };
  /** True when the card was imported from Jira, so it is never re-decomposed. */
  jiraImported?: boolean;
  /**
   * Automaker-side decomposition of a card that Jira did not split.
   *
   * The leader proposes the split, the human approves it on the board, and only
   * then are the Jira sub-tasks created (by the monitor, the single Jira writer);
   * the created keys come back as `jiraSubtasks` and are what dispatch executes.
   */
  decompositionRequest?: {
    status: 'proposed' | 'creating-jira' | 'created' | 'rejected' | 'failed';
    tasks: Array<{
      id: string;
      description: string;
      filePath?: string;
      phase?: string;
    }>;
    createdAt?: string;
    approvedAt?: string;
    createdKeys?: string[];
    error?: string;
  };
  /** Changes detected on the Jira issue since this card was imported/updated. */
  jiraChanges?: JiraChange[];
  /** Actual MR/PR URLs created for this feature. */
  mergeRequests?: string[];
  /**
   * herdr placement of this card's agent conversation: the worktree's space
   * (one per worktree) inside the project's herdr session, and the task's tab
   * inside that space (one per card).
   */
  herdrWorkspaceId?: string;
  herdrTabId?: string;
  /** Native session id of the CLI agent that ran this card (pi session id). */
  providerSessionId?: string;
  /** Separate Pi viewer session when the execution provider is not Pi. */
  herdrPiSessionId?: string;
  createdAt?: string; // ISO timestamp when feature was created
  updatedAt?: string; // ISO timestamp of the last state change
  startedAt?: string;
  /** When the card entered Done (verified); cleared when work resumes on it. */
  verifiedAt?: string;
  /**
   * Checkout Automaker released after the card stayed in Done past the retention
   * window. The branch stays on the remote and metadata/conversations live
   * outside the worktree, so the next Reply/Agent run rebuilds this path.
   */
  worktreeRelease?: {
    releasedAt: string;
    /** Checkout path that was removed and is reused when rebuilding */
    path: string;
    branch: string;
  };
  descriptionHistory?: DescriptionHistoryEntry[]; // History of description changes
  [key: string]: unknown; // Keep catch-all for extensibility
}

/** Legacy errors still need attention; explicit review notices stay in review. */
export function hasFeatureAttentionError(
  feature: Pick<Feature, 'status' | 'error' | 'executionNotice'>
): boolean {
  return (
    feature.status !== 'verified' &&
    feature.status !== 'completed' &&
    !(feature.status === 'waiting_approval' && feature.executionNotice?.kind === 'review') &&
    typeof feature.error === 'string' &&
    feature.error.trim() !== ''
  );
}

export interface ChangedProject {
  /** Project/repository path or display name (for example backend/service). */
  name: string;
  /** Actual MR/PR URL for this project, when one was created. */
  mrUrl?: string;
}

/** A Jira subtask that a dispatched feature covers in its single worktree. */
export interface JiraSubtask {
  /** Jira issue key, for example AIP-114928. */
  key: string;
  /** Subtask summary as written in Jira. */
  summary?: string;
  /** Jira workflow status name (待办, In Progress, ...). */
  status?: string;
  /** Jira issue type name (Frontend-Task, QA-Task, ...). */
  type?: string;
}

/**
 * Normalized Jira work type of an issue. Used as the branch prefix and shown as
 * the worktree badge, so the kind of work is visible even when a legacy branch
 * is still named `jira/<key>-<label>`.
 */
export type JiraWorkType = 'epic' | 'story' | 'feat' | 'impr' | 'bugfix' | 'task';

export type FeatureStatus = 'pending' | 'running' | 'completed' | 'failed' | 'verified';

/**
 * Export format for a feature, used when exporting features to share or backup
 */
export interface FeatureExport {
  /** Export format version for compatibility checking */
  version: string;
  /** The feature data being exported */
  feature: Feature;
  /** ISO date string when the export was created */
  exportedAt: string;
  /** Optional identifier of who/what performed the export */
  exportedBy?: string;
  /** Additional metadata about the export context */
  metadata?: {
    projectName?: string;
    projectPath?: string;
    branch?: string;
    [key: string]: unknown;
  };
}

/**
 * Options for importing a feature
 */
export interface FeatureImport {
  /** The feature data to import (can be raw Feature or wrapped FeatureExport) */
  data: Feature | FeatureExport;
  /** Whether to overwrite an existing feature with the same ID */
  overwrite?: boolean;
  /** Whether to preserve the original branchName or ignore it */
  preserveBranchInfo?: boolean;
  /** Optional new ID to assign (if not provided, uses the feature's existing ID) */
  newId?: string;
  /** Optional new category to assign */
  targetCategory?: string;
}

/**
 * Result of a feature import operation
 */
export interface FeatureImportResult {
  /** Whether the import was successful */
  success: boolean;
  /** The ID of the imported feature */
  featureId?: string;
  /** ISO date string when the import was completed */
  importedAt: string;
  /** Non-fatal warnings encountered during import */
  warnings?: string[];
  /** Errors that caused import failure */
  errors?: string[];
  /** Whether an existing feature was overwritten */
  wasOverwritten?: boolean;
}

/**
 * A Jira-side change detected when re-importing an issue. The card shows the
 * before/after so a human decides what to do next; Automaker never rewrites
 * delivered work or re-runs a card on its own.
 */
export interface JiraChange {
  /** Field that changed: summary, description, assignee, labels, subtasks. */
  field: string;
  /** Human-readable previous value (omitted for added entries). */
  before?: string;
  /** Human-readable new value (omitted for removed entries). */
  after?: string;
  /** ISO timestamp when the change was detected. */
  detectedAt: string;
}
