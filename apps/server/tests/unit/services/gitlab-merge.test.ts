import { describe, it, expect, vi } from 'vitest';
import {
  GitLabMergeService,
  parseMergeRequestUrl,
  type FetchLike,
} from '../../../src/services/gitlab-merge-service.js';
import { buildFeatureMergePlan } from '../../../src/services/feature-merge-plan.js';

const FRONTEND_MR = 'http://gitblue.transwarp.io/saas/saas-frontend/-/merge_requests/2065';
const BACKEND_MR = 'http://gitblue.transwarp.io/llm/llmops/sophon-mind/-/merge_requests/261';
const ROOT_MR = 'http://gitblue.transwarp.io/llm/llmops/product/vibe-llmops/-/merge_requests/10';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseMergeRequestUrl', () => {
  it('extracts project and iid from a nested GitLab MR URL', () => {
    expect(parseMergeRequestUrl(ROOT_MR)).toEqual({
      project: 'llm/llmops/product/vibe-llmops',
      iid: 10,
      host: 'http://gitblue.transwarp.io',
    });
  });

  it('rejects non-MR URLs', () => {
    expect(parseMergeRequestUrl('https://example.com/group/repo/pull/12')).toBeNull();
    expect(parseMergeRequestUrl('not-a-url')).toBeNull();
  });
});

describe('buildFeatureMergePlan', () => {
  it('merges subprojects before the root repository', () => {
    const plan = buildFeatureMergePlan({
      changedProjects: [
        { name: 'frontend/saas-frontend', mrUrl: FRONTEND_MR },
        { name: 'backend/sophon-mind', mrUrl: BACKEND_MR },
        { name: 'vibe-llmops', mrUrl: ROOT_MR },
      ],
      rootProjectName: 'vibe-llmops',
    });

    expect(plan.map((entry) => entry.name)).toEqual([
      'frontend/saas-frontend',
      'backend/sophon-mind',
      'vibe-llmops',
    ]);
    expect(plan.at(-1)?.isRoot).toBe(true);
    expect(plan[0]).toMatchObject({ iid: 2065, gitlabProject: 'saas/saas-frontend' });
  });

  it('orders annotated root labels last and deduplicates trailing slashes', () => {
    const plan = buildFeatureMergePlan({
      changedProjects: [
        { name: 'root (vibe-llmops)', mrUrl: ROOT_MR },
        { name: 'backend/sophon-mind', mrUrl: BACKEND_MR },
      ],
      mergeRequests: [ROOT_MR + '/'],
      rootProjectName: 'vibe-llmops',
    });
    expect(plan.map((entry) => entry.mrUrl)).toEqual([BACKEND_MR, ROOT_MR]);
    expect(plan.at(-1)?.isRoot).toBe(true);
  });

  it('skips projects without an MR and de-duplicates URLs', () => {
    const plan = buildFeatureMergePlan({
      changedProjects: [
        { name: 'vibe-design' },
        { name: 'backend/sophon-mind', mrUrl: BACKEND_MR },
        { name: 'backend/sophon-mind', mrUrl: BACKEND_MR },
      ],
      rootProjectName: 'vibe-llmops',
    });

    expect(plan).toHaveLength(1);
    expect(plan[0].name).toBe('backend/sophon-mind');
  });

  it('recovers projects from the flat MR list when labels are missing', () => {
    const plan = buildFeatureMergePlan({
      mergeRequests: [FRONTEND_MR, ROOT_MR],
      rootProjectName: 'vibe-llmops',
    });

    // Without receipt labels the GitLab project path is the most accurate name,
    // but ordering still recognises the root by its leaf segment.
    expect(plan.map((entry) => entry.name)).toEqual([
      'saas/saas-frontend',
      'llm/llmops/product/vibe-llmops',
    ]);
    expect(plan.at(-1)?.isRoot).toBe(true);
  });
});

describe('GitLabMergeService', () => {
  const service = (fetchImpl: FetchLike) => new GitLabMergeService('token', fetchImpl);

  it('reads draft and conflict state from the MR', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        state: 'opened',
        title: 'Draft: AIP-114859 审计日志导出',
        draft: true,
        source_branch: 'jira/aip-114859-dodo',
        target_branch: 'dev',
        sha: 'abc123',
        has_conflicts: true,
        merge_status: 'cannot_be_merged',
        web_url: ROOT_MR,
      })
    );

    const mr = await service(fetchImpl as unknown as FetchLike).getMergeRequest(ROOT_MR);

    expect(mr).toMatchObject({ draft: true, hasConflicts: true, targetBranch: 'dev' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://gitblue.transwarp.io/api/v4/projects/llm%2Fllmops%2Fproduct%2Fvibe-llmops/merge_requests/10'
    );
  });

  it('strips the Draft prefix so GitLab accepts the merge', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ title: 'AIP-114859 审计日志导出' }));

    const result = await service(fetchImpl as unknown as FetchLike).markReady(
      ROOT_MR,
      'Draft: AIP-114859 审计日志导出'
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).title).toBe(
      'AIP-114859 审计日志导出'
    );
  });

  it('does not call the API when the MR is already ready', async () => {
    const fetchImpl = vi.fn();
    const result = await service(fetchImpl as unknown as FetchLike).markReady(
      ROOT_MR,
      'AIP-114859'
    );

    expect(result.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a failed merge with the GitLab error message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: ['Branch cannot be merged'] }, 405));

    const result = await service(fetchImpl as unknown as FetchLike).merge(ROOT_MR, {
      sha: 'abc123',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Branch cannot be merged');
  });

  it('merges when GitLab accepts the request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ state: 'merged' }));
    const result = await service(fetchImpl as unknown as FetchLike).merge(BACKEND_MR);

    expect(result).toMatchObject({ ok: true, merged: true });
  });
});
