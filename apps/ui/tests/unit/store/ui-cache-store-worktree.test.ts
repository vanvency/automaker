import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../../src/store/app-store';
import {
  useUICacheStore,
  syncUICache,
  restoreFromUICache,
} from '../../../src/store/ui-cache-store';

function resetUICacheStore() {
  useUICacheStore.setState({
    cachedProjectId: null,
    cachedSidebarOpen: true,
    cachedSidebarStyle: 'unified',
    cachedWorktreePanelCollapsed: false,
    cachedCollapsedNavSections: {},
    cachedCurrentWorktreeByProject: {},
  });
}

describe('ui-cache-store worktree state hardening', () => {
  beforeEach(() => {
    resetUICacheStore();
    useAppStore.setState({ projects: [] as unknown[], currentProject: null });
  });

  it('syncUICache persists only structurally valid worktree entries', () => {
    syncUICache({
      currentWorktreeByProject: {
        '/valid-main': { path: null, branch: 'main' },
        '/valid-feature': { path: '/valid/.worktrees/feature-a', branch: 'feature/a' },
        '/invalid-empty-branch': { path: '/x', branch: '' },
        '/invalid-path-type': { path: 123 as unknown, branch: 'feature/b' } as {
          path: unknown;
          branch: string;
        },
        '/invalid-shape': { path: '/x' } as unknown as { path: string; branch: string },
      },
    });

    expect(useUICacheStore.getState().cachedCurrentWorktreeByProject).toEqual({
      '/valid-main': { path: null, branch: 'main' },
      '/valid-feature': { path: '/valid/.worktrees/feature-a', branch: 'feature/a' },
    });
  });

  it('restoreFromUICache sanitizes worktree map and restores resolved project context', () => {
    useAppStore.setState({
      projects: [{ id: 'project-1', name: 'Project One', path: '/project-1' }] as unknown[],
    });

    useUICacheStore.setState({
      cachedProjectId: 'project-1',
      cachedSidebarOpen: false,
      cachedSidebarStyle: 'discord',
      cachedWorktreePanelCollapsed: true,
      cachedCollapsedNavSections: { a: true },
      cachedCurrentWorktreeByProject: {
        '/valid': { path: '/valid/.worktrees/feature-a', branch: 'feature/a' },
        '/invalid': { path: 123 as unknown, branch: 'feature/b' } as unknown as {
          path: string | null;
          branch: string;
        },
      },
    });

    const appStoreSetState = vi.fn();
    const didRestore = restoreFromUICache(appStoreSetState);

    expect(didRestore).toBe(true);
    expect(appStoreSetState).toHaveBeenCalledTimes(1);

    const restoredState = appStoreSetState.mock.calls[0][0] as Record<string, unknown>;
    expect(restoredState.currentWorktreeByProject).toEqual({
      '/valid': { path: '/valid/.worktrees/feature-a', branch: 'feature/a' },
    });
    expect(restoredState.currentProject).toEqual({
      id: 'project-1',
      name: 'Project One',
      path: '/project-1',
    });
  });

  it('restoreFromUICache returns false when there is no cached project context', () => {
    const appStoreSetState = vi.fn();

    const didRestore = restoreFromUICache(appStoreSetState);

    expect(didRestore).toBe(false);
    expect(appStoreSetState).not.toHaveBeenCalled();
  });

  it('keeps navigation and subscribers working when storage is full, then retries persistence', () => {
    const original = window.Storage.prototype.setItem;
    const writes = vi
      .spyOn(window.Storage.prototype, 'setItem')
      .mockImplementation(function (key, value) {
        if (key === 'automaker-ui-cache') {
          throw new window.DOMException('Storage full', 'QuotaExceededError');
        }
        original.call(this, key, value);
      });
    const unsubscribeCache = useAppStore.subscribe(syncUICache);
    const listener = vi.fn();
    const unsubscribeListener = useAppStore.subscribe(listener);
    const select = useAppStore.getState().setCurrentWorktree;

    try {
      expect(() => select('/quota', '/quota/a', 'branch-a')).not.toThrow();
      expect(() => select('/quota', '/quota/b', 'branch-b')).not.toThrow();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState().getCurrentWorktree('/quota')).toEqual({
        path: '/quota/b',
        branch: 'branch-b',
      });
      expect(useUICacheStore.getState().cachedCurrentWorktreeByProject['/quota']).toEqual({
        path: '/quota/b',
        branch: 'branch-b',
      });

      writes.mockRestore();
      select('/quota', '/quota/c', 'branch-c');
      expect(
        JSON.parse(localStorage.getItem('automaker-ui-cache')!).state
          .cachedCurrentWorktreeByProject['/quota']
      ).toEqual({ path: '/quota/c', branch: 'branch-c' });
    } finally {
      unsubscribeCache();
      unsubscribeListener();
      writes.mockRestore();
    }
  });

  it('tolerates access to localStorage being denied', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new window.DOMException('Denied', 'SecurityError');
    });

    await useUICacheStore.persist.rehydrate();
    expect(useUICacheStore.persist.hasHydrated()).toBe(true);
    expect(() => syncUICache({ sidebarOpen: false })).not.toThrow();
    expect(useUICacheStore.getState().cachedSidebarOpen).toBe(false);
    expect(() => useUICacheStore.persist.clearStorage()).not.toThrow();
  });
});
