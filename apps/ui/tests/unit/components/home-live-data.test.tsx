import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from '@/components/views/home-view';

const mocks = vi.hoisted(() => ({
  project: { name: 'Demo', path: '/demo' },
  features: vi.fn(),
  progress: vi.fn(),
  agents: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/store/app-store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ currentProject: mocks.project }),
}));
vi.mock('@/hooks/queries', () => ({
  useFeatures: mocks.features,
  useWorktreeProgress: mocks.progress,
  useRunningAgents: mocks.agents,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={to + (search ? '?' + new URLSearchParams(search) : '')} {...props}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.project = { name: 'Demo', path: '/demo' };
  const result = {
    isFetchedAfterMount: true,
    isFetching: false,
    dataUpdatedAt: Date.now(),
    refetch: mocks.refresh,
  };
  mocks.features.mockReturnValue({
    ...result,
    data: [
      {
        id: 'failed',
        title: 'Broken validation',
        status: 'failed',
        passes: false,
        branchName: 'work/a',
      },
    ],
  });
  mocks.progress.mockReturnValue({ ...result, data: { rows: [], projects: [] } });
  mocks.agents.mockReturnValue({ ...result, data: { agents: [] } });
});

it('shows actual findings, links to the owning task and refreshes all sources', async () => {
  const view = render(<HomeView />);
  expect(mocks.features).toHaveBeenLastCalledWith('/demo');
  expect(mocks.progress).toHaveBeenLastCalledWith([mocks.project]);
  const health = within(screen.getAllByRole('article')[0]);
  expect(health.getByText('Recorded validation failures').nextElementSibling).toHaveTextContent(
    '1'
  );
  await userEvent.click(health.getByText(/Inspect findings/));
  const link = health.getByRole('link', { name: 'Broken validation' });
  const url = new URL(link.getAttribute('href')!, 'http://localhost');
  expect(url.searchParams.get('projectPath')).toBe('/demo');
  expect(url.searchParams.get('featureId')).toBe('failed');
  expect(url.searchParams.get('worktree')).toBe('work/a');
  await userEvent.click(screen.getByRole('button', { name: 'Refresh data' }));
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
  mocks.project = { name: 'Second', path: '/second' };
  mocks.features.mockReturnValue({ data: undefined, isFetchedAfterMount: false, isFetching: true });
  view.rerender(<HomeView />);
  expect(mocks.features).toHaveBeenLastCalledWith('/second');
  expect(screen.queryByText('Broken validation')).not.toBeInTheDocument();
  expect(screen.getAllByText('Loading project data…')).toHaveLength(4);
});

it('shows unavailable instead of zero failures when an API fails', () => {
  mocks.progress.mockReturnValue({
    error: new Error('Git unavailable'),
    isFetchedAfterMount: true,
    dataUpdatedAt: 0,
  });
  render(<HomeView />);
  expect(screen.getByRole('alert')).toHaveTextContent('Worktrees: Git unavailable');
  expect(screen.getAllByText('Data unavailable')).toHaveLength(4);
  expect(screen.queryByText('No findings in the available records.')).not.toBeInTheDocument();
});
