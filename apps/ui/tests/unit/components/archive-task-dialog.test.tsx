import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveTaskDialog } from '../../../src/components/views/board-view/dialogs/archive-task-dialog';
import type { Feature } from '@automaker/types';
const mocks = vi.hoisted(() => ({ api: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/api-fetch', () => ({ apiFetch: mocks.api }));
vi.mock('@/store/app-store', () => ({
  useAppStore: { getState: () => ({ updateFeature: mocks.update }) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
const features = [
  { id: 'a', title: 'Export' },
  { id: 'b', title: 'Export and audit', jiraKey: 'AIP-114859' },
  { id: 'other-task', title: 'Login' },
  { id: 'archived', title: 'Archived export', archive: {} },
  { id: 'superseded', title: 'Superseded export', supersededBy: 'b' },
  { id: 'consolidating', title: 'Consolidating export', consolidationPlanId: 'plan' },
] as Feature[];
function view() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ArchiveTaskDialog
        projectPath="/project"
        featureIds={['a']}
        features={features}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  );
}
describe('archive task form', () => {
  it('requires reason and description and a target for duplicates', async () => {
    view();
    const submit = screen.getByRole('button', { name: 'Archive Task' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Archive reason'), { target: { value: 'duplicate' } });
    fireEvent.change(screen.getByLabelText('Archive description'), {
      target: { value: 'All export requirements are covered by the other task' },
    });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('combobox', { name: /Duplicate of/ }));
    const options = within(screen.getByRole('listbox'));
    expect(options.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'AIP-114859 · Export and audit',
      'Login',
    ]);
    const search = screen.getByPlaceholderText('Search by title, Jira key or task ID...');
    for (const query of ['AUDIT', 'aip-114859', 'b']) {
      fireEvent.change(search, { target: { value: query } });
      expect(options.getAllByRole('option')).toHaveLength(1);
      expect(options.getByRole('option')).toHaveTextContent('Export and audit');
    }
    fireEvent.change(search, { target: { value: 'no such task' } });
    expect(screen.getByText('No matching tasks.')).toBeInTheDocument();
    expect(options.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    expect(options.getAllByRole('option')).toHaveLength(2);
    fireEvent.click(options.getByRole('option', { name: 'AIP-114859 · Export and audit' }));
    mocks.api.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, archivedCount: 1, features: [] }),
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith('/api/features/archive', 'POST', {
        body: {
          projectPath: '/project',
          featureIds: ['a'],
          archive: {
            reason: 'duplicate',
            description: 'All export requirements are covered by the other task',
            duplicateOf: 'b',
          },
        },
      })
    );
  });
  it('does not require a duplicate target for deferred requirements', () => {
    view();
    fireEvent.change(screen.getByLabelText('Archive reason'), { target: { value: 'deferred' } });
    fireEvent.change(screen.getByLabelText('Archive description'), {
      target: { value: 'Budget not available this quarter' },
    });
    expect(screen.queryByLabelText('Duplicate of')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive Task' })).toBeEnabled();
  });
});
