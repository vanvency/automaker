import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store/app-store';
import { useRecentWorktreesStore } from '@/store/recent-worktrees-store';
import {
  buildWorktreeCategoryGroups,
  withRecentWorktrees,
} from '@/components/views/board-view/worktree-panel/components/worktree-category-utils';
import type { WorktreeInfo } from '@/components/views/board-view/worktree-panel/types';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => useRecentWorktreesStore.setState({ pathsByProject: {} }));
describe('recent worktree navigation', () => {
  it('keeps five unique visits newest-first, scoped to each project, including main', () => {
    const { visit } = useRecentWorktreesStore.getState();
    for (let i = 1; i <= 6; i++) visit('/project', `/project/w${i}`);
    visit('/project', '/project/w3');
    visit('/other', null);
    expect(useRecentWorktreesStore.getState().pathsByProject).toEqual({
      '/project': ['/project/w3', '/project/w6', '/project/w5', '/project/w4', '/project/w2'],
      '/other': ['/other'],
    });
  });
  it('retains the history across reloads', async () => {
    useRecentWorktreesStore.getState().visit('/project', '/project/w1');
    // Simulate memory being discarded without overwriting persisted storage.
    const saved = localStorage.getItem('automaker-recent-worktrees')!;
    useRecentWorktreesStore.setState({ pathsByProject: {} });
    localStorage.setItem('automaker-recent-worktrees', saved);
    await useRecentWorktreesStore.persist.rehydrate();
    expect(useRecentWorktreesStore.getState().pathsByProject['/project']).toEqual(['/project/w1']);
  });
  it('switches worktrees and keeps recent visits in memory when storage is full', () => {
    const original = Storage.prototype.setItem;
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === 'automaker-recent-worktrees')
        throw new DOMException('Storage full', 'QuotaExceededError');
      original.call(this, key, value);
    });
    const select = useAppStore.getState().setCurrentWorktree;
    expect(() => select('/quota', '/quota/a', 'branch-a')).not.toThrow();
    expect(() => select('/quota', '/quota/b', 'branch-b')).not.toThrow();
    expect(useAppStore.getState().getCurrentWorktree('/quota')).toEqual({
      path: '/quota/b',
      branch: 'branch-b',
    });
    expect(useRecentWorktreesStore.getState().pathsByProject['/quota']).toEqual([
      '/quota/b',
      '/quota/a',
    ]);
    writes.mockRestore();
    select('/quota', '/quota/c', 'branch-c');
    expect(
      JSON.parse(localStorage.getItem('automaker-recent-worktrees')!).state.pathsByProject['/quota']
    ).toEqual(['/quota/c', '/quota/b', '/quota/a']);
  });
  it('never propagates a history failure through the navigation action', () => {
    const original = useRecentWorktreesStore.getState().visit;
    useRecentWorktreesStore.setState({
      visit: () => {
        throw new DOMException('Storage full', 'QuotaExceededError');
      },
    });
    try {
      expect(() =>
        useAppStore
          .getState()
          .setCurrentWorktree('/history-failure', '/history-failure/target', 'target')
      ).not.toThrow();
      expect(useAppStore.getState().getCurrentWorktree('/history-failure')?.branch).toBe('target');
    } finally {
      useRecentWorktreesStore.setState({ visit: original });
    }
  });
  it('tolerates browser storage being inaccessible during hydration and cleanup', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    await expect(
      Promise.resolve(useRecentWorktreesStore.persist.rehydrate())
    ).resolves.toBeUndefined();
    expect(() => useRecentWorktreesStore.persist.clearStorage()).not.toThrow();
  });
  it('respects search, ignores deleted worktrees and does not duplicate entries', () => {
    const trees = ['alpha', 'beta', 'gamma'].map(
      (name) => ({ path: `/project/${name}`, branch: name }) as WorktreeInfo
    );
    const recent = ['/project/deleted', '/project/beta', '/project/alpha'];
    const groups = withRecentWorktrees(buildWorktreeCategoryGroups(trees), recent);
    expect(groups[0].category).toBe('recent');
    expect(groups[0].worktrees.map((tree) => tree.branch)).toEqual(['beta', 'alpha']);
    expect(groups.flatMap((group) => group.worktrees)).toHaveLength(3);
    const filtered = withRecentWorktrees(buildWorktreeCategoryGroups(trees, {}, 'alpha'), recent);
    expect(filtered.flatMap((group) => group.worktrees).map((tree) => tree.branch)).toEqual([
      'alpha',
    ]);
  });
});
