import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HerdrTaskService,
  buildLeaderAgentName,
  buildTabLabel,
  buildWorkerAgentName,
  buildWorktreeWorkspaceLabel,
  isLeaderAgentName,
  piSessionIdFromFile,
  resolveTaskPiSession,
  HERDR_LEADER_MODEL,
  HERDR_WORKER_MODEL,
  MAX_WORKERS_PER_TASK,
} from '../../../src/services/herdr-task-service.js';
import { HerdrApiError, HerdrControlClient } from '../../../src/services/herdr-client.js';

const {
  findPiSessionMock,
  findPiSessionForFeatureMock,
  findPiSessionForFeatureInProjectMock,
  listPiSessionFilesMock,
  readSessionFeatureIdMock,
} = vi.hoisted(() => ({
  findPiSessionMock: vi.fn(),
  findPiSessionForFeatureMock: vi.fn(),
  findPiSessionForFeatureInProjectMock: vi.fn(),
  listPiSessionFilesMock: vi.fn(),
  readSessionFeatureIdMock: vi.fn(),
}));

vi.mock('../../../src/services/pi-session-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/pi-session-store.js')>()),
  findPiSession: findPiSessionMock,
  findPiSessionForFeature: findPiSessionForFeatureMock,
  findPiSessionForFeatureInProject: findPiSessionForFeatureInProjectMock,
  listPiSessionFiles: listPiSessionFilesMock,
  readSessionFeatureId: readSessionFeatureIdMock,
}));

/**
 * Build a service whose client is stubbed at the socket boundary.
 *
 * The stub keeps a tiny in-memory herdr: workspaces, tabs and panes are real
 * enough objects for the service to look them up again (by label, by id, by
 * tab), which is what the deep-link logic does.
 */
function createStubService(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state = {
    workspaces: [] as Array<Record<string, unknown>>,
    tabs: [] as Array<Record<string, unknown>>,
    panes: [] as Array<Record<string, unknown>>,
    nextWorkspace: 9,
  };

  const panesIn = (workspaceId: string) =>
    state.panes.filter((pane) => pane.workspace_id === workspaceId);
  const tabsIn = (workspaceId: string) =>
    state.tabs.filter((tab) => tab.workspace_id === workspaceId);

  const defaults: Record<string, (params: Record<string, unknown>) => unknown> = {
    'workspace.list': () => ({ workspaces: state.workspaces }),
    'workspace.get': (params) => ({
      workspace: state.workspaces.find((w) => w.workspace_id === params.workspace_id) ?? undefined,
    }),
    'workspace.create': (params) => {
      const id = 'w' + state.nextWorkspace++;
      const workspace = {
        workspace_id: id,
        label: params.label,
        agent_status: 'unknown',
        focused: false,
        pane_count: 1,
        tab_count: 1,
      };
      const tab = {
        tab_id: id + ':t1',
        workspace_id: id,
        label: '1',
        focused: true,
        pane_count: 1,
        agent_status: 'unknown',
      };
      const rootPane = {
        pane_id: id + ':p1',
        workspace_id: id,
        tab_id: tab.tab_id,
        cwd: params.cwd ?? null,
        focused: true,
        agent_status: 'unknown',
      };
      state.workspaces.push(workspace);
      state.tabs.push(tab);
      state.panes.push(rootPane);
      return { workspace, tab, root_pane: rootPane };
    },
    'tab.list': (params) => ({ tabs: tabsIn(String(params.workspace_id)) }),
    'tab.get': (params) => ({
      tab: state.tabs.find((tab) => tab.tab_id === params.tab_id) ?? undefined,
    }),
    'tab.create': (params) => {
      const workspaceId = String(params.workspace_id);
      const tab = {
        tab_id: workspaceId + ':t' + (tabsIn(workspaceId).length + 1),
        workspace_id: workspaceId,
        label: params.label,
        focused: false,
        pane_count: 1,
        agent_status: 'unknown',
      };
      const rootPane = {
        pane_id: workspaceId + ':p' + (panesIn(workspaceId).length + 1),
        workspace_id: workspaceId,
        tab_id: tab.tab_id,
        cwd: params.cwd ?? null,
        focused: false,
        agent_status: 'unknown',
      };
      state.tabs.push(tab);
      state.panes.push(rootPane);
      return { tab, root_pane: rootPane };
    },
    'tab.rename': (params) => {
      const tab = state.tabs.find((entry) => entry.tab_id === params.tab_id);
      if (tab) tab.label = params.label;
      return {};
    },
    'tab.focus': (params) => ({
      tab: state.tabs.find((tab) => tab.tab_id === params.tab_id) ?? undefined,
    }),
    'pane.list': (params) => ({ panes: panesIn(String(params.workspace_id)) }),
    'pane.split': (params) => {
      const target = state.panes.find((pane) => pane.pane_id === params.target_pane_id);
      const workspaceId = String(target?.workspace_id ?? 'w9');
      const pane = {
        pane_id: workspaceId + ':p' + (panesIn(workspaceId).length + 1),
        workspace_id: workspaceId,
        tab_id: target?.tab_id ?? workspaceId + ':t1',
        cwd: params.cwd ?? target?.cwd ?? null,
        focused: false,
        agent_status: 'unknown',
      };
      state.panes.push(pane);
      return { pane };
    },
    'workspace.focus': (params) => ({
      workspace: { workspace_id: params.workspace_id, focused: true },
    }),
    'agent.focus': (params) => ({
      agent: { pane_id: params.target, name: 'focused', agent: 'pi' },
    }),
    'agent.start': (params) => ({
      agent: { name: params.name, pane_id: params.pane_id, agent_status: 'idle' },
      argv: ['pi'],
    }),
  };
  const handlers = { ...defaults, ...overrides };

  const client = new HerdrControlClient({ socketPath: '/tmp/does-not-matter.sock' });
  vi.spyOn(client, 'ensureSession').mockResolvedValue({ started: false, socketPath: '/x' });
  vi.spyOn(client, 'request').mockImplementation(async (method: string, params: never) => {
    calls.push({ method, params: params as Record<string, unknown> });
    const handler = handlers[method];
    if (!handler) throw new Error('unexpected call ' + method);
    return handler(params as Record<string, unknown>) as never;
  });
  vi.spyOn(client, 'isSessionRunning').mockResolvedValue(true);
  vi.spyOn(client, 'isAvailable').mockReturnValue(true);
  vi.spyOn(client, 'listAgents').mockResolvedValue([]);
  vi.spyOn(client, 'waitForAgentReady').mockImplementation(async (paneId: string) => ({
    name: null,
    agent: 'pi',
    agent_status: 'idle',
    pane_id: paneId,
    tab_id: 'w9:t1',
    workspace_id: 'w9',
    focused: false,
    interactive_ready: true,
  }));
  return { service: new HerdrTaskService(client), calls, client, state };
}

describe('herdr-task-service', () => {
  beforeEach(() => {
    findPiSessionMock.mockReset();
    findPiSessionMock.mockReturnValue(null);
    findPiSessionForFeatureMock.mockReset();
    findPiSessionForFeatureMock.mockReturnValue(null);
    findPiSessionForFeatureInProjectMock.mockReset();
    findPiSessionForFeatureInProjectMock.mockReturnValue(null);
    listPiSessionFilesMock.mockReset();
    listPiSessionFilesMock.mockReturnValue([]);
    readSessionFeatureIdMock.mockReset();
    readSessionFeatureIdMock.mockReturnValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  it('builds readable tab labels', () => {
    expect(buildTabLabel('  Fix   the   login bug  ')).toBe('Fix the login bug');
    expect(buildTabLabel('x'.repeat(200)).length).toBe(80);
    expect(buildTabLabel('x'.repeat(200)).endsWith('...')).toBe(true);
  });

  it('names a space after the worktree, not the task', () => {
    expect(buildWorktreeWorkspaceLabel('/workspace/vibe-llmops/.worktrees/aip-114859-dodo')).toBe(
      'aip-114859-dodo'
    );
    expect(buildWorktreeWorkspaceLabel('/workspace/vibe-llmops')).toBe('vibe-llmops');
  });

  it('scopes agent names by tab, because herdr names are session-wide', () => {
    expect(buildLeaderAgentName('w3:t2')).toBe('w3-t2-leader');
    expect(buildWorkerAgentName('w3:t2', 0)).toBe('w3-t2-worker-1');
    expect(buildWorkerAgentName('w3:t2', 3)).toBe('w3-t2-worker-4');
    expect(isLeaderAgentName('w3-t2-leader', 'w3:t2')).toBe(true);
    // Names written by earlier builds still identify the leader.
    expect(isLeaderAgentName('w3-leader', 'w3:t2')).toBe(true);
    expect(isLeaderAgentName('leader', 'w3:t2')).toBe(true);
    expect(isLeaderAgentName('w3-t2-worker-1', 'w3:t2')).toBe(false);
    expect(isLeaderAgentName(null, 'w3:t2')).toBe(false);
  });

  it('reads the pi session id out of a session file name', () => {
    expect(
      piSessionIdFromFile(
        '/root/.pi/agent/sessions/--workspace-vibe-llmops--/2026-09-18T02-22-46-792Z_01a0b252-d008-741d-a7ac-6e0cf80f30a2.jsonl'
      )
    ).toBe('01a0b252-d008-741d-a7ac-6e0cf80f30a2');
    expect(piSessionIdFromFile(null)).toBeNull();
    expect(piSessionIdFromFile('/tmp/nope.jsonl')).toBeNull();
  });

  describe('resolveTaskPiSession', () => {
    const mine = { id: 'sess-mine', modelId: 'worker', modelProvider: 'litellm' };
    const other = { id: 'sess-other', modelId: 'worker', modelProvider: 'litellm' };

    it('prefers the session the card persists', () => {
      findPiSessionMock.mockReturnValue(mine);
      findPiSessionForFeatureMock.mockReturnValue(other);
      expect(resolveTaskPiSession('/wt', { providerSessionId: 'sess-mine' })).toBe(mine);
      expect(findPiSessionForFeatureMock).not.toHaveBeenCalled();
    });

    it("ignores a pin that points at another card's conversation", () => {
      findPiSessionMock.mockReturnValue({ ...other, filePath: '/wt/other.jsonl' });
      readSessionFeatureIdMock.mockReturnValue('jira-other-1');
      findPiSessionForFeatureMock.mockReturnValue(mine);

      expect(
        resolveTaskPiSession('/wt', {
          providerSessionId: 'sess-other',
          taskKeys: ['jira-mine-1'],
        })
      ).toBe(mine);
      expect(findPiSessionForFeatureMock).toHaveBeenCalledWith('/wt', ['jira-mine-1']);
    });

    it('falls back to the session dispatched for the card', () => {
      findPiSessionForFeatureMock.mockReturnValue(mine);
      expect(resolveTaskPiSession('/wt', { taskKeys: ['jira-x-1'] })).toBe(mine);
      expect(findPiSessionForFeatureMock).toHaveBeenCalledWith('/wt', ['jira-x-1']);
    });

    it('finds the conversation a card ran in an older worktree of the project', () => {
      findPiSessionForFeatureMock.mockReturnValue(null);
      findPiSessionForFeatureInProjectMock.mockReturnValue(mine);
      expect(
        resolveTaskPiSession('/wt/new', { taskKeys: ['jira-x-1'], projectPath: '/proj' })
      ).toBe(mine);
      expect(findPiSessionForFeatureInProjectMock).toHaveBeenCalledWith('/proj', ['jira-x-1']);
    });

    it('does not resume a singleton session belonging to a different task', () => {
      listPiSessionFilesMock.mockReturnValue(['/wt/other.jsonl']);
      findPiSessionMock.mockReturnValue({ ...other, filePath: '/wt/other.jsonl' });
      readSessionFeatureIdMock.mockReturnValue('task-a');
      expect(resolveTaskPiSession('/wt', { taskKeys: ['task-b'] })).toBeNull();
      expect(
        resolveTaskPiSession('/wt', { taskKeys: ['task-b'], providerSessionId: 'sess-other' })
      ).toBeNull();
    });

    it('uses the only session when the worktree never ran anything else', () => {
      listPiSessionFilesMock.mockReturnValue(['/wt/one.jsonl']);
      findPiSessionMock.mockReturnValue(mine);
      expect(resolveTaskPiSession('/wt')).toBe(mine);
    });

    it('refuses to guess between several unrelated sessions', () => {
      listPiSessionFilesMock.mockReturnValue(['/wt/a.jsonl', '/wt/b.jsonl']);
      expect(resolveTaskPiSession('/wt')).toBeNull();
      expect(findPiSessionMock).not.toHaveBeenCalled();
    });
  });

  it('creates a workspace for the worktree directory', async () => {
    const { service, calls } = createStubService();
    const result = await service.ensureWorktreeWorkspace({
      workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
    });

    expect(result.created).toBe(true);
    const create = calls.find((c) => c.method === 'workspace.create');
    expect(create?.params).toMatchObject({
      label: 'aip-114859-dodo',
      cwd: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
      focus: false,
    });
  });

  it('reuses the workspace that already covers the worktree', async () => {
    const { service, calls } = createStubService({
      'workspace.list': () => ({
        workspaces: [{ workspace_id: 'w4', label: 'aip-114859-dodo', agent_status: 'idle' }],
      }),
    });
    const result = await service.ensureWorktreeWorkspace({
      workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
    });

    expect(result.workspace.workspace_id).toBe('w4');
    expect(result.created).toBe(false);
    expect(calls.some((c) => c.method === 'workspace.create')).toBe(false);
  });

  it('ignores a persisted workspace id that belongs to another worktree', async () => {
    const { service } = createStubService({
      'workspace.get': () => ({
        workspace: { workspace_id: 'w1', label: 'some-other-task', agent_status: 'idle' },
      }),
      'pane.list': () => ({ panes: [{ pane_id: 'w1:p1', cwd: '/other/wt' }] }),
    });
    const result = await service.ensureWorktreeWorkspace({
      workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
      workspaceId: 'w1',
    });

    expect(result.created).toBe(true);
    expect(result.workspace.workspace_id).not.toBe('w1');
  });

  it('creates a tab labelled with the task name', async () => {
    const { service, calls, state } = createStubService();
    state.workspaces.push({ workspace_id: 'w4', label: 'aip-114859-dodo' });
    state.panes.push({ pane_id: 'w4:p1', workspace_id: 'w4', tab_id: 'w4:t1', cwd: '/tmp/wt' });

    const tab = await service.ensureTaskTab({
      workspaceId: 'w4',
      taskName: 'AIP-114859: 审计日志导出',
      workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
    });

    expect(tab.created).toBe(true);
    expect(tab.tab.label).toBe('AIP-114859: 审计日志导出');
    const create = calls.find((c) => c.method === 'tab.create');
    expect(create?.params).toMatchObject({
      workspace_id: 'w4',
      label: 'AIP-114859: 审计日志导出',
      focus: false,
    });
  });

  it('reuses the task tab by label and by persisted tab id', async () => {
    const { service, calls, state } = createStubService();
    state.tabs.push({ tab_id: 'w4:t2', workspace_id: 'w4', label: 'AIP-114859: 审计日志导出' });
    state.panes.push({ pane_id: 'w4:p2', workspace_id: 'w4', tab_id: 'w4:t2', cwd: '/tmp/wt' });

    const byLabel = await service.ensureTaskTab({
      workspaceId: 'w4',
      taskName: 'AIP-114859: 审计日志导出',
      workDir: '/tmp/wt',
    });
    expect(byLabel.created).toBe(false);
    expect(byLabel.tab.tab_id).toBe('w4:t2');
    expect(byLabel.rootPaneId).toBe('w4:p2');

    const byId = await service.ensureTaskTab({
      workspaceId: 'w4',
      taskName: 'renamed task',
      workDir: '/tmp/wt',
      tabId: 'w4:t2',
    });
    expect(byId.tab.tab_id).toBe('w4:t2');
    expect(calls.some((c) => c.method === 'tab.create')).toBe(false);
  });

  it('keeps identically named cards in separate tabs and reuses each by task identity', async () => {
    const { service, state } = createStubService();
    state.workspaces.push({ workspace_id: 'w4', label: 'worktree' });
    const options = {
      workspaceId: 'w4',
      workDir: '/tmp/wt',
      taskName: 'Repeated title '.repeat(10),
    };
    const first = await service.ensureTaskTab({ ...options, taskId: 'task-a' });
    const second = await service.ensureTaskTab({ ...options, taskId: 'task-b' });
    const reopened = await service.ensureTaskTab({ ...options, taskId: 'task-a' });
    expect(first.tab.tab_id).not.toBe(second.tab.tab_id);
    expect(first.tab.label).not.toBe(second.tab.label);
    expect(reopened.tab.tab_id).toBe(first.tab.tab_id);
  });

  it('does not adopt a persisted tab owned by a different task', async () => {
    const { service, state } = createStubService();
    state.workspaces.push({ workspace_id: 'w4', label: 'worktree' });
    const options = { workspaceId: 'w4', workDir: '/tmp/wt', taskName: 'Same title' };
    const first = await service.ensureTaskTab({ ...options, taskId: 'task-a' });
    const second = await service.ensureTaskTab({
      ...options,
      taskId: 'task-b',
      tabId: first.tab.tab_id,
    });
    expect(first.tab.tab_id).not.toBe(second.tab.tab_id);
    const reopened = await service.ensureTaskTab({
      ...options,
      taskId: 'task-a',
      tabId: first.tab.tab_id,
    });
    expect(reopened.tab.tab_id).toBe(first.tab.tab_id);
  });

  it('adopts the root tab of a one-space-per-task workspace', async () => {
    const { service, calls, state } = createStubService();
    state.workspaces.push({ workspace_id: 'w3', label: 'AIP-114859: 审计日志导出' });
    state.tabs.push({ tab_id: 'w3:t1', workspace_id: 'w3', label: '1' });
    state.panes.push({ pane_id: 'w3:p1', workspace_id: 'w3', tab_id: 'w3:t1', cwd: '/tmp/wt' });

    const tab = await service.ensureTaskTab({
      workspaceId: 'w3',
      taskName: 'AIP-114859: 审计日志导出',
      workDir: '/tmp/wt',
      adoptRootTab: true,
    });

    expect(tab.created).toBe(false);
    expect(tab.tab.tab_id).toBe('w3:t1');
    expect(tab.tab.label).toBe('AIP-114859: 审计日志导出');
    expect(calls.find((c) => c.method === 'tab.rename')?.params).toEqual({
      tab_id: 'w3:t1',
      label: 'AIP-114859: 审计日志导出',
    });
  });

  it('starts the leader with the leader model, named after the tab', async () => {
    const { service, calls } = createStubService();
    await service.startLeader({ rootPaneId: 'w9:p1', tabId: 'w9:t2' });
    const start = calls.find((c) => c.method === 'agent.start');
    expect(start?.params).toMatchObject({
      name: 'w9-t2-leader',
      kind: 'pi',
      pane_id: 'w9:p1',
    });
    // pi args may carry extra telemetry/skill flags; the model selection is what matters.
    expect(start?.params.args).toEqual(
      expect.arrayContaining(['--provider', 'litellm', '--model', HERDR_LEADER_MODEL])
    );
  });

  describe('restoreConversation', () => {
    it('reloads an idle stale pane from the exact authoritative transcript file', async () => {
      const { service, client, calls, state } = createStubService();
      state.workspaces.push({ workspace_id: 'w7', label: 'wt' });
      state.tabs.push({ tab_id: 'w7:t2', workspace_id: 'w7', label: 'Task A' });
      state.panes.push({ pane_id: 'w7:p3', workspace_id: 'w7', tab_id: 'w7:t2', cwd: '/tmp/wt' });
      const oldAgent = {
        name: 'w7-t2-leader',
        agent: 'pi',
        agent_status: 'idle',
        pane_id: 'w7:p3',
        workspace_id: 'w7',
        tab_id: 'w7:t2',
        agent_session: { value: '/sessions/old_same-id.jsonl' },
      };
      vi.mocked(client.listAgents)
        .mockResolvedValueOnce([oldAgent as never])
        .mockResolvedValue([]);
      vi.spyOn(client, 'promptAgent').mockResolvedValue(oldAgent as never);
      findPiSessionMock.mockReturnValue({
        id: 'same-id',
        filePath: '/sessions/new_same-id.jsonl',
        cwd: '/tmp/wt',
      });
      await service.restoreConversation({
        taskName: 'Task A',
        workDir: '/tmp/wt',
        workspaceId: 'w7',
        tabId: 'w7:t2',
        providerSessionId: 'same-id',
        taskKeys: ['task-a'],
      });
      expect(client.promptAgent).toHaveBeenCalledExactlyOnceWith({
        target: 'w7:p3',
        text: '/quit',
      });
      expect(calls.find((call) => call.method === 'agent.start')?.params.args).toContain(
        '/sessions/new_same-id.jsonl'
      );
    });

    it('never restarts a working conversation to deliver another task reply', async () => {
      const { service, client, state } = createStubService();
      state.workspaces.push({ workspace_id: 'w7', label: 'wt' });
      state.tabs.push({ tab_id: 'w7:t2', workspace_id: 'w7', label: 'Task A' });
      state.panes.push({ pane_id: 'w7:p3', workspace_id: 'w7', tab_id: 'w7:t2', cwd: '/tmp/wt' });
      vi.mocked(client.listAgents).mockResolvedValue([
        {
          name: 'w7-t2-leader',
          agent: 'pi',
          agent_status: 'working',
          pane_id: 'w7:p3',
          workspace_id: 'w7',
          tab_id: 'w7:t2',
        } as never,
      ]);
      const prompt = vi.spyOn(client, 'promptAgent');
      await expect(
        service.restoreConversation({
          taskName: 'Task A',
          workDir: '/tmp/wt',
          workspaceId: 'w7',
          tabId: 'w7:t2',
          executionArgs: ['--model', 'worker'],
        })
      ).rejects.toThrow('busy');
      expect(prompt).not.toHaveBeenCalled();
    });

    it('creates the worktree space and task tab, then resumes the pi session', async () => {
      findPiSessionForFeatureMock.mockReturnValue({
        id: 'sess-1',
        modelProvider: 'litellm',
        modelId: 'worker',
      });
      const { service, calls } = createStubService();

      const target = await service.restoreConversation({
        taskName: 'AIP-114859: 审计日志导出',
        workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
        taskKeys: ['jira-dodo-aip-114859', 'AIP-114859'],
      });

      expect(target).toMatchObject({
        tabId: 'w9:t1',
        paneId: 'w9:p1',
        createdWorkspace: true,
        createdTab: false,
        startedAgent: true,
        resumedSessionId: 'sess-1',
      });
      // Several cards share a worktree, so the card's own dispatch marker picks it.
      expect(findPiSessionForFeatureMock).toHaveBeenCalledWith(
        '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
        ['jira-dodo-aip-114859', 'AIP-114859']
      );
      expect(calls.find((c) => c.method === 'workspace.create')?.params).toMatchObject({
        label: 'aip-114859-dodo',
      });
      const start = calls.find((c) => c.method === 'agent.start');
      expect(start?.params).toMatchObject({
        name: 'w9-t1-leader',
        kind: 'pi',
        pane_id: 'w9:p1',
      });
      expect(start?.params.args).toEqual(
        expect.arrayContaining([
          '--provider',
          'litellm',
          '--model',
          'worker',
          '--session',
          'sess-1',
        ])
      );
      // The deep link must leave the attached TUI on this task's pane.
      expect(calls.find((c) => c.method === 'workspace.focus')?.params).toEqual({
        workspace_id: 'w9',
      });
      expect(calls.find((c) => c.method === 'tab.focus')?.params).toEqual({ tab_id: 'w9:t1' });
      expect(calls.find((c) => c.method === 'agent.focus')?.params).toEqual({ target: 'w9:p1' });
    });

    it("resumes the session the card already owns, not a sibling task's", async () => {
      findPiSessionMock.mockReturnValue({
        id: 'sess-mine',
        modelProvider: 'litellm',
        modelId: 'worker',
      });
      const { service } = createStubService();

      const target = await service.restoreConversation({
        taskName: 'AIP-114915: 版本级属性',
        workDir: '/workspace/vibe-llmops/.worktrees/aip-114866-dodo',
        providerSessionId: 'sess-mine',
      });

      expect(findPiSessionMock).toHaveBeenCalledWith(
        '/workspace/vibe-llmops/.worktrees/aip-114866-dodo',
        'sess-mine'
      );
      expect(target.sessionId).toBe('sess-mine');
    });

    it('forks a conversation that was recorded in another worktree', async () => {
      findPiSessionForFeatureMock.mockReturnValue(null);
      findPiSessionForFeatureInProjectMock.mockReturnValue({
        id: 'sess-old',
        cwd: '/old/worktree',
        filePath: '/root/.pi/agent/sessions/--old--/old.jsonl',
        modelProvider: 'litellm',
        modelId: 'worker',
      });
      const { service, calls } = createStubService();

      await service.restoreConversation({
        taskName: 'moved card',
        workDir: '/new/worktree',
        taskKeys: ['jira-x-1'],
        projectPath: '/proj',
      });

      const start = calls.find((call) => call.method === 'agent.start');
      expect(start?.params.args).toEqual(
        expect.arrayContaining(['--fork', '/root/.pi/agent/sessions/--old--/old.jsonl'])
      );
      expect(start?.params.args).not.toContain('--session');
    });

    it('reuses the persisted space and tab with the pi agent already in it', async () => {
      const { service, calls, client, state } = createStubService();
      state.workspaces.push({ workspace_id: 'w7', label: 'wt' });
      state.tabs.push({ tab_id: 'w7:t2', workspace_id: 'w7', label: 'AIP-114859: 审计日志导出' });
      state.panes.push({ pane_id: 'w7:p3', workspace_id: 'w7', tab_id: 'w7:t2', cwd: '/tmp/wt' });
      vi.spyOn(client, 'listAgents').mockResolvedValue([
        {
          name: 'w7-t2-leader',
          agent: 'pi',
          agent_status: 'idle',
          pane_id: 'w7:p3',
          workspace_id: 'w7',
          tab_id: 'w7:t2',
          focused: false,
          cwd: '/tmp/wt',
        } as never,
      ]);

      const target = await service.restoreConversation({
        taskName: 'AIP-114859: 审计日志导出',
        workDir: '/tmp/wt',
        workspaceId: 'w7',
        tabId: 'w7:t2',
      });

      expect(target).toMatchObject({
        workspaceId: 'w7',
        tabId: 'w7:t2',
        paneId: 'w7:p3',
        createdWorkspace: false,
        createdTab: false,
        startedAgent: false,
        resumedSessionId: null,
      });
      expect(calls.some((c) => c.method === 'workspace.create')).toBe(false);
      expect(calls.some((c) => c.method === 'tab.create')).toBe(false);
      expect(calls.some((c) => c.method === 'agent.start')).toBe(false);
      expect(calls.find((c) => c.method === 'tab.focus')?.params).toEqual({ tab_id: 'w7:t2' });
      expect(calls.find((c) => c.method === 'agent.focus')?.params).toEqual({ target: 'w7:p3' });
    });

    it('adopts the space of a card written by the one-space-per-task layout', async () => {
      const { service, calls, state } = createStubService();
      state.workspaces.push({ workspace_id: 'w3', label: 'AIP-114859: 审计日志导出' });
      state.tabs.push({ tab_id: 'w3:t1', workspace_id: 'w3', label: '1' });
      state.panes.push({
        pane_id: 'w3:p1',
        workspace_id: 'w3',
        tab_id: 'w3:t1',
        cwd: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
      });

      const target = await service.restoreConversation({
        taskName: 'AIP-114859: 审计日志导出',
        workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
        workspaceId: 'w3',
      });

      expect(target).toMatchObject({ workspaceId: 'w3', tabId: 'w3:t1', createdWorkspace: false });
      expect(calls.some((c) => c.method === 'workspace.create')).toBe(false);
      expect(calls.some((c) => c.method === 'tab.create')).toBe(false);
      // The adopted root pane gets the (resumed) pi agent.
      expect(calls.find((c) => c.method === 'agent.start')?.params).toMatchObject({
        pane_id: 'w3:p1',
        name: 'w3-t1-leader',
      });
    });

    it('still points at the tab when the pane cannot host pi', async () => {
      const { service, calls } = createStubService({
        'agent.start': () => {
          throw new HerdrApiError('agent_pane_busy', 'pane is busy');
        },
      });

      const target = await service.restoreConversation({
        taskName: 'AIP-1',
        workDir: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
      });

      expect(target).toMatchObject({ paneId: null, startedAgent: false });
      expect(calls.find((c) => c.method === 'workspace.focus')?.params).toEqual({
        workspace_id: 'w9',
      });
      expect(calls.find((c) => c.method === 'tab.focus')).toBeDefined();
    });
  });

  describe('restoreSpaceTabs', () => {
    it('gives every card of the worktree a tab with its pi conversation', async () => {
      findPiSessionMock.mockImplementation((_workDir: string, sessionId?: string) =>
        sessionId === 'sess-a'
          ? { id: 'sess-a', modelProvider: 'litellm', modelId: 'worker' }
          : null
      );
      findPiSessionForFeatureMock.mockImplementation((_workDir: string, keys: string[]) =>
        keys.includes('aip-1-child-2')
          ? { id: 'sess-b', modelProvider: 'litellm', modelId: 'worker' }
          : null
      );

      const { service, calls, state } = createStubService();
      state.workspaces.push({ workspace_id: 'w4', label: 'aip-114866-dodo' });
      state.tabs.push({ tab_id: 'w4:t1', workspace_id: 'w4', label: 'epic' });
      state.panes.push({ pane_id: 'w4:p1', workspace_id: 'w4', tab_id: 'w4:t1', cwd: '/tmp/wt' });

      const results = await service.restoreSpaceTabs({
        workspaceId: 'w4',
        workDir: '/tmp/wt',
        agents: 'all',
        targets: [
          { taskKeys: ['aip-1-child-1'], title: 'child 1', providerSessionId: 'sess-a' },
          { taskKeys: ['aip-1-child-2'], title: 'child 2' },
          { taskKeys: ['aip-1-child-3'], title: 'child 3' },
        ],
      });

      expect(results.map((result) => result.tabId)).toEqual(['w4:t2', 'w4:t3', 'w4:t4']);
      // The card that never ran gets a fresh conversation, not a bare shell.
      expect(results.map((result) => result.resumedSessionId)).toEqual(['sess-a', 'sess-b', null]);
      expect(results.map((result) => result.startedAgent)).toEqual([true, true, true]);
      const starts = calls.filter((call) => call.method === 'agent.start');
      expect(starts.map((call) => call.params.name)).toEqual([
        'w4-t2-leader',
        'w4-t3-leader',
        'w4-t4-leader',
      ]);
      expect(starts[0].params.args).toEqual(
        expect.arrayContaining([
          '--provider',
          'litellm',
          '--model',
          'worker',
          '--session',
          'sess-a',
        ])
      );
      expect(starts).toHaveLength(3);
    });

    it('can only create the tabs, leaving the pi conversations for later', async () => {
      const { service, calls, state } = createStubService();
      state.workspaces.push({ workspace_id: 'w4', label: 'aip-114866-dodo' });
      state.tabs.push({ tab_id: 'w4:t1', workspace_id: 'w4', label: 'epic' });
      state.panes.push({ pane_id: 'w4:p1', workspace_id: 'w4', tab_id: 'w4:t1', cwd: '/tmp/wt' });

      const results = await service.restoreSpaceTabs({
        workspaceId: 'w4',
        workDir: '/tmp/wt',
        agents: 'none',
        targets: [{ taskKeys: ['aip-1-child-1'], title: 'child 1' }],
      });

      expect(results[0]).toMatchObject({ tabId: 'w4:t2', createdTab: true, paneId: null });
      expect(calls.some((call) => call.method === 'agent.start')).toBe(false);
    });
  });

  it('creates one worker pane and agent per subtask, named after the tab', async () => {
    const { service, calls, state } = createStubService();
    state.panes.push({ pane_id: 'w9:p1', workspace_id: 'w9', tab_id: 'w9:t2', cwd: '/tmp/wt' });
    const workers = await service.startWorkers({
      leaderPaneId: 'w9:p1',
      tabId: 'w9:t2',
      workDir: '/tmp/wt',
      subtaskCount: 3,
    });
    expect(workers).toHaveLength(3);
    expect(workers.map((w) => w.name)).toEqual([
      'w9-t2-worker-1',
      'w9-t2-worker-2',
      'w9-t2-worker-3',
    ]);
    const starts = calls.filter((c) => c.method === 'agent.start');
    expect(starts).toHaveLength(3);
    for (const start of starts) {
      expect(start.params.args).toEqual(
        expect.arrayContaining(['--provider', 'litellm', '--model', HERDR_WORKER_MODEL])
      );
    }
    const splits = calls.filter((c) => c.method === 'pane.split');
    expect(splits).toHaveLength(3);
    expect(splits[0].params.direction).toBe('right');
    expect(splits[1].params.direction).toBe('down');
    // Splits fan out from the newest pane rather than all from the leader.
    expect(splits[1].params.target_pane_id).not.toBe('w9:p1');
  });

  it('caps workers at the configured maximum', async () => {
    const { service } = createStubService();
    const workers = await service.startWorkers({
      leaderPaneId: 'w9:p1',
      tabId: 'w9:t1',
      workDir: '/tmp/wt',
      subtaskCount: MAX_WORKERS_PER_TASK + 5,
    });
    expect(workers).toHaveLength(MAX_WORKERS_PER_TASK);
  });

  it('lists only the agents of the requested tab', async () => {
    const { service, client } = createStubService();
    vi.spyOn(client, 'listAgents').mockResolvedValue([
      { pane_id: 'w9:p1', workspace_id: 'w9', tab_id: 'w9:t1', agent: 'pi' },
      { pane_id: 'w9:p2', workspace_id: 'w9', tab_id: 'w9:t2', agent: 'pi' },
      { pane_id: 'w8:p1', workspace_id: 'w8', tab_id: 'w8:t1', agent: 'pi' },
    ] as never);

    expect((await service.listTaskAgents('w9')).map((a) => a.pane_id)).toEqual(['w9:p1', 'w9:p2']);
    expect((await service.listTaskAgents('w9', 'w9:t2')).map((a) => a.pane_id)).toEqual(['w9:p2']);
  });

  it('treats an already-closed workspace or tab as success', async () => {
    const { service, client } = createStubService();
    vi.spyOn(client, 'closeWorkspace').mockRejectedValue(
      new HerdrApiError('workspace_not_found', 'workspace not found')
    );
    vi.spyOn(client, 'closeTab').mockRejectedValue(
      new HerdrApiError('tab_not_found', 'tab not found')
    );

    await expect(service.closeWorkspace('w9')).resolves.toBeUndefined();
    await expect(service.closeTaskTab('w9:t1')).resolves.toBeUndefined();
  });
});
