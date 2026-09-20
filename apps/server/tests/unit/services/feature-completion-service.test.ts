import { describe, it, expect, vi } from 'vitest';
import {
  completeFeatureMergeRequests,
  type CompletionDependencies,
} from '../../../src/services/feature-completion-service.js';
import type { MergePlanEntry } from '../../../src/services/feature-merge-plan.js';
import type { MergeRequestState } from '../../../src/services/gitlab-merge-service.js';

const SUB: MergePlanEntry = {
  name: 'backend/sophon-mind',
  mrUrl: 'http://gl/group/sophon-mind/-/merge_requests/261',
  gitlabProject: 'group/sophon-mind',
  iid: 261,
  isRoot: false,
};
const ROOT: MergePlanEntry = {
  name: 'vibe-llmops',
  mrUrl: 'http://gl/group/vibe-llmops/-/merge_requests/10',
  gitlabProject: 'group/vibe-llmops',
  iid: 10,
  isRoot: true,
};

function state(
  entry: MergePlanEntry,
  overrides: Partial<MergeRequestState> = {}
): MergeRequestState {
  return {
    iid: entry.iid,
    project: entry.gitlabProject,
    state: 'opened',
    title: `Draft: ${entry.name}`,
    draft: true,
    sourceBranch: 'jira/x',
    targetBranch: 'dev',
    sha: 'sha-' + entry.iid,
    hasConflicts: false,
    ...overrides,
  };
}

function deps(
  states: Record<string, MergeRequestState>,
  overrides: Partial<CompletionDependencies> = {}
): CompletionDependencies & { order: string[] } {
  const order: string[] = [];
  // Once a project's conflict is resolved the follow-up recheck must observe it.
  const resolved = new Set<string>();
  const base: CompletionDependencies = {
    gitlab: {
      getMergeRequest: vi.fn(async (url: string) => {
        order.push(`get:${url.includes('261') ? 'sub' : 'root'}`);
        const current = states[url];
        if (!current) return null;
        // Resolving pushes commits, so the branch head (sha) moves.
        return resolved.has(url)
          ? { ...current, hasConflicts: false, sha: `${current.sha}-resolved` }
          : current;
      }),
      markReady: vi.fn(async (url: string) => {
        order.push(`ready:${url.includes('261') ? 'sub' : 'root'}`);
        return { ok: true };
      }),
      merge: vi.fn(async (url: string) => {
        order.push(`merge:${url.includes('261') ? 'sub' : 'root'}`);
        return { ok: true, merged: true };
      }),
    } as unknown as CompletionDependencies['gitlab'],
    resolveConflict: vi.fn(async (entry: MergePlanEntry) => {
      order.push(`resolve:${entry.name}`);
      resolved.add(entry.mrUrl);
      return { ok: true };
    }),
    runVerification: vi.fn(async () => {
      order.push('verify');
      return { ok: true, log: 'ok' };
    }),
    ...overrides,
  };
  return Object.assign(base, { order });
}

describe('completeFeatureMergeRequests', () => {
  it('runs conflicts -> verify -> ready -> merge, subprojects before the root', async () => {
    const d = deps({ [SUB.mrUrl]: state(SUB), [ROOT.mrUrl]: state(ROOT) });

    const result = await completeFeatureMergeRequests([SUB, ROOT], d);

    expect(result.ok).toBe(true);
    expect(result.merged).toEqual([SUB.mrUrl, ROOT.mrUrl]);
    // verification must precede un-drafting so a bad resolution never lands.
    expect(d.order.indexOf('verify')).toBeLessThan(d.order.indexOf('ready:sub'));
    expect(d.order.indexOf('ready:sub')).toBeLessThan(d.order.indexOf('merge:sub'));
    expect(d.order.indexOf('merge:sub')).toBeLessThan(d.order.indexOf('merge:root'));
  });

  it('resolves conflicts before verification and does not merge on failure', async () => {
    const d = deps(
      { [ROOT.mrUrl]: state(ROOT, { hasConflicts: true }) },
      { resolveConflict: vi.fn(async () => ({ ok: false, error: 'sub-task could not resolve' })) }
    );

    const result = await completeFeatureMergeRequests([ROOT], d);

    expect(result).toMatchObject({ ok: false, stage: 'conflicts' });
    expect(result.error).toContain('vibe-llmops');
    expect(result.error).toContain('sub-task could not resolve');
    expect(d.runVerification).not.toHaveBeenCalled();
    expect(d.gitlab.merge).not.toHaveBeenCalled();
    expect(d.gitlab.markReady).not.toHaveBeenCalled();
  });

  it('dispatches one resolution task per conflicted project', async () => {
    const OTHER: MergePlanEntry = {
      name: 'frontend/saas-frontend',
      mrUrl: 'http://gl/group/saas-frontend/-/merge_requests/2065',
      gitlabProject: 'group/saas-frontend',
      iid: 2065,
      isRoot: false,
    };
    const d = deps({
      [SUB.mrUrl]: state(SUB, { hasConflicts: true }),
      [OTHER.mrUrl]: state(OTHER, { hasConflicts: true }),
      [ROOT.mrUrl]: state(ROOT),
    });

    const result = await completeFeatureMergeRequests([SUB, OTHER, ROOT], d);

    expect(result.ok).toBe(true);
    const resolved = d.order.filter((step) => step.startsWith('resolve:'));
    expect(resolved).toEqual(['resolve:backend/sophon-mind', 'resolve:frontend/saas-frontend']);
    // The main task still owns verification, after every sub-task resolved.
    expect(d.order.indexOf('resolve:frontend/saas-frontend')).toBeLessThan(
      d.order.indexOf('verify')
    );
    expect(d.gitlab.merge).toHaveBeenCalledTimes(3);
  });

  it('merges the refreshed head after a conflict resolution moved the branch', async () => {
    const d = deps({ [SUB.mrUrl]: state(SUB, { hasConflicts: true }) });

    const result = await completeFeatureMergeRequests([SUB], d);

    expect(result.ok).toBe(true);
    // The resolution pushed new commits, so the sha captured before it is stale.
    // GitLab rejects a merge whose `sha` no longer matches the branch head.
    expect(d.gitlab.merge).toHaveBeenCalledWith(SUB.mrUrl, { sha: 'sha-261-resolved' });
  });

  it('stops when the merge request cannot be re-read after conflict resolution', async () => {
    const d = deps({ [SUB.mrUrl]: state(SUB, { hasConflicts: true }) });
    const getMergeRequest = d.gitlab.getMergeRequest as unknown as ReturnType<typeof vi.fn>;
    getMergeRequest
      .mockImplementationOnce(async () => state(SUB, { hasConflicts: true }))
      .mockImplementationOnce(async () => null);

    const result = await completeFeatureMergeRequests([SUB], d);

    expect(result).toMatchObject({ ok: false, stage: 'conflicts' });
    expect(result.error).toContain('Could not re-read merge request');
    expect(d.gitlab.merge).not.toHaveBeenCalled();
    expect(d.gitlab.markReady).not.toHaveBeenCalled();
  });

  it('keeps merge requests as drafts when local verification fails', async () => {
    const d = deps(
      { [SUB.mrUrl]: state(SUB) },
      { runVerification: vi.fn(async () => ({ ok: false, error: 'go test failed' })) }
    );

    const result = await completeFeatureMergeRequests([SUB], d);

    expect(result).toMatchObject({ ok: false, stage: 'verify' });
    expect(d.gitlab.markReady).not.toHaveBeenCalled();
    expect(d.gitlab.merge).not.toHaveBeenCalled();
    expect(result.merged).toEqual([]);
  });

  it('stops at the failing merge and keeps what already landed', async () => {
    const d = deps({ [SUB.mrUrl]: state(SUB), [ROOT.mrUrl]: state(ROOT) });
    (d.gitlab.merge as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) =>
        url === SUB.mrUrl
          ? { ok: true, merged: true }
          : { ok: false, merged: false, error: 'conflict' }
    );

    const result = await completeFeatureMergeRequests([SUB, ROOT], d);

    expect(result).toMatchObject({ ok: false, stage: 'merge' });
    expect(result.merged).toEqual([SUB.mrUrl]);
    expect(result.error).toContain('vibe-llmops');
  });

  it('skips merge requests that are already merged', async () => {
    const d = deps({ [SUB.mrUrl]: state(SUB, { state: 'merged' }), [ROOT.mrUrl]: state(ROOT) });

    const result = await completeFeatureMergeRequests([SUB, ROOT], d);

    expect(result.alreadyMerged).toEqual([SUB.mrUrl]);
    expect(result.merged).toEqual([ROOT.mrUrl]);
  });

  it('does nothing when the feature has no merge requests', async () => {
    const d = deps({});
    const result = await completeFeatureMergeRequests([], d);

    expect(result).toMatchObject({ ok: true, stage: 'done' });
    expect(d.gitlab.getMergeRequest).not.toHaveBeenCalled();
  });
});
