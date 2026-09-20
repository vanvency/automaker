import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const findWorktreeForBranch = vi.fn();
vi.mock('../../../../src/services/worktree-resolver.js', () => ({
  WorktreeResolver: class {
    findWorktreeForBranch = findWorktreeForBranch;
  },
}));
const validateWorkingDirectory = vi.fn();
vi.mock('../../../../src/lib/sdk-options.js', () => ({ validateWorkingDirectory }));
const getHerdrTaskService = vi.fn();
const listTaskAgents = vi.fn();
const HerdrScheduler = vi.fn();
const dispatch = vi.fn();
const updateFeatureFields = vi.fn().mockResolvedValue(undefined);
const updateFeaturePlanSpec = vi.fn().mockResolvedValue(undefined);
const updateTaskStatus = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../src/services/herdr-task-service.js', async (importOriginal) => ({
  // Keep the real name helpers (the route resolves the leader by agent name)
  ...(await importOriginal<typeof import('../../../../src/services/herdr-task-service.js')>()),
  getHerdrTaskService: () => getHerdrTaskService(),
}));
vi.mock('../../../../src/services/herdr-scheduler.js', () => ({
  HerdrScheduler: class {
    constructor(...args: unknown[]) {
      HerdrScheduler(...args);
    }
    dispatch = dispatch;
  },
}));
vi.mock('../../../../src/services/feature-state-manager.js', () => ({
  FeatureStateManager: class {
    updateFeatureFields = updateFeatureFields;
    updateFeaturePlanSpec = updateFeaturePlanSpec;
    updateTaskStatus = updateTaskStatus;
    destroy = vi.fn();
  },
}));

const { createHerdrTaskStatusHandler, createHerdrDispatchHandler } =
  await import('../../../../src/routes/features/routes/herdr-task.js');

function fakeResponse() {
  const recorded: {
    body: Record<string, unknown> | null;
    statusCalls: number[];
    res: Response;
  } = { body: null, statusCalls: [], res: null as unknown as Response };
  recorded.res = {
    status(code: number) {
      recorded.statusCalls.push(code);
      return this;
    },
    json(body: unknown) {
      recorded.body = body as Record<string, unknown>;
      return this;
    },
  } as unknown as Response;
  return recorded;
}

describe('herdr-task routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHerdrTaskService.mockReturnValue({ listTaskAgents });
    listTaskAgents.mockResolvedValue([]);
    dispatch.mockResolvedValue({
      status: 'executed',
      workspaceId: 'w1',
      tasks: [],
    });
  });

  it('returns null status when the feature has no herdr workspace', async () => {
    const featureLoader = {
      get: vi.fn().mockResolvedValue({ id: 'f1', title: 'A task' }),
    } as never;
    const res = fakeResponse();
    await createHerdrTaskStatusHandler(featureLoader)(
      { query: { projectPath: '/p', featureId: 'f1' } } as unknown as Request,
      res.res
    );
    expect(res.body).toEqual({ success: true, status: null });
    expect(listTaskAgents).not.toHaveBeenCalled();
  });

  it('returns leader and worker status from the stored workspace id', async () => {
    const featureLoader = {
      get: vi.fn().mockResolvedValue({
        id: 'f2',
        title: 'B task',
        herdrWorkspaceId: 'w9',
      }),
    } as never;
    listTaskAgents.mockResolvedValue([
      { pane_id: 'w9:p1', name: 'leader', agent: 'pi', agent_status: 'working' },
      { pane_id: 'w9:p2', name: 'worker-1', agent: 'pi', agent_status: 'idle' },
    ]);
    const res = fakeResponse();
    await createHerdrTaskStatusHandler(featureLoader)(
      { query: { projectPath: '/p', featureId: 'f2' } } as unknown as Request,
      res.res
    );
    expect(res.body).toMatchObject({
      success: true,
      status: {
        workspaceId: 'w9',
        leaderPaneId: 'w9:p1',
        agents: [
          { paneId: 'w9:p1', name: 'leader', status: 'working' },
          { paneId: 'w9:p2', name: 'worker-1', status: 'idle' },
        ],
      },
    });
  });

  it('rejects a requested directory outside the allowed workspace before dispatch', async () => {
    validateWorkingDirectory
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('Outside allowed root');
      });
    const loader = { get: vi.fn().mockResolvedValue({ id: 'f3' }) } as never;
    const res = fakeResponse();
    await createHerdrDispatchHandler(loader)(
      { body: { projectPath: '/p', featureId: 'f3', workDir: '/outside' } } as Request,
      res.res
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ success: false, error: 'Outside allowed root' });
  });

  it('defaults decomposition dispatch to the assigned worktree, not the project root', async () => {
    findWorktreeForBranch.mockResolvedValue('/p/.worktrees/task');
    const loader = {
      get: vi.fn().mockResolvedValue({ id: 'f3', branchName: 'task/branch' }),
    } as never;
    const res = fakeResponse();
    await createHerdrDispatchHandler(loader)(
      { body: { projectPath: '/p', featureId: 'f3' } } as Request,
      res.res
    );
    expect(validateWorkingDirectory).toHaveBeenCalledWith('/p/.worktrees/task');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ workDir: '/p/.worktrees/task' })
    );
  });

  it('dispatches the feature and returns the outcome', async () => {
    const featureLoader = {
      get: vi.fn().mockResolvedValue({ id: 'f3', title: 'C task' }),
    } as never;
    const res = fakeResponse();
    await createHerdrDispatchHandler(featureLoader)(
      { body: { projectPath: '/p', featureId: 'f3' } } as unknown as Request,
      res.res
    );
    expect(dispatch).toHaveBeenCalled();
    expect(res.body).toMatchObject({ success: true, status: 'executed', workspaceId: 'w1' });
  });
});
