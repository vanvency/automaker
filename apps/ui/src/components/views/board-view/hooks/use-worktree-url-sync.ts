import { useEffect, useRef } from 'react';
import { useRecentWorktreesStore } from '@/store/recent-worktrees-store';

interface WorktreeTarget {
  path: string;
  branch: string;
  isMain?: boolean;
}
interface Options {
  projectPath?: string;
  urlProjectPath?: string;
  urlBranch?: string;
  selectedBranch: string | null;
  worktrees: readonly WorktreeTarget[];
  loading: boolean;
  select: (project: string, path: string | null, branch: string) => void;
  navigate: (project: string, branch: string) => void;
}

/** Apply incoming links before publishing local selections; never echo stale rendered state. */
export function useWorktreeUrlSync({
  projectPath,
  urlProjectPath,
  urlBranch,
  selectedBranch,
  worktrees,
  loading,
  select,
  navigate,
}: Options) {
  const observedUrl = useRef<string | undefined>(undefined);
  const publishedUrls = useRef<string[]>([]);
  const pendingBranch = useRef<string | undefined>(undefined);
  const lastVisit = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!projectPath || loading || (urlProjectPath && urlProjectPath !== projectPath)) return;
    // Record visits even when hydration already restored this selection and no
    // setCurrentWorktree call is needed. Wait for an incoming URL to be applied.
    if (urlBranch && urlBranch !== selectedBranch) return;
    const target = worktrees.find((tree) => tree.branch === selectedBranch);
    if (!target) return;
    const visitKey = JSON.stringify([projectPath, target.path]);
    if (lastVisit.current === visitKey) return;
    lastVisit.current = visitKey;
    try {
      useRecentWorktreesStore.getState().visit(projectPath, target.isMain ? null : target.path);
    } catch {
      // History is optional and must not interrupt opening the board.
    }
  }, [projectPath, urlProjectPath, urlBranch, selectedBranch, worktrees, loading]);
  useEffect(() => {
    if (!projectPath || loading || (urlProjectPath && urlProjectPath !== projectPath)) return;
    const key = (branch?: string | null) => JSON.stringify([projectPath, branch ?? null]);
    const urlKey = key(urlBranch);
    if (observedUrl.current !== urlKey) {
      observedUrl.current = urlKey;
      // A route update initiated by this hook acknowledges the selection; it is
      // not a new request to restore a previous worktree over a newer click.
      const acknowledged = publishedUrls.current.indexOf(urlKey);
      pendingBranch.current = acknowledged >= 0 ? undefined : urlBranch;
      publishedUrls.current =
        acknowledged >= 0 ? publishedUrls.current.slice(acknowledged + 1) : [];
    }
    if (pendingBranch.current) {
      if (!worktrees.length) return;
      const target = worktrees.find((tree) => tree.branch === pendingBranch.current);
      if (!target) {
        pendingBranch.current = undefined;
        return;
      }
      if (selectedBranch !== target.branch) {
        select(projectPath, target.isMain ? null : target.path, target.branch);
        return;
      }
      pendingBranch.current = undefined;
      return;
    }
    if (
      selectedBranch &&
      selectedBranch !== urlBranch &&
      publishedUrls.current.at(-1) !== key(selectedBranch)
    ) {
      publishedUrls.current = [...publishedUrls.current, key(selectedBranch)].slice(-10);
      navigate(projectPath, selectedBranch);
    }
  }, [
    projectPath,
    urlProjectPath,
    urlBranch,
    selectedBranch,
    worktrees,
    loading,
    select,
    navigate,
  ]);
}
