import { beforeEach, expect, it, vi } from 'vitest';
import type { Feature } from '@automaker/types';
import * as secureFs from '../../../src/lib/secure-fs.js';
import { execGitCommand } from '@automaker/git-utils';
import {
  GitLabMergeService,
  resolveGitLabToken,
} from '../../../src/services/gitlab-merge-service.js';
import { WorktreeResolver } from '../../../src/services/worktree-resolver.js';
import { gateDraftMrReview } from '../../../src/services/draft-mr-review-gate.js';

vi.mock('../../../src/lib/secure-fs.js', () => ({ readFile: vi.fn(), readdir: vi.fn() }));
vi.mock('@automaker/git-utils', () => ({ execGitCommand: vi.fn() }));
vi.mock('../../../src/services/gitlab-merge-service.js', async (original) => ({
  ...(await original<typeof import('../../../src/services/gitlab-merge-service.js')>()),
  resolveGitLabToken: vi.fn(),
}));

const mrUrl = 'https://git.example/team/frontend/-/merge_requests/1';
const rootMr = 'https://git.example/team/project/-/merge_requests/2';
const feature = {
  id: 'task',
  jiraKey: 'AIP-1',
  branchName: 'fix/aip-1',
  status: 'waiting_approval',
  executionRunId: 'run-1',
} as Feature;
let receipt: Record<string, unknown>;
let getMr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(secureFs.readdir).mockResolvedValue([]);
  receipt = {
    issueKey: 'AIP-1',
    runId: 'run-1',
    outcome: 'mr_created',
    blockers: [],
    changedProjects: [
      { name: 'frontend', mrUrl },
      { name: 'project', mrUrl: rootMr },
    ],
    mergeRequests: [mrUrl, rootMr],
  };
  vi.spyOn(WorktreeResolver.prototype, 'findWorktreeForBranch').mockResolvedValue(
    '/project/.worktrees/task'
  );
  vi.mocked(secureFs.readFile).mockImplementation(async (file) =>
    JSON.stringify(
      String(file).endsWith('settings.json')
        ? { jiraSync: { gitlabHost: 'git.example', targetBranch: 'dev' } }
        : receipt
    )
  );
  vi.mocked(resolveGitLabToken).mockResolvedValue('test-token');
  vi.mocked(execGitCommand).mockImplementation(async (args, cwd) => {
    if (args.includes('--show-toplevel')) return cwd;
    if (args[0] === 'branch') return 'fix/aip-1';
    if (args[0] === 'diff') return 'changed-file.ts';
    if (args[0] === 'config') return 'submodule.frontend.path frontend\n';
    if (args[0] === 'remote')
      return `git@git.example:team/${cwd.endsWith('/frontend') ? 'frontend' : 'project'}.git`;
    return 'current-sha';
  });
  getMr = vi.spyOn(GitLabMergeService.prototype, 'getMergeRequest').mockResolvedValue({
    iid: 1,
    project: 'team/frontend',
    state: 'opened',
    title: 'Draft: fix',
    draft: true,
    sourceBranch: 'fix/aip-1',
    targetBranch: 'dev',
    sha: 'current-sha',
    hasConflicts: false,
  });
});

it('admits a current multi-repository Draft delivery and records its URLs', async () => {
  expect(await gateDraftMrReview('/project', feature)).toEqual({
    changedProjects: receipt.changedProjects,
    mergeRequests: [mrUrl, rootMr],
  });
  expect(getMr).toHaveBeenCalledTimes(2);
});

it('accepts an explicitly named root repository without skipping its MR verification', async () => {
  receipt.changedProjects = [
    { name: 'frontend', mrUrl },
    { name: 'project (root)', mrUrl: rootMr },
  ];
  expect(await gateDraftMrReview('/project', feature)).toEqual({
    changedProjects: receipt.changedProjects,
    mergeRequests: [mrUrl, rootMr],
  });
  expect(getMr).toHaveBeenCalledTimes(2);
});

it('accepts root as the project root alias and still verifies its MR', async () => {
  receipt.changedProjects = [
    { name: 'frontend', mrUrl },
    { name: 'root', mrUrl: rootMr },
  ];
  expect(await gateDraftMrReview('/project', feature)).toEqual({
    changedProjects: receipt.changedProjects,
    mergeRequests: [mrUrl, rootMr],
  });
  expect(getMr).toHaveBeenCalledTimes(2);
});

it('does not allow the root alias to identify a submodule MR', async () => {
  receipt.changedProjects = [{ name: 'root', mrUrl }];
  expect(await gateDraftMrReview('/project', feature)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('does not uniquely match repository root'),
  });
  expect(getMr).not.toHaveBeenCalled();
});

it('admits a merged subproject at its merge commit while the root MR stays open and Draft', async () => {
  const draft = await getMr.getMockImplementation()!(rootMr);
  getMr.mockImplementation(async (url) =>
    url === mrUrl
      ? {
          ...draft,
          state: 'merged',
          draft: false,
          sha: 'source-commit-before-squash',
          mergeCommitSha: 'current-sha',
        }
      : draft
  );
  expect(await gateDraftMrReview('/project', feature)).toEqual({
    changedProjects: receipt.changedProjects,
    mergeRequests: [mrUrl, rootMr],
  });
});

it('admits a merged subproject whose source SHA matches the task checkout', async () => {
  const draft = await getMr.getMockImplementation()!(mrUrl);
  getMr.mockImplementation(async (url) =>
    url === mrUrl
      ? {
          ...draft,
          state: 'merged',
          draft: false,
          mergeCommitSha: 'target-branch-merge-commit',
        }
      : draft
  );
  expect(await gateDraftMrReview('/project', feature)).toEqual({
    changedProjects: receipt.changedProjects,
    mergeRequests: [mrUrl, rootMr],
  });
});

it('lets a human verify when every MR was merged from the current task revisions', async () => {
  const draft = await getMr.getMockImplementation()!(mrUrl);
  getMr.mockResolvedValue({
    ...draft,
    state: 'merged',
    draft: false,
    mergeCommitSha: 'target-branch-merge-commit',
  });
  const verified = { ...feature, status: 'verified' as const, completionSource: 'human' as const };
  expect(await gateDraftMrReview('/project', verified)).not.toHaveProperty('status', 'failed');
  expect(await gateDraftMrReview('/project', feature)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('At least one open Draft MR'),
  });
});

it('does not verify a closed MR or a merged MR from a stale revision', async () => {
  const draft = await getMr.getMockImplementation()!(mrUrl);
  const verified = { ...feature, status: 'verified' as const, completionSource: 'human' as const };
  getMr.mockResolvedValue({ ...draft, state: 'closed', draft: false });
  expect(await gateDraftMrReview('/project', verified)).toMatchObject({ status: 'failed' });
  getMr.mockResolvedValue({
    ...draft,
    state: 'merged',
    draft: false,
    sha: 'stale-source-sha',
    mergeCommitSha: 'target-branch-merge-commit',
  });
  expect(await gateDraftMrReview('/project', verified)).toMatchObject({ status: 'failed' });
});

it('rejects a merged subproject if its merge commit differs from the checkout', async () => {
  const draft = await getMr.getMockImplementation()!(rootMr);
  getMr.mockImplementation(async (url) =>
    url === mrUrl
      ? {
          ...draft,
          state: 'merged',
          draft: false,
          sha: 'stale-source-sha',
          mergeCommitSha: 'old-merge',
        }
      : draft
  );
  expect(await gateDraftMrReview('/project', feature)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('merged MR matching the checked-out revision'),
  });
});

const deliveredFeature = (): Feature => ({
  ...feature,
  status: 'verified',
  completionSource: 'human',
  mergeRequests: [mrUrl, rootMr],
  deliveryCompletion: {
    status: 'succeeded',
    updatedAt: '2026-09-21T09:58:52Z',
    steps: [
      { id: 'merge', status: 'succeeded' },
      { id: 'jira', status: 'succeeded' },
      { id: 'preview', status: 'succeeded' },
    ],
  },
});

it('restores confirmed delivery using the same merged revisions and clears the erroneous Draft gate failure', async () => {
  const state = await getMr.getMockImplementation()!(mrUrl);
  getMr.mockResolvedValue({ ...state, state: 'merged', draft: false });
  const result = await gateDraftMrReview('/project', {
    ...deliveredFeature(),
    error: 'Draft MR delivery required before review: An open Draft MR is required',
    executionNotice: {
      kind: 'error',
      source: 'delivery',
      message: 'Draft MR required',
      occurredAt: 'now',
    },
  });
  expect(result).not.toHaveProperty('status');
  expect(result).toMatchObject({ error: undefined, executionNotice: undefined });
  expect(getMr).toHaveBeenCalledTimes(2);
});

it('names the receipt blockers so the notice explains itself', async () => {
  receipt.blockers = ['cvat-backend does not compile', 'no runtime screenshot'];
  const result = await gateDraftMrReview('/project', feature);
  expect(result.executionNotice?.message).toContain(
    'cvat-backend does not compile; no runtime screenshot'
  );
});

it('explains a blocked current run using its receipt summary and blockers before the MR gate', async () => {
  receipt.outcome = 'blocked';
  receipt.summary = '真实 E2E 缺少专用账号和目标空间；浏览器测试未通过。';
  receipt.blockers = [
    'Missing .env.playwright USERNAME/PASSWORD and TENANT_ID/PROJECT_ID.',
    'DatasetCreate/DatasetImport failed; Vitest mock module error.',
  ];
  const result = await gateDraftMrReview('/project', feature);
  expect(result).toMatchObject({ status: 'failed', executionNotice: { source: 'delivery' } });
  expect(result.error).toContain(receipt.summary);
  for (const blocker of receipt.blockers as string[]) expect(result.error).toContain(blocker);
  expect(result.error).not.toContain('Development is not complete; resolve');
  expect(getMr).not.toHaveBeenCalled();
});

it.each([
  { sha: 'different-revision' },
  { sourceBranch: 'other-task' },
  { targetBranch: 'other-target' },
  { state: 'closed' },
])('does not use historical completion to approve changed delivery: %j', async (changes) => {
  const state = await getMr.getMockImplementation()!(mrUrl);
  getMr.mockResolvedValue({ ...state, state: 'merged', draft: false, ...changes });
  expect(await gateDraftMrReview('/project', deliveredFeature())).toMatchObject({
    status: 'failed',
  });
});

it('rejects merged MRs when only some delivery steps succeeded', async () => {
  const state = await getMr.getMockImplementation()!(mrUrl);
  getMr.mockResolvedValue({ ...state, state: 'merged', draft: false });
  const task = deliveredFeature();
  task.deliveryCompletion!.steps[1].status = 'failed';
  expect(await gateDraftMrReview('/project', task)).toMatchObject({ status: 'failed' });
});

it.each([
  ['missing MRs', { changedProjects: [{ name: 'frontend' }], mergeRequests: [] }],
  [
    'partial multi-repository delivery',
    { changedProjects: [{ name: 'frontend', mrUrl }, { name: 'project' }] },
  ],
  ['stale receipt', { runId: 'old-run' }],
  ['another issue', { issueKey: 'AIP-2' }],
  ['blocked delivery', { outcome: 'blocked' }],
  ['unresolved blocker', { blockers: ['Tests failed'] }],
  [
    'untrusted host',
    {
      changedProjects: [{ name: 'frontend', mrUrl: mrUrl.replace('git.example', 'other.example') }],
    },
  ],
])('keeps %s in Needs Attention', async (_name, changes) => {
  Object.assign(receipt, changes);
  expect(await gateDraftMrReview('/project', feature)).toMatchObject({
    status: 'failed',
    executionNotice: { kind: 'error', source: 'delivery' },
  });
});

it.each([
  { draft: false },
  { state: 'closed' },
  { state: 'merged' },
  { sourceBranch: 'another-task' },
  { targetBranch: 'main' },
  { sha: 'old-sha' },
])('rejects a remote MR with invalid delivery state: %j', async (changes) => {
  getMr.mockResolvedValue({
    state: 'opened',
    draft: true,
    sourceBranch: 'fix/aip-1',
    targetBranch: 'dev',
    sha: 'current-sha',
    ...changes,
  });
  expect(await gateDraftMrReview('/project', feature)).toMatchObject({ status: 'failed' });
});

it('does not send credentials to an untrusted receipt URL', async () => {
  receipt.changedProjects = [
    { name: 'frontend', mrUrl: 'https://evil.example/team/frontend/-/merge_requests/1' },
  ];
  await gateDraftMrReview('/project', feature);
  expect(getMr).not.toHaveBeenCalled();
});

it('detects a changed root repository omitted entirely from the receipt', async () => {
  receipt.changedProjects = [{ name: 'frontend', mrUrl }];
  expect(await gateDraftMrReview('/project', feature)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('missing for changed repository project'),
  });
});

it('admits submodule-only delivery without a root MR when the root has no committed changes', async () => {
  receipt.changedProjects = [{ name: 'frontend', mrUrl }];
  receipt.mergeRequests = [mrUrl];
  const normal = vi.mocked(execGitCommand).getMockImplementation()!;
  vi.mocked(execGitCommand).mockImplementation(async (args, cwd) => {
    if (args[0] === 'diff' && cwd === '/project/.worktrees/task') return '';
    return normal(args, cwd);
  });
  expect(await gateDraftMrReview('/project', feature)).toEqual({
    changedProjects: receipt.changedProjects,
    mergeRequests: [mrUrl],
  });
  expect(getMr).toHaveBeenCalledExactlyOnceWith(mrUrl);
});

const sharedStory = {
  ...feature,
  issueType: 'Story',
  epicJiraKey: 'AIP-100',
  jiraInstanceUrl: 'https://jira.example',
} as Feature;
const laterMr = 'https://git.example/team/later/-/merge_requests/3';
const laterStory = {
  ...sharedStory,
  id: 'later',
  jiraKey: 'AIP-2',
  status: 'failed',
  executionRunId: 'later-run',
  dependencies: [feature.id],
  jiraDelivery: {
    issueKey: 'AIP-2',
    branch: feature.branchName,
    worktree: '/project/.worktrees/task',
  },
} as Feature;

function sharedWorktree(later = laterStory, delivery: Record<string, unknown> = {}) {
  const read = vi.mocked(secureFs.readFile).getMockImplementation()!;
  vi.mocked(secureFs.readdir).mockResolvedValue([
    { name: 'later', isDirectory: () => true },
  ] as never);
  vi.mocked(secureFs.readFile).mockImplementation(async (file, ...args) => {
    if (String(file) === '/project/.automaker/features/later/feature.json')
      return JSON.stringify(later);
    if (String(file).endsWith('/jira/later/jira-result.json'))
      return JSON.stringify({
        issueKey: 'AIP-2',
        runId: 'later-run',
        outcome: 'mr_created',
        blockers: ['Later Story tests are blocked'],
        changedProjects: [{ name: 'later', mrUrl: laterMr }],
        ...delivery,
      });
    return read(file, ...args);
  });
  const git = vi.mocked(execGitCommand).getMockImplementation()!;
  vi.mocked(execGitCommand).mockImplementation(async (args, cwd, ...rest) => {
    if (args[0] === 'config')
      return 'submodule.frontend.path frontend\nsubmodule.later.path backend/later\n';
    if (args[0] === 'remote' && cwd.endsWith('/later')) return 'git@git.example:team/later.git';
    return git(args, cwd, ...rest);
  });
}

it('does not charge an earlier Story for a repository delivered by its downstream Story', async () => {
  sharedWorktree();
  expect(await gateDraftMrReview('/project', sharedStory)).toEqual({
    changedProjects: receipt.changedProjects,
    mergeRequests: [mrUrl, rootMr],
  });
  expect(getMr).toHaveBeenCalledWith(laterMr);
});

it('still rejects an unaccounted repository in a shared Epic branch', async () => {
  sharedWorktree(laterStory, { changedProjects: [] });
  expect(await gateDraftMrReview('/project', sharedStory)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('Draft MR missing for changed repository backend/later'),
  });
});

it('does not let a downstream Story replace a root MR omitted by the earlier Story', async () => {
  receipt.changedProjects = [{ name: 'frontend', mrUrl }];
  sharedWorktree(laterStory, { changedProjects: [{ name: 'project', mrUrl: rootMr }] });
  expect(await gateDraftMrReview('/project', sharedStory)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('Draft MR missing for changed repository project'),
  });
});

it('accepts coverage through multiple downstream dependency steps', async () => {
  sharedWorktree({ ...laterStory, dependencies: ['middle'] });
  vi.mocked(secureFs.readdir).mockResolvedValue([
    { name: 'later', isDirectory: () => true },
    { name: 'middle', isDirectory: () => true },
  ] as never);
  const read = vi.mocked(secureFs.readFile).getMockImplementation()!;
  vi.mocked(secureFs.readFile).mockImplementation(async (file, ...args) => {
    if (String(file) === '/project/.automaker/features/middle/feature.json')
      return JSON.stringify({
        ...laterStory,
        id: 'middle',
        dependencies: [feature.id],
        executionRunId: undefined,
      });
    return read(file, ...args);
  });
  expect(await gateDraftMrReview('/project', sharedStory)).not.toHaveProperty('status', 'failed');
  expect(getMr).toHaveBeenCalledWith(laterMr);
});

it.each([
  { epicJiraKey: 'AIP-999' },
  { branchName: 'other-branch' },
  { jiraInstanceUrl: 'https://other-jira.example' },
  { dependencies: [] },
  { jiraDelivery: { ...laterStory.jiraDelivery!, worktree: '/project/another-worktree' } },
  { archive: { reason: 'deferred' } },
  { herdrExecution: { status: 'running' } },
])('does not borrow repository coverage from an unrelated or active Story: %j', async (changes) => {
  sharedWorktree({ ...laterStory, ...changes } as Feature);
  expect(await gateDraftMrReview('/project', sharedStory)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('Draft MR missing for changed repository backend/later'),
  });
});

it.each([
  { runId: 'stale-run' },
  { issueKey: 'AIP-999' },
  { outcome: 'needs_input' },
  { changedProjects: [] },
])(
  'does not borrow repository coverage from an invalid downstream receipt: %j',
  async (changes) => {
    sharedWorktree(laterStory, changes);
    expect(await gateDraftMrReview('/project', sharedStory)).toMatchObject({ status: 'failed' });
  }
);

it('still checks the downstream repository MR revision rather than trusting its receipt', async () => {
  sharedWorktree();
  const state = await getMr.getMockImplementation()!(mrUrl);
  getMr.mockImplementation(async (url) =>
    url === laterMr ? { ...state, sha: 'not-pushed' } : state
  );
  expect(await gateDraftMrReview('/project', sharedStory)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('Push the current later revision'),
  });
});

it.each([{ state: 'closed' }, { sourceBranch: 'another-story' }, { targetBranch: 'other-target' }])(
  'still rejects an invalid downstream MR: %j',
  async (changes) => {
    sharedWorktree();
    const state = await getMr.getMockImplementation()!(mrUrl);
    getMr.mockImplementation(async (url) => (url === laterMr ? { ...state, ...changes } : state));
    expect(await gateDraftMrReview('/project', sharedStory)).toMatchObject({ status: 'failed' });
  }
);

it('does not send credentials to an untrusted downstream receipt URL', async () => {
  const untrusted = laterMr.replace('git.example', 'evil.example');
  sharedWorktree(laterStory, { changedProjects: [{ name: 'later', mrUrl: untrusted }] });
  expect(await gateDraftMrReview('/project', sharedStory)).toMatchObject({ status: 'failed' });
  expect(getMr).not.toHaveBeenCalledWith(untrusted);
});

it('fails closed when GitLab is unavailable', async () => {
  getMr.mockRejectedValue(new Error('GitLab unavailable'));
  expect(await gateDraftMrReview('/project', feature)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('GitLab unavailable'),
  });
});

it('leaves ordinary tasks and active Jira runs alone', async () => {
  expect(await gateDraftMrReview('/project', { ...feature, jiraKey: undefined })).toEqual({});
  expect(await gateDraftMrReview('/project', { ...feature, status: 'in_progress' })).toEqual({});
  expect(getMr).not.toHaveBeenCalled();
});
