import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDelivery, releaseDeliveryPreview } from '../../../src/services/delivery-completion.js';
const { list, stop } = vi.hoisted(() => ({ list: vi.fn(), stop: vi.fn() }));
vi.mock('../../../src/services/worktree-resolver.js', () => ({
  WorktreeResolver: class {
    listWorktrees = list;
  },
}));
vi.mock('../../../src/services/worktree-preview-service.js', () => ({
  worktreePreviewService: { stop },
}));
beforeEach(() => {
  list.mockResolvedValue([{ path: '/p/wt', branch: 'task', isMain: false }]);
  stop.mockReset();
  stop.mockResolvedValue({ status: 'stopped' });
});
describe('delivery preview cleanup', () => {
  it('only stops the preview associated with the task worktree', async () => {
    const loader = {
      getAll: vi.fn(async () => [{ id: 'other', branchName: 'unrelated', status: 'in_progress' }]),
    } as any;
    expect(
      (await releaseDeliveryPreview(loader, '/p', { id: 'f', branchName: 'task' } as any)).status
    ).toBe('succeeded');
    expect(stop).toHaveBeenCalledExactlyOnceWith('/p', '/p/wt');
  });
  it('preserves a preview shared by unfinished work', async () => {
    const loader = {
      getAll: vi.fn(async () => [{ id: 'other', branchName: 'task', status: 'verified' }]),
    } as any;
    expect(
      (await releaseDeliveryPreview(loader, '/p', { id: 'f', branchName: 'task' } as any)).status
    ).toBe('skipped');
    expect(stop).not.toHaveBeenCalled();
  });
  it('reports no managed preview without deleting unrelated resources', async () => {
    stop.mockResolvedValue(null);
    const loader = { getAll: vi.fn(async () => []) } as any;
    const result = await releaseDeliveryPreview(loader, '/p', {
      id: 'f',
      branchName: 'task',
    } as any);
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('外部手工部署');
  });
  it('recognises unassigned and explicitly main-branch tasks as the same worktree', async () => {
    list.mockResolvedValue([{ path: '/p', branch: 'main', isMain: true }]);
    const loader = {
      getAll: vi.fn(async () => [{ id: 'other', status: 'waiting_approval' }]),
    } as any;
    expect(
      (await releaseDeliveryPreview(loader, '/p', { id: 'f', branchName: 'main' } as any)).status
    ).toBe('skipped');
    expect(stop).not.toHaveBeenCalled();
  });
  it('retains confirmed steps and the cleanup error while preparing a retry', () => {
    const previous = {
      status: 'failed',
      updatedAt: 'old',
      steps: [
        { id: 'merge', status: 'succeeded' },
        { id: 'jira', status: 'succeeded' },
        { id: 'preview', status: 'failed', message: 'denied' },
      ],
    } as any;
    const next = newDelivery(previous);
    expect(next.status).toBe('running');
    expect(next.steps).toEqual(previous.steps);
  });

  it('does not fall back to the project root if the task worktree is missing', async () => {
    list.mockResolvedValue([{ path: '/p', branch: 'main', isMain: true }]);
    await expect(
      releaseDeliveryPreview({ getAll: vi.fn() } as any, '/p', {
        id: 'f',
        branchName: 'missing',
      } as any)
    ).rejects.toThrow('找不到任务 worktree');
    expect(stop).not.toHaveBeenCalled();
  });
});
