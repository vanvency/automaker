// MrConflictNotice - Done lane MR conflict hint.
//
// A verified card whose delivery merge requests conflict cannot be completed, so
// the card shows the repositories and one button that hands the fix to the agents
// of the tasks that own them.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const getMergeConflicts = vi.hoisted(() => vi.fn());
const resolveConflicts = vi.hoisted(() => vi.fn());

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({
    features: {
      getMergeConflicts: (...args: unknown[]) => getMergeConflicts(...args),
      resolveConflicts: (...args: unknown[]) => resolveConflicts(...args),
    },
  }),
}));

import { MrConflictNotice } from '@/components/views/board-view/components/kanban-card/mr-conflict-notice';

const CONFLICTS = [
  {
    name: 'frontend/saas-frontend',
    mrUrl: 'http://git/mr/2065',
    iid: 2065,
    sourceBranch: 'jira/aip-114859-dodo',
    targetBranch: 'dev',
  },
];

function renderNotice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<MrConflictNotice projectPath="/proj" featureId="f1" />, { wrapper });
}

describe('MrConflictNotice', () => {
  beforeEach(() => {
    getMergeConflicts.mockReset();
    resolveConflicts.mockReset();
  });

  it('stays out of the way when the delivery is mergeable', async () => {
    getMergeConflicts.mockResolvedValue({ success: true, conflicts: [] });
    renderNotice();
    await waitFor(() => expect(getMergeConflicts).toHaveBeenCalledWith('/proj', 'f1'));
    expect(screen.queryByTestId('mr-conflict-f1')).toBeNull();
  });

  it('names the conflicting merge requests and offers the agent', async () => {
    getMergeConflicts.mockResolvedValue({ success: true, conflicts: CONFLICTS });
    renderNotice();
    const notice = await screen.findByTestId('mr-conflict-f1');
    expect(notice).toHaveTextContent('frontend/saas-frontend !2065');
    expect(screen.getByTestId('resolve-conflicts-f1')).toHaveTextContent('让 Agent 修复冲突');
  });

  it('dispatches the fix for this card when the button is pressed', async () => {
    getMergeConflicts.mockResolvedValue({ success: true, conflicts: CONFLICTS });
    resolveConflicts.mockResolvedValue({
      success: true,
      dispatched: [{ featureId: 'f1', title: 'Task', repositories: ['frontend/saas-frontend'] }],
    });
    renderNotice();
    await userEvent.click(await screen.findByTestId('resolve-conflicts-f1'));
    await waitFor(() => expect(resolveConflicts).toHaveBeenCalledWith('/proj', 'f1'));
  });
});
