import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSimilarTasks } from '../../../src/components/views/similar-tasks-view';
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-fetch', () => ({ apiFetch: mocks.api }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/store/app-store', () => ({ useAppStore: vi.fn() }));
const keep = {
  id: 'keep',
  title: 'AIP-114859 audit',
  jiraKey: 'AIP-114859',
  scope: 'Export, confirmation and audit trail',
  description: 'Full parent requirement\nIncludes export confirmation and persistent audit events.',
};
const retire = {
  id: 'retire',
  title: 'AIP-114829 export',
  jiraKey: 'AIP-114829',
  scope: 'Export',
  description: 'Original export description\nPreserve viewer permissions.',
};
const plan = {
  id: 'plan-id',
  keep,
  retire,
  reason: 'covers export',
  status: 'planned',
  warnings: ['Check coverage'],
  blockers: [],
  steps: [],
  mergeRequests: [
    {
      url: 'https://gitlab/p/-/merge_requests/1',
      state: 'merged',
      action: 'preserve',
      reason: 'Already merged',
    },
  ],
  jira: {
    key: retire.jiraKey,
    status: 'Open',
    done: false,
    transitions: [{ id: 'close', name: 'Close', target: 'Closed' }],
  },
};
describe('similar task review flow', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.api.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({
        success: true,
        result: url.endsWith('/list')
          ? {
              tasks: [keep, retire],
              history: [],
              pairs: [
                {
                  left: keep,
                  right: retire,
                  score: 70,
                  reasons: ['Shared export requirement'],
                  sharedTerms: ['export'],
                },
              ],
            }
          : plan,
      }),
    }));
  });
  afterEach(() => {
    cleanup();
    client.clear();
  });
  function view() {
    render(
      <QueryClientProvider client={client}>
        <ProjectSimilarTasks projectPath="/project" />
      </QueryClientProvider>
    );
  }
  it('compares complete descriptions from a candidate without creating a cleanup plan', async () => {
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Compare Descriptions' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(/Includes export confirmation and persistent audit events/)
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Preserve viewer permissions/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Swap Sides' }));
    expect(within(dialog).getByLabelText('Left Task')).toHaveValue('retire');
    fireEvent.change(within(dialog).getByLabelText('Comparison content'), {
      target: { value: 'scope' },
    });
    expect(within(dialog).getByText(keep.scope)).toBeInTheDocument();
    expect(mocks.api.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep AIP-114859' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task to keep')).toHaveValue('keep');
    expect(screen.getByLabelText('Covered task')).toHaveValue('retire');
  });
  it('allows manual comparison without choosing a cleanup direction or writing a reason', async () => {
    view();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Compare Any Two Tasks' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compare Any Two Tasks' }));
    fireEvent.change(screen.getByLabelText('Left Task'), { target: { value: 'keep' } });
    fireEvent.change(screen.getByLabelText('Right Task'), { target: { value: 'keep' } });
    expect(
      within(screen.getByRole('dialog'))
        .getAllByRole('button', { name: 'Keep AIP-114859' })
        .every((button) => button.hasAttribute('disabled'))
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Right Task'), { target: { value: 'retire' } });
    expect(
      within(screen.getByRole('dialog')).getByText(/Preserve viewer permissions/)
    ).toBeInTheDocument();
    expect(mocks.api.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
  });
  it('requires coverage reason, preview and typed confirmation; external operations default off', async () => {
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep AIP-114859' }));
    expect(screen.getByRole('button', { name: 'Preview Cleanup' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Coverage rationale and reviewed acceptance criteria'), {
      target: { value: 'AIP-114859 covers the export requirement' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview Cleanup' }));
    await screen.findByRole('dialog');
    expect(
      screen.getByRole('button', { name: 'Confirm Archive and Selected Cleanup' })
    ).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Close this Jira/ })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Confirm covered task key'), {
      target: { value: 'AIP-114829' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Archive and Selected Cleanup' }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith('/api/task-consolidation/apply', 'POST', {
        body: {
          projectPath: '/project',
          planId: 'plan-id',
          confirmation: 'AIP-114829',
          selection: { mrUrls: [], closeJira: false, transitionId: undefined },
        },
      })
    );
  });
});
