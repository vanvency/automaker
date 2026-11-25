import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DragEndEvent } from '@dnd-kit/core';
import type { Feature } from '@/store/app-store';
import { useBoardDragDrop } from '@/components/views/board-view/hooks/use-board-drag-drop';
import { useBoardColumnFeatures } from '@/components/views/board-view/hooks/use-board-column-features';

function setup(status = 'failed', running = false) {
  const feature = {
    id: 'aip-115486',
    status,
    description: 'Publish description required',
    branchName: 'task',
    error: 'Push the current revision before requesting review.',
    executionNotice: { kind: 'error', source: 'delivery', message: 'Push required' },
  } as Feature;
  const persistFeatureUpdate = vi.fn(async () => {});
  const handleStartImplementation = vi.fn(async () => true);
  const { result, rerender } = renderHook(
    ({ runningTasks, projectPath }) =>
      useBoardDragDrop({
        features: [feature],
        currentProject: { id: 'p', path: projectPath },
        runningAutoTasks: runningTasks,
        persistFeatureUpdate,
        handleStartImplementation,
        stopFeature: vi.fn(),
      }),
    { initialProps: { runningTasks: running ? [feature.id] : [], projectPath: '/p' } }
  );
  const drop = async (target: string) => {
    await act(() =>
      result.current.handleDragEnd({
        active: { id: feature.id },
        over: { id: target },
      } as DragEndEvent)
    );
  };
  const confirm = async () => {
    await act(() => result.current.confirmAttentionMove());
  };
  return {
    feature,
    drop,
    confirm,
    result,
    rerender,
    persistFeatureUpdate,
    handleStartImplementation,
  };
}

describe('moving tasks out of Needs Attention', () => {
  it.each(['failed', 'error', 'merge_conflict', 'interrupted', 'waiting_approval', 'backlog'])(
    'moves %s with an error to Backlog and clears the notice in the persisted payload',
    async (status) => {
      const s = setup(status);
      await s.drop('column-header-backlog');
      expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
      await s.confirm();
      expect(s.persistFeatureUpdate).toHaveBeenCalledExactlyOnceWith(s.feature.id, {
        status: 'backlog',
        error: null,
        executionNotice: null,
      });
      expect(s.handleStartImplementation).not.toHaveBeenCalled();
      const updated = { ...s.feature, ...s.persistFeatureUpdate.mock.calls[0][1] };
      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          features: [updated],
          runningAutoTasks: [],
          runningAutoTasksAllWorktrees: [],
          searchQuery: '',
          currentWorktreePath: '/p/task',
          currentWorktreeBranch: 'task',
          projectPath: '/p',
        })
      );
      expect(result.current.getColumnFeatures('failed')).toEqual([]);
      expect(result.current.getColumnFeatures('backlog').map((f) => f.id)).toEqual([s.feature.id]);
    }
  );

  it('retries through the execution action instead of merely changing status', async () => {
    const s = setup();
    await s.drop('in_progress');
    expect(s.handleStartImplementation).not.toHaveBeenCalled();
    await s.confirm();
    expect(s.handleStartImplementation).toHaveBeenCalledExactlyOnceWith(s.feature);
    expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
  });

  it('sends a human Done decision through the existing server update', async () => {
    const s = setup();
    await s.drop('verified');
    expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
    await s.confirm();
    expect(s.persistFeatureUpdate).toHaveBeenCalledExactlyOnceWith(s.feature.id, {
      status: 'verified',
      completionSource: 'human',
      error: null,
      executionNotice: null,
      attentionOverride: {
        fromStatus: 'failed',
        targetStatus: 'verified',
        acceptedAt: expect.any(String),
        executionRunId: undefined,
        previousError: s.feature.error,
      },
    });
  });

  it('rechecks review when the underlying status was already waiting_approval', async () => {
    const s = setup('waiting_approval');
    await s.drop('waiting_approval');
    await s.confirm();
    expect(s.persistFeatureUpdate).toHaveBeenCalledExactlyOnceWith(s.feature.id, {
      status: 'waiting_approval',
      error: null,
      executionNotice: null,
      attentionOverride: {
        fromStatus: 'waiting_approval',
        targetStatus: 'waiting_approval',
        acceptedAt: expect.any(String),
        executionRunId: undefined,
        previousError: s.feature.error,
      },
    });
  });

  it('cancels without updating or starting execution', async () => {
    const s = setup();
    await s.drop('verified');
    expect(s.result.current.pendingAttentionMove?.targetStatus).toBe('verified');
    act(() => s.result.current.cancelAttentionMove());
    await s.confirm();
    expect(s.result.current.pendingAttentionMove).toBeNull();
    expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
    expect(s.handleStartImplementation).not.toHaveBeenCalled();
  });

  it('rejects a confirmation if the task was archived while the dialog was open', async () => {
    const s = setup();
    await s.drop('verified');
    s.feature.archive = { reason: 'obsolete' } as Feature['archive'];
    await s.confirm();
    expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
    expect(s.result.current.pendingAttentionMove).toBeNull();
  });

  it('rejects a confirmation if execution starts while the dialog is open', async () => {
    const s = setup();
    await s.drop('verified');
    s.rerender({ runningTasks: [s.feature.id], projectPath: '/p' });
    await s.confirm();
    expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
    expect(s.handleStartImplementation).not.toHaveBeenCalled();
  });

  it('clears the pending move when switching projects', async () => {
    const s = setup();
    await s.drop('verified');
    s.rerender({ runningTasks: [], projectPath: '/other' });
    await s.confirm();
    expect(s.result.current.pendingAttentionMove).toBeNull();
    expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
  });

  it('does not dispatch or move a task already running with a stale failure status', async () => {
    const s = setup('failed', true);
    await s.drop('in_progress');
    await s.drop('backlog');
    expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
    expect(s.handleStartImplementation).not.toHaveBeenCalled();
  });

  it('does not let a drag manufacture failure or bypass archive restoration', async () => {
    const s = setup();
    await s.drop('failed');
    s.feature.archive = { reason: 'obsolete' } as Feature['archive'];
    await s.drop('backlog');
    expect(s.persistFeatureUpdate).not.toHaveBeenCalled();
  });
});
