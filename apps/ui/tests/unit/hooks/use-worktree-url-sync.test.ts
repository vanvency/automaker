import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorktreeUrlSync } from '@/components/views/board-view/hooks/use-worktree-url-sync';
const trees = [
  { path: '/p/859', branch: 'AIP-114859' },
  { path: '/p/830', branch: 'AIP-114830' },
  { path: '/p/448', branch: 'AIP-115448' },
];
function setup(urlBranch = 'AIP-114830', selectedBranch = 'AIP-114859') {
  return {
    projectPath: '/p',
    urlProjectPath: '/p',
    urlBranch,
    selectedBranch,
    worktrees: trees,
    loading: false,
    select: vi.fn(),
    navigate: vi.fn(),
  };
}
describe('worktree URL and selection synchronization', () => {
  it('does not navigate back to 114859 while applying an incoming task link', () => {
    const options = setup();
    const { rerender } = renderHook(useWorktreeUrlSync, { initialProps: options });
    expect(options.select).toHaveBeenCalledWith('/p', '/p/830', 'AIP-114830');
    expect(options.navigate).not.toHaveBeenCalled();
    rerender({ ...options, selectedBranch: 'AIP-114830' });
    expect(options.navigate).not.toHaveBeenCalled();
    rerender({ ...options, selectedBranch: 'AIP-115448' });
    expect(options.navigate).toHaveBeenCalledExactlyOnceWith('/p', 'AIP-115448');
  });
  it('waits for the requested project and worktrees instead of publishing old selections', () => {
    const options = setup();
    const { rerender } = renderHook(useWorktreeUrlSync, {
      initialProps: { ...options, projectPath: '/old', worktrees: [] },
    });
    expect(options.navigate).not.toHaveBeenCalled();
    rerender({ ...options, worktrees: [] });
    expect(options.navigate).not.toHaveBeenCalled();
    rerender(options);
    expect(options.select).toHaveBeenCalledExactlyOnceWith('/p', '/p/830', 'AIP-114830');
  });
  it('does not restore a delayed URL acknowledgement over a more recent manual click', () => {
    const options = setup('AIP-114859');
    const { rerender } = renderHook(useWorktreeUrlSync, { initialProps: options });
    rerender({ ...options, selectedBranch: 'AIP-114830' });
    rerender({ ...options, urlBranch: 'AIP-114830', selectedBranch: 'AIP-115448' });
    expect(options.select).not.toHaveBeenCalled();
    expect(options.navigate).toHaveBeenLastCalledWith('/p', 'AIP-115448');
  });
  it('restores an external link after manual switching and supports browser navigation', () => {
    const options = setup('AIP-114859');
    const { rerender } = renderHook(useWorktreeUrlSync, { initialProps: options });
    rerender({ ...options, selectedBranch: 'AIP-114830' });
    rerender({ ...options, urlBranch: 'AIP-114830', selectedBranch: 'AIP-114830' });
    rerender({ ...options, urlBranch: 'AIP-115448', selectedBranch: 'AIP-114830' });
    expect(options.select).toHaveBeenLastCalledWith('/p', '/p/448', 'AIP-115448');
  });
  it('keeps the latest choice when several route updates are still in flight', () => {
    const options = setup('AIP-114859');
    const { rerender } = renderHook(useWorktreeUrlSync, { initialProps: options });
    rerender({ ...options, selectedBranch: 'AIP-114830' });
    rerender({ ...options, selectedBranch: 'AIP-115448' });
    rerender({ ...options, urlBranch: 'AIP-114830', selectedBranch: 'AIP-115448' });
    expect(options.select).not.toHaveBeenCalled();
    expect(options.navigate).toHaveBeenCalledTimes(2);
    rerender({ ...options, urlBranch: 'AIP-115448', selectedBranch: 'AIP-115448' });
    expect(options.select).not.toHaveBeenCalled();
  });
});
