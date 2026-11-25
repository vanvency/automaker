import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

// History is optional: full/disabled browser storage must not break navigation.
// Zustand still keeps the latest visits in memory when persistence fails.
const recentWorktreesStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch (error) {
      if (!(error instanceof globalThis.DOMException) || error.name !== 'QuotaExceededError')
        return;
      // Feature snapshots can fill localStorage; they are refetched from the API.
      // Prefer retaining navigation history over these disposable response caches.
      try {
        for (let index = localStorage.length - 1; index >= 0; index--) {
          const key = localStorage.key(index);
          if (key?.startsWith('automaker:features-cache:')) localStorage.removeItem(key);
        }
        localStorage.setItem(name, value);
      } catch {
        // Keep the in-memory history when browser storage is unavailable.
      }
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // Storage can also be unavailable in private/restricted browser contexts.
    }
  },
};

interface RecentWorktreesState {
  pathsByProject: Record<string, string[]>;
  visit: (projectPath: string, worktreePath: string | null) => void;
}

/** Browser-local navigation history, independent of project/server settings. */
export const useRecentWorktreesStore = create<RecentWorktreesState>()(
  persist(
    (set) => ({
      pathsByProject: {},
      visit: (projectPath, worktreePath) => {
        const path = worktreePath ?? projectPath;
        set((state) => {
          // Another tab may have visited work since this store was hydrated.
          // Read the latest persisted history before replacing the shared key.
          let stored: Record<string, string[]> = {};
          try {
            const raw = recentWorktreesStorage.getItem('automaker-recent-worktrees');
            if (typeof raw === 'string') {
              const parsed = JSON.parse(raw)?.state?.pathsByProject;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                stored = Object.fromEntries(
                  Object.entries(parsed).filter(
                    (entry): entry is [string, string[]] =>
                      Array.isArray(entry[1]) && entry[1].every((item) => typeof item === 'string')
                  )
                );
              }
            }
          } catch {
            // A corrupt cache must not prevent navigation.
          }
          const previous = [
            ...(stored[projectPath] ?? []),
            ...(state.pathsByProject[projectPath] ?? []),
          ];
          return {
            pathsByProject: {
              ...state.pathsByProject,
              ...stored,
              [projectPath]: [...new Set([path, ...previous])].slice(0, 5),
            },
          };
        });
      },
    }),
    {
      name: 'automaker-recent-worktrees',
      storage: createJSONStorage(() => recentWorktreesStorage),
      partialize: (state) => ({ pathsByProject: state.pathsByProject }),
    }
  )
);
