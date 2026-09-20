import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveTaskDialog } from '../../../src/components/views/board-view/dialogs/archive-task-dialog';
import type { Feature } from '@automaker/types';
const mocks = vi.hoisted(() => ({ api: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/api-fetch', () => ({ apiFetch: mocks.api }));
vi.mock('@/store/app-store', () => ({
  useAppStore: { getState: () => ({ updateFeature: mocks.update }) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);
const features = [
  { id: 'a', title: 'Export' },
  { id: 'b', title: 'Export and audit' },
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
    expect(screen.getByLabelText('Duplicate of').querySelector('option[value="a"]')).toBeNull();
    fireEvent.change(screen.getByLabelText('Duplicate of'), { target: { value: 'b' } });
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
