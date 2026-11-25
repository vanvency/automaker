import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      approved: true,
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

  it('renders HTML and text review comments while removing unsafe HTML', async () => {
    const plan = completionPlan();
    plan.result.mergeRequests = [
      {
        ...plan.result.mergeRequests[0],
        feedback: [
          {
            id: 1,
            author: 'Reviewer',
            updatedAt: '',
            url: 'https://git/mr/1#note_1',
            body: '<h3>Review findings</h3><table><tr><th>Issue</th></tr><tr><td>Missing check</td></tr></table><details><summary>Details</summary><p>Fix permission checks.</p></details><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">Unsafe link</a>',
          },
          {
            id: 2,
            author: 'Reviewer',
            updatedAt: '',
            url: 'https://git/mr/1#note_2',
            body: 'Plain text review\nKeep the existing API.\n\n**Required**: add a regression check.\n\n```html\n<strong>Example source</strong>\n```',
          },
        ],
      } as (typeof plan.result.mergeRequests)[number],
    ];
    apiFetch.mockResolvedValue({ ok: true, json: async () => plan });
    render(
      <CompleteTaskDialog
        feature={{ id: 'f1' } as Feature}
        projectPath="/p"
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />
    );
    expect(await screen.findByRole('heading', { name: 'Review findings' })).toBeVisible();
    expect(screen.getByRole('cell', { name: 'Missing check' })).toBeVisible();
    expect(screen.getByText('Details').tagName).toBe('SUMMARY');
    expect(screen.getByText(/Plain text review/)).toHaveTextContent('Keep the existing API.');
    expect(screen.getByText('Required').tagName).toBe('STRONG');
    expect(screen.getByText('<strong>Example source</strong>').tagName).toBe('CODE');
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('script, [onerror], a[href^="javascript:"]')).toBeNull();
  });

  it('fills the Jira fields with defaults and prefills Jira fields but requires explicit Confirm', async () => {
    render(
      <CompleteTaskDialog
        feature={{ id: 'f1', jiraKey: 'AIP-1' } as Feature}
        projectPath="/p"
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />
    );

    const confirm = await screen.findByRole('button', { name: /确认执行并归档/ });
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

    const confirm = await screen.findByRole('button', { name: /确认执行并归档/ });
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

    expect(await screen.findByRole('button', { name: 'Fix MR' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认执行并归档/ })).toBeDisabled();
  });
  it('shows live feedback and Approve MR only removes Draft; no Confirm request is sent', async () => {
    const plan = completionPlan();
    plan.result.approved = false;
    Object.assign(plan.result.mergeRequests[0], {
      draft: true,
      feedback: [
        {
          id: 9,
          body: 'Latest reviewer suggestion',
          author: 'reviewer',
          url: 'http://git/mr/1#note_9',
        },
      ],
    });
    apiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => plan })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    const onClose = vi.fn();
    render(
      <CompleteTaskDialog
        feature={{ id: 'f1' } as Feature}
        projectPath="/p"
        onClose={onClose}
        onCompleted={vi.fn()}
      />
    );
    expect(await screen.findByText('Latest reviewer suggestion')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix MR' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve MR' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiFetch.mock.calls[1][2].body).toMatchObject({
      action: 'approve',
      fingerprint: 'fp-1',
    });
    expect(apiFetch.mock.calls.some((call) => call[2].body.action === 'confirm')).toBe(false);
  });

  it('describes the external actions in order and sends Confirm only on the final click', async () => {
    apiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => completionPlan() })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    render(
      <CompleteTaskDialog
        feature={{ id: 'f1' } as Feature}
        projectPath="/p"
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />
    );
    const button = await screen.findByRole('button', { name: '确认执行并归档' });
    expect(
      screen.getByText(/① 释放托管预览资源 → ② squash 合并 MR → ③ 关闭 Jira/)
    ).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1][2].body).toMatchObject({
      action: 'confirm',
      transitionId: '111',
      jiraFields: { resolution: ['1'], fixVersions: ['19348'] },
    });
  });

  it('refreshes feedback and switches back to Approve when approval is stale', async () => {
    const fresh = completionPlan();
    fresh.result.approved = false;
    Object.assign(fresh.result.mergeRequests[0], {
      feedback: [{ id: 3, body: 'New feedback after push', url: 'http://git/mr/1' }],
    });
    apiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => completionPlan() })
      .mockResolvedValueOnce({ ok: true, json: async () => fresh });
    render(
      <CompleteTaskDialog
        feature={{ id: 'f1' } as Feature}
        projectPath="/p"
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />
    );
    await screen.findByRole('button', { name: '确认执行并归档' });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('New feedback after push')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve MR' })).toBeEnabled();
  });

  it('dispatches Fix MR for review-only feedback', async () => {
    const plan = completionPlan();
    plan.result.approved = false;
    Object.assign(plan.result.mergeRequests[0], {
      feedback: [{ id: 9, body: 'Fix this', url: 'http://git/mr/1' }],
    });
    apiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => plan })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    render(
      <CompleteTaskDialog
        feature={{ id: 'f1' } as Feature}
        projectPath="/p"
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Fix MR' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1][2].body.action).toBe('fix');
  });
});
