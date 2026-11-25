import { createHash } from 'node:crypto';
import { activeDeliveryProjects } from '../../../../src/services/delivery-completion.js';
import { describe, expect, it, vi } from 'vitest';
import { createCompleteHandler } from '../../../../src/routes/features/routes/complete.js';
import type { FeatureLoader } from '../../../../src/services/feature-loader.js';
import type { SettingsService } from '../../../../src/services/settings-service.js';
import type { Request, Response } from 'express';

function setup(
  options: {
    status?: string;
    approved?: boolean;
    source?: string;
    conflict?: boolean;
    merged?: boolean;
    jiraFailure?: boolean;
    requiredFields?: boolean;
    localOnly?: boolean;
    cleanupFailure?: boolean;
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
  if (options.approved !== false)
    Object.assign(feature, {
      deliveryApproval: {
        approvedAt: 'now',
        reviews: feature.mergeRequests.map((url) => ({
          url,
          sha: 'abc',
          feedbackHash: createHash('sha256').update('[]').digest('hex'),
        })),
      },
    });
  const loader = {
    get: vi.fn(async () => ({ ...feature })),
    update: vi.fn(async (_p, _f, updates) => ({ ...Object.assign(feature, updates) })),
  };
  const settings = {
    getProjectSettings: vi.fn(async () => ({
      jiraSync: { gitlabHost: 'git.test', jiraUrl: 'https://jira.test', targetBranch: 'dev' },
    })),
  };
  const order: string[] = [];
  let draft = options.approved === false;
  const gitlab = {
    getMergeRequest: vi.fn(async (url: string) => ({
      iid: url.endsWith('1') ? 1 : 2,
      project: 'g/repo',
      state: 'opened',
      title: 'Draft: change',
      draft,
      sha: 'abc',
      sourceBranch: options.source ?? 'jira/task',
      targetBranch: 'dev',
      hasConflicts: options.conflict ?? false,
    })),
    markReady: vi.fn(async () => {
      draft = false;
      return { ok: true };
    }),
    getReviewFeedback: vi.fn(async () => [] as Array<{ id: number; body: string }>),
    getMergeBlockers: vi.fn(async () => [] as string[]),
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
  const executor = { followUpFeature: vi.fn(async () => {}) };
  const handler = createCompleteHandler(
    loader as unknown as FeatureLoader,
    settings as unknown as SettingsService,
    async () => [],
    { jira, gitlab: async () => gitlab as never },
    async () => {
      order.push('preview');
      if (options.cleanupFailure) throw new Error('Preview deletion denied');
      return { status: 'succeeded', message: 'Preview released' };
    },
    executor as never
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
  return { call, apply, loader, gitlab, jira, order, feature, executor };
}

describe('human Complete delivery endpoint', () => {
  it('Approve only removes Draft and persists the reviewed revisions; Confirm is a separate action', async () => {
    const s = setup({ approved: false });
    const preview = await s.call();
    expect(preview.result.approved).toBe(false);
    expect(s.jira).not.toHaveBeenCalled();
    const approved = await s.call({ action: 'approve', fingerprint: preview.result.fingerprint });
    expect(approved.success).toBe(true);
    expect(approved.feature.deliveryApproval.reviews).toHaveLength(2);
    expect(s.gitlab.markReady).toHaveBeenCalled();
    expect(s.order).toEqual([]);
    expect(approved.feature.archive).toBeUndefined();
    expect(approved.feature.status).toBe('verified');
    expect((await s.call()).result.approved).toBe(true);
    expect((await s.apply()).feature.archive.reason).toBe('completed');
  });

  it('cannot Confirm before approval, even with a current fingerprint', async () => {
    const s = setup({ approved: false });
    const result = await s.apply();
    expect(result.error).toContain('Approve MR');
    expect(s.order).toEqual([]);
  });

  it('allows removal of Draft despite conflicts but refuses Confirm until they are fixed', async () => {
    const s = setup({ approved: false, conflict: true });
    const plan = await s.call();
    expect(
      (await s.call({ action: 'approve', fingerprint: plan.result.fingerprint })).success
    ).toBe(true);
    expect((await s.apply()).error).toContain('冲突');
    expect(s.order).toEqual([]);
  });

  it('refreshes edited review feedback and rejects approval of an old preview', async () => {
    const s = setup({ approved: false });
    s.gitlab.getReviewFeedback.mockResolvedValue([{ id: 1, body: 'old suggestion' }]);
    const old = await s.call();
    s.gitlab.getReviewFeedback.mockResolvedValue([{ id: 1, body: 'updated suggestion' }]);
    expect((await s.call({ action: 'approve', fingerprint: old.result.fingerprint })).success).toBe(
      false
    );
    expect(s.gitlab.markReady).not.toHaveBeenCalled();
    const fresh = await s.call();
    expect(fresh.result.mergeRequests[0].feedback[0].body).toBe('updated suggestion');
  });

  it('invalidates approval after a new source commit or review feedback', async () => {
    for (const change of ['sha', 'feedback']) {
      const s = setup();
      const old = await s.call();
      if (change === 'sha') {
        const state = await s.gitlab.getMergeRequest('1');
        s.gitlab.getMergeRequest.mockResolvedValue({ ...state, sha: 'new' });
      } else s.gitlab.getReviewFeedback.mockResolvedValue([{ id: 2, body: 'New review' }]);
      expect((await s.call()).result.approved).toBe(false);
      expect(
        (await s.call({ action: 'confirm', fingerprint: old.result.fingerprint })).success
      ).toBe(false);
      expect(s.order).toEqual([]);
    }
  });

  it('Fix MR reuses the task and includes live review feedback without performing delivery', async () => {
    const s = setup({ approved: false });
    s.gitlab.getReviewFeedback.mockResolvedValue([{ id: 7, body: 'Latest review suggestion' }]);
    const plan = await s.call();
    const result = await s.call({ action: 'fix', fingerprint: plan.result.fingerprint });
    expect(result.success).toBe(true);
    expect(s.executor.followUpFeature).toHaveBeenCalledWith(
      '/root',
      'task',
      expect.stringContaining('Latest review suggestion'),
      undefined,
      true
    );
    expect(s.executor.followUpFeature.mock.calls[0][2]).toContain(
      'Fetch the latest MR discussions'
    );
    expect(s.order).toEqual([]);
    expect(s.gitlab.markReady).not.toHaveBeenCalled();
  });

  it('rejects duplicate Fix MR dispatch while the first turn is running', async () => {
    const s = setup({ approved: false, conflict: true });
    let finish!: () => void;
    s.executor.followUpFeature.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    try {
      const plan = await s.call();
      expect((await s.call({ action: 'fix', fingerprint: plan.result.fingerprint })).success).toBe(
        true
      );
      expect((await s.call({ action: 'fix', fingerprint: plan.result.fingerprint })).success).toBe(
        false
      );
      expect(s.executor.followUpFeature).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it('blocks CI failures before releasing previews or merging', async () => {
    const s = setup();
    s.gitlab.getMergeBlockers.mockResolvedValue(['CI 尚未成功（running）']);
    const plan = await s.call();
    expect(plan.result.blockers).toContain('CI 尚未成功（running）');
    expect((await s.apply()).success).toBe(false);
    expect(s.order).toEqual([]);
  });

  it('rechecks feedback after preview release and stops before a merge if it changed', async () => {
    const s = setup();
    s.gitlab.getReviewFeedback.mockImplementation(async () =>
      s.order.includes('preview') ? [{ id: 3, body: 'New feedback' }] : []
    );
    const result = await s.apply();
    expect(result.error).toContain('MR review changed');
    expect(s.order).toEqual(['preview']);
    expect((s.feature as any).archive).toBeUndefined();
  });

  it('retries a partial merge using live state and archives only after the remaining steps succeed', async () => {
    const s = setup();
    const read = s.gitlab.getMergeRequest.getMockImplementation()!;
    const merged = new Set<string>();
    s.gitlab.getMergeRequest.mockImplementation(async (url) => ({
      ...(await read(url)),
      state: merged.has(url) ? 'merged' : 'opened',
    }));
    let failRoot = true;
    s.gitlab.merge.mockImplementation(async (url) => {
      if (url.endsWith('2') && failRoot) return { ok: false, merged: false };
      merged.add(url);
      return { ok: true, merged: true };
    });
    expect((await s.apply()).success).toBe(false);
    expect((s.feature as any).archive).toBeUndefined();
    expect(s.feature.status).toBe('verified');
    expect(s.jira.mock.calls.some(([input]) => input.action === 'close')).toBe(false);
    failRoot = false;
    const result = await s.apply();
    expect(result.success).toBe(true);
    expect(result.feature.archive.reason).toBe('completed');
    expect(result.feature.archiveHistory).toHaveLength(1);
    expect(s.gitlab.merge.mock.calls.filter(([url]) => url.endsWith('1'))).toHaveLength(1);
    expect(s.jira.mock.calls.filter(([input]) => input.action === 'close')).toHaveLength(1);
  });

  it('previews without changing MR, Jira or task', async () => {
    const s = setup();
    const result = await s.call();
    expect(result.success).toBe(true);
    expect(result.result.mergeRequests).toHaveLength(2);
    expect(s.gitlab.markReady).not.toHaveBeenCalled();
    expect(s.gitlab.merge).not.toHaveBeenCalled();
    expect(s.jira).toHaveBeenCalledWith(expect.objectContaining({ action: 'inspect' }));
    expect(s.loader.update.mock.calls.some((call) => call[2].status === 'completed')).toBe(false);
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
  it('releases preview, merges subprojects before root, closes Jira, then archives', async () => {
    const s = setup();
    expect((await s.apply()).success).toBe(true);
    expect(s.order).toEqual([
      'preview',
      'https://git.test/g/sub/-/merge_requests/1',
      'https://git.test/g/root/-/merge_requests/2',
      'jira',
    ]);
    expect(s.gitlab.merge).toHaveBeenCalledWith(expect.any(String), { sha: 'abc', squash: true });
    expect(s.loader.update).toHaveBeenCalledWith(
      '/root',
      'task',
      expect.objectContaining({
        status: 'completed',
        jiraStatus: 'Done',
        archive: expect.objectContaining({ reason: 'completed' }),
      })
    );
  });
  it('does not merge conflicts or archive the task', async () => {
    const s = setup({ conflict: true });
    expect((await s.apply()).success).toBe(false);
    expect(s.gitlab.markReady).not.toHaveBeenCalled();
    expect(s.loader.update.mock.calls.some((call) => call[2].status === 'completed')).toBe(false);
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
    expect(s.loader.update.mock.calls.some((call) => call[2].status === 'completed')).toBe(false);
  });
  it('leaves the task in Done if Jira closing fails after merging', async () => {
    const s = setup({ jiraFailure: true });
    const result = await s.apply();
    expect(result.success).toBe(false);
    expect(result.error).toContain('MR 已全部合并');
    expect(s.gitlab.merge).toHaveBeenCalledTimes(2);
    expect(s.loader.update.mock.calls.some((call) => call[2].status === 'completed')).toBe(false);
  });
  it('reconciles completed external operations without merging or closing again', async () => {
    const s = setup();
    const state = await s.gitlab.getMergeRequest('https://git.test/g/sub/-/merge_requests/1');
    s.gitlab.getMergeRequest.mockResolvedValue({ ...state, state: 'merged' });
    const issue = await s.jira({ action: 'inspect' });
    s.jira.mockClear();
    s.jira.mockResolvedValue({ ...issue, done: true, status: 'Closed', transitions: [] });
    expect((await s.apply()).success).toBe(true);
    expect(s.gitlab.markReady).not.toHaveBeenCalled();
    expect(s.gitlab.merge).not.toHaveBeenCalled();
    expect(s.jira.mock.calls.every(([input]) => input.action === 'inspect')).toBe(true);
    expect(s.loader.update).toHaveBeenCalledWith(
      '/root',
      'task',
      expect.objectContaining({ status: 'completed', jiraStatus: 'Closed' })
    );
  });

  it('persists all three successful steps in order', async () => {
    const s = setup();
    const result = await s.apply();
    expect(result.success).toBe(true);
    const writes = s.loader.update.mock.calls.map((call) => call[2]);
    expect(writes.at(-1).deliveryCompletion.status).toBe('succeeded');
    expect(
      writes.at(-1).deliveryCompletion.steps.map((step: { status: string }) => step.status)
    ).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(
      writes.some((update) =>
        update.deliveryCompletion?.steps.some(
          (step: { id: string; status: string }) =>
            step.id === 'preview' && step.status === 'running'
        )
      )
    ).toBe(true);
  });
  it('stops before merging or closing Jira if preview cleanup fails', async () => {
    const s = setup({ cleanupFailure: true });
    const result = await s.apply();
    expect(result.success).toBe(false);
    const last = s.loader.update.mock.calls.at(-1)![2];
    expect(last.deliveryCompletion.status).toBe('failed');
    expect(last.deliveryCompletion.steps.map((step: { status: string }) => step.status)).toEqual([
      'failed',
      'pending',
      'pending',
    ]);
    expect(s.gitlab.merge).not.toHaveBeenCalled();
    expect(s.jira.mock.calls.some(([input]) => input.action === 'close')).toBe(false);
    expect(last.deliveryCompletion.steps[0].message).toContain('Preview deletion denied');
    expect(s.loader.update.mock.calls.some((call) => call[2].status === 'completed')).toBe(false);
  });
  it('retains released preview and merged MRs when Jira closure fails', async () => {
    const s = setup({ jiraFailure: true });
    await s.apply();
    expect(s.order[0]).toBe('preview');
    const progress = s.loader.update.mock.calls.at(-1)![2].deliveryCompletion;
    expect(progress.steps.map((step: { status: string }) => step.status)).toEqual([
      'succeeded',
      'succeeded',
      'failed',
    ]);
  });

  it('keeps successful steps if reconciliation fails during a retry', async () => {
    const s = setup();
    Object.assign(s.feature, {
      deliveryCompletion: {
        status: 'failed',
        updatedAt: 'old',
        steps: [
          { id: 'merge', status: 'succeeded' },
          { id: 'jira', status: 'succeeded' },
          { id: 'preview', status: 'failed', message: 'old cleanup failure' },
        ],
      },
    });
    s.gitlab.getMergeRequest.mockRejectedValue(new Error('GitLab unavailable'));
    const result = await s.call({ preview: false, fingerprint: 'old' });
    expect(result.success).toBe(false);
    const progress = s.loader.update.mock.calls.at(-1)![2].deliveryCompletion;
    expect(progress.steps.map((step: { status: string }) => step.status)).toEqual([
      'failed',
      'succeeded',
      'succeeded',
    ]);
    expect(progress.reconciliationError.message).toContain('GitLab unavailable');
  });

  it('rejects another Complete while this project is finishing preview ownership checks', async () => {
    const s = setup();
    activeDeliveryProjects.add('/root');
    try {
      const result = await s.call({ preview: false });
      expect(result.success).toBe(false);
      expect(s.gitlab.merge).not.toHaveBeenCalled();
      expect(s.loader.update).not.toHaveBeenCalled();
    } finally {
      activeDeliveryProjects.delete('/root');
    }
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
    expect(s.loader.update.mock.calls.some((call) => call[2].status === 'completed')).toBe(false);
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
