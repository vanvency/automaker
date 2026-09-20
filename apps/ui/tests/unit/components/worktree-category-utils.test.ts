import { describe, it, expect } from 'vitest';
import {
  buildWorktreeCategoryGroups,
  buildWorktreeSearchText,
  classifyWorktreeCategory,
  getWorktreeFeatures,
  isActiveFeatureStatus,
  isCompleteFeatureStatus,
  matchesWorktreeSearch,
  WORKTREE_CATEGORY_ORDER,
} from '../../../src/components/views/board-view/worktree-panel/components/worktree-category-utils';
import type {
  FeatureInfo,
  WorktreeInfo,
} from '../../../src/components/views/board-view/worktree-panel/types';

function worktree(overrides: Partial<WorktreeInfo> & Pick<WorktreeInfo, 'branch'>): WorktreeInfo {
  return {
    path: `/repo/${overrides.branch}`,
    isMain: false,
    isCurrent: false,
    hasWorktree: true,
    ...overrides,
  };
}

function feature(overrides: Partial<FeatureInfo> & Pick<FeatureInfo, 'id'>): FeatureInfo {
  return { ...overrides };
}

describe('worktree category statuses', () => {
  it('treats running / planning statuses and pipeline steps as active', () => {
    expect(isActiveFeatureStatus('in_progress')).toBe(true);
    expect(isActiveFeatureStatus('Running')).toBe(true);
    expect(isActiveFeatureStatus('pipeline_review')).toBe(true);
    expect(isActiveFeatureStatus('backlog')).toBe(false);
    expect(isActiveFeatureStatus(undefined)).toBe(false);
  });

  it('treats verified / completed / merged as complete', () => {
    expect(isCompleteFeatureStatus('verified')).toBe(true);
    expect(isCompleteFeatureStatus('completed')).toBe(true);
    expect(isCompleteFeatureStatus('MERGED')).toBe(true);
    expect(isCompleteFeatureStatus('waiting_approval')).toBe(false);
  });
});

describe('getWorktreeFeatures', () => {
  it('matches cards by branch name and gives branch-less cards to the main worktree', () => {
    const features = [
      feature({ id: 'f-1', branchName: 'feature/a' }),
      feature({ id: 'f-2', branchName: 'feature/b' }),
      feature({ id: 'f-3' }),
    ];

    expect(
      getWorktreeFeatures(worktree({ branch: 'feature/a' }), features).map((f) => f.id)
    ).toEqual(['f-1']);
    expect(
      getWorktreeFeatures(worktree({ branch: 'main', isMain: true }), features).map((f) => f.id)
    ).toEqual(['f-3']);
  });
});

describe('classifyWorktreeCategory', () => {
  it('marks a worktree with a running agent as 工作中', () => {
    const target = worktree({ branch: 'feature/running' });
    const category = classifyWorktreeCategory(target, {
      isRunning: (candidate) => candidate.branch === 'feature/running',
    });
    expect(category).toBe('working');
  });

  it('marks a worktree whose card is in flight as 工作中', () => {
    const target = worktree({ branch: 'feature/running' });
    const category = classifyWorktreeCategory(target, {
      features: [feature({ id: 'f-1', branchName: 'feature/running', status: 'in_progress' })],
    });
    expect(category).toBe('working');
  });

  it('marks a worktree with a merged PR as 已完成', () => {
    const target = worktree({
      branch: 'feature/merged',
      pr: {
        number: 12,
        url: 'https://example.test/pr/12',
        title: 'Merged work',
        state: 'MERGED',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(classifyWorktreeCategory(target)).toBe('done');
  });

  it('marks a worktree whose cards are all finished as 已完成', () => {
    const target = worktree({ branch: 'feature/done' });
    const category = classifyWorktreeCategory(target, {
      features: [
        feature({ id: 'f-1', branchName: 'feature/done', status: 'verified' }),
        feature({ id: 'f-2', branchName: 'feature/done', status: 'completed' }),
      ],
    });
    expect(category).toBe('done');
  });

  it('keeps a worktree with unfinished cards as 空闲', () => {
    const target = worktree({ branch: 'feature/idle' });
    const category = classifyWorktreeCategory(target, {
      features: [feature({ id: 'f-1', branchName: 'feature/idle', status: 'backlog' })],
    });
    expect(category).toBe('idle');
  });

  it('marks an empty non-main worktree as 新增 but keeps the main worktree 空闲', () => {
    expect(classifyWorktreeCategory(worktree({ branch: 'feature/fresh' }))).toBe('new');
    expect(classifyWorktreeCategory(worktree({ branch: 'main', isMain: true }))).toBe('idle');
  });

  it('uses the unarchived card count when no feature is attached', () => {
    const target = worktree({ branch: 'feature/counted' });
    const category = classifyWorktreeCategory(target, {
      cardCounts: { 'feature/counted': 2 },
    });
    expect(category).toBe('idle');
  });

  it('prefers 工作中 over 已完成 when work restarted on a merged branch', () => {
    const target = worktree({
      branch: 'feature/restarted',
      pr: {
        number: 7,
        url: 'https://example.test/pr/7',
        title: 'Old PR',
        state: 'MERGED',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const category = classifyWorktreeCategory(target, {
      features: [feature({ id: 'f-1', branchName: 'feature/restarted', status: 'in_progress' })],
    });
    expect(category).toBe('working');
  });
});

describe('worktree keyword search', () => {
  const target = worktree({
    branch: 'feature/jira-123',
    pr: {
      number: 99,
      url: 'https://example.test/pr/99',
      title: 'Add keyword search',
      state: 'OPEN',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const features = [
    feature({
      id: 'jira-123',
      branchName: 'feature/jira-123',
      title: 'worktree 切换搜索',
      jiraKey: 'PROJ-123',
    }),
  ];

  it('indexes branch, path, card and PR fields', () => {
    const text = buildWorktreeSearchText(target, features);
    expect(text).toContain('feature/jira-123');
    expect(text).toContain('/repo/feature/jira-123');
    expect(text).toContain('worktree 切换搜索');
    expect(text).toContain('proj-123');
    expect(text).toContain('99');
  });

  it('matches any single field and requires every term to match', () => {
    expect(matchesWorktreeSearch(target, features, 'PROJ-123')).toBe(true);
    expect(matchesWorktreeSearch(target, features, '切换 搜索')).toBe(true);
    expect(matchesWorktreeSearch(target, features, '搜索 missing')).toBe(false);
    expect(matchesWorktreeSearch(target, features, '   ')).toBe(true);
  });
});

describe('buildWorktreeCategoryGroups', () => {
  const worktrees = [
    worktree({ branch: 'feature/running' }),
    worktree({ branch: 'feature/idle' }),
    worktree({ branch: 'feature/fresh' }),
    worktree({
      branch: 'feature/merged',
      pr: {
        number: 3,
        url: 'https://example.test/pr/3',
        title: 'Merged branch',
        state: 'MERGED',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  ];
  const features = [
    feature({
      id: 'f-1',
      branchName: 'feature/running',
      status: 'in_progress',
      title: 'Busy card',
    }),
    feature({ id: 'f-2', branchName: 'feature/idle', status: 'backlog', title: 'Idle card' }),
  ];

  it('groups in 工作中 → 空闲 → 新增 → 已完成 order', () => {
    const groups = buildWorktreeCategoryGroups(worktrees, { features });

    expect(groups.map((group) => group.category)).toEqual(WORKTREE_CATEGORY_ORDER);
    expect(groups.flatMap((group) => group.worktrees.map((wt) => wt.branch))).toEqual([
      'feature/running',
      'feature/idle',
      'feature/fresh',
      'feature/merged',
    ]);
  });

  it('drops empty groups and filters by keyword', () => {
    const groups = buildWorktreeCategoryGroups(worktrees, { features }, 'idle card');

    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe('idle');
    expect(groups[0].label).toBe('空闲');
    expect(groups[0].worktrees.map((wt) => wt.branch)).toEqual(['feature/idle']);
  });

  it('matches a category label so the list can be narrowed to one group', () => {
    const groups = buildWorktreeCategoryGroups(worktrees, { features }, '已完成');

    expect(groups.map((group) => group.category)).toEqual(['done']);
    expect(groups[0].worktrees.map((wt) => wt.branch)).toEqual(['feature/merged']);
  });

  it('returns no group when nothing matches', () => {
    expect(buildWorktreeCategoryGroups(worktrees, { features }, 'does-not-exist')).toEqual([]);
  });
});
