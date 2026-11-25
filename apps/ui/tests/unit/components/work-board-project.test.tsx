import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorktreesView } from '@/components/views/worktrees-view';

const mocks = vi.hoisted(() => {
  const project = { id: 'a', path: '/project', name: 'Demo' };
  return {
    project,
    store: {
      projects: [project, { id: 'b', path: '/other', name: 'Other' }],
      currentProject: project,
      setCurrentProject: vi.fn(),
      getWorktrees: vi.fn(() => []),
      setWorktrees: vi.fn(),
      setCurrentWorktree: vi.fn(),
    },
    navigate: vi.fn(),
    progress: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    copy: vi.fn(),
    archive: vi.fn(),
    logModal: vi.fn(),
  };
});
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/store/app-store', () => ({
  useAppStore: Object.assign(() => mocks.store, { getState: () => mocks.store }),
}));
vi.mock('@/hooks/queries', () => ({
  useWorktreeProgress: mocks.progress,
  useRunningAgents: () => ({ data: { agents: [] } }),
}));
vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({ worktree: { create: mocks.create }, features: { getAll: mocks.list } }),
}));
vi.mock('@/lib/clipboard-utils', () => ({ writeToClipboard: mocks.copy }));
vi.mock('@/lib/api-fetch', () => ({ apiFetch: mocks.archive }));
vi.mock('@/components/views/worktree-preview', () => ({ WorktreePreviewControls: () => null }));
vi.mock('@/components/views/board-view/dialogs/agent-output-modal', () => ({
  AgentOutputModal: (props: unknown) => {
    mocks.logModal(props);
    return <div data-testid="agent-output-modal" />;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.currentProject = mocks.project;
  mocks.progress.mockReturnValue({
    data: {
      projects: [],
      rows: ['/project', '/other'].map((projectPath) => ({
        projectPath,
        projectName: projectPath,
        path: `${projectPath}/.worktrees/example`,
        branch: 'work/example',
        stage: 'backlog',
        isMain: false,
        tasks: [],
        featureCount: 0,
        ahead: 0,
        behind: 0,
        changedFilesCount: 0,
        feature: { id: projectPath, title: `${projectPath} work` },
      })),
    },
    refetch: vi.fn(),
  });
});

it('opens Logs from a Needs Attention card for its main task without navigating', async () => {
  mocks.progress.mockReturnValue({
    data: {
      projects: [],
      rows: [
        {
          projectPath: '/project',
          projectName: 'Demo',
          path: '/project/.worktrees/work-a',
          branch: 'work/a',
          stage: 'failed',
          isMain: false,
          tasks: [{ id: 'task-a', title: 'Task A', stage: 'failed', childIds: [] }],
          feature: { id: 'task-a', title: 'Task A' },
          featureCount: 1,
          ahead: 0,
          behind: 0,
          changedFilesCount: 0,
        },
      ],
    },
    refetch: vi.fn(),
  });
  renderBoard();
  const card = within(screen.getByTestId('task-card-work/a'));
  await userEvent.click(card.getByRole('button', { name: 'Logs' }));
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.logModal).toHaveBeenCalledWith(
    expect.objectContaining({
      open: true,
      projectPath: '/project',
      featureId: 'task-a',
    })
  );
});

it('resets a Jira Work from its card only after showing the fresh Jira preview', async () => {
  const refetch = vi.fn();
  mocks.progress.mockReturnValue({
    refetch,
    data: {
      projects: [],
      rows: [
        {
          projectPath: '/project',
          projectName: 'Demo',
          path: '/project/.worktrees/work-a',
          branch: 'work/a',
          stage: 'backlog',
          isMain: false,
          tasks: [{ id: 'jira-a', jiraKey: 'AIP-1', stage: 'backlog', childIds: [] }],
          featureCount: 1,
          ahead: 0,
          behind: 0,
          changedFilesCount: 0,
          feature: { id: 'jira-a', title: 'Old Work', jiraKey: 'AIP-1' },
        },
      ],
    },
  });
  mocks.archive.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({
      success: true,
      result: url.endsWith('/reset-preview')
        ? {
            reset: {
              featureId: 'jira-a',
              issueKey: 'AIP-1',
              title: 'New Jira requirement',
              oldBranch: 'work/a',
              oldWorktree: '/project/.worktrees/work-a',
              newBranch: 'work/a-reset-123',
              hasLocalChanges: true,
              snapshot: 'a'.repeat(64),
            },
          }
        : { reset: { featureId: 'jira-new' } },
    }),
  }));
  renderBoard();
  const card = within(screen.getByTestId('task-card-work/a'));
  await userEvent.click(card.getByRole('button', { name: '重置 Work' }));
  expect(mocks.navigate).not.toHaveBeenCalled();
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByText('New Jira requirement', { exact: false })).toBeVisible();
  expect(dialog.getByText(/未提交修改/)).toBeVisible();
  expect(mocks.archive.mock.calls.some(([url]) => url.endsWith('/reset-work'))).toBe(false);
  await userEvent.click(dialog.getByRole('button', { name: '确认丢弃旧 Work 并重建' }));
  await waitFor(() =>
    expect(mocks.archive).toHaveBeenCalledWith('/api/jira-sync/reset-work', 'POST', {
      body: { projectPath: '/project', featureId: 'jira-a', snapshot: 'a'.repeat(64) },
    })
  );
  await waitFor(() => expect(refetch).toHaveBeenCalled());
});

it('shares Kanban controls and opens Archive before the task list finishes loading', async () => {
  const tasks = ['a', 'child', 'b'].map((id) => ({
    id,
    title: `Task ${id}`,
    description: id,
    category: 'test',
    branchName: id === 'b' ? 'work/b' : 'work/a',
    status: 'backlog',
  }));
  let resolveTasks!: (value: { success: boolean; features: typeof tasks }) => void;
  mocks.list.mockReturnValue(
    new Promise((resolve) => {
      resolveTasks = resolve;
    })
  );
  mocks.copy.mockResolvedValue(true);
  mocks.archive.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, features: [], archivedCount: 2 }),
  });
  const refetch = vi.fn();
  mocks.progress.mockReturnValue({
    refetch,
    data: {
      projects: [],
      rows: ['a', 'b'].map((id) => ({
        projectPath: '/project',
        projectName: 'Demo',
        path: `/project/.worktrees/${id}`,
        branch: `work/${id}`,
        stage: 'backlog',
        isMain: false,
        tasks: tasks
          .filter((f) => f.branchName === `work/${id}`)
          .map((f) => ({ ...f, stage: 'backlog', childIds: [] })),
        featureCount: id === 'a' ? 2 : 1,
        ahead: 0,
        behind: 0,
        changedFilesCount: 0,
        feature: {
          id,
          title: `Work ${id}`,
          jiraKey: `AIP-${id}`,
          jiraAssignee: id === 'a' ? 'alice' : undefined,
          jiraAssigneeDisplayName: id === 'a' ? 'Alice' : undefined,
          jiraReporter: id === 'a' ? 'bob' : 'eve',
          jiraReporterDisplayName: id === 'a' ? 'Bob' : 'Eve',
        },
      })),
    },
  });
  renderBoard();
  const search = screen.getByRole('textbox', { name: 'Search' });
  fireEvent.keyDown(document.body, { key: '/' });
  expect(search).toHaveFocus();
  await userEvent.type(search, 'alice');
  expect(screen.getByText('Work a')).toBeVisible();
  expect(screen.queryByText('Work b')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  await userEvent.selectOptions(screen.getByLabelText('Filter by assignee'), '__missing__');
  expect(screen.queryByText('Work a')).not.toBeInTheDocument();
  expect(screen.getByText('Work b')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await userEvent.selectOptions(screen.getByLabelText('Filter by reporter'), 'bob');
  expect(screen.queryByText('Work b')).not.toBeInTheDocument();
  const card = within(screen.getByTestId('task-card-work/a'));
  expect(
    within(card.getByTestId('work-card-actions')).getByRole('button', { name: 'Snooze Work' })
  ).toBeVisible();
  const copy = within(card.getByTestId('work-jira-row')).getByRole('button', {
    name: 'Copy Jira ID',
  });
  copy.focus();
  await userEvent.keyboard('{Enter}');
  expect(mocks.copy).toHaveBeenCalledWith('AIP-a');
  expect(mocks.navigate).not.toHaveBeenCalled();
  await userEvent.click(card.getByRole('button', { name: 'Archive Work' }));
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByText('Task a')).toBeVisible();
  expect(dialog.getByText('Task child')).toBeVisible();
  expect(dialog.queryByText('Task b')).not.toBeInTheDocument();
  expect(dialog.getByLabelText('Archive reason')).toHaveValue('already_taken');
  expect(dialog.getByRole('button', { name: 'Archive Work' })).toBeDisabled();
  fireEvent.change(dialog.getByLabelText('Archive reason'), { target: { value: 'done' } });
  resolveTasks({ success: true, features: tasks });
  await waitFor(() => expect(dialog.getByRole('button', { name: 'Archive Work' })).toBeEnabled());
  await userEvent.click(dialog.getByRole('button', { name: 'Archive Work' }));
  await waitFor(() =>
    expect(mocks.archive).toHaveBeenCalledWith('/api/features/archive', 'POST', {
      body: {
        projectPath: '/project',
        featureIds: ['a', 'child'],
        archive: { reason: 'done', description: '', duplicateOf: undefined },
      },
    })
  );
  expect(refetch).toHaveBeenCalled();
});

function renderBoard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <WorktreesView />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

it('does not reopen Archive when a cancelled task-list request finishes', async () => {
  let resolveTasks!: (value: { success: boolean; features: unknown[] }) => void;
  mocks.list.mockReturnValue(
    new Promise((resolve) => {
      resolveTasks = resolve;
    })
  );
  mocks.progress.mockReturnValue({
    data: {
      projects: [],
      rows: [
        {
          projectPath: '/project',
          projectName: 'Demo',
          path: '/project/.worktrees/example',
          branch: 'work/example',
          stage: 'backlog',
          isMain: false,
          tasks: [{ id: 'a', title: 'Task A', stage: 'backlog', childIds: [] }],
          feature: { id: 'a', title: 'Task A' },
          featureCount: 1,
          ahead: 0,
          behind: 0,
          changedFilesCount: 0,
        },
      ],
    },
    refetch: vi.fn(),
  });
  renderBoard();
  await userEvent.click(
    within(screen.getByTestId('task-card-work/example')).getByRole('button', {
      name: 'Archive Work',
    })
  );
  const dialog = within(await screen.findByRole('dialog'));
  await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  await act(async () => {
    resolveTasks({
      success: true,
      features: [{ id: 'a', title: 'Task A', branchName: 'work/example' }],
    });
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.archive).not.toHaveBeenCalled();
});

it('queries only the selected project and opens its worktree, including after switching projects', async () => {
  const view = renderBoard();
  expect(mocks.progress).toHaveBeenLastCalledWith([mocks.project], true);
  expect(screen.queryByText('/other work')).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('/project work'));
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/board',
    search: { projectPath: '/project', worktree: 'work/example' },
  });
  mocks.store.currentProject = mocks.store.projects[1];
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <WorktreesView />
      </TooltipProvider>
    </QueryClientProvider>
  );
  expect(mocks.progress).toHaveBeenLastCalledWith([mocks.store.projects[1]], true);
  expect(screen.queryByText('/project work')).not.toBeInTheDocument();
  expect(screen.getByText('/other work')).toBeVisible();
});

it('creates a real worktree before entering its Task Kanban and retains errors for retry', async () => {
  mocks.create
    .mockResolvedValueOnce({ success: false, error: 'Permission denied' })
    .mockResolvedValueOnce({
      success: true,
      worktree: { path: '/project/.worktrees/new', branch: 'work/new', isNew: true },
    });
  renderBoard();
  await userEvent.click(screen.getByRole('button', { name: 'New Work' }));
  await userEvent.type(screen.getByLabelText('Branch Name'), 'work/new');
  await userEvent.click(screen.getByRole('button', { name: 'Create Worktree' }));
  expect(await screen.findByText('Permission denied')).toBeVisible();
  expect(mocks.navigate).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Create Worktree' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('/project', 'work/new', undefined));
  expect(mocks.store.setCurrentWorktree).toHaveBeenCalledWith(
    '/project',
    '/project/.worktrees/new',
    'work/new'
  );
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/board',
    search: { projectPath: '/project', worktree: 'work/new' },
  });
});
