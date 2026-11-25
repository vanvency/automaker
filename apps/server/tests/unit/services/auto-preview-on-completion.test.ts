import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoPreviewOnCompletion } from '../../../src/services/auto-preview-on-completion.js';
import type { EventEmitter } from '../../../src/lib/events.js';
import type { FeatureLoader } from '../../../src/services/feature-loader.js';
import type { WorktreeResolver } from '../../../src/services/worktree-resolver.js';
import type { WorktreePreviewService } from '../../../src/services/worktree-preview-service.js';

afterEach(() => vi.useRealTimers());

describe('automatic task preview', () => {
  it('deploys a completed task with a configured worktree once and ignores later verification', async () => {
    vi.useFakeTimers();
    let notify!: Parameters<EventEmitter['subscribe']>[0];
    const events = {
      subscribe: vi.fn((handler: typeof notify) => {
        notify = handler;
        return () => {};
      }),
    } as unknown as EventEmitter;
    const feature = {
      id: 'task',
      status: 'waiting_approval',
      branchName: 'feat/task',
      lastExecutionCompletedAt: '2026-11-07T09:00:00Z',
    };
    const features = { get: vi.fn(async () => feature) };
    const worktrees = { findWorktreeForBranch: vi.fn(async () => '/project/.worktrees/task') };
    const previews = {
      config: vi.fn(async () => ({ enabled: true })),
      status: vi.fn(async () => ({
        preview: { status: 'ready', deploymentStartedAt: '2026-11-07T08:00:00Z' },
      })),
      start: vi.fn(async () => ({ status: 'deploying' })),
    };
    new AutoPreviewOnCompletion(
      events,
      features as unknown as FeatureLoader,
      worktrees as unknown as WorktreeResolver,
      previews as unknown as WorktreePreviewService
    );
    notify('auto-mode:event', {
      type: 'feature_status_changed',
      projectPath: '/project',
      featureId: 'task',
      status: 'waiting_approval',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(previews.start).toHaveBeenCalledWith('/project', '/project/.worktrees/task');

    feature.status = 'verified';
    previews.status.mockResolvedValue({
      preview: { status: 'ready', deploymentStartedAt: '2026-11-07T09:00:01Z' },
    });
    notify('auto-mode:event', {
      type: 'feature_status_changed',
      projectPath: '/project',
      featureId: 'task',
      status: 'verified',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(previews.start).toHaveBeenCalledTimes(1);
  });

  it('waits for an existing deployment before deploying a newer completed run', async () => {
    vi.useFakeTimers();
    let notify!: Parameters<EventEmitter['subscribe']>[0];
    const events = {
      subscribe: vi.fn((handler: typeof notify) => {
        notify = handler;
        return () => {};
      }),
    } as unknown as EventEmitter;
    const features = {
      get: vi.fn(async () => ({
        id: 'task',
        status: 'waiting_approval',
        branchName: 'feat/task',
        lastExecutionCompletedAt: '2026-11-07T10:00:00Z',
      })),
    };
    const previews = {
      config: vi.fn(async () => ({ enabled: true })),
      status: vi
        .fn()
        .mockResolvedValueOnce({ preview: { status: 'deploying' } })
        .mockResolvedValue({
          preview: { status: 'ready', deploymentStartedAt: '2026-11-07T09:00:00Z' },
        }),
      start: vi.fn(async () => ({ status: 'deploying' })),
    };
    new AutoPreviewOnCompletion(
      events,
      features as unknown as FeatureLoader,
      {
        findWorktreeForBranch: vi.fn(async () => '/project/worktree'),
      } as unknown as WorktreeResolver,
      previews as unknown as WorktreePreviewService
    );
    notify('auto-mode:event', {
      type: 'feature_status_changed',
      projectPath: '/project',
      featureId: 'task',
      status: 'waiting_approval',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(previews.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(previews.start).toHaveBeenCalledOnce();
  });
});
