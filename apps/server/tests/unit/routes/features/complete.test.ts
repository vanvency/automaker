import { describe, expect, it, vi } from 'vitest';
import { createCompleteHandler } from '../../../../src/routes/features/routes/complete.js';
import type { FeatureLoader } from '../../../../src/services/feature-loader.js';
import type { SettingsService } from '../../../../src/services/settings-service.js';
import type { Request, Response } from 'express';

function setup(
  options: {
    status?: string;
    source?: string;
    conflict?: boolean;
    merged?: boolean;
    jiraFailure?: boolean;
    requiredFields?: boolean;
    localOnly?: boolean;
  } = {}
) {
  const feature = {
    id: 'task',
    status: options.status ?? 'verified',
    completionSource: 'human',
    branchName: 'jira/task',
    jiraKey: options.localOnly ? undefined : 'AIP-1',
    mergeRequests: options.localOnly
      ? []
      : ['https://git.test/g/sub/-/merge_requests/1', 'https://git.test/g/root/-/merge_requests/2'],
  };
  const loader = {
    get: vi.fn(async () => feature),
    update: vi.fn(async (_p, _f, updates) => ({ ...feature, ...updates })),
  };
  const settings = {
    getProjectSettings: vi.fn(async () => ({
      jiraSync: { gitlabHost: 'git.test', jiraUrl: 'https://jira.test', targetBranch: 'dev' },
    })),
  };
  const order: string[] = [];
  const gitlab = {
    getMergeRequest: vi.fn(async (url: string) => ({
      iid: url.endsWith('1') ? 1 : 2,
      project: 'g/repo',
      state: 'opened',
      title: 'Draft: change',
      draft: true,
      sha: 'abc',
      sourceBranch: options.source ?? 'jira/task',
      targetBranch: 'dev',
      hasConflicts: options.conflict ?? false,
    })),
    markReady: vi.fn(async () => ({ ok: true })),
    merge: vi.fn(async (url: string) => {
      order.push(url);
      return { ok: true, merged: options.merged ?? true };
    }),
  };
  const jira = vi.fn(async (input: Record<string, string>) => {
    if (input.action === 'close') {
      order.push('jira');
      if (options.jiraFailure) throw new Error('Jira unavailable');
    }
    return {
      key: 'AIP-1',
      url: 'https://jira.test/browse/AIP-1',
      status: input.action === 'close' ? 'Done' : 'Open',
      updated: '1',
      done: input.action === 'close',
      transitions: [
        {
          id: '7',
          name: 'Finish',
          target: 'Done',
          ...(options.requiredFields
            ? {
                fields: [
                  {
                    key: 'resolution',
                    name: 'Resolution',
                    multiple: false,
                    supported: true,
                    allowedValues: [{ id: '1', name: 'Fixed' }],
                    value: [],
                  },
                  {
                    key: 'fixVersions',
                    name: 'Fix Version/s',
                    multiple: true,
                    supported: true,
                    allowedValues: [{ id: '19348', name: 'LLM-3.1' }],
                    value: ['19348'],
                  },
                ],
              }
            : {}),
        },
      ],
    };
  });
  const handler = createCompleteHandler(
    loader as unknown as FeatureLoader,
    settings as unknown as SettingsService,
    async () => [],
    { jira, gitlab: async () => gitlab as never }
  );
  const call = async (body = {}) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(
      { body: { projectPath: '/root', featureId: 'task', ...body } } as Request,
      res as unknown as Response
    );
    return res.json.mock.calls[0][0];
  };
  const apply = async () => {
    const plan = await call();
    return call({ preview: false, fingerprint: plan.result?.fingerprint, transitionId: '7' });
  };
  return { call, apply, loader, gitlab, jira, order };
}

describe('human Complete delivery endpoint', () => {
  it('previews without changing MR, Jira or task', async () => {
    const s = setup();
    const result = await s.call();
    expect(result.success).toBe(true);
    expect(result.result.mergeRequests).toHaveLength(2);
    expect(s.gitlab.markReady).not.toHaveBeenCalled();
    expect(s.gitlab.merge).not.toHaveBeenCalled();
    expect(s.jira).toHaveBeenCalledWith(expect.objectContaining({ action: 'inspect' }));
    expect(s.loader.update).not.toHaveBeenCalled();
  });
  it('completes an accepted local task without requiring GitLab MRs', async () => {
    const s = setup({ localOnly: true });
    expect((await s.apply()).success).toBe(true);
    expect(s.gitlab.merge).not.toHaveBeenCalled();
    expect(s.jira).not.toHaveBeenCalled();
    expect(s.loader.update).toHaveBeenCalledWith(
      '/root',
      'task',
      expect.objectContaining({ status: 'completed' })
    );
  });

  it('requires Verify first', async () => {
    const s = setup({ status: 'waiting_approval' });
    expect((await s.call()).success).toBe(false);
    expect(s.jira).not.toHaveBeenCalled();
    expect(s.gitlab.merge).not.toHaveBeenCalled();
  });
  it('merges subprojects before the root, closes Jira last, then completes locally', async () => {
    const s = setup();
    expect((await s.apply()).success).toBe(true);
    expect(s.order).toEqual([
      'https://git.test/g/sub/-/merge_requests/1',
      'https://git.test/g/root/-/merge_requests/2',
      'jira',
    ]);
    expect(s.gitlab.merge).toHaveBeenCalledWith(expect.any(String), { sha: 'abc' });
    expect(s.loader.update).toHaveBeenCalledWith(
      '/root',
      'task',
      expect.objectContaining({ status: 'completed', jiraStatus: 'Done' })
    );
  });
  it('does not merge conflicts or archive the task', async () => {
    const s = setup({ conflict: true });
    expect((await s.apply()).success).toBe(false);
    expect(s.gitlab.markReady).not.toHaveBeenCalled();
    expect(s.loader.update).not.toHaveBeenCalled();
  });
  it('rejects an MR from a different task branch', async () => {
    const s = setup({ source: 'another-task' });
    expect((await s.call()).success).toBe(false);
    expect(s.gitlab.merge).not.toHaveBeenCalled();
  });
  it('requires a fresh preview before external writes', async () => {
    const s = setup();
    expect(
      (await s.call({ preview: false, fingerprint: 'stale', transitionId: '7' })).success
    ).toBe(false);
    expect(s.gitlab.merge).not.toHaveBeenCalled();
  });
  it('does not close Jira if a successful API response has not actually merged the MR', async () => {
    const s = setup({ merged: false });
    expect((await s.apply()).success).toBe(false);
    expect(s.jira.mock.calls.some(([input]) => input.action === 'close')).toBe(false);
    expect(s.loader.update).not.toHaveBeenCalled();
  });
  it('leaves the task in Done if Jira closing fails after merging', async () => {
    const s = setup({ jiraFailure: true });
    expect((await s.apply()).success).toBe(false);
    expect(s.gitlab.merge).toHaveBeenCalledTimes(2);
    expect(s.loader.update).not.toHaveBeenCalled();
  });
  it('validates required Jira fields before merging anything', async () => {
    const s = setup({ requiredFields: true });
    const preview = await s.call();
    for (const jiraFields of [
      {},
      { resolution: ['wrong'], fixVersions: ['19348'] },
      { resolution: ['1'], fixVersions: [] },
    ]) {
      const result = await s.call({
        preview: false,
        fingerprint: preview.result.fingerprint,
        transitionId: '7',
        jiraFields,
      });
      expect(result.success).toBe(false);
    }
    expect(s.gitlab.markReady).not.toHaveBeenCalled();
    expect(s.gitlab.merge).not.toHaveBeenCalled();
    expect(s.loader.update).not.toHaveBeenCalled();
  });

  it('forwards the reviewed resolution and version to the Jira closure', async () => {
    const s = setup({ requiredFields: true });
    const preview = await s.call();
    const jiraFields = { resolution: ['1'], fixVersions: ['19348'] };
    const result = await s.call({
      preview: false,
      fingerprint: preview.result.fingerprint,
      transitionId: '7',
      jiraFields,
    });
    expect(result.success).toBe(true);
    expect(s.jira).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'close',
        includeFields: 'true',
        fields: JSON.stringify(jiraFields),
      })
    );
  });
});
