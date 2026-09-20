import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  createMergeConflictCheckHandler,
  createResolveConflictsHandler,
} from '../../../../src/routes/features/routes/merge-conflicts.js';
import type { FeatureLoader } from '../../../../src/services/feature-loader.js';
import type { SettingsService } from '../../../../src/services/settings-service.js';

const SUB_MR = 'https://git.test/g/sub/-/merge_requests/1';
const ROOT_MR = 'https://git.test/g/root/-/merge_requests/2';

function setup(options: { conflict?: boolean[]; status?: string } = {}) {
  const feature = {
    id: 'jira-dodo-aip-114859',
    title: 'AIP-114859: 审计日志导出',
    status: options.status ?? 'verified',
    branchName: 'jira/aip-114859-dodo',
    jiraKey: 'AIP-114859',
    mergeRequests: [SUB_MR, ROOT_MR],
  };
  const child = {
    id: 'aip-114859-child-1',
    title: '后端导出',
    status: 'verified',
    branchName: 'jira/aip-114859-dodo',
    jiraKey: 'AIP-114859',
    changedProjects: [{ name: 'g/sub' }],
  };
  const loader = {
    get: vi.fn(async (_projectPath: string, featureId: string) =>
      featureId === child.id ? child : featureId === feature.id ? feature : null
    ),
    getAll: vi.fn(async () => [feature, child]),
  };
  const settings = {
    getProjectSettings: vi.fn(async () => ({
      jiraSync: { gitlabHost: 'git.test', targetBranch: 'dev' },
    })),
  };
  const conflicts = options.conflict ?? [true, true];
  const gitlab = {
    getMergeRequest: vi.fn(async (url: string) => ({
      iid: url === SUB_MR ? 1 : 2,
      project: url === SUB_MR ? 'g/sub' : 'g/root',
      state: 'opened',
      title: 'Draft: AIP-114859',
      draft: true,
      sourceBranch: 'jira/aip-114859-dodo',
      targetBranch: 'dev',
      hasConflicts: url === SUB_MR ? conflicts[0] : conflicts[1],
    })),
  };
  const followUp = vi.fn(async () => {});
  const call = async (
    handler: (req: Request, res: Response) => Promise<void>,
    body: Record<string, unknown> = {}
  ) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(
      { body: { projectPath: '/root', featureId: feature.id, ...body } } as Request,
      res as unknown as Response
    );
    return { body: res.json.mock.calls[0][0], status: res.status.mock.calls[0]?.[0] };
  };
  const check = (body = {}) =>
    call(
      createMergeConflictCheckHandler(
        loader as unknown as FeatureLoader,
        settings as unknown as SettingsService,
        { gitlab: async () => gitlab as never }
      ),
      body
    );
  const resolve = (body = {}) =>
    call(
      createResolveConflictsHandler(
        loader as unknown as FeatureLoader,
        settings as unknown as SettingsService,
        undefined,
        { gitlab: async () => gitlab as never, followUp }
      ),
      body
    );
  return { check, resolve, followUp, gitlab, loader };
}

describe('merge conflict check', () => {
  it('reports every conflicting merge request with its repository', async () => {
    const { check } = setup();
    const { body } = await check();
    expect(body.success).toBe(true);
    expect(body.conflicts).toEqual([
      {
        name: 'g/sub',
        mrUrl: SUB_MR,
        iid: 1,
        sourceBranch: 'jira/aip-114859-dodo',
        targetBranch: 'dev',
      },
      {
        name: 'g/root',
        mrUrl: ROOT_MR,
        iid: 2,
        sourceBranch: 'jira/aip-114859-dodo',
        targetBranch: 'dev',
      },
    ]);
  });

  it('reports nothing when the merge requests are clean', async () => {
    const { check } = setup({ conflict: [false, false] });
    const { body } = await check();
    expect(body.success).toBe(true);
    expect(body.conflicts).toEqual([]);
  });

  it('reports nothing when the card has no recorded merge requests', async () => {
    const s = setup();
    s.loader.get.mockResolvedValue({ id: 'task', status: 'verified' } as never);
    const { body } = await s.check();
    expect(body.conflicts).toEqual([]);
    expect(s.gitlab.getMergeRequest).not.toHaveBeenCalled();
  });

  it('asks GitLab only for the configured host', async () => {
    const s = setup();
    s.loader.get.mockResolvedValue({
      id: 'task',
      status: 'verified',
      mergeRequests: ['https://elsewhere.test/g/sub/-/merge_requests/1'],
    } as never);
    const { body } = await s.check();
    expect(body.conflicts).toEqual([]);
    expect(s.gitlab.getMergeRequest).not.toHaveBeenCalled();
  });
});

describe('conflict resolution dispatch', () => {
  it('hands each conflicted repository to its owning task', async () => {
    const { resolve, followUp } = setup();
    const { body } = await resolve();
    expect(body.success).toBe(true);
    expect(body.dispatched).toEqual([
      { featureId: 'aip-114859-child-1', title: '后端导出', repositories: ['g/sub'] },
      {
        featureId: 'jira-dodo-aip-114859',
        title: 'AIP-114859: 审计日志导出',
        repositories: ['g/root'],
      },
    ]);
    // Both turns run in the same worktree, so the prompt names one path only.
    expect(followUp).toHaveBeenCalledTimes(2);
    const [, , prompt] = followUp.mock.calls[0];
    expect(prompt).toContain('!1');
    expect(prompt).toContain('`g/sub`');
    expect(prompt).not.toContain('`g/root`');
  });

  it('keeps the work on the card when no sub-task claims the repository', async () => {
    const s = setup();
    s.loader.getAll.mockResolvedValue([
      { id: 'jira-dodo-aip-114859', jiraKey: 'AIP-114859' },
    ] as never);
    const { body } = await s.resolve();
    expect(body.dispatched).toHaveLength(1);
    expect(body.dispatched[0].featureId).toBe('jira-dodo-aip-114859');
    expect(body.dispatched[0].repositories).toEqual(['g/sub', 'g/root']);
  });

  it('refuses to dispatch for a card that is not in Done', async () => {
    const { resolve, followUp } = setup({ status: 'waiting_approval' });
    const { body, status } = await resolve();
    expect(status).toBe(409);
    expect(body.success).toBe(false);
    expect(followUp).not.toHaveBeenCalled();
  });

  it('refuses when nothing conflicts', async () => {
    const { resolve, followUp } = setup({ conflict: [false, false] });
    const { body, status } = await resolve();
    expect(status).toBe(409);
    expect(body.success).toBe(false);
    expect(followUp).not.toHaveBeenCalled();
  });

  it('requires a feature id', async () => {
    const { resolve } = setup();
    const { body, status } = await resolve({ featureId: undefined });
    expect(status).toBe(400);
    expect(body.error).toContain('required');
  });
});
