import { expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorktreesView } from '@/components/views/worktrees-view';

const mocks = vi.hoisted(() => ({ api: vi.fn(), refetch: vi.fn() }));
vi.mock('@/lib/api-fetch', () => ({ apiFetch: mocks.api }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/store/app-store', () => ({
  useAppStore: () => ({
    projects: [{ path: '/project', name: 'Demo' }],
    currentProject: { path: '/project', name: 'Demo' },
    setCurrentProject: vi.fn(),
  }),
}));
vi.mock('@/hooks/queries', () => ({
  useWorktreeProgress: () => ({
    data: {
      projects: [],
      rows: ['active', 'later'].map((id) => ({
        path: `/project/.worktrees/${id}`,
        branch: `task/${id}`,
        projectPath: '/project',
        projectName: 'Demo',
        isMain: false,
        stage: 'backlog',
        featureCount: 1,
        feature: { id, title: `Work ${id}` },
        tasks: [{ id, title: `Task ${id}`, stage: 'backlog', childIds: [] }],
        hasChanges: false,
        hasConflicts: false,
        changedFilesCount: 0,
        ahead: 0,
        behind: 0,
        head: null,
        pr: null,
        ...(id === 'later'
          ? { snoozedAt: '2026-09-21T00:00:00Z', snoozeReason: 'Next quarter' }
          : {}),
      })),
    },
    refetch: mocks.refetch,
  }),
  useRunningAgents: () => ({ data: { agents: [] } }),
}));
vi.mock('@/components/views/worktree-preview', () => ({ WorktreePreviewControls: () => null }));

it('manages snoozed work separately and sends branch-scoped snooze and resume requests', async () => {
  mocks.api.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <WorktreesView />
      </TooltipProvider>
    </QueryClientProvider>
  );
  expect(screen.queryByText('Work later')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'More work actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Snoozed Works (1)' }));
  let dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('Work later')).toBeVisible();
  expect(dialog.getByText('Next quarter')).toBeVisible();
  await userEvent.click(dialog.getByRole('button', { name: 'Resume Worktree' }));
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith('/api/worktree/snooze', 'POST', {
      body: {
        projectPath: '/project',
        branchName: 'task/later',
        snoozed: false,
        reason: undefined,
      },
    })
  );
  await userEvent.keyboard('{Escape}');
  await userEvent.click(screen.getByTestId('snooze-worktree-task/active'));
  dialog = within(screen.getByRole('dialog'));
  await userEvent.type(dialog.getByRole('textbox', { name: 'Snooze reason' }), 'Not urgent');
  await userEvent.click(dialog.getByRole('button', { name: 'Snooze Worktree' }));
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith('/api/worktree/snooze', 'POST', {
      body: {
        projectPath: '/project',
        branchName: 'task/active',
        snoozed: true,
        reason: 'Not urgent',
      },
    })
  );
  expect(mocks.refetch).toHaveBeenCalled();
});

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => vi.unstubAllGlobals());
