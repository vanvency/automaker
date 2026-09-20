/**
 * Worktrees Query Hooks
 *
 * React Query hooks for fetching worktree data.
 */

import { useQuery } from '@tanstack/react-query';
import { getElectronAPI } from '@/lib/electron';
import { queryKeys } from '@/lib/query-keys';
import { STALE_TIMES } from '@/lib/query-client';
import { createSmartPollingInterval } from '@/hooks/use-event-recency';
import type { WorktreeProgressItem } from '@automaker/types';

const WORKTREE_REFETCH_ON_FOCUS = false;
const WORKTREE_REFETCH_ON_RECONNECT = false;
const WORKTREES_POLLING_INTERVAL = 30000;
const WORKTREE_PROGRESS_POLLING_INTERVAL = 30000;

interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
  hasChanges?: boolean;
  changedFilesCount?: number;
  featureId?: string;
  linkedToBranch?: string;
  /** Whether a merge, rebase, or cherry-pick is in progress with conflicts */
  hasConflicts?: boolean;
  /** Type of conflict operation in progress */
  conflictType?: 'merge' | 'rebase' | 'cherry-pick';
  /** List of files with conflicts */
  conflictFiles?: string[];
  /** The branch that is the source of the conflict (e.g. the branch being merged in) */
  conflictSourceBranch?: string;
}

interface RemovedWorktree {
  path: string;
  branch: string;
}

interface WorktreesResult {
  worktrees: WorktreeInfo[];
  removedWorktrees: RemovedWorktree[];
}

/**
 * Fetch all worktrees for a project
 *
 * @param projectPath - Path to the project
 * @param includeDetails - Whether to include detailed info (default: true)
 * @returns Query result with worktrees array and removed worktrees
 *
 * @example
 * ```tsx
 * const { data, isLoading, refetch } = useWorktrees(currentProject?.path);
 * const worktrees = data?.worktrees ?? [];
 * ```
 */
export function useWorktrees(projectPath: string | undefined, includeDetails = true) {
  return useQuery({
    queryKey: queryKeys.worktrees.all(projectPath ?? ''),
    queryFn: async (): Promise<WorktreesResult> => {
      if (!projectPath) throw new Error('No project path');
      const api = getElectronAPI();
      if (!api.worktree) {
        throw new Error('Worktree API not available');
      }
      const result = await api.worktree.listAll(projectPath, includeDetails);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch worktrees');
      }
      return {
        worktrees: result.worktrees ?? [],
        removedWorktrees: result.removedWorktrees ?? [],
      };
    },
    enabled: !!projectPath,
    staleTime: STALE_TIMES.WORKTREES,
    refetchInterval: createSmartPollingInterval(WORKTREES_POLLING_INTERVAL),
    refetchOnWindowFocus: WORKTREE_REFETCH_ON_FOCUS,
    refetchOnReconnect: WORKTREE_REFETCH_ON_RECONNECT,
  });
}

/**
 * Fetch worktree info for a specific feature
 *
 * @param projectPath - Path to the project
 * @param featureId - ID of the feature
 * @returns Query result with worktree info
 */
export function useWorktreeInfo(projectPath: string | undefined, featureId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.worktrees.single(projectPath ?? '', featureId ?? ''),
    queryFn: async () => {
      if (!projectPath || !featureId) throw new Error('Missing project path or feature ID');
      const api = getElectronAPI();
      if (!api.worktree) {
        throw new Error('Worktree API not available');
      }
      const result = await api.worktree.getInfo(projectPath, featureId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch worktree info');
      }
      return result;
    },
    enabled: !!projectPath && !!featureId,
    staleTime: STALE_TIMES.WORKTREES,
    refetchOnWindowFocus: WORKTREE_REFETCH_ON_FOCUS,
    refetchOnReconnect: WORKTREE_REFETCH_ON_RECONNECT,
  });
}

/**
 * Fetch worktree status for a specific feature
 *
 * @param projectPath - Path to the project
 * @param featureId - ID of the feature
 * @returns Query result with worktree status
 */
export function useWorktreeStatus(projectPath: string | undefined, featureId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.worktrees.status(projectPath ?? '', featureId ?? ''),
    queryFn: async () => {
      if (!projectPath || !featureId) throw new Error('Missing project path or feature ID');
      const api = getElectronAPI();
      if (!api.worktree) {
        throw new Error('Worktree API not available');
      }
      const result = await api.worktree.getStatus(projectPath, featureId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch worktree status');
      }
      return result;
    },
    enabled: !!projectPath && !!featureId,
    staleTime: STALE_TIMES.WORKTREES,
    refetchOnWindowFocus: WORKTREE_REFETCH_ON_FOCUS,
    refetchOnReconnect: WORKTREE_REFETCH_ON_RECONNECT,
  });
}

/**
 * Fetch worktree diffs for a specific feature
 *
 * @param projectPath - Path to the project
 * @param featureId - ID of the feature
 * @returns Query result with files and diff content
 */
export function useWorktreeDiffs(
  projectPath: string | undefined,
  featureId: string | undefined,
  options?: { taskScope?: 'auto' | 'branch' }
) {
  const taskScope = options?.taskScope ?? 'auto';
  return useQuery({
    queryKey: [
      ...queryKeys.worktrees.diffs(projectPath ?? '', featureId ?? ''),
      { taskScope },
    ] as const,
    queryFn: async () => {
      if (!projectPath || !featureId) throw new Error('Missing project path or feature ID');
      const api = getElectronAPI();
      if (!api.worktree) {
        throw new Error('Worktree API not available');
      }
      const result = await api.worktree.getDiffs(projectPath, featureId, { taskScope });
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch diffs');
      }
      return {
        files: result.files ?? [],
        diff: result.diff ?? '',
        ...(result.mergeState ? { mergeState: result.mergeState } : {}),
        ...(result.submodules && result.submodules.length > 0
          ? { submodules: result.submodules }
          : {}),
        ...(result.scope ? { scope: result.scope } : {}),
      };
    },
    enabled: !!projectPath && !!featureId,
    staleTime: STALE_TIMES.WORKTREES,
    refetchOnWindowFocus: WORKTREE_REFETCH_ON_FOCUS,
    refetchOnReconnect: WORKTREE_REFETCH_ON_RECONNECT,
  });
}

interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommit?: string;
  upstream?: string;
}

interface BranchesResult {
  branches: BranchInfo[];
  aheadCount: number;
  behindCount: number;
  hasRemoteBranch: boolean;
  hasAnyRemotes: boolean;
  isGitRepo: boolean;
  hasCommits: boolean;
  /** The name of the remote that the current branch is tracking (e.g. "origin"), if any */
  trackingRemote?: string;
  /** List of remote names that have a branch matching the current branch name */
  remotesWithBranch?: string[];
}

/**
 * Fetch available branches for a worktree
 *
 * @param worktreePath - Path to the worktree
 * @param includeRemote - Whether to include remote branches
 * @returns Query result with branches, ahead/behind counts, and git repo status
 */
export function useWorktreeBranches(worktreePath: string | undefined, includeRemote = false) {
  return useQuery({
    // Include includeRemote in query key so different configurations have separate caches
    queryKey: queryKeys.worktrees.branches(worktreePath ?? '', includeRemote),
    queryFn: async (): Promise<BranchesResult> => {
      if (!worktreePath) throw new Error('No worktree path');
      const api = getElectronAPI();
      if (!api.worktree) {
        throw new Error('Worktree API not available');
      }
      const result = await api.worktree.listBranches(worktreePath, includeRemote);

      // Handle special git status codes
      if (result.code === 'NOT_GIT_REPO') {
        return {
          branches: [],
          aheadCount: 0,
          behindCount: 0,
          hasRemoteBranch: false,
          hasAnyRemotes: false,
          isGitRepo: false,
          hasCommits: false,
        };
      }
      if (result.code === 'NO_COMMITS') {
        return {
          branches: [],
          aheadCount: 0,
          behindCount: 0,
          hasRemoteBranch: false,
          hasAnyRemotes: result.result?.hasAnyRemotes ?? false,
          isGitRepo: true,
          hasCommits: false,
        };
      }

      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch branches');
      }

      return {
        branches: result.result?.branches ?? [],
        aheadCount: result.result?.aheadCount ?? 0,
        behindCount: result.result?.behindCount ?? 0,
        hasRemoteBranch: result.result?.hasRemoteBranch ?? false,
        hasAnyRemotes: result.result?.hasAnyRemotes ?? false,
        isGitRepo: true,
        hasCommits: true,
        trackingRemote: result.result?.trackingRemote,
        remotesWithBranch: (result.result as { remotesWithBranch?: string[] })?.remotesWithBranch,
      };
    },
    enabled: !!worktreePath,
    staleTime: STALE_TIMES.WORKTREES,
    refetchOnWindowFocus: WORKTREE_REFETCH_ON_FOCUS,
    refetchOnReconnect: WORKTREE_REFETCH_ON_RECONNECT,
  });
}

/**
 * Fetch init script for a project
 *
 * @param projectPath - Path to the project
 * @returns Query result with init script content
 */
export function useWorktreeInitScript(projectPath: string | undefined) {
  return useQuery({
    queryKey: queryKeys.worktrees.initScript(projectPath ?? ''),
    queryFn: async () => {
      if (!projectPath) throw new Error('No project path');
      const api = getElectronAPI();
      if (!api.worktree) {
        throw new Error('Worktree API not available');
      }
      const result = await api.worktree.getInitScript(projectPath);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch init script');
      }
      return {
        exists: result.exists ?? false,
        content: result.content ?? '',
      };
    },
    enabled: !!projectPath,
    staleTime: STALE_TIMES.SETTINGS,
    refetchOnWindowFocus: WORKTREE_REFETCH_ON_FOCUS,
    refetchOnReconnect: WORKTREE_REFETCH_ON_RECONNECT,
  });
}

/**
 * Fetch available editors
 *
 * @returns Query result with available editors
 */
export function useAvailableEditors() {
  return useQuery({
    queryKey: queryKeys.worktrees.editors(),
    queryFn: async () => {
      const api = getElectronAPI();
      if (!api.worktree) {
        throw new Error('Worktree API not available');
      }
      const result = await api.worktree.getAvailableEditors();
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch editors');
      }
      return result.result?.editors ?? [];
    },
    staleTime: STALE_TIMES.CLI_STATUS,
    refetchOnWindowFocus: WORKTREE_REFETCH_ON_FOCUS,
    refetchOnReconnect: WORKTREE_REFETCH_ON_RECONNECT,
  });
}

/** A progress row tagged with the project it belongs to (the view spans projects). */
export interface WorktreeProgressRow extends WorktreeProgressItem {
  projectPath: string;
  projectName: string;
}

/** Per-project metadata of a progress query, used to show the reference branch. */
export interface WorktreeProgressProjectInfo {
  projectPath: string;
  projectName: string;
  baseBranch: string | null;
  generatedAt: string | null;
  error?: string;
}

export interface WorktreeProgressData {
  rows: WorktreeProgressRow[];
  projects: WorktreeProgressProjectInfo[];
}

export interface WorktreeProgressProject {
  path: string;
  name: string;
}

/**
 * Fetch aggregated worktree progress for one or more projects.
 *
 * Each project is fetched in parallel and rows are merged into a single list so
 * the view can show every worktree at once. A project that fails (for example a
 * folder that is no longer a git repository) only adds an `error` entry.
 *
 * @param projects - Projects to include
 * @param enabled - Set to false to skip fetching (e.g. no project selected)
 *
 * @example
 * ```tsx
 * const { data, isLoading } = useWorktreeProgress(projects);
 * const rows = data?.rows ?? [];
 * ```
 */
export function useWorktreeProgress(projects: WorktreeProgressProject[], enabled = true) {
  const paths = projects.map((project) => project.path).filter(Boolean);
  const names = new Map(projects.map((project) => [project.path, project.name]));

  return useQuery({
    queryKey: queryKeys.worktrees.progress(paths.join('|')),
    queryFn: async (): Promise<WorktreeProgressData> => {
      const api = getElectronAPI();
      if (!api.worktree?.progress) {
        throw new Error('Worktree progress API not available');
      }

      const results = await Promise.all(
        paths.map(async (projectPath) => {
          const projectName = names.get(projectPath) ?? projectPath;
          try {
            const result = await api.worktree!.progress!(projectPath);
            if (!result.success) {
              return { projectPath, projectName, error: result.error ?? 'Request failed' } as const;
            }
            return {
              projectPath,
              projectName,
              baseBranch: result.baseBranch ?? null,
              generatedAt: result.generatedAt ?? null,
              worktrees: result.worktrees ?? [],
              error: undefined,
            } as const;
          } catch (error) {
            return {
              projectPath,
              projectName,
              error: error instanceof Error ? error.message : String(error),
            } as const;
          }
        })
      );

      if (results.every((result) => result.error)) {
        throw new Error(results[0]?.error ?? 'Failed to load worktree progress');
      }

      const rows: WorktreeProgressRow[] = [];
      for (const result of results) {
        if (result.error) continue;
        for (const worktree of result.worktrees ?? []) {
          rows.push({
            ...worktree,
            projectPath: result.projectPath,
            projectName: result.projectName,
          });
        }
      }

      return {
        rows,
        projects: results.map((result) => ({
          projectPath: result.projectPath,
          projectName: result.projectName,
          baseBranch: 'baseBranch' in result ? (result.baseBranch ?? null) : null,
          generatedAt: 'generatedAt' in result ? (result.generatedAt ?? null) : null,
          error: result.error,
        })),
      };
    },
    enabled: enabled && paths.length > 0,
    staleTime: STALE_TIMES.WORKTREES,
    refetchInterval: createSmartPollingInterval(WORKTREE_PROGRESS_POLLING_INTERVAL),
    refetchOnWindowFocus: WORKTREE_REFETCH_ON_FOCUS,
    refetchOnReconnect: WORKTREE_REFETCH_ON_RECONNECT,
  });
}
