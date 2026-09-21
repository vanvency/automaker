import { activeDeliveryProjects } from './delivery-completion.js';
/**
 * ExecutionService - Feature execution lifecycle coordination
 */

import path from 'path';
import { randomUUID } from 'node:crypto';
import type { ChangedProject, Feature } from '@automaker/types';
import { createLogger, classifyError, loadContextFiles, recordMemoryUsage } from '@automaker/utils';
import { resolveModelString, DEFAULT_MODELS } from '@automaker/model-resolver';
import { getFeatureDir } from '@automaker/platform';
import { isShuttingDown } from '../lib/shutdown-state.js';
import { ProviderFactory } from '../providers/provider-factory.js';
import * as secureFs from '../lib/secure-fs.js';
import {
  getPromptCustomization,
  getAutoLoadClaudeMdSetting,
  getUseClaudeCodeSystemPromptSetting,
  filterClaudeMdFromContext,
} from '../lib/settings-helpers.js';
import { validateWorkingDirectory } from '../lib/sdk-options.js';
import { extractSummary } from './spec-parser.js';
import type { TypedEventBus } from './typed-event-bus.js';
import type { ConcurrencyManager, RunningFeature } from './concurrency-manager.js';
import type { WorktreeResolver } from './worktree-resolver.js';
import type { SettingsService } from './settings-service.js';
import type { FeatureConversationSink } from './agent-service.js';
import { pipelineService } from './pipeline-service.js';
import { collectAcceptanceEvidence } from './acceptance-evidence-service.js';

// Re-export callback types from execution-types.ts for backward compatibility
export type {
  RunAgentFn,
  ExecutePipelineFn,
  UpdateFeatureStatusFn,
  LoadFeatureFn,
  GetPlanningPromptPrefixFn,
  SaveFeatureSummaryFn,
  RecordLearningsFn,
  ContextExistsFn,
  ResumeFeatureFn,
  TrackFailureFn,
  SignalPauseFn,
  RecordSuccessFn,
  SaveExecutionStateFn,
  LoadContextFilesFn,
} from './execution-types.js';

import type {
  RunAgentFn,
  ExecutePipelineFn,
  UpdateFeatureStatusFn,
  LoadFeatureFn,
  GetPlanningPromptPrefixFn,
  SaveFeatureSummaryFn,
  RecordLearningsFn,
  ContextExistsFn,
  ResumeFeatureFn,
  TrackFailureFn,
  SignalPauseFn,
  RecordSuccessFn,
  SaveExecutionStateFn,
  LoadContextFilesFn,
} from './execution-types.js';

import { DEVELOPMENT_COMPLETION_POLICY } from './continuation-prompt.js';

const logger = createLogger('ExecutionService');

/** Marker written by agent-executor for each tool invocation. */
const TOOL_USE_MARKER = '🔧 Tool:';

/** Minimum trimmed output length to consider agent work meaningful. */
const MIN_MEANINGFUL_OUTPUT_LENGTH = 200;

/**
 * How often the mirrored AgentSession picks up new agent-output.md content.
 * The executor rewrites that file with a 500ms debounce, so a slightly slower
 * poll shows the conversation while the feature is still running without
 * hammering the disk.
 */
const FEATURE_CONVERSATION_POLL_MS = 1_500;

/**
 * Provider errors that mean a recorded conversation id can no longer be
 * resumed. The id is cleared so the next attempt starts a fresh session instead
 * of failing the same way forever.
 */
function isStaleProviderSessionError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('session not found') ||
    text.includes('session expired') ||
    text.includes('invalid session') ||
    text.includes('no such session')
  );
}

function normalizeReceiptMrUrl(value: unknown): string | undefined {
  const url = String(value ?? '').trim();
  return /^https?:\/\/\S+\/merge_requests\/\d+\/?$/i.test(url) ? url : undefined;
}

function normalizeReceiptMergeRequests(receipt: Record<string, unknown>): string[] {
  const value = receipt.mergeRequests;
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === 'string') return normalizeReceiptMrUrl(entry);
      if (entry && typeof entry === 'object') {
        const record = entry as { url?: unknown; mrUrl?: unknown };
        return normalizeReceiptMrUrl(record.url ?? record.mrUrl);
      }
      return undefined;
    })
    .filter((url): url is string => Boolean(url));
}

function normalizeReceiptChangedProjects(receipt: Record<string, unknown>): ChangedProject[] {
  const value = receipt.changedProjects;
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        const name = entry.trim();
        return name ? { name } : null;
      }
      if (entry && typeof entry === 'object') {
        const record = entry as { name?: unknown; mrUrl?: unknown; url?: unknown };
        const name = String(record.name ?? '').trim();
        if (!name) return null;
        return {
          name,
          mrUrl: normalizeReceiptMrUrl(record.mrUrl ?? record.url),
        };
      }
      return null;
    })
    .map((project) => (project ? withRealProjectName(project) : null))
    .filter((project): project is ChangedProject => Boolean(project));
}

/** Labels agents use instead of the real repository path */
const GENERIC_PROJECT_LABELS = new Set([
  '子项目',
  '子仓库',
  '子模块',
  '根项目',
  '根仓',
  '主项目',
  '主仓',
  '父项目',
  '仓库',
  '项目',
  'subproject',
  'submodule',
  'root',
  'rootproject',
  'rootrepo',
  'mainproject',
  'mainrepo',
  'parentproject',
  'parentrepo',
  'repo',
  'project',
  'workspace',
  'child',
  'childproject',
]);

/**
 * Resolve `group/subgroup/project` from a GitLab merge request URL.
 */
export function deriveProjectNameFromMrUrl(mrUrl: string | undefined): string | undefined {
  if (!mrUrl) return undefined;
  const match = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?merge_requests\/\d+\/?$/i.exec(mrUrl.trim());
  const projectPath = match?.[1]?.trim();
  return projectPath ? projectPath : undefined;
}

/**
 * Store the real repository path instead of generic labels like "子项目"/"根仓".
 * Keeps historical `changedProjects` readable when the receipt only carried a
 * relative label but a concrete MR URL.
 */
export function withRealProjectName(project: ChangedProject): ChangedProject {
  const normalized = project.name.toLowerCase().replace(/[\s_\-·、,，:：()（）[\]【】]/g, '');
  if (!project.mrUrl || !GENERIC_PROJECT_LABELS.has(normalized)) {
    return project;
  }
  const derived = deriveProjectNameFromMrUrl(project.mrUrl);
  return derived ? { ...project, name: derived } : project;
}

export class ExecutionService {
  constructor(
    private eventBus: TypedEventBus,
    private concurrencyManager: ConcurrencyManager,
    private worktreeResolver: WorktreeResolver,
    private settingsService: SettingsService | null,
    // Callback dependencies for delegation
    private runAgentFn: RunAgentFn,
    private executePipelineFn: ExecutePipelineFn,
    private updateFeatureStatusFn: UpdateFeatureStatusFn,
    private loadFeatureFn: LoadFeatureFn,
    private getPlanningPromptPrefixFn: GetPlanningPromptPrefixFn,
    private saveFeatureSummaryFn: SaveFeatureSummaryFn,
    private recordLearningsFn: RecordLearningsFn,
    private contextExistsFn: ContextExistsFn,
    private resumeFeatureFn: ResumeFeatureFn,
    private trackFailureFn: TrackFailureFn,
    private signalPauseFn: SignalPauseFn,
    private recordSuccessFn: RecordSuccessFn,
    private saveExecutionStateFn: SaveExecutionStateFn,
    private loadContextFilesFn: LoadContextFilesFn,
    private featureStateManager?: {
      updateFeatureFields: (p: string, id: string, fields: Partial<Feature>) => Promise<void>;
    },
    /**
     * Optional sink that publishes the run as an AgentSession so the Agent view
     * lists feature conversations while they are still in progress.
     */
    private featureConversations?: FeatureConversationSink,
    /** Rebuilds a checkout that the Done lane's retention job released. */
    private worktreeRetention?: {
      ensureWorktree: (projectPath: string, feature: Feature) => Promise<string | null>;
    }
  ) {}

  private acquireRunningFeature(options: {
    featureId: string;
    projectPath: string;
    isAutoMode: boolean;
    allowReuse?: boolean;
  }): RunningFeature {
    return this.concurrencyManager.acquire(options);
  }

  private releaseRunningFeature(featureId: string, options?: { force?: boolean }): void {
    this.concurrencyManager.release(featureId, options);
  }

  private extractTitleFromDescription(description: string | undefined): string {
    if (!description?.trim()) return 'Untitled Feature';
    const firstLine = description.split('\n')[0].trim();
    return firstLine.length <= 60 ? firstLine : firstLine.substring(0, 57) + '...';
  }

  /**
   * Build feature description section (without implementation instructions).
   * Used when planning mode is active — the planning prompt provides its own instructions.
   */
  buildFeatureDescription(feature: Feature): string {
    const title = this.extractTitleFromDescription(feature.description);

    let prompt = `## Feature Task

**Feature ID:** ${feature.id}
**Title:** ${title}
**Description:** ${feature.description}
`;

    if (feature.spec) {
      prompt += `
**Specification:**
${feature.spec}
`;
    }

    if (feature.imagePaths && feature.imagePaths.length > 0) {
      const imagesList = feature.imagePaths
        .map((img, idx) => {
          const imgPath = typeof img === 'string' ? img : img.path;
          const filename =
            typeof img === 'string'
              ? imgPath.split('/').pop()
              : img.filename || imgPath.split('/').pop();
          const mimeType = typeof img === 'string' ? 'image/*' : img.mimeType || 'image/*';
          return `   ${idx + 1}. ${filename} (${mimeType})\n      Path: ${imgPath}`;
        })
        .join('\n');
      prompt += `\n**Context Images Attached:**\n${feature.imagePaths.length} image(s) attached:\n${imagesList}\n`;
    }

    return prompt;
  }

  buildFeaturePrompt(
    feature: Feature,
    taskExecutionPrompts: {
      implementationInstructions: string;
      playwrightVerificationInstructions: string;
    }
  ): string {
    let prompt = this.buildFeatureDescription(feature);

    prompt += feature.skipTests
      ? `\n${taskExecutionPrompts.implementationInstructions}`
      : `\n${taskExecutionPrompts.implementationInstructions}\n\n${taskExecutionPrompts.playwrightVerificationInstructions}`;
    return prompt;
  }

  /**
   * Prompt for re-running a feature that already owns a provider session.
   *
   * The session holds the original description and implementation instructions,
   * so only a short anchor plus the summary contract (which the server parses)
   * is sent. This keeps the first turn the only place the full scaffolding is
   * transmitted.
   */
  buildContinuingFeaturePrompt(feature: Feature): string {
    const title = feature.title || feature.id;
    return `## Continue Feature Implementation

**Feature ID:** ${feature.id}
**Title:** ${title}

This conversation already contains the feature description, the implementation
instructions and the work done so far. Continue from the current state instead of
restarting, and re-verify your changes before stopping.

When you stop, end your reply with the summary block the conversation already
requires:

<summary>
## Summary: ${title}
### Changes Implemented
- [...]
### Files Modified
- [...]
### Notes for Developer
- [...]
</summary>
`;
  }

  async executeFeature(
    projectPath: string,
    featureId: string,
    useWorktrees = false,
    isAutoMode = false,
    providedWorktreePath?: string,
    options?: { continuationPrompt?: string; _calledInternally?: boolean }
  ): Promise<void> {
    if (activeDeliveryProjects.has(projectPath))
      throw new Error('Complete is running for this project; wait before starting an Agent');
    const executionStartedAt = Date.now();
    const tempRunningFeature = this.acquireRunningFeature({
      featureId,
      projectPath,
      isAutoMode,
      allowReuse: options?._calledInternally,
    });
    const abortController = tempRunningFeature.abortController;
    // Persist running features for every execution, not just auto-mode.
    // Manual starts (including Jira-dispatched tasks) would otherwise be reset
    // to backlog on restart and never resumed.
    await this.saveExecutionStateFn(projectPath);
    let feature: Feature | null = null;
    let pipelineCompleted = false;
    /** Closer for the AgentSession mirroring this run, when one was registered */
    let closeFeatureConversation: ((error?: string) => Promise<void>) | null = null;
    /** Failure surfaced to the mirrored conversation when the run does not succeed */
    let conversationError: string | undefined;

    try {
      validateWorkingDirectory(projectPath);
      feature = await this.loadFeatureFn(projectPath, featureId);
      if (!feature) throw new Error(`Feature ${featureId} not found`);
      if (feature.archive || feature.supersededBy || feature.consolidationPlanId) {
        logger.info(`Task ${featureId} is covered or locked for consolidation; execution skipped`);
        return;
      }
      if (feature.jiraIssueId && this.featureStateManager) {
        feature.executionRunId = feature.jiraDispatchRunId || randomUUID();
        await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
          executionRunId: feature.executionRunId,
          jiraDispatchRunId: undefined,
        });
      }
      if (!options?._calledInternally && this.featureStateManager) {
        await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
          error: undefined,
          executionNotice: undefined,
          completionSource: undefined,
        });
      }

      // Update status to in_progress immediately after acquiring the feature.
      // This prevents a race condition where the UI reloads features and sees the
      // feature still in 'backlog' status while it's actually being executed.
      // Only do this for the initial call (not internal/recursive calls which would
      // redundantly update the status).
      if (
        !options?._calledInternally &&
        (feature.status === 'backlog' ||
          feature.status === 'ready' ||
          feature.status === 'interrupted' ||
          !!options?.continuationPrompt)
      ) {
        await this.updateFeatureStatusFn(projectPath, featureId, 'in_progress');
      }

      if (!options?.continuationPrompt) {
        if (feature.planSpec?.status === 'approved') {
          const prompts = await getPromptCustomization(this.settingsService, '[ExecutionService]');
          let continuationPrompt = prompts.taskExecution.continuationAfterApprovalTemplate;
          continuationPrompt = continuationPrompt
            .replace(/\{\{userFeedback\}\}/g, '')
            .replace(/\{\{approvedPlan\}\}/g, feature.planSpec.content || '');
          return await this.executeFeature(
            projectPath,
            featureId,
            useWorktrees,
            isAutoMode,
            providedWorktreePath,
            { continuationPrompt, _calledInternally: true }
          );
        }
        if (await this.contextExistsFn(projectPath, featureId)) {
          return await this.resumeFeatureFn(projectPath, featureId, useWorktrees, true);
        }
      }

      let worktreePath: string | null = providedWorktreePath ?? null;
      const branchName = feature.branchName;
      // A card whose checkout was released (Done longer than the retention
      // window) is rebuilt from its branch here: the work belongs on that
      // branch, so running it in the main checkout would edit the wrong tree.
      const needsCheckout = useWorktrees || !!feature.worktreeRelease;
      if (!worktreePath && needsCheckout && branchName) {
        worktreePath = await this.worktreeResolver.findWorktreeForBranch(projectPath, branchName);
        if (!worktreePath && feature.worktreeRelease) {
          const rebuilt = await this.worktreeRetention?.ensureWorktree(projectPath, feature);
          if (rebuilt) worktreePath = rebuilt;
        }
        if (!worktreePath) {
          throw new Error(
            `Worktree enabled but no worktree found for feature branch "${branchName}".`
          );
        }
        logger.info(`Using worktree for branch "${branchName}": ${worktreePath}`);
      }
      const workDir = worktreePath ? path.resolve(worktreePath) : path.resolve(projectPath);
      validateWorkingDirectory(workDir);
      tempRunningFeature.worktreePath = worktreePath;
      tempRunningFeature.branchName = branchName ?? null;
      // Ensure status is in_progress (may already be set from the early update above,
      // but internal/recursive calls skip the early update and need it here).
      // Mirror the external guard: only transition when the feature is still in
      // backlog, ready, or interrupted to avoid overwriting a concurrent terminal status.
      if (
        options?._calledInternally &&
        (feature.status === 'backlog' ||
          feature.status === 'ready' ||
          feature.status === 'interrupted')
      ) {
        await this.updateFeatureStatusFn(projectPath, featureId, 'in_progress');
      }
      this.eventBus.emitAutoModeEvent('auto_mode_feature_start', {
        featureId,
        projectPath,
        branchName: feature.branchName ?? null,
        feature: {
          id: featureId,
          title: feature.title || 'Loading...',
          description: feature.description || 'Feature is starting',
        },
      });

      const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
        projectPath,
        this.settingsService,
        '[ExecutionService]'
      );
      const useClaudeCodeSystemPrompt = await getUseClaudeCodeSystemPromptSetting(
        projectPath,
        this.settingsService,
        '[ExecutionService]'
      );
      const prompts = await getPromptCustomization(this.settingsService, '[ExecutionService]');
      let prompt: string;
      const contextResult = await this.loadContextFilesFn({
        projectPath,
        fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
        taskContext: {
          title: feature.title ?? '',
          description: feature.description ?? '',
        },
      });
      const combinedSystemPrompt = filterClaudeMdFromContext(contextResult, autoLoadClaudeMd);
      // Continue the feature's existing provider conversation so every approval
      // round and follow-up lands in the same session instead of a clean one.
      const providerSessionId = (feature as { providerSessionId?: string }).providerSessionId;

      if (options?.continuationPrompt) {
        prompt = options.continuationPrompt;
      } else {
        const planningPrefix = await this.getPlanningPromptPrefixFn(feature);
        if (planningPrefix) {
          // Planning mode active: use planning instructions + feature description only.
          // Do NOT include implementationInstructions — they conflict with the planning
          // prompt's "DO NOT proceed with implementation until approval" directive.
          prompt = planningPrefix + '\n\n' + this.buildFeatureDescription(feature);
        } else if (providerSessionId) {
          // Continuing an existing conversation: resend only a short anchor so the
          // transcript is not duplicated on every re-run.
          prompt = this.buildContinuingFeaturePrompt(feature);
        } else {
          prompt = this.buildFeaturePrompt(feature, prompts.taskExecution);
        }
        if (feature.planningMode && feature.planningMode !== 'skip') {
          this.eventBus.emitAutoModeEvent('planning_started', {
            featureId: feature.id,
            mode: feature.planningMode,
            message: `Starting ${feature.planningMode} planning phase`,
          });
        }
      }

      const imagePaths = feature.imagePaths?.map((img) =>
        typeof img === 'string' ? img : img.path
      );
      prompt += `\n\n${DEVELOPMENT_COMPLETION_POLICY}`;
      if (feature.executionRunId && feature.jiraIssueId) {
        prompt += `\n\nExecution run ID: ${feature.executionRunId}\nWrite this exact runId in the feature-scoped jira-result.json receipt. Old receipts must not be reused.`;
      }
      if (feature.jiraDelivery) {
        // Old imported descriptions may still contain automatic decomposition
        // permission. The current delivery policy must win without rewriting history.
        prompt += `\n\nCurrent Jira delivery policy (supersedes historical import instructions):
Delivery issue: ${feature.jiraDelivery.issueKey}. Jira subtasks: ${feature.jiraDelivery.subtaskKeys.join(', ') || 'none'}.
Deliver the parent and its Jira subtasks in this task's worktree; do not create duplicate Automaker child cards or independent subtask worktrees.
${feature.jiraDelivery.requiresDecision ? 'Jira has not split this Epic/Story. Unless this turn explicitly approves an Automaker split, ask for a human decision before implementation and report needs_input. Absence of Jira subtasks is not authorization to split.' : ''}
${feature.jiraDelivery.conflictingCards?.length ? `Independent child cards already exist: ${feature.jiraDelivery.conflictingCards.join(', ')}. Confirm their delivery scope before implementing overlapping work.` : ''}`;
      }
      const model = resolveModelString(feature.model, DEFAULT_MODELS.claude);
      tempRunningFeature.model = model;
      tempRunningFeature.provider = ProviderFactory.getProviderNameForModel(model);

      // Publish the run as an AgentSession before the provider starts, so the
      // Agent view lists the conversation while it is still in progress.
      closeFeatureConversation = await this.beginFeatureConversationMirror({
        featureId,
        feature,
        projectPath,
        workDir,
        prompt,
        model,
        provider: tempRunningFeature.provider,
        abortController,
      });

      await this.runAgentFn(
        workDir,
        featureId,
        prompt,
        abortController,
        projectPath,
        imagePaths,
        model,
        {
          projectPath,
          planningMode: feature.planningMode,
          requirePlanApproval: feature.requirePlanApproval,
          systemPrompt: combinedSystemPrompt || undefined,
          autoLoadClaudeMd,
          useClaudeCodeSystemPrompt,
          thinkingLevel: feature.thinkingLevel,
          reasoningEffort: feature.reasoningEffort,
          providerId: feature.providerId,
          branchName: feature.branchName ?? null,
          sdkSessionId: providerSessionId,
        }
      );

      // Check for incomplete tasks after agent execution.
      // The agent may have finished early (hit max turns, decided it was done, etc.)
      // while tasks are still pending. If so, re-run the agent to complete remaining tasks.
      const MAX_TASK_RETRY_ATTEMPTS = 3;
      let taskRetryAttempts = 0;
      while (!abortController.signal.aborted && taskRetryAttempts < MAX_TASK_RETRY_ATTEMPTS) {
        const currentFeature = await this.loadFeatureFn(projectPath, featureId);
        if (!currentFeature?.planSpec?.tasks) break;

        const pendingTasks = currentFeature.planSpec.tasks.filter(
          (t) => t.status === 'pending' || t.status === 'in_progress'
        );
        if (pendingTasks.length === 0) break;

        taskRetryAttempts++;
        const totalTasks = currentFeature.planSpec.tasks.length;
        const completedTasks = currentFeature.planSpec.tasks.filter(
          (t) => t.status === 'completed'
        ).length;
        logger.info(
          `[executeFeature] Feature ${featureId} has ${pendingTasks.length} incomplete tasks (${completedTasks}/${totalTasks} completed). Re-running agent (attempt ${taskRetryAttempts}/${MAX_TASK_RETRY_ATTEMPTS})`
        );

        this.eventBus.emitAutoModeEvent('auto_mode_progress', {
          featureId,
          branchName: feature.branchName ?? null,
          content: `Agent finished with ${pendingTasks.length} tasks remaining. Re-running to complete tasks (attempt ${taskRetryAttempts}/${MAX_TASK_RETRY_ATTEMPTS})...`,
          projectPath,
        });

        // Build a continuation prompt that tells the agent to finish remaining tasks
        const remainingTasksList = pendingTasks
          .map((t) => `- ${t.id}: ${t.description} (${t.status})`)
          .join('\n');

        const continuationPrompt = `## Continue Implementation - Incomplete Tasks

The previous agent session ended before all tasks were completed. Please continue implementing the remaining tasks.

**Completed:** ${completedTasks}/${totalTasks} tasks
**Remaining tasks:**
${remainingTasksList}

Please continue from where you left off and complete all remaining tasks. Use the same [TASK_START:ID] and [TASK_COMPLETE:ID] markers for each task.`;

        await this.runAgentFn(
          workDir,
          featureId,
          continuationPrompt,
          abortController,
          projectPath,
          undefined,
          model,
          {
            projectPath,
            planningMode: 'skip',
            requirePlanApproval: false,
            systemPrompt: combinedSystemPrompt || undefined,
            autoLoadClaudeMd,
            useClaudeCodeSystemPrompt,
            thinkingLevel: feature.thinkingLevel,
            reasoningEffort: feature.reasoningEffort,
            providerId: feature.providerId,
            branchName: feature.branchName ?? null,
            sdkSessionId: providerSessionId,
          }
        );
      }

      // Log if tasks are still incomplete after retry attempts
      if (taskRetryAttempts >= MAX_TASK_RETRY_ATTEMPTS) {
        const finalFeature = await this.loadFeatureFn(projectPath, featureId);
        const stillPending = finalFeature?.planSpec?.tasks?.filter(
          (t) => t.status === 'pending' || t.status === 'in_progress'
        );
        if (stillPending && stillPending.length > 0) {
          logger.warn(
            `[executeFeature] Feature ${featureId} still has ${stillPending.length} incomplete tasks after ${MAX_TASK_RETRY_ATTEMPTS} retry attempts. Moving to final status.`
          );
        }
      }

      const pipelineConfig = await pipelineService.getPipelineConfig(projectPath);
      const excludedStepIds = new Set(feature.excludedPipelineSteps || []);
      const sortedSteps = [...(pipelineConfig?.steps || [])]
        .sort((a, b) => a.order - b.order)
        .filter((step) => !excludedStepIds.has(step.id));
      if (sortedSteps.length > 0) {
        await this.executePipelineFn({
          projectPath,
          featureId,
          feature,
          steps: sortedSteps,
          workDir,
          worktreePath,
          branchName: feature.branchName ?? null,
          abortController,
          autoLoadClaudeMd,
          useClaudeCodeSystemPrompt,
          testAttempts: 0,
          maxTestAttempts: 5,
        });
        pipelineCompleted = true;
        // Check if pipeline set a terminal status (e.g., merge_conflict) — don't overwrite it
        const refreshed = await this.loadFeatureFn(projectPath, featureId);
        if (refreshed?.status === 'merge_conflict') {
          return;
        }
      }

      // A shutdown can end the provider stream without an abort error. Keep the
      // feature interrupted so the next start resumes it instead of marking it done.
      if (isShuttingDown()) {
        await this.updateFeatureStatusFn(projectPath, featureId, 'interrupted');
        logger.info(
          `[executeFeature] Feature ${featureId} interrupted by server shutdown; resume on next start`
        );
        return;
      }

      // Read agent output before determining final status.
      // CLI-based providers (Cursor, Codex, etc.) may exit quickly without doing
      // meaningful work. Check output to avoid prematurely marking as 'verified'.
      const outputPath = path.join(getFeatureDir(projectPath, featureId), 'agent-output.md');
      let agentOutput = '';
      try {
        agentOutput = (await secureFs.readFile(outputPath, 'utf-8')) as string;
      } catch {
        /* */
      }

      // Jira-dispatched agents write a machine-readable delivery receipt in their
      // worktree. A blocked/needs-input receipt must override the generic output
      // heuristic: a long session with tool calls can still report unresolved work.
      // Receipts are written feature-scoped; older dispatches (and parent
      // decompositions) used a single worktree-level file, so fall back to it.
      const receiptCandidates = [
        path.join(workDir, '.automaker', 'jira', featureId, 'jira-result.json'),
        path.join(workDir, '.automaker', 'jira-result.json'),
      ];
      let executionReceipt: Record<string, unknown> | null = null;
      for (const receiptPath of receiptCandidates) {
        try {
          const rawReceipt = (await secureFs.readFile(receiptPath, 'utf-8')) as string;
          executionReceipt = JSON.parse(rawReceipt) as Record<string, unknown>;
          if (feature.jiraIssueId && executionReceipt.runId !== feature.executionRunId) {
            executionReceipt = null;
            continue;
          }
          break;
        } catch {
          /* Try the next candidate; no receipt is valid for ordinary features. */
        }
      }
      const receiptOutcome =
        executionReceipt && typeof executionReceipt.outcome === 'string'
          ? executionReceipt.outcome
          : null;
      const receiptBlockers =
        executionReceipt && Array.isArray(executionReceipt.blockers)
          ? (executionReceipt.blockers as unknown[]).filter(
              (blocker): blocker is string => typeof blocker === 'string' && blocker.trim() !== ''
            )
          : [];
      const receiptRequiresReview = receiptOutcome !== null && receiptOutcome !== 'mr_created';
      const receiptNeedsAttention =
        receiptOutcome !== null && !['development_complete', 'mr_created'].includes(receiptOutcome);
      const receiptHasBlockers = receiptBlockers.length > 0;
      const receiptChangedProjects = executionReceipt
        ? normalizeReceiptChangedProjects(executionReceipt)
        : [];
      const receiptMergeRequests = executionReceipt
        ? normalizeReceiptMergeRequests(executionReceipt)
        : [];

      // Determine if the agent did meaningful work by checking for tool usage
      // indicators in the output. The agent executor writes "🔧 Tool:" markers
      // each time a tool is invoked. No tool usage suggests the CLI exited
      // without performing implementation work.
      const hasToolUsage = agentOutput.includes(TOOL_USE_MARKER);
      const isOutputTooShort = agentOutput.trim().length < MIN_MEANINGFUL_OUTPUT_LENGTH;
      const agentDidWork = hasToolUsage && !isOutputTooShort;

      let finalStatus: 'verified' | 'waiting_approval' | 'backlog';
      let executionError: string | undefined;
      if (feature.skipTests) {
        finalStatus = 'waiting_approval';
      } else if (receiptRequiresReview || receiptHasBlockers) {
        // Preserve the delivered work and require a human to review the receipt.
        finalStatus = 'waiting_approval';
        if (receiptHasBlockers) {
          logger.warn(
            `[executeFeature] Feature ${featureId}: delivery receipt contains ` +
              `${receiptBlockers.length} blocker(s); setting waiting_approval instead of verified.`
          );
        } else {
          logger.warn(
            `[executeFeature] Feature ${featureId}: delivery receipt outcome ` +
              `"${receiptOutcome}" requires review; setting waiting_approval instead of verified.`
          );
        }
      } else if (
        options?.continuationPrompt &&
        !options._calledInternally &&
        !hasToolUsage &&
        agentOutput.trim().length > 0
      ) {
        // A reply can answer a question without calling tools. It is a completed
        // conversational turn requiring review, not a failed implementation.
        finalStatus = 'waiting_approval';
      } else if (!agentDidWork) {
        // Agent didn't produce meaningful output (e.g., provider stream stalled).
        // This is an execution failure, not work awaiting review: reset to backlog
        // with an explicit error so the board shows a retry affordance.
        finalStatus = 'backlog';
        executionError =
          `Agent produced insufficient output ` +
          `(${agentOutput.trim().length}/${MIN_MEANINGFUL_OUTPUT_LENGTH} chars, ` +
          `toolUsage=${hasToolUsage}). Retry this feature.`;
        logger.warn(`[executeFeature] Feature ${featureId}: ${executionError}`);
        conversationError = executionError;
      } else {
        finalStatus = 'verified';
      }

      // A visual verification result is evidence for a human, never approval.
      // Ignore artifacts left by a previous run.
      if (this.featureStateManager) {
        try {
          const evidence = await collectAcceptanceEvidence(
            projectPath,
            featureId,
            workDir,
            executionStartedAt
          );
          if (evidence) {
            await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
              acceptanceEvidence: evidence,
            });
            finalStatus = 'waiting_approval';
          }
        } catch (error) {
          finalStatus = 'waiting_approval';
          await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
            error: `Acceptance evidence could not be imported: ${(error as Error).message}`,
          });
        }
      }
      if (this.featureStateManager) {
        const reviewMessage =
          receiptBlockers.join('\n\n') ||
          (receiptRequiresReview && typeof executionReceipt?.summary === 'string'
            ? executionReceipt.summary
            : '');
        if (reviewMessage) {
          await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
            error: receiptNeedsAttention ? reviewMessage : undefined,
            executionNotice: {
              kind: receiptNeedsAttention ? 'error' : 'review',
              source: 'delivery',
              message: reviewMessage,
              occurredAt: new Date().toISOString(),
            },
          });
        }
      }
      await this.updateFeatureStatusFn(projectPath, featureId, finalStatus);
      if (
        this.featureStateManager &&
        (receiptChangedProjects.length > 0 || receiptMergeRequests.length > 0)
      ) {
        try {
          await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
            changedProjects: receiptChangedProjects,
            mergeRequests: receiptMergeRequests,
          });
        } catch (error) {
          logger.warn(`Failed to persist delivery project/MR metadata for ${featureId}:`, error);
        }
      }
      if (finalStatus === 'backlog' && executionError) {
        try {
          const currentFeature = await this.loadFeatureFn(projectPath, featureId);
          if (
            currentFeature &&
            currentFeature.error !== executionError &&
            this.featureStateManager
          ) {
            await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
              error: executionError,
              executionNotice: {
                kind: 'error',
                source: 'execution',
                message: executionError,
                occurredAt: new Date().toISOString(),
              },
            });
          }
        } catch (error) {
          logger.warn(`Failed to persist execution error for ${featureId}:`, error);
        }
      }
      if (finalStatus === 'backlog') {
        // A run that produced no usable output is a failure, not a success:
        // clearing the counter here would let auto mode re-dispatch the same
        // failing feature forever without ever reaching the pause threshold.
        const failureInfo = {
          type: 'insufficient_output',
          message: executionError ?? 'Agent produced insufficient output',
        };
        if (this.trackFailureFn(failureInfo)) {
          this.signalPauseFn(failureInfo);
        }
      } else {
        this.recordSuccessFn();
      }

      // Check final task completion state for accurate reporting
      const completedFeature = await this.loadFeatureFn(projectPath, featureId);
      const totalTasks = completedFeature?.planSpec?.tasks?.length ?? 0;
      const completedTasks =
        completedFeature?.planSpec?.tasks?.filter((t) => t.status === 'completed').length ?? 0;
      const hasIncompleteTasks = totalTasks > 0 && completedTasks < totalTasks;

      try {
        // Only save summary if feature doesn't already have one (e.g., accumulated from pipeline steps)
        // This prevents overwriting accumulated summaries with just the last step's output
        // The agent-executor already extracts and saves summaries during execution
        if (agentOutput && !completedFeature?.summary) {
          const summary = extractSummary(agentOutput);
          if (summary) await this.saveFeatureSummaryFn(projectPath, featureId, summary);
        }
        if (contextResult.memoryFiles.length > 0 && agentOutput) {
          await recordMemoryUsage(
            projectPath,
            contextResult.memoryFiles,
            agentOutput,
            true,
            secureFs as Parameters<typeof recordMemoryUsage>[4]
          );
        }
        await this.recordLearningsFn(projectPath, feature, agentOutput);
      } catch {
        /* learnings recording failed */
      }

      const elapsedSeconds = Math.round((Date.now() - tempRunningFeature.startTime) / 1000);
      let completionMessage = `Feature completed in ${elapsedSeconds}s`;
      if (finalStatus === 'verified') completionMessage += ' - auto-verified';
      if (hasIncompleteTasks)
        completionMessage += ` (${completedTasks}/${totalTasks} tasks completed)`;

      if (isAutoMode) {
        this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
          featureId,
          featureName: feature.title,
          branchName: feature.branchName ?? null,
          executionMode: 'auto',
          passes: finalStatus !== 'backlog',
          message: finalStatus === 'backlog' ? executionError : completionMessage,
          projectPath,
          model: tempRunningFeature.model,
          provider: tempRunningFeature.provider,
        });
      }
    } catch (error) {
      const errorInfo = classifyError(error);
      if (errorInfo.isAbort) {
        await this.updateFeatureStatusFn(projectPath, featureId, 'interrupted');
        if (isAutoMode) {
          this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
            featureId,
            featureName: feature?.title,
            branchName: feature?.branchName ?? null,
            executionMode: 'auto',
            passes: false,
            message: 'Feature stopped by user',
            projectPath,
          });
        }
      } else {
        logger.error(`Feature ${featureId} failed:`, error);
        conversationError = errorInfo.message;
        // Persist the current failure before changing status. Otherwise the card
        // shows a previous delivery blocker next to a Retry button for this run.
        if (this.featureStateManager) {
          try {
            await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
              error: errorInfo.message,
              executionNotice: {
                kind: 'error',
                source: 'execution',
                message: errorInfo.message,
                occurredAt: new Date().toISOString(),
              },
            });
          } catch (persistError) {
            logger.warn(
              `Failed to persist current execution error for ${featureId}:`,
              persistError
            );
          }
        }
        if (
          feature?.providerSessionId &&
          this.featureStateManager &&
          isStaleProviderSessionError(
            `${errorInfo.message} ${error instanceof Error ? error.message : ''}`
          )
        ) {
          logger.warn(
            `[executeFeature] Feature ${featureId}: recorded provider session is no longer ` +
              `resumable; clearing it so the next run starts a fresh conversation.`
          );
          try {
            await this.featureStateManager.updateFeatureFields(projectPath, featureId, {
              providerSessionId: undefined,
            });
          } catch (clearError) {
            logger.warn(`Failed to clear stale provider session id for ${featureId}:`, clearError);
          }
        }
        // If pipeline steps completed successfully, don't send the feature back to backlog.
        // The pipeline work is done — set to waiting_approval so the user can review.
        const fallbackStatus = pipelineCompleted ? 'waiting_approval' : 'backlog';
        if (pipelineCompleted) {
          logger.info(
            `[executeFeature] Feature ${featureId} failed after pipeline completed. ` +
              `Setting status to waiting_approval instead of backlog to preserve pipeline work.`
          );
        }
        // Don't overwrite terminal states like 'merge_conflict' that were set during pipeline execution
        let currentStatus: string | undefined;
        try {
          const currentFeature = await this.loadFeatureFn(projectPath, featureId);
          currentStatus = currentFeature?.status;
        } catch (loadErr) {
          // If loading fails, log it and proceed with the status update anyway
          logger.warn(
            `[executeFeature] Failed to reload feature ${featureId} for status check:`,
            loadErr
          );
        }
        if (currentStatus !== 'merge_conflict') {
          await this.updateFeatureStatusFn(projectPath, featureId, fallbackStatus);
        }
        this.eventBus.emitAutoModeEvent('auto_mode_error', {
          featureId,
          featureName: feature?.title,
          branchName: feature?.branchName ?? null,
          error: errorInfo.message,
          errorType: errorInfo.type,
          projectPath,
        });
        if (this.trackFailureFn({ type: errorInfo.type, message: errorInfo.message })) {
          this.signalPauseFn({ type: errorInfo.type, message: errorInfo.message });
        }
      }
    } finally {
      if (closeFeatureConversation) {
        try {
          await closeFeatureConversation(conversationError);
        } catch (mirrorError) {
          logger.warn(
            `[executeFeature] Failed to close the AgentSession for ${featureId}:`,
            mirrorError
          );
        }
      }
      this.releaseRunningFeature(featureId);
      // During shutdown the recovery snapshot is written by the graceful
      // shutdown path. Saving here after release would erase the running ids.
      if (projectPath && !isShuttingDown()) await this.saveExecutionStateFn(projectPath);
    }
  }

  /**
   * Publish a running feature as an AgentSession and keep its transcript in
   * sync with `agent-output.md` until the run ends.
   *
   * Feature runs do not go through AgentService, so without this the Agent view
   * only ever listed hand-created chat sessions. The returned closer flushes the
   * final transcript and marks the session as finished.
   *
   * @returns Closer for the mirrored session, or null when nothing was registered
   */
  private async beginFeatureConversationMirror(params: {
    featureId: string;
    feature: Feature;
    projectPath: string;
    workDir: string;
    prompt: string;
    model: string;
    provider?: string;
    abortController: AbortController;
  }): Promise<((error?: string) => Promise<void>) | null> {
    const sink = this.featureConversations;
    if (!sink) return null;

    const { featureId, projectPath, workDir } = params;
    try {
      await sink.startFeatureConversation({
        featureId,
        name: params.feature.title || featureId,
        projectPath,
        workingDirectory: workDir,
        prompt: params.prompt,
        model: params.model,
        provider: params.provider,
        providerSessionId: (params.feature as { providerSessionId?: string }).providerSessionId,
        abortController: params.abortController,
      });
    } catch (error) {
      logger.warn(
        `[executeFeature] Could not publish feature ${featureId} as an AgentSession:`,
        error
      );
      return null;
    }

    const outputPath = path.join(getFeatureDir(projectPath, featureId), 'agent-output.md');
    let stopped = false;

    const sync = async (): Promise<void> => {
      try {
        const output = (await secureFs.readFile(outputPath, 'utf-8')) as string;
        if (typeof output === 'string' && output.trim()) {
          await sink.updateFeatureConversation(featureId, output);
        }
      } catch {
        // The executor creates agent-output.md on its first flush; nothing to sync yet.
      }
    };

    const timer = setInterval(() => {
      if (!stopped) void sync();
    }, FEATURE_CONVERSATION_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();

    return async (error?: string): Promise<void> => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await sync();
      await sink.finishFeatureConversation(featureId, error ? { error } : undefined);
    };
  }

  async stopFeature(featureId: string): Promise<boolean> {
    // Note: the mirrored AgentSession shares this run's AbortController, so
    // stopping from the Agent view aborts the feature the same way.
    const running = this.concurrencyManager.getRunningFeature(featureId);
    if (!running) return false;
    const { projectPath } = running;

    // Immediately update feature status to 'interrupted' so the UI reflects
    // the stop right away. CLI-based providers can take seconds to terminate
    // their subprocess after the abort signal fires, leaving the feature stuck
    // in 'in_progress' on the Kanban board until the executeFeature catch block
    // eventually runs. By persisting and emitting the status change here, the
    // board updates immediately regardless of how long the subprocess takes to stop.
    try {
      await this.updateFeatureStatusFn(projectPath, featureId, 'interrupted');
    } catch (err) {
      // Non-fatal: the abort still proceeds and executeFeature's catch block
      // will attempt the same update once the subprocess terminates.
      logger.warn(`stopFeature: failed to immediately update status for ${featureId}:`, err);
    }

    running.abortController.abort();
    this.releaseRunningFeature(featureId, { force: true });
    return true;
  }
}
