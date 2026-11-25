import { expect, it, vi } from 'vitest';
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
import { GuideView } from '@/components/views/guide-view';

const store = vi.hoisted(() => ({ currentProject: null as { name: string; path: string } | null }));
vi.mock('@/store/app-store', () => ({
  useAppStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

it('shows the four routines and keeps the full guide reachable without a project', async () => {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: '/', component: HomeView });
  const guide = createRoute({ getParentRoute: () => root, path: '/guide', component: GuideView });
  const router = createRouter({
    routeTree: root.addChildren([home, guide]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'Home', exact: true });
  expect(
    screen.getAllByRole('article').map((card) => within(card).getByRole('heading').textContent)
  ).toEqual([
    'Weekday repo audit',
    'Release readiness',
    'Daily change review',
    'Hourly queue check',
  ]);
  expect(screen.getByRole('link', { name: 'Open or create a project' })).toHaveAttribute(
    'href',
    '/dashboard'
  );
  expect(screen.queryByRole('list', { name: 'Workspace flow' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('link', { name: 'Guide', exact: true }));
  await screen.findByRole('heading', { name: 'Guide', exact: true });
  expect(router.state.location.pathname).toBe('/guide');
  expect(screen.getByRole('list', { name: 'Workspace flow' })).toBeVisible();
  await userEvent.click(screen.getByRole('link', { name: 'Back to Home' }));
  await screen.findByRole('heading', { name: 'Home', exact: true });
});
