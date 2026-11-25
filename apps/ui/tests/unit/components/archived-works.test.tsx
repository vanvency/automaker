import { expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorktreesView } from '@/components/views/worktrees-view';

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  agents: [] as { featureId: string }[],
  copy: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/clipboard-utils', () => ({ writeToClipboard: mocks.copy }));
vi.mock('@/store/app-store', () => ({
  useAppStore: () => ({
    projects: [{ path: '/project', name: 'Demo' }],
    currentProject: { path: '/project', name: 'Demo' },
    setCurrentProject: vi.fn(),
  }),
}));
vi.mock('@/hooks/queries', () => ({
  useWorktreeProgress: () => ({ data: { rows: mocks.rows, projects: [] }, refetch: vi.fn() }),
  useRunningAgents: () => ({ data: { agents: mocks.agents } }),
}));
vi.mock('@/components/views/worktree-preview', () => ({ WorktreePreviewControls: () => null }));

it('separates Done archives from active work, keeps live agents visible, and searches released history', async () => {
  const row = (id: string, archived = false) => ({
    path: `/project/.worktrees/${id}`,
    branch: `task/${id}`,
    projectPath: '/project',
    projectName: 'Demo',
    isMain: false,
    stage: 'complete',
    featureCount: 1,
    feature: { id, title: `Work ${id}` },
    tasks: [{ id, title: `Task ${id}`, stage: 'complete', childIds: [] }],
    counts: { total: 1, completed: 1, running: 0, waiting: 0, failed: 0, backlog: 0 },
    hasChanges: false,
    hasConflicts: false,
    changedFilesCount: 0,
    ahead: 0,
    behind: 0,
    head: null,
    pr: null,
    ...(archived
      ? {
          doneAt: '2026-09-01T00:00:00Z',
          archivedAt: '2026-09-08T00:00:00Z',
          checkoutMissing: true,
        }
      : {}),
  });
  mocks.rows = [row('recent'), row('old', true), row('running', true)];
  mocks.agents = [{ featureId: 'running' }];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <WorktreesView />
      </TooltipProvider>
    </QueryClientProvider>
  );
  expect(screen.getByText('Work recent')).toBeVisible();
  expect(screen.getByText('Work running')).toBeVisible();
  expect(screen.queryByText('Work old')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'More work actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Archived Works (1)' }));
  const dialog = within(screen.getByTestId('archived-works-dialog'));
  expect(dialog.getByText('Work old')).toBeVisible();
  expect(dialog.getByText('Done', { exact: true })).toBeVisible();
  expect(dialog.getByText(/Local checkout released/)).toBeVisible();
  expect(dialog.queryByText('Work recent')).not.toBeInTheDocument();
  expect(dialog.queryByText('Work running')).not.toBeInTheDocument();
  await userEvent.type(dialog.getByRole('textbox', { name: 'Search archived works' }), 'no match');
  expect(dialog.getByText('No matching archived works.')).toBeVisible();
});

it('copies the displayed Jira ID in card and table views without opening the task', async () => {
  mocks.copy.mockResolvedValue(true);
  mocks.rows = ['linked', 'unlinked'].map((id) => ({
    path: `/project/.worktrees/${id}`,
    branch: `task/${id}`,
    projectPath: '/project',
    projectName: 'Demo',
    stage: 'backlog',
    isMain: false,
    featureCount: 1,
    feature: { id, title: id, ...(id === 'linked' ? { jiraKey: 'AIP-115473' } : {}) },
    tasks: [],
    head: null,
    pr: null,
    ahead: 0,
    behind: 0,
    changedFilesCount: 0,
  }));
  mocks.agents = [];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <WorktreesView />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  for (const name of ['Backlog', 'In Progress', 'Needs Attention', 'Waiting Review', 'Done']) {
    const heading = screen.getByRole('heading', { name, exact: true });
    expect(heading.parentElement?.querySelector('svg')).toBeInTheDocument();
  }
  const card = within(screen.getByTestId('task-card-task/linked'));
  await user.click(card.getByRole('button', { name: 'Copy Jira ID' }));
  expect(mocks.copy).toHaveBeenLastCalledWith('AIP-115473');
  expect(mocks.navigate).not.toHaveBeenCalled();
  card.getByRole('button', { name: 'Copy Jira ID' }).focus();
  await user.keyboard('{Enter}');
  expect(mocks.copy).toHaveBeenCalledTimes(2);
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(
    within(screen.getByTestId('task-card-task/unlinked')).queryByRole('button', {
      name: 'Copy Jira ID',
    })
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Table view' }));
  const buttons = screen.getAllByRole('button', { name: 'Copy Jira ID' });
  await user.click(buttons.find((button) => !button.hasAttribute('disabled'))!);
  expect(mocks.copy).toHaveBeenLastCalledWith('AIP-115473');
  expect(screen.queryByRole('button', { name: 'Copy worktree path' })).not.toBeInTheDocument();
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
