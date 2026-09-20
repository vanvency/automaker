import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useBoardColumnFeatures } from '@/components/views/board-view/hooks/use-board-column-features';
import { useAppStore, type Feature } from '@/store/app-store';
const feature = {
  id: 'aip-115448',
  title: 'AIP-115448',
  description: 'Login autofill',
  status: 'waiting_approval',
  branchName: 'bugfix/aip-115448-dodo',
  error: 'Acceptance evidence could not be imported: Invalid acceptance screenshot timestamp',
} as Feature;
const options = {
  features: [feature],
  runningAutoTasks: [],
  runningAutoTasksAllWorktrees: [],
  searchQuery: '',
  currentWorktreePath: '/project/wt',
  currentWorktreeBranch: feature.branchName!,
  projectPath: '/project',
};
afterEach(() => useAppStore.setState({ recentlyCompletedFeatures: new Set() }));
describe('completed runs awaiting attention remain visible', () => {
  it('shows an evidence import failure even after a run completion event', () => {
    useAppStore.setState({ recentlyCompletedFeatures: new Set([feature.id]) });
    const { result } = renderHook(() => useBoardColumnFeatures(options));
    expect(result.current.getColumnFeatures('failed').map((f: Feature) => f.id)).toEqual([
      feature.id,
    ]);
  });
  it('still scopes attention cards to their own worktree', () => {
    useAppStore.setState({ recentlyCompletedFeatures: new Set([feature.id]) });
    const { result } = renderHook(() =>
      useBoardColumnFeatures({ ...options, currentWorktreeBranch: 'other' })
    );
    expect(result.current.getColumnFeatures('failed')).toEqual([]);
  });
  it('keeps an actively retried task in In Progress rather than hiding it', () => {
    useAppStore.setState({ recentlyCompletedFeatures: new Set([feature.id]) });
    const { result } = renderHook(() =>
      useBoardColumnFeatures({ ...options, runningAutoTasksAllWorktrees: [feature.id] })
    );
    expect(result.current.getColumnFeatures('failed')).toEqual([]);
    expect(result.current.getColumnFeatures('in_progress').map((f: Feature) => f.id)).toEqual([
      feature.id,
    ]);
  });
});
