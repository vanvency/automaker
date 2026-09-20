import { describe, it, expect, vi } from 'vitest';
import {
  HerdrScheduler,
  buildLeaderPlanningPrompt,
  buildWorkerPrompt,
} from '../../../src/services/herdr-scheduler.js';
import type { HerdrTaskService } from '../../../src/services/herdr-task-service.js';
import type { Feature, ParsedTask } from '@automaker/types';

const FEATURE: Feature = {
  id: 'feat-1',
  title: 'Add herdr scheduler',
  description: 'Wire leader/worker orchestration',
  category: 'feature',
};

const PLAN = [
  'Here is the plan.',
  '```tasks',
  '## Phase 1',
  '- [ ] T001: Create the scheduler | File: src/scheduler.ts',
  '- [ ] T002: Add the tests | File: tests/scheduler.test.ts',
  '```',
].join('\n');

function createTaskService(overrides: Partial<HerdrTaskService> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  void record;

  const service = {
    ensureWorktreeWorkspace: vi.fn(async () => ({
      workspace: { workspace_id: 'w7', label: 'wt', agent_status: 'idle' },
      created: true,
    })),
    ensureTaskTab: vi.fn(async (opts: { taskName: string }) => ({
      tab: { tab_id: 'w7:t1', workspace_id: 'w7', label: opts.taskName },
      created: true,
      rootPaneId: 'w7:p1',
    })),
    startLeader: vi.fn(async ({ rootPaneId }: { rootPaneId: string }) => ({
      name: 'leader',
      agent: 'pi',
      agent_status: 'idle',
      pane_id: rootPaneId,
      interactive_ready: true,
    })),
    waitForLeader: vi.fn(async (paneId: string) => ({
      name: 'leader',
      agent: 'pi',
      agent_status: 'idle',
      pane_id: paneId,
      interactive_ready: true,
    })),
    startWorkers: vi.fn(async ({ subtaskCount }: { subtaskCount: number }) =>
      Array.from({ length: subtaskCount }, (_, index) => ({
        name: `worker-${index + 1}`,
        role: 'worker' as const,
        paneId: `w7:p${index + 2}`,
        model: 'worker',
        subtaskIndex: index,
        lastStatus: 'idle' as const,
      }))
    ),
    ensureConversationAgent: vi.fn(async (opts: { rootPaneId: string }) => ({
      agent: {
        name: 'w7-t1-worker-1',
        agent: 'pi',
        agent_status: 'idle',
        pane_id: opts.rootPaneId,
        interactive_ready: true,
      },
      started: true,
      resumedSessionId: null,
      sessionId: null,
    })),
    promptAndWait: vi.fn(async () => ({ agent: { agent_status: 'idle' }, timedOut: false })),
    readAgent: vi.fn(async () => PLAN),
    readAgentText: vi.fn(async () => PLAN),
    listTaskAgents: vi.fn(async () => []),
    ...overrides,
  } as unknown as HerdrTaskService;

  return { service, calls };
}

describe('herdr-scheduler', () => {
  it('builds a planning prompt that asks for a parsable tasks block', () => {
    const prompt = buildLeaderPlanningPrompt(FEATURE);
    expect(prompt).toContain('Add herdr scheduler');
    expect(prompt).toContain('```tasks');
    expect(prompt).toContain('Do not write code');
  });

  it('builds a worker prompt scoped to a single subtask', () => {
    const task: ParsedTask = { id: 'T002', description: 'write tests', status: 'pending' };
    const prompt = buildWorkerPrompt(task, 1, 3);
    expect(prompt).toContain('worker 2 of 3');
    expect(prompt).toContain('T002: write tests');
  });

  it('creates the space with the task name and runs the leader', async () => {
    const { service } = createTaskService();
    const scheduler = new HerdrScheduler(service);
    const result = await scheduler.dispatch({
      projectPath: '/proj',
      feature: FEATURE,
      workDir: '/proj/wt',
      planOnly: true,
    });

    expect(service.ensureWorktreeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workDir: '/proj/wt' })
    );
    expect(service.ensureTaskTab).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: 'Add herdr scheduler', workspaceId: 'w7' })
    );
    expect(service.startLeader).toHaveBeenCalledWith({
      rootPaneId: 'w7:p1',
      tabId: 'w7:t1',
    });
    expect(result.workspaceId).toBe('w7');
    expect(result.tabId).toBe('w7:t1');
    expect(result.status).toBe('planned');
  });

  it('parses the leader plan into subtasks', async () => {
    const { service } = createTaskService();
    const scheduler = new HerdrScheduler(service);
    const result = await scheduler.dispatch({
      projectPath: '/proj',
      feature: FEATURE,
      workDir: '/proj/wt',
      planOnly: true,
    });
    expect(result.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
  });

  it('asks a human to confirm an Automaker-side split instead of starting workers', async () => {
    const { service } = createTaskService();
    const persistProposal = vi.fn().mockResolvedValue(undefined);
    const scheduler = new HerdrScheduler(service, null, { persistProposal });
    const result = await scheduler.dispatch({
      projectPath: '/proj',
      feature: FEATURE,
      workDir: '/proj/wt',
    });

    expect(service.startWorkers).not.toHaveBeenCalled();
    expect(persistProposal).toHaveBeenCalledWith('/proj', 'feat-1', PLAN, expect.anything());
    expect(result.status).toBe('awaiting_approval');
    expect(result.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
    expect(result.workers).toHaveLength(0);
  });

  it('runs the Jira sub-tasks in order, one worker prompt each', async () => {
    const seen: Array<{ pane: string; text: string }> = [];
    const { service } = createTaskService({
      promptAndWait: vi.fn(async (pane: string, text: string) => {
        seen.push({ pane, text });
        return { agent: { agent_status: 'idle' }, timedOut: false };
      }) as never,
    });
    const persistTaskStatus = vi.fn().mockResolvedValue(undefined);
    const scheduler = new HerdrScheduler(service, null, { persistTaskStatus });
    const feature = {
      ...FEATURE,
      jiraKey: 'AIP-100',
      jiraSubtasks: [
        { key: 'AIP-101', summary: 'Build the parser', type: 'Backend-Task' },
        { key: 'AIP-102', summary: 'Wire the parser' },
      ],
    };

    const result = await scheduler.dispatch({
      projectPath: '/proj',
      feature,
      workDir: '/proj/wt',
    });

    // No leader planning: the Jira sub-tasks are the units of work.
    expect(service.startLeader).not.toHaveBeenCalled();
    expect(seen).toHaveLength(2);
    expect(seen[0].text).toContain('AIP-101');
    expect(seen[1].text).toContain('AIP-102');
    expect(seen[0].pane).toBe(seen[1].pane);
    expect(persistTaskStatus).toHaveBeenCalledWith('/proj', 'feat-1', 'AIP-101', 'completed');
    expect(persistTaskStatus).toHaveBeenCalledWith('/proj', 'feat-1', 'AIP-102', 'completed');
    expect(result.status).toBe('executed');
    expect(result.tasks.map((task) => task.id)).toEqual(['AIP-101', 'AIP-102']);
  });

  it('refuses to split a parent issue a human has to split in Jira', async () => {
    const { service } = createTaskService();
    const scheduler = new HerdrScheduler(service);
    const feature = {
      ...FEATURE,
      jiraKey: 'AIP-200',
      description: 'Manual decomposition only (this Story issue has no Jira subtasks)',
    };

    await expect(
      scheduler.dispatch({ projectPath: '/proj', feature, workDir: '/proj/wt' })
    ).rejects.toMatchObject({ code: 'needs_input' });
    expect(service.ensureWorktreeWorkspace).not.toHaveBeenCalled();
  });

  it('refuses to implement a container card whose sub-tasks have their own cards', async () => {
    const { service } = createTaskService();
    const scheduler = new HerdrScheduler(service);
    const feature = {
      ...FEATURE,
      jiraKey: 'AIP-300',
      description: 'Scope: Jira subtasks are separate cards (do NOT implement them here)',
      jiraSubtasks: [{ key: 'AIP-301', summary: 'Child one' }],
    };

    await expect(
      scheduler.dispatch({ projectPath: '/proj', feature, workDir: '/proj/wt' })
    ).rejects.toMatchObject({ code: 'separate_cards' });
  });

  it('emits a planning and an awaiting-approval plan event for an Automaker split', async () => {
    const { service } = createTaskService();
    const emit = vi.fn();
    const scheduler = new HerdrScheduler(service, { emit } as never);
    await scheduler.dispatch({ projectPath: '/proj', feature: FEATURE, workDir: '/proj/wt' });

    const events = emit.mock.calls.map(
      (call) => call[1] as { type: string; awaitingApproval?: boolean }
    );
    expect(events.map((event) => event.type)).toEqual([
      'herdr_planning_started',
      'herdr_plan_ready',
    ]);
    expect(events[1].awaitingApproval).toBe(true);
  });

  it('emits one subtask event pair per Jira sub-task', async () => {
    const { service } = createTaskService();
    const emit = vi.fn();
    const scheduler = new HerdrScheduler(service, { emit } as never);
    await scheduler.dispatch({
      projectPath: '/proj',
      feature: {
        ...FEATURE,
        jiraKey: 'AIP-100',
        jiraSubtasks: [{ key: 'AIP-101', summary: 'one' }],
      },
      workDir: '/proj/wt',
    });

    const events = emit.mock.calls.map((call) => call[1] as { type: string; taskId?: string });
    expect(events.map((event) => event.type)).toEqual([
      'herdr_plan_ready',
      'herdr_subtask_started',
      'herdr_subtask_complete',
    ]);
    expect(events[1].taskId).toBe('AIP-101');
  });

  it('persists the placement and the proposal for an Automaker split', async () => {
    const { service } = createTaskService();
    const persistTarget = vi.fn().mockResolvedValue(undefined);
    const persistProposal = vi.fn().mockResolvedValue(undefined);
    const scheduler = new HerdrScheduler(service, null, { persistTarget, persistProposal });
    await scheduler.dispatch({ projectPath: '/proj', feature: FEATURE, workDir: '/proj/wt' });

    expect(persistTarget).toHaveBeenCalledWith({
      projectPath: '/proj',
      featureId: 'feat-1',
      workspaceId: 'w7',
      tabId: 'w7:t1',
    });
    expect(persistProposal).toHaveBeenCalledWith('/proj', 'feat-1', PLAN, expect.anything());
  });

  it('reuses an existing leader pane instead of failing on a busy pane', async () => {
    const { service } = createTaskService({
      listTaskAgents: vi.fn(async () => [
        { agent: 'pi', name: 'leader', pane_id: 'w7:p9', agent_status: 'idle' },
      ]) as never,
    });
    const scheduler = new HerdrScheduler(service);
    await scheduler.dispatch({
      projectPath: '/proj',
      feature: FEATURE,
      workDir: '/proj/wt',
      planOnly: true,
    });
    expect(service.waitForLeader).toHaveBeenCalledWith('w7:p9');
  });

  it('returns aborted without workers when the signal is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = createTaskService();
    const scheduler = new HerdrScheduler(service);
    const result = await scheduler.dispatch({
      projectPath: '/proj',
      feature: FEATURE,
      workDir: '/proj/wt',
      abortSignal: controller.signal,
    });
    expect(result.status).toBe('aborted');
    expect(result.workers).toHaveLength(0);
    expect(service.startWorkers).not.toHaveBeenCalled();
  });

  it('does not start workers when the plan has no parsable tasks', async () => {
    const { service } = createTaskService({
      readAgentText: vi.fn(async () => 'no tasks here') as never,
    });
    const scheduler = new HerdrScheduler(service);
    const result = await scheduler.dispatch({
      projectPath: '/proj',
      feature: FEATURE,
      workDir: '/proj/wt',
    });
    expect(result.status).toBe('planned');
    expect(result.tasks).toEqual([]);
    expect(service.startWorkers).not.toHaveBeenCalled();
  });
});
