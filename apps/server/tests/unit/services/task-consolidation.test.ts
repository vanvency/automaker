import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Feature } from '@automaker/types';
import { findSimilarTasks, taskScope, taskSummary } from '../../../src/services/similar-tasks.js';
import {
  TaskConsolidationService,
  type ConsolidationExternal,
} from '../../../src/services/task-consolidation-service.js';
import type { FeatureLoader } from '../../../src/services/feature-loader.js';
import type { SettingsService } from '../../../src/services/settings-service.js';

const mrUrl = 'https://gitlab.example/group/project/-/merge_requests/1';
const keep: Feature = {
  id: 'keep',
  category: 'Jira',
  title: 'AIP-114859: 审计日志导出',
  description: '知识库操作审计日志导出，确认弹窗、权限检查、导出留痕',
  jiraKey: 'AIP-114859',
  status: 'waiting_approval',
  branchName: 'task/keep',
};
const retire: Feature = {
  id: 'retire',
  category: 'Jira',
  title: 'AIP-114829: 【知识库审计】知识库操作审计日志支持导出',
  description: '知识库操作审计日志导出，查看权限为准',
  jiraKey: 'AIP-114829',
  jiraUrl: 'https://jira.example/browse/AIP-114829',
  status: 'backlog',
  branchName: 'task/retire',
  mergeRequests: [mrUrl],
};

describe('similarity discovery', () => {
  it('keeps the full task description for comparison beyond the similarity excerpt', () => {
    const description = 'Requirement\n'.repeat(2000) + 'Final acceptance criterion';
    expect(taskSummary({ ...keep, description }).description).toBe(description);
    expect(taskScope({ ...keep, description }).length).toBeLessThan(description.length);
  });
  it('compares only independent roots, excluding parents vs children and sibling subtasks', () => {
    const children = [
      { ...retire, id: 'child-a', jiraKey: 'AIP-2', parentFeatureId: keep.id },
      { ...retire, id: 'child-b', jiraKey: 'AIP-3', parentJiraKey: keep.jiraKey },
      { ...retire, id: 'child-c', jiraKey: 'AIP-4', jiraParentKey: keep.jiraKey },
      { ...retire, id: `${keep.id}-child-1`, jiraKey: 'AIP-5' },
      { ...retire, id: 'child-d', jiraKey: 'AIP-6', epicJiraKey: keep.jiraKey },
      { ...retire, id: 'orphan', jiraKey: 'AIP-7', parentFeatureId: 'missing-parent' },
    ];
    const pairs = findSimilarTasks([keep, retire, ...children]);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].left.id, pairs[0].right.id]).toEqual(['keep', 'retire']);
  });
  it('recognizes children through the parent checklist even without child-side metadata', () => {
    const parent = { ...keep, jiraSubtasks: [{ key: 'AIP-2', summary: 'Export UI' }] };
    expect(findSimilarTasks([parent, { ...retire, jiraKey: 'AIP-2' }])).toEqual([]);
  });
  it('finds the supplied audit-export example without declaring coverage automatically', () => {
    const pairs = findSimilarTasks([keep, retire]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].sharedTerms).toContain('导出');
    expect(pairs[0]).not.toHaveProperty('supersededBy');
  });
  it('extracts actual requirements instead of common automation templates', () => {
    const feature = {
      ...keep,
      description:
        'Implement Jira AIP-1\nDelivery: shared instructions\nInitial Jira snapshot:\n' +
        JSON.stringify({ summary: '原始需求', description: '支持CSV导出' }) +
        '\nCommon trailing instructions',
    };
    expect(taskScope(feature)).toBe('原始需求\n支持CSV导出');
    expect(
      findSimilarTasks([
        { ...feature, title: '图片压缩', id: 'a' },
        { ...feature, title: '数据库备份', id: 'b' },
      ])
    ).toHaveLength(0);
  });
  it('does not suggest already-superseded cards', () => {
    expect(
      findSimilarTasks([
        keep,
        {
          ...retire,
          supersededBy: {
            featureId: 'keep',
            reason: 'covered',
            planId: 'p',
            at: 'now',
          },
        },
      ])
    ).toEqual([]);
  });
});

describe('reviewed task cleanup', () => {
  let directory: string;
  let service: TaskConsolidationService;
  let features: Feature[];
  let external: ConsolidationExternal;
  let running: ReturnType<typeof vi.fn>;
  let mrState: string;
  let jiraDone: boolean;
  const settings = {
    getProjectSettings: vi.fn(async () => ({
      jiraSync: { jiraUrl: 'https://jira.example', gitlabHost: 'gitlab.example' },
    })),
  } as unknown as SettingsService;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'task-consolidation-'));
    features = structuredClone([keep, retire]);
    mrState = 'opened';
    jiraDone = false;
    running = vi.fn(async () => []);
    const loader = {
      getAll: vi.fn(async () => structuredClone(features)),
      get: vi.fn(async (_project, id) =>
        structuredClone(features.find((f) => f.id === id) ?? null)
      ),
      update: vi.fn(async (_project, id, updates) => {
        const feature = features.find((f) => f.id === id)!;
        Object.assign(feature, updates);
        return structuredClone(feature);
      }),
    } as unknown as FeatureLoader;
    external = {
      mr: vi.fn(async () => ({
        iid: 1,
        project: 'group/project',
        state: mrState,
        title: 'Draft: export',
        draft: true,
        sourceBranch: 'task/retire',
        targetBranch: 'dev',
        sha: 'commit-a',
        hasConflicts: false,
      })),
      closeMr: vi.fn(async () => {
        mrState = 'closed';
      }),
      jira: vi.fn(async (input) => {
        if (input.action === 'close') jiraDone = true;
        return {
          key: 'AIP-114829',
          url: 'https://jira.example/browse/AIP-114829',
          status: jiraDone ? 'Closed' : 'Open',
          updated: '2026-09-20',
          done: jiraDone,
          transitions: [{ id: 'close-1', name: 'Close', target: 'Closed' }],
        };
      }),
    };
    service = new TaskConsolidationService(loader, settings, directory, running, external);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const plan = () =>
    service.plan(
      '/project',
      'keep',
      'retire',
      'The retained task covers export plus its complete audit flow'
    );
  const choice = { mrUrls: [mrUrl], closeJira: true, transitionId: 'close-1' };

  it('preview is read-only and exposes actual Jira transitions and MR state', async () => {
    const result = await plan();
    expect(result.mergeRequests[0].action).toBe('close');
    expect(result.jira?.transitions[0].id).toBe('close-1');
    expect(external.closeMr).not.toHaveBeenCalled();
    expect(features[1].status).toBe('backlog');
  });
  it('does not expose subtasks in manual selection and refuses their cleanup previews', async () => {
    features.push({ ...retire, id: 'child', jiraKey: 'AIP-2', parentFeatureId: 'keep' });
    const list = await service.list('/project');
    expect(list.tasks.map((task) => task.id)).toEqual(['keep', 'retire']);
    await expect(service.plan('/project', 'keep', 'child', 'same parent scope')).rejects.toThrow(
      'parent tasks'
    );
    expect(external.closeMr).not.toHaveBeenCalled();
  });
  it('requires typed confirmation and rejects altered task snapshots', async () => {
    const p = await plan();
    await expect(service.apply('/project', p.id, choice, 'keep')).rejects.toThrow('exact');
    features[1].description = 'new independent requirement';
    await expect(service.apply('/project', p.id, choice, 'AIP-114829')).rejects.toThrow('changed');
    expect(external.closeMr).not.toHaveBeenCalled();
  });
  it('preserves shared, merged and foreign-host MRs', async () => {
    features[0].mergeRequests = [mrUrl];
    expect((await plan()).mergeRequests[0].action).toBe('preserve');
    delete features[0].mergeRequests;
    mrState = 'merged';
    expect((await plan()).mergeRequests[0].reason).toContain('merged');
    features[1].mergeRequests = ['https://untrusted.example/group/p/-/merge_requests/9'];
    vi.mocked(external.mr).mockClear();
    expect((await plan()).mergeRequests[0].state).toBe('unknown');
    expect(external.mr).not.toHaveBeenCalled();
  });
  it('refuses MRs that became shared or changed after preview', async () => {
    const p = await plan();
    features.push({ ...keep, id: 'sibling', branchName: 'task/retire' });
    await expect(service.apply('/project', p.id, choice, 'AIP-114829')).rejects.toThrow('shared');
    expect(external.closeMr).not.toHaveBeenCalled();
  });
  it('prevents consolidation while either task is running or has dependents', async () => {
    running.mockResolvedValue(['keep']);
    expect((await plan()).blockers[0]).toContain('running');
    const p = await plan();
    await expect(service.apply('/project', p.id, choice, 'AIP-114829')).rejects.toThrow('running');
    running.mockResolvedValue([]);
    features.push({ ...keep, id: 'dependent', dependencies: ['retire'] });
    expect((await plan()).blockers[0]).toContain('depend');
  });
  it('closes only approved resources, then archives the card with coverage attribution', async () => {
    const p = await plan();
    const result = await service.apply('/project', p.id, choice, 'AIP-114829');
    expect(result.status).toBe('complete');
    expect(external.closeMr).toHaveBeenCalledExactlyOnceWith(mrUrl);
    expect(
      vi
        .mocked(external.jira)
        .mock.calls.some(([input]) => input.action === 'close' && input.key === retire.jiraKey)
    ).toBe(true);
    expect(features[1].supersededBy?.featureId).toBe('keep');
    expect(features[1].status).toBe('completed');
    expect(features[0]).toEqual(keep);
    await service.apply('/project', p.id, choice, 'AIP-114829');
    expect(external.closeMr).toHaveBeenCalledOnce();
  });
  it('supports card-only retirement without writing to Jira or GitLab', async () => {
    const p = await plan();
    await service.apply('/project', p.id, { mrUrls: [], closeJira: false }, 'AIP-114829');
    expect(external.closeMr).not.toHaveBeenCalled();
    expect(vi.mocked(external.jira).mock.calls.every(([input]) => input.action === 'inspect')).toBe(
      true
    );
    expect(features[1].supersededBy).toBeDefined();
  });
  it('preserves partial results and safely resumes after a lost Jira response', async () => {
    const p = await plan();
    const normal = external.jira;
    let lost = false;
    external.jira = vi.fn(async (input) => {
      if (input.action === 'close' && !lost) {
        lost = true;
        jiraDone = true;
        throw new Error('response lost');
      }
      return normal(input);
    });
    const first = await service.apply('/project', p.id, choice, 'AIP-114829');
    expect(first.status).toBe('partial');
    expect(features[1].consolidationPlanId).toBe(p.id);
    expect(features[1].supersededBy).toBeUndefined();
    const second = await service.apply('/project', p.id, choice, 'AIP-114829');
    expect(second.status).toBe('complete');
    expect(external.closeMr).toHaveBeenCalledOnce();
    expect(features[1].consolidationPlanId).toBeUndefined();
  });
  it('refuses arbitrary MRs or transition IDs injected into execute requests', async () => {
    const p = await plan();
    await expect(
      service.apply('/project', p.id, { ...choice, mrUrls: ['https://evil'] }, 'AIP-114829')
    ).rejects.toThrow('unapproved');
    await expect(
      service.apply('/project', p.id, { ...choice, transitionId: 'invented' }, 'AIP-114829')
    ).rejects.toThrow('transition');
  });
  it('can cancel unfinished cleanup without undoing already-closed MRs', async () => {
    const p = await plan();
    const original = external.jira;
    external.jira = vi.fn(async (input) => {
      if (input.action === 'close') throw new Error('Jira unavailable');
      return original(input);
    });
    expect((await service.apply('/project', p.id, choice, 'AIP-114829')).status).toBe('partial');
    expect(mrState).toBe('closed');
    expect((await service.cancel('/project', p.id, 'AIP-114829')).status).toBe('cancelled');
    expect(features[1].consolidationPlanId).toBeUndefined();
    expect(features[1].supersededBy).toBeUndefined();
    expect(mrState).toBe('closed');
    await expect(service.apply('/project', p.id, choice, 'AIP-114829')).rejects.toThrow(
      'cancelled'
    );
  });
  it('also checks live herdr conversations not tracked by the Automaker runner', async () => {
    external.busyConversations = vi.fn(async () => true);
    const p = await plan();
    expect(p.blockers.some((message) => message.includes('herdr'))).toBe(true);
    await expect(service.apply('/project', p.id, choice, 'AIP-114829')).rejects.toThrow('herdr');
    expect(external.closeMr).not.toHaveBeenCalled();
  });
  it('rechecks Jira before closing any MR', async () => {
    const p = await plan();
    const original = external.jira;
    external.jira = vi.fn(async (input) => ({
      ...(await original(input)),
      updated: 'newer-version',
    }));
    await expect(service.apply('/project', p.id, choice, 'AIP-114829')).rejects.toThrow(
      'Jira changed'
    );
    expect(external.closeMr).not.toHaveBeenCalled();
  });
});
