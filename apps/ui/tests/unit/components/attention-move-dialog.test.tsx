import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttentionMoveDialog } from '@/components/views/board-view/dialogs/attention-move-dialog';
import type { PendingAttentionMove } from '@/components/views/board-view/hooks/use-board-drag-drop';

const move = {
  feature: {
    id: 'task',
    jiraKey: 'AIP-117268',
    status: 'failed',
    title: 'Manually merged task',
    error: 'Draft MR delivery required before review',
  },
  targetStatus: 'verified',
  projectPath: '/project',
} as PendingAttentionMove;

describe('attention move risk confirmation', () => {
  it('shows the existing blocker and requires an explicit choice', () => {
    const onConfirm = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(
      <AttentionMoveDialog move={move} busy={false} onCancel={onCancel} onConfirm={onConfirm} />
    );
    expect(screen.getByText(/AIP-117268/)).toBeInTheDocument();
    expect(screen.getByText(move.feature.error!)).toBeInTheDocument();
    expect(screen.getByText(/跳过本次交付检查/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '接受风险并移动' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('disables confirmation and cancellation while the move is saving', () => {
    render(<AttentionMoveDialog move={move} busy onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '正在移动…' })).toBeDisabled();
  });
});
