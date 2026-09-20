/**
 * CompleteTaskDialog - Jira completion fields.
 *
 * The dialog used to block Complete until the operator picked every Jira
 * transition field by hand (resolution was the usual suspect). Defaults are
 * filled automatically now, so a card without blockers completes in one click.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Feature } from '@automaker/types';
import type { ReactNode } from 'react';

const apiFetch = vi.hoisted(() => vi.fn());
const getMergeConflicts = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({
    features: {
      getMergeConflicts: (...args: unknown[]) => getMergeConflicts(...args),
      resolveConflicts: vi.fn(),
    },
  }),
}));

import { CompleteTaskDialog } from '@/components/views/board-view/dialogs/complete-task-dialog';

function completionPlan(
  blockers: string[] = [],
  conflicts: Array<{ name: string; mrUrl: string; iid: number }> = []
) {
  return {
    success: true,
    result: {
      fingerprint: 'fp-1',
      mergeRequests: [{ name: 'saas/saas-frontend', url: 'http://git/mr/1', state: 'opened' }],
      blockers,
      conflicts,
      jira: {
        key: 'AIP-1',
        status: '待办',
        done: false,
        transitions: [
          {
            id: '111',
            name: 'CLOSED',
            target: 'Closed',
            fields: [
              {
                key: 'resolution',
                name: 'Resolution',
                multiple: false,
                supported: true,
                value: [],
                allowedValues: [
                  { id: '1', name: 'Fixed' },
                  { id: '2', name: "Won't Fix" },
                ],
              },
              {
                key: 'fixVersions',
                name: 'Fix Version',
                multiple: true,
                supported: true,
                value: ['19348'],
                allowedValues: [{ id: '19348', name: 'LLM-3.1' }],
              },
            ],
          },
        ],
      },
    },
  };
}

describe('CompleteTaskDialog', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    getMergeConflicts.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => completionPlan(),
    });
  });

  it('fills the Jira fields with defaults and enables Complete without user input', async () => {
    render(
      <CompleteTaskDialog
        feature={{ id: 'f1', jiraKey: 'AIP-1' } as Feature}
        projectPath="/p"
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />
    );

    const confirm = await screen.findByRole('button', { name: /确认 Complete/ });
    await waitFor(() => expect(confirm).toBeEnabled());
    // Values are summarised in the collapsed section instead of demanding input.
    expect(screen.getByTestId('jira-completion-fields')).toHaveTextContent('Resolution=Fixed');
    expect(screen.getByTestId('jira-completion-fields')).toHaveTextContent('LLM-3.1');
  });

  it('stays disabled while the plan reports blockers', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => completionPlan(['Resolve conflicts and verify again: http://git/mr/1']),
    });

    render(
      <CompleteTaskDialog
        feature={{ id: 'f2', jiraKey: 'AIP-2' } as Feature}
        projectPath="/p"
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />
    );

    const confirm = await screen.findByRole('button', { name: /确认 Complete/ });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/Resolve conflicts and verify again/)).toBeInTheDocument();
  });

  it('offers the agent when the merge requests conflict', async () => {
    const conflicts = [
      {
        name: 'frontend/saas-frontend',
        mrUrl: 'http://git/mr/2065',
        iid: 2065,
        sourceBranch: 'jira/aip-114859-dodo',
        targetBranch: 'dev',
      },
    ];
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => completionPlan([], conflicts),
    });
    getMergeConflicts.mockResolvedValue({ success: true, conflicts });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    render(
      <CompleteTaskDialog
        feature={{ id: 'f3', jiraKey: 'AIP-3' } as Feature}
        projectPath="/p"
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
      { wrapper }
    );

    expect(await screen.findByTestId('resolve-conflicts-f3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认 Complete/ })).toBeDisabled();
  });
});
