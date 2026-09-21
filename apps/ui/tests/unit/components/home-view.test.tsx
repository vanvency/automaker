import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { HomeView } from '@/components/views/home-view';

const store = vi.hoisted(() => ({
  currentProject: null as { name: string; path: string } | null,
}));

vi.mock('@/store/app-store', () => ({
  useAppStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

async function renderHome() {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: '/', component: HomeView });
  const settings = createRoute({
    getParentRoute: () => root,
    path: '/project-settings',
    validateSearch: (search: Record<string, unknown>) => ({ section: search.section }),
    component: () => <h1>Project Settings</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, settings]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: '从 Jira 需求，到可验收的交付' });
  return router;
}

describe('HomeView', () => {
  it('explains the workflow without requiring a project and directs users to project selection', async () => {
    store.currentProject = null;
    await renderHome();

    expect(screen.getByRole('link', { name: '先选择项目' })).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByRole('link', { name: '配置 Jira 同步' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '进入任务看板' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '如何拆分任务' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: '任务泳道' }))
        .getAllByRole('heading')
        .map((heading) => heading.textContent)
    ).toEqual(['Backlog', 'In Progress', 'Needs Attention', 'Waiting Review', 'Done']);
    expect(screen.getByRole('link', { name: '查看运行中的 Agent' })).toHaveAttribute(
      'href',
      '/running-agents'
    );
  });

  it('links the selected project to its board, agent workspace and Jira settings section', async () => {
    store.currentProject = { name: 'Demo', path: '/projects/demo' };
    const router = await renderHome();

    expect(screen.getByText(/当前项目：Demo/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '进入任务看板' })).toHaveAttribute('href', '/board');
    expect(screen.getByRole('link', { name: '打开 Work Board' })).toHaveAttribute(
      'href',
      '/worktrees'
    );
    expect(screen.getByRole('link', { name: '打开 Agent 工作区' })).toHaveAttribute(
      'href',
      '/agent'
    );
    await userEvent.click(screen.getByRole('link', { name: '配置 Jira 同步' }));
    await screen.findByRole('heading', { name: 'Project Settings' });
    expect(router.state.location.pathname).toBe('/project-settings');
    expect(router.state.location.search).toEqual({ section: 'jira' });
  });
});
