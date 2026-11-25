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
import { GuideView } from '@/components/views/guide-view';

const store = vi.hoisted(() => ({
  currentProject: null as { name: string; path: string } | null,
}));

vi.mock('@/store/app-store', () => ({
  useAppStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

async function renderGuide() {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: '/', component: GuideView });
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
  await screen.findByRole('heading', { name: 'Guide', exact: true });
  return router;
}

describe('GuideView', () => {
  it('explains the workflow without requiring a project and directs users to project selection', async () => {
    store.currentProject = null;
    await renderGuide();

    expect(screen.getByRole('link', { name: 'Select a project first' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(screen.queryByRole('link', { name: 'Configure Jira sync' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Task Kanban' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open or create a project' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(screen.queryByRole('link', { name: 'Open Agent workspace' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Workspace flow' }))
        .getAllByRole('heading')
        .map((heading) => heading.textContent)
    ).toEqual(['Project', 'Work Board', 'Task Kanban']);
    expect(
      within(screen.getByRole('list', { name: 'Task lanes' }))
        .getAllByRole('heading')
        .map((heading) => heading.textContent)
    ).toEqual(['Backlog', 'In Progress', 'Needs Attention', 'Waiting Review', 'Done']);
  });

  it('links the selected project to its board, agent workspace and Jira settings section', async () => {
    store.currentProject = { name: 'Demo', path: '/projects/demo' };
    const router = await renderGuide();

    expect(screen.getByText('Demo')).toBeInTheDocument();
    expect(screen.getByText('/projects/demo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Switch project' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(screen.getByText('Snoozed Works')).toBeInTheDocument();
    expect(screen.getByText('Archived Works')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Work Board' })).toHaveAttribute(
      'href',
      '/worktrees'
    );
    expect(screen.getByRole('link', { name: 'Open Agent workspace' })).toHaveAttribute(
      'href',
      '/agent'
    );
    await userEvent.click(screen.getByRole('link', { name: 'Configure Jira sync' }));
    await screen.findByRole('heading', { name: 'Project Settings' });
    expect(router.state.location.pathname).toBe('/project-settings');
    expect(router.state.location.search).toEqual({ section: 'jira' });
  });
});
