import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const isHerdrAvailableMock = vi.fn<() => boolean>(() => true);
const attachWorktreeSessionMock = vi.fn(async (options: Record<string, unknown>) => ({
  sessionName: (options.sessionName as string) ?? 'am-automaker-feature',
  terminalSessionId: 'term-1',
  reused: false,
}));
const restoreConversationMock = vi.fn();
const restoreSpaceTabsMock = vi.fn(async (options: { targets: Array<{ taskKeys: string[] }> }) =>
  options.targets.map((target, index) => ({
    taskKeys: target.taskKeys,
    tabId: `w7:t${index + 2}`,
    createdTab: true,
    paneId: null,
    startedAgent: false,
    resumedSessionId: null,
    sessionId: null,
  }))
);
const getHerdrTaskServiceMock = vi.fn(() => ({
  restoreConversation: restoreConversationMock,
  restoreSpaceTabs: restoreSpaceTabsMock,
}));
const updateFeatureFieldsMock = vi.fn().mockResolvedValue(undefined);
const resolveFeatureWorkDirMock = vi.fn();
const getAllFeaturesMock = vi.fn(async () => [] as Array<Record<string, unknown>>);
const featureLoaderStub = { getAll: getAllFeaturesMock };

vi.mock('../../../../src/services/herdr-service.js', () => ({
  isHerdrAvailable: isHerdrAvailableMock,
  getHerdrService: vi.fn(() => ({ attachWorktreeSession: attachWorktreeSessionMock })),
}));
vi.mock('../../../../src/services/terminal-service.js', () => ({
  getTerminalService: vi.fn(() => ({})),
}));
vi.mock('../../../../src/services/herdr-task-service.js', () => ({
  getHerdrTaskService: (projectPath: string) => getHerdrTaskServiceMock(projectPath),
}));
vi.mock('../../../../src/services/feature-state-manager.js', () => ({
  FeatureStateManager: class {
    updateFeatureFields = updateFeatureFieldsMock;
    destroy = vi.fn();
  },
}));
vi.mock('../../../../src/routes/features/routes/opencode-session.js', () => ({
  resolveFeatureWorkDir: resolveFeatureWorkDirMock,
}));

const { createHerdrWebHandler } =
  await import('../../../../src/routes/features/routes/herdr-web.js');

function fakeResponse() {
  const recorded = { body: null as Record<string, unknown> | null, statusCalls: [] as number[] };
  const res = {
    status(code: number) {
      recorded.statusCalls.push(code);
      return this;
    },
    json(body: unknown) {
      recorded.body = body as Record<string, unknown>;
      return this;
    },
  } as unknown as Response;
  return { res, recorded };
}

function fakeFeature(extra: Record<string, unknown> = {}) {
  return {
    model: 'pi:litellm/worker',
    id: 'jira-dodo-aip-114859',
    title: 'AIP-114859: 审计日志导出',
    ...extra,
  };
}

/** The loader the handler is built with (only `getAll` is used by this route) */
const featureLoader = featureLoaderStub as never;

describe('herdr web route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isHerdrAvailableMock.mockImplementation(() => true);
    resolveFeatureWorkDirMock.mockResolvedValue({
      feature: fakeFeature(),
      workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
    });
    restoreConversationMock.mockResolvedValue({
      workspaceId: 'w7',
      tabId: 'w7:t2',
      paneId: 'w7:p1',
      rootPaneId: 'w7:p1',
      createdWorkspace: true,
      createdTab: true,
      startedAgent: true,
      resumedSessionId: 'sess-1',
      sessionId: 'sess-1',
    });
  });

  it('restores the task conversation, focuses it and attaches the shared session', async () => {
    const { res, recorded } = fakeResponse();
    await createHerdrWebHandler(featureLoader)(
      {
        body: {
          projectPath: '/workspace/vibe-llmops',
          featureId: 'jira-dodo-aip-114859',
        },
      } as unknown as Request,
      res
    );

    expect(getHerdrTaskServiceMock).toHaveBeenCalledWith('/workspace/vibe-llmops');
    expect(restoreConversationMock).toHaveBeenCalledWith({
      taskName: 'AIP-114859: 审计日志导出',
      workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
      workspaceId: null,
      tabId: null,
      providerSessionId: null,
      taskKeys: ['jira-dodo-aip-114859'],
      projectPath: '/workspace/vibe-llmops',
    });
    // No explicit session: the project session is the default now.
    expect(attachWorktreeSessionMock).toHaveBeenCalledWith({
      projectPath: '/workspace/vibe-llmops',
      workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
    });
    expect(recorded.body).toMatchObject({
      success: true,
      workspaceId: 'w7',
      tabId: 'w7:t2',
      restored: true,
    });
    expect(updateFeatureFieldsMock).toHaveBeenCalledWith(
      '/workspace/vibe-llmops',
      'jira-dodo-aip-114859',
      { herdrWorkspaceId: 'w7', herdrTabId: 'w7:t2', providerSessionId: 'sess-1' }
    );
  });

  it('keeps non-Pi provider session IDs separate from the Pi viewer session', async () => {
    resolveFeatureWorkDirMock.mockResolvedValue({
      feature: fakeFeature({ model: 'claude-opus', providerSessionId: 'claude-native-id' }),
      workDir: '/p/wt',
    });
    const { res } = fakeResponse();
    await createHerdrWebHandler(featureLoader)(
      { body: { projectPath: '/p', featureId: 'f' } } as Request,
      res
    );
    expect(restoreConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: null })
    );
    expect(updateFeatureFieldsMock).toHaveBeenCalledWith(
      '/p',
      'f',
      expect.objectContaining({ herdrPiSessionId: 'sess-1' })
    );
    expect(updateFeatureFieldsMock.mock.calls[0][2]).not.toHaveProperty('providerSessionId');
  });

  it('keeps the persisted workspace id when the feature already has one', async () => {
    resolveFeatureWorkDirMock.mockResolvedValue({
      feature: fakeFeature({ herdrWorkspaceId: 'w7', herdrTabId: 'w7:t1' }),
      workDir: '/tmp/wt',
    });
    restoreConversationMock.mockResolvedValue({
      workspaceId: 'w7',
      tabId: 'w7:t1',
      paneId: 'w7:p1',
      rootPaneId: 'w7:p1',
      createdWorkspace: false,
      createdTab: false,
      startedAgent: false,
      resumedSessionId: null,
      sessionId: null,
    });

    const { res } = fakeResponse();
    await createHerdrWebHandler(featureLoader)(
      { body: { projectPath: '/p', featureId: 'jira-dodo-aip-114859' } } as unknown as Request,
      res
    );

    expect(restoreConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w7', tabId: 'w7:t1' })
    );
    // Nothing changed, so the feature file is left alone.
    expect(updateFeatureFieldsMock).not.toHaveBeenCalled();
  });

  it('lists every card of the worktree as a tab in the space', async () => {
    getAllFeaturesMock.mockResolvedValue([
      {
        id: 'jira-dodo-aip-114859',
        title: 'AIP-114859: 审计日志导出',
        branchName: 'jira/aip-114859-dodo',
      },
      {
        id: 'jira-dodo-aip-114860',
        title: 'AIP-114860: 另一个子任务',
        branchName: 'jira/aip-114859-dodo',
        jiraKey: 'AIP-114860',
      },
      { id: 'jira-dodo-aip-114999', title: 'other worktree', branchName: 'jira/aip-114999-dodo' },
    ]);
    resolveFeatureWorkDirMock.mockResolvedValue({
      feature: fakeFeature({ branchName: 'jira/aip-114859-dodo' }),
      workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
    });

    const { res } = fakeResponse();
    await createHerdrWebHandler(featureLoader)(
      { body: { projectPath: '/p', featureId: 'jira-dodo-aip-114859' } } as unknown as Request,
      res
    );

    // Only cards sharing the worktree (branch) become tabs, and only tab creation
    // is awaited before the browser opens.
    expect(restoreSpaceTabsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w7',
        agents: 'none',
        projectPath: '/p',
        targets: [
          expect.objectContaining({
            taskKeys: ['jira-dodo-aip-114860', 'AIP-114860'],
            title: 'AIP-114860: 另一个子任务',
          }),
        ],
      })
    );
    expect(updateFeatureFieldsMock).toHaveBeenCalledWith('/p', 'jira-dodo-aip-114860', {
      herdrWorkspaceId: 'w7',
      herdrTabId: 'w7:t2',
    });

    // Their conversations are resumed after the response, so the tabs fill in.
    await vi.waitFor(() => {
      expect(restoreSpaceTabsMock).toHaveBeenCalledWith(expect.objectContaining({ agents: 'all' }));
    });
  });

  it('falls back to the worktree session when the conversation cannot be restored', async () => {
    restoreConversationMock.mockRejectedValue(new Error('herdr control unavailable'));

    const { res, recorded } = fakeResponse();
    await createHerdrWebHandler(featureLoader)(
      { body: { projectPath: '/p', featureId: 'jira-dodo-aip-114859' } } as unknown as Request,
      res
    );

    expect(attachWorktreeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/p' })
    );
    expect(recorded.body).toMatchObject({ success: true, restored: false });
  });

  it('reports herdr as unavailable', async () => {
    isHerdrAvailableMock.mockImplementation(() => false);

    const { res, recorded } = fakeResponse();
    await createHerdrWebHandler(featureLoader)(
      { body: { projectPath: '/p', featureId: 'jira-dodo-aip-114859' } } as unknown as Request,
      res
    );

    expect(recorded.statusCalls).toEqual([503]);
    expect(restoreConversationMock).not.toHaveBeenCalled();
  });
});
