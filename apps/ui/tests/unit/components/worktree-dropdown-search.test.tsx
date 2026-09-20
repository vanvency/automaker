import { useRecentWorktreesStore } from '@/store/recent-worktrees-store';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  WorktreeDropdown,
  type WorktreeDropdownProps,
} from '../../../src/components/views/board-view/worktree-panel/components/worktree-dropdown';
import { WorktreeMobileDropdown } from '../../../src/components/views/board-view/worktree-panel/components/worktree-mobile-dropdown';
import type {
  FeatureInfo,
  WorktreeInfo,
} from '../../../src/components/views/board-view/worktree-panel/types';

// The actions dropdown next to the switcher detects editors/terminals through the
// Electron/http bridge, which is not available in jsdom.
vi.mock(
  '../../../src/components/views/board-view/worktree-panel/hooks/use-available-editors',
  () => ({
    useAvailableEditors: () => ({
      editors: [],
      isLoading: false,
      isRefreshing: false,
      refresh: vi.fn(),
      hasMultipleEditors: false,
      defaultEditor: null,
    }),
    useEffectiveDefaultEditor: () => null,
  })
);

vi.mock(
  '../../../src/components/views/board-view/worktree-panel/hooks/use-available-terminals',
  () => ({
    useAvailableTerminals: () => ({
      terminals: [],
      isLoading: false,
      isRefreshing: false,
      refresh: vi.fn(),
      hasExternalTerminals: false,
      defaultTerminal: null,
    }),
    useEffectiveDefaultTerminal: () => null,
  })
);

beforeAll(() => {
  // Radix popper needs a ResizeObserver instance; the global mock in
  // tests/setup.ts is wiped by the `mockReset` option.
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
});

function worktree(overrides: Partial<WorktreeInfo> & Pick<WorktreeInfo, 'branch'>): WorktreeInfo {
  return {
    path: `/repo/${overrides.branch}`,
    isMain: false,
    isCurrent: false,
    hasWorktree: true,
    ...overrides,
  };
}

const worktrees: WorktreeInfo[] = [
  worktree({ branch: 'feature/running' }),
  worktree({ branch: 'feature/idle' }),
  worktree({ branch: 'feature/fresh' }),
  worktree({
    branch: 'feature/merged',
    pr: {
      number: 42,
      url: 'https://example.test/pr/42',
      title: 'Merged branch',
      state: 'MERGED',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  }),
  worktree({ branch: 'main', isMain: true, isCurrent: true }),
];

const features: FeatureInfo[] = [
  { id: 'f-1', branchName: 'feature/running', status: 'in_progress', title: 'Busy card' },
  { id: 'f-2', branchName: 'feature/idle', status: 'backlog', title: 'Idle card' },
];

function buildProps(overrides: Partial<WorktreeDropdownProps> = {}): WorktreeDropdownProps {
  const noop = vi.fn();
  const notRunning = () => false;

  return {
    worktrees,
    isWorktreeSelected: (candidate) => candidate.branch === 'feature/running',
    hasRunningFeatures: (candidate) => candidate.branch === 'feature/running',
    isActivating: false,
    branchCardCounts: {},
    features,
    isDevServerRunning: notRunning,
    isDevServerStarting: notRunning,
    getDevServerInfo: () => undefined,
    isAutoModeRunningForWorktree: notRunning,
    isTestRunningForWorktree: notRunning,
    getTestSessionInfo: () => undefined,
    onSelectWorktree: noop,
    branches: [],
    filteredBranches: [],
    branchFilter: '',
    isLoadingBranches: false,
    isSwitching: false,
    onBranchDropdownOpenChange: () => noop,
    onBranchFilterChange: noop,
    onSwitchBranch: noop,
    onCreateBranch: noop,
    isPulling: false,
    isPushing: false,
    isStartingAnyDevServer: false,
    aheadCount: 0,
    behindCount: 0,
    hasRemoteBranch: false,
    gitRepoStatus: { isGitRepo: true, hasCommits: true },
    hasTestCommand: false,
    isStartingTests: false,
    hasInitScript: false,
    onActionsDropdownOpenChange: () => noop,
    onPull: noop,
    onPush: noop,
    onPushNewBranch: noop,
    onOpenInEditor: noop,
    onOpenInIntegratedTerminal: noop,
    onOpenInExternalTerminal: noop,
    onViewChanges: noop,
    onViewCommits: noop,
    onDiscardChanges: noop,
    onCommit: noop,
    onCreatePR: noop,
    onAddressPRComments: noop,
    onAutoAddressPRComments: noop,
    onResolveConflicts: noop,
    onMerge: noop,
    onDeleteWorktree: noop,
    onStartDevServer: noop,
    onStopDevServer: noop,
    onOpenDevServerUrl: noop,
    onViewDevServerLogs: noop,
    onRunInitScript: noop,
    onToggleAutoMode: noop,
    onStartTests: noop,
    onStopTests: noop,
    onViewTestLogs: noop,
    ...overrides,
  };
}

async function openSwitcher(props: Partial<WorktreeDropdownProps> = {}) {
  const user = userEvent.setup();
  // The actions dropdown rendered next to the switcher reads React Query hooks.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <WorktreeDropdown {...buildProps(props)} />
    </QueryClientProvider>
  );

  await user.click(screen.getByRole('button', { name: /feature\/running/ }));
  const menu = await screen.findByRole('menu');
  return { user, menu };
}

function groupLabels(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[data-category]')).map(
    (element) => (element as HTMLElement).dataset.category!
  );
}

describe('WorktreeDropdown categories and keyword search', () => {
  it('clicking a recent worktree invokes the same switch callback as the full list', async () => {
    const target = worktrees.find((tree) => tree.branch === 'feature/idle')!;
    useRecentWorktreesStore.setState({ pathsByProject: { '/recent-test': [target.path] } });
    const onSelectWorktree = vi.fn();
    const { user, menu } = await openSwitcher({ projectPath: '/recent-test', onSelectWorktree });
    const recent = menu.querySelector('[data-category="recent"]')!
      .nextElementSibling as HTMLElement;
    await user.click(within(recent).getByRole('menuitem'));
    expect(onSelectWorktree).toHaveBeenCalledExactlyOnceWith(target);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('groups worktrees as 工作中 → 空闲 → 新增 → 已完成', async () => {
    const { menu } = await openSwitcher();

    expect(groupLabels(menu)).toEqual(['working', 'idle', 'new', 'done']);
    for (const label of ['工作中', '空闲', '新增', '已完成']) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
  });

  it('places each worktree in the matching group', async () => {
    const { menu } = await openSwitcher();

    // The group label is rendered right before the item group container.
    const groupFor = (category: string) => {
      const label = menu.querySelector(`[data-category="${category}"]`);
      return within(label?.nextElementSibling as HTMLElement);
    };

    expect(groupFor('working').getByText('feature/running')).toBeInTheDocument();
    expect(groupFor('idle').getByText('feature/idle')).toBeInTheDocument();
    // The main worktree shows its branch name ("main") plus the same badge text.
    expect(groupFor('idle').getAllByText('main').length).toBeGreaterThan(0);
    expect(groupFor('new').getByText('feature/fresh')).toBeInTheDocument();
    expect(groupFor('done').getByText('feature/merged')).toBeInTheDocument();
  });

  it('filters the list by keyword', async () => {
    const { user, menu } = await openSwitcher();

    await user.type(within(menu).getByLabelText('Search worktrees'), 'idle card');

    expect(groupLabels(menu)).toEqual(['idle']);
    expect(within(menu).getByText('feature/idle')).toBeInTheDocument();
    expect(within(menu).queryByText('feature/running')).not.toBeInTheDocument();
  });

  it('filters by branch, card title and category label', async () => {
    const { user, menu } = await openSwitcher();
    const search = within(menu).getByLabelText('Search worktrees');

    await user.type(search, 'merged');
    expect(groupLabels(menu)).toEqual(['done']);
    expect(within(menu).getByText('feature/merged')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'Busy card');
    expect(groupLabels(menu)).toEqual(['working']);

    await user.clear(search);
    await user.type(search, '新增');
    expect(groupLabels(menu)).toEqual(['new']);
    expect(within(menu).getByText('feature/fresh')).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    const { user, menu } = await openSwitcher();

    await user.type(within(menu).getByLabelText('Search worktrees'), 'no-such-worktree');

    expect(groupLabels(menu)).toEqual([]);
    expect(within(menu).getByText('没有匹配的 worktree')).toBeInTheDocument();
  });
});

describe('WorktreeMobileDropdown categories and keyword search', () => {
  async function openMobileSwitcher() {
    const user = userEvent.setup();
    render(
      <WorktreeMobileDropdown
        worktrees={worktrees}
        isWorktreeSelected={(candidate) => candidate.branch === 'feature/running'}
        hasRunningFeatures={(candidate) => candidate.branch === 'feature/running'}
        isDevServerRunning={() => false}
        isDevServerStarting={() => false}
        getDevServerInfo={() => undefined}
        isActivating={false}
        branchCardCounts={{}}
        features={features}
        onSelectWorktree={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /feature\/running/ }));
    const menu = await screen.findByRole('menu');
    return { user, menu };
  }

  it('switches when a recent item is selected on mobile', async () => {
    const target = worktrees.find((tree) => tree.branch === 'feature/idle')!;
    useRecentWorktreesStore.setState({ pathsByProject: { '/recent-mobile': [target.path] } });
    const onSelectWorktree = vi.fn();
    render(
      <WorktreeMobileDropdown
        {...buildProps({ projectPath: '/recent-mobile', onSelectWorktree })}
      />
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /feature\/running/ }));
    const menu = await screen.findByRole('menu');
    const recent = menu.querySelector('[data-category="recent"]')!
      .nextElementSibling as HTMLElement;
    await user.click(within(recent).getByRole('menuitem'));
    expect(onSelectWorktree).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('uses the same groups as the desktop switcher', async () => {
    const { menu } = await openMobileSwitcher();

    expect(groupLabels(menu)).toEqual(['working', 'idle', 'new', 'done']);
  });

  it('filters the mobile list by keyword', async () => {
    const { user, menu } = await openMobileSwitcher();

    await user.type(within(menu).getByLabelText('Search worktrees'), 'feature/merged');

    expect(groupLabels(menu)).toEqual(['done']);
    expect(within(menu).getByText('feature/merged')).toBeInTheDocument();
    expect(within(menu).queryByText('feature/fresh')).not.toBeInTheDocument();
  });
});
