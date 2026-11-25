import { expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Feature } from '@automaker/types';
import { CompletedFeaturesModal } from '@/components/views/board-view/dialogs/completed-features-modal';

it('shows archive reasons and task identity, offers only restore for modern and legacy archives', async () => {
  const archive = {
    reason: 'obsolete' as const,
    description: 'Replaced by the revised requirements.',
    previousStatus: 'backlog',
    archivedAt: '2026-09-21T09:00:00Z',
  };
  const tasks = [
    {
      id: 'archived',
      title: 'AIP-1: Actual task title',
      summary: 'An unrelated-looking implementation summary',
      archive,
      archiveHistory: [],
    },
    {
      id: 'delivered',
      title: 'AIP-2: Legacy delivery',
      deliveryCompletion: {
        status: 'succeeded',
        updatedAt: '2026-09-21T09:00:00Z',
        steps: [{ id: 'merge', status: 'succeeded', message: 'Two MRs merged.' }],
      },
    },
    { id: 'legacy', title: 'AIP-3: Older archive' },
  ].map((task) => ({
    description: '',
    status: 'completed',
    branchName: 'task/a',
    ...task,
  })) as Feature[];
  const restore = vi.fn();
  render(
    <CompletedFeaturesModal
      open
      onOpenChange={vi.fn()}
      completedFeatures={tasks}
      onUnarchive={restore}
      branchName="task/a"
    />
  );

  expect(screen.queryByRole('button', { name: 'Archive Task' })).not.toBeInTheDocument();
  expect(screen.queryByTitle('Archive Task')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(3);
  expect(screen.getByText('AIP-1: Actual task title')).toBeVisible();
  expect(screen.queryByText('An unrelated-looking implementation summary')).not.toBeInTheDocument();
  expect(screen.getByText('Replaced by the revised requirements.')).toBeVisible();
  expect(screen.getByText(/Archive reason: Requirement no longer valid/)).toBeVisible();
  expect(screen.getByText('Archive reason: Delivery completed')).toBeVisible();
  expect(screen.getByText('Two MRs merged.')).toBeVisible();
  expect(screen.getByText('Archive reason: Not recorded (legacy task)')).toBeVisible();
  await userEvent.click(
    within(screen.getByTestId('completed-card-delivered')).getByRole('button', { name: 'Restore' })
  );
  expect(restore).toHaveBeenCalledWith(tasks[1]);
});
