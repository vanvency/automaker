/**
 * HerdrScheduler - the Automaker-side dispatcher for herdr task topology.
 *
 * Automaker stays the scheduler; herdr only runs the panes. The flow for one
 * feature/task is:
 *
 * 1. `ensureWorkspace` - one herdr space, named exactly like the task.
 * 2. `startLeader`     - the space's root pane runs `pi --model leader`.
 * 3. leader plans      - Automaker prompts it and reads the plan back.
 * 4. subtasks parsed   - Automaker parses the plan (same parser the classic
 *                        executor uses), capped at MAX_WORKERS_PER_TASK.
 * 5. `startWorkers`    - one pane + `pi --model worker` per subtask.
 * 6. workers execute   - Automaker prompts each worker with its own subtask and
 *                        waits for it to settle; progress streams to the board.
 *
 * Everything is observable from Automaker because every state change is
 * published on the event bus, and from herdr because the panes are real.
 */

import { createLogger } from '@automaker/utils';
import type { Feature, JiraSubtask, ParsedTask } from '@automaker/types';
import type { TypedEventBus } from './typed-event-bus.js';
import { parseTasksFromSpec } from './spec-parser.js';
import { HERDR_WORKER_MODEL } from './herdr-task-service.js';
import {
  TaskScopeError,
  buildJiraSubtaskPrompt,
  buildTasksFromJiraSubtasks,
  resolveTaskScope,
} from './task-scope.js';
import {
  isLeaderAgentName,
  type HerdrTaskAgent,
  type HerdrTaskService,
} from './herdr-task-service.js';
import type { HerdrAgentStatus } from './herdr-client.js';

const logger = createLogger('HerdrScheduler');

/** Per-turn timeout for an agent (planning or executing a subtask) */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

export interface HerdrDispatchOptions {
  projectPath: string;
  feature: Feature;
  workDir: string;
  /** Abort signal: checked between steps, and used to stop waiting early */
  abortSignal?: AbortSignal;
  /** Extra environment for the panes (defaults to none) */
  env?: Record<string, string>;
  /** Override the planning prompt */
  planningPrompt?: string;
  /** Skip worker creation and only plan (useful for plan-only features) */
  planOnly?: boolean;
}

export interface HerdrDispatchResult {
  workspaceId: string;
  tabId: string;
  leaderPaneId: string;
  plan: string;
  tasks: ParsedTask[];
  workers: HerdrTaskAgent[];
  /** `awaiting_approval`: Automaker proposed a split, a human has to confirm it */
  status: 'planned' | 'executed' | 'aborted' | 'awaiting_approval';
}

/** Prompt handed to the leader pane to produce a machine-parsable plan */
export function buildLeaderPlanningPrompt(feature: Feature): string {
  const title = feature.title || feature.id;
  return [
    'You are the leader for the following task. Plan it, do not implement it.',
    '',
    'Task: ' + title,
    feature.description ? 'Description: ' + feature.description : '',
    '',
    'Break the work into concrete subtasks and reply with a ```tasks block using',
    'the marker format so the orchestrator can parse it. Example:',
    '',
    '```tasks',
    '## Phase 1: Foundation',
    '- [ ] T001: Do the first thing | File: path/to/file',
    '- [ ] T002: Do the second thing | File: path/to/other',
    '```',
    '',
    'Keep every subtask independently implementable. Do not write code in your reply.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Prompt handed to a worker pane for one subtask */
export function buildWorkerPrompt(task: ParsedTask, index: number, total: number): string {
  return [
    'You are worker ' + (index + 1) + ' of ' + total + ' for this task.',
    'Implement exactly this subtask and nothing else:',
    '',
    '  ' + task.id + ': ' + task.description,
    task.filePath ? '  Suggested file: ' + task.filePath : '',
    task.phase ? '  Phase: ' + task.phase : '',
    '',
    'When you are done, reply with a one-paragraph summary of what changed.',
  ]
    .filter(Boolean)
    .join('\n');
}

export class HerdrScheduler {
  constructor(
    private taskService: HerdrTaskService,
    private eventBus: TypedEventBus | null = null,
    private options: {
      /** Persist the herdr placement on the feature so the board can query status */
      persistTarget?: (target: {
        projectPath: string;
        featureId: string;
        workspaceId: string;
        tabId: string;
      }) => Promise<void>;
      /** Persist the leader's plan and parsed tasks on the feature */
      persistTasks?: (
        projectPath: string,
        featureId: string,
        plan: string,
        tasks: ParsedTask[]
      ) => Promise<void>;
      /** Persist task status changes as workers finish */
      persistTaskStatus?: (
        projectPath: string,
        featureId: string,
        taskId: string,
        status: ParsedTask['status']
      ) => Promise<void>;
      /** Persist an Automaker-side split proposal (Jira did not split this card) */
      persistProposal?: (
        projectPath: string,
        featureId: string,
        plan: string,
        tasks: ParsedTask[]
      ) => Promise<void>;
    } = {}
  ) {}

  /**
   * Dispatch a feature to herdr.
   *
   * Returns after the plan is produced (and, unless `planOnly`, after the
   * workers finish). The board follows progress through the `herdr_*` events
   * emitted here.
   */
  async dispatch(options: HerdrDispatchOptions): Promise<HerdrDispatchResult> {
    const { projectPath, feature, workDir, abortSignal, env, planOnly } = options;
    const featureId = feature.id;
    const taskName = feature.title || feature.id;

    // Same split rules the Jira monitor wrote into the card: Jira owns the split.
    const scope = resolveTaskScope(feature);
    if (scope.kind === 'needs-input') {
      throw new TaskScopeError('needs_input', scope.reason);
    }
    if (scope.kind === 'separate-cards') {
      throw new TaskScopeError(
        'separate_cards',
        `${feature.jiraKey ?? featureId} is a container: its Jira sub-tasks have their own ` +
          `cards (${scope.pending.join(', ')}). Dispatch those cards instead of this one.`
      );
    }

    // The worktree owns the space, the task owns a tab inside it.
    const workspace = await this.taskService.ensureWorktreeWorkspace({ workDir, env });
    const workspaceId = workspace.workspace.workspace_id;
    const taskTab = await this.taskService.ensureTaskTab({
      workspaceId,
      taskName,
      taskId: featureId,
      workDir,
      tabId: feature.herdrTabId ?? null,
      // A space we just created has an empty root tab the first task can claim.
      adoptRootTab: workspace.created,
      env,
    });
    const tabId = taskTab.tab.tab_id;
    await this.options.persistTarget?.({
      projectPath,
      featureId,
      workspaceId,
      tabId,
    });
    logger.info(
      'Feature ' +
        featureId +
        ' -> herdr workspace ' +
        workspaceId +
        ' tab ' +
        tabId +
        " ('" +
        taskName +
        "')"
    );

    if (abortSignal?.aborted) {
      return {
        workspaceId,
        tabId,
        leaderPaneId: taskTab.rootPaneId,
        plan: '',
        tasks: [],
        workers: [],
        status: 'aborted',
      };
    }

    // Jira already split this issue: those sub-tasks are the units of work, so the
    // leader must not invent a second split. They run in order, in this worktree,
    // because they all land on the same branch.
    if (scope.kind === 'jira-subtasks') {
      const tasks = buildTasksFromJiraSubtasks(scope.subtasks);
      const plan = tasks.map((task) => `- [ ] ${task.id}: ${task.description}`).join('\n');
      await this.options.persistTasks?.(projectPath, featureId, plan, tasks);
      this.emit('herdr_plan_ready', {
        featureId,
        projectPath,
        workspaceId,
        paneId: taskTab.rootPaneId,
        tasks: tasks.map((task) => ({ id: task.id, description: task.description })),
        source: 'jira',
        timedOut: false,
      });

      if (planOnly) {
        return {
          workspaceId,
          tabId,
          leaderPaneId: taskTab.rootPaneId,
          plan,
          tasks,
          workers: [],
          status: 'planned',
        };
      }

      const { aborted, worker } = await this.runJiraSubtasks({
        feature,
        projectPath,
        workspaceId,
        tabId,
        rootPaneId: taskTab.rootPaneId,
        workDir,
        subtasks: scope.subtasks,
        abortSignal,
        env,
      });
      return {
        workspaceId,
        tabId,
        leaderPaneId: worker?.paneId ?? taskTab.rootPaneId,
        plan,
        tasks,
        workers: worker ? [worker] : [],
        status: aborted ? 'aborted' : 'executed',
      };
    }

    // A leader left over from a previous run already owns its pane; starting a
    // second one would fail with agent_name_taken. Reuse it instead.
    const existingLeaderPaneId = await this.resolveLeaderPane(tabId, workspaceId);
    const leader =
      existingLeaderPaneId === null
        ? await this.taskService.startLeader({ rootPaneId: taskTab.rootPaneId, tabId })
        : await this.taskService.waitForLeader(existingLeaderPaneId);
    logger.info('Leader ready for ' + featureId + ' in pane ' + leader.pane_id);

    this.emit('herdr_planning_started', {
      featureId,
      projectPath,
      workspaceId,
      paneId: leader.pane_id,
    });

    const planningPrompt = options.planningPrompt ?? buildLeaderPlanningPrompt(feature);
    const planOutcome = await this.taskService.promptAndWait(leader.pane_id, planningPrompt, {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    });
    // Read the structured transcript, not the pane: pi runs on the alternate
    // screen and a pane read silently truncates a long plan, which would make
    // task parsing miss subtasks (or find none at all).
    const plan = await this.taskService.readAgentText(leader.pane_id);
    const tasks = parseTasksFromSpec(plan);

    // `planOnly` keeps the older "just show me the plan" behaviour; a plan with no
    // parsable task is not worth asking a human to approve either.
    if (planOnly || tasks.length === 0) {
      await this.options.persistTasks?.(projectPath, featureId, plan, tasks);
      this.emit('herdr_plan_ready', {
        featureId,
        projectPath,
        workspaceId,
        paneId: leader.pane_id,
        tasks: tasks.map((task) => ({ id: task.id, description: task.description })),
        source: 'automaker',
        awaitingApproval: false,
        timedOut: planOutcome.timedOut,
      });
      return {
        workspaceId,
        tabId,
        leaderPaneId: leader.pane_id,
        plan,
        tasks,
        workers: [],
        status: 'planned',
      };
    }

    // Automaker-side split: Jira did not split this card, and only a human may
    // turn a proposal into Jira work. Persist it as a proposal and stop - the
    // workers start after the approval created the Jira sub-tasks.
    await this.options.persistProposal?.(projectPath, featureId, plan, tasks);

    this.emit('herdr_plan_ready', {
      featureId,
      projectPath,
      workspaceId,
      paneId: leader.pane_id,
      tasks: tasks.map((task) => ({ id: task.id, description: task.description })),
      source: 'automaker',
      awaitingApproval: true,
      timedOut: planOutcome.timedOut,
    });

    logger.info(
      'Feature ' +
        featureId +
        ' proposed a split of ' +
        tasks.length +
        ' task(s); waiting for approval before creating Jira sub-tasks'
    );
    return {
      workspaceId,
      tabId,
      leaderPaneId: leader.pane_id,
      plan,
      tasks,
      workers: [],
      status: 'awaiting_approval',
    };
  }

  /**
   * Run the sub-tasks of a card Jira already split.
   *
   * They all land on the same worktree and branch, so they run one after another
   * in the task's tab instead of in parallel panes: parallel writers would fight
   * over the same files. Progress is reported per Jira sub-task key.
   */
  private async runJiraSubtasks(params: {
    feature: Feature;
    projectPath: string;
    workspaceId: string;
    tabId: string;
    rootPaneId: string;
    workDir: string;
    subtasks: JiraSubtask[];
    abortSignal?: AbortSignal;
    env?: Record<string, string>;
  }): Promise<{ aborted: boolean; worker: HerdrTaskAgent | null }> {
    const { feature, projectPath, workspaceId, tabId, rootPaneId, workDir, subtasks } = params;
    const featureId = feature.id;
    const issueKey = feature.jiraKey ?? featureId;

    const agent = await this.taskService.ensureConversationAgent({
      workspaceId,
      tabId,
      rootPaneId,
      workDir,
      taskKeys: [featureId, feature.jiraKey].filter((key): key is string => !!key),
      providerSessionId: feature.providerSessionId,
      projectPath: params.projectPath,
      force: true,
      env: params.env,
    });
    if (!agent.agent) {
      throw new Error('Could not start a pi agent for ' + featureId + ' in tab ' + tabId);
    }

    const worker: HerdrTaskAgent = {
      name: agent.agent.name ?? tabId + '-worker-1',
      role: 'worker',
      paneId: agent.agent.pane_id,
      model: HERDR_WORKER_MODEL,
      lastStatus: agent.agent.agent_status,
    };

    for (const [index, subtask] of subtasks.entries()) {
      if (params.abortSignal?.aborted) return { aborted: true, worker };

      this.emit('herdr_subtask_started', {
        featureId,
        projectPath,
        workspaceId,
        taskId: subtask.key,
        description: subtask.summary ?? subtask.key,
        paneId: worker.paneId,
        worker: worker.name,
      });

      const outcome = await this.taskService.promptAndWait(
        worker.paneId,
        buildJiraSubtaskPrompt(subtask, index, subtasks.length, issueKey, featureId),
        { timeoutMs: DEFAULT_TURN_TIMEOUT_MS }
      );

      this.emit('herdr_subtask_complete', {
        featureId,
        projectPath,
        workspaceId,
        taskId: subtask.key,
        paneId: worker.paneId,
        worker: worker.name,
        status: outcome.agent.agent_status,
        timedOut: outcome.timedOut,
      });
      await this.options.persistTaskStatus?.(
        projectPath,
        featureId,
        subtask.key,
        outcome.timedOut ? 'in_progress' : 'completed'
      );
    }

    return { aborted: params.abortSignal?.aborted === true, worker };
  }

  /**
   * Pick the pane the leader should run in.
   *
   * Re-running a feature reuses its workspace, whose root pane may already host
   * a leader agent from the previous run. `agent.start` refuses a busy pane
   * (`agent_pane_busy`), so an existing leader pane is reused as-is.
   */
  private async resolveLeaderPane(tabId: string, workspaceId: string): Promise<string | null> {
    const agents = await this.taskService.listTaskAgents(workspaceId, tabId);
    const existing = agents.find(
      (agent) => agent.agent === 'pi' && isLeaderAgentName(agent.name, tabId)
    );
    return existing?.pane_id ?? null;
  }

  /** Live status of every agent in a feature's tab */
  async getTaskStatus(
    workspaceId: string,
    tabId?: string
  ): Promise<
    Array<{ paneId: string; name: string | null; status: HerdrAgentStatus; agent: string | null }>
  > {
    const agents = await this.taskService.listTaskAgents(workspaceId, tabId);
    return agents.map((agent) => ({
      paneId: agent.pane_id,
      name: agent.name ?? null,
      status: agent.agent_status,
      agent: agent.agent,
    }));
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.eventBus?.emit('auto-mode:event', { type, ...data });
  }
}
