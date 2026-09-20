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
    } catch {
      // Keep the in-memory history; retry persistence on the next visit.
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
          const previous = state.pathsByProject[projectPath] ?? [];
          if (previous[0] === path) return state;
          return {
            pathsByProject: {
              ...state.pathsByProject,
              [projectPath]: [path, ...previous.filter((item) => item !== path)].slice(0, 5),
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
