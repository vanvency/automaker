import { render, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Feature } from '@automaker/types';
import { TaskNotice } from '../../../src/components/views/board-view/components/task-notice';

describe('task notice details', () => {
  it('opens the complete error with its source and time without editing the card', () => {
    const edit = vi.fn();
    const message = '429: No deployments available\n' + 'Long error detail. '.repeat(100);
    render(
      <div onClick={edit} onDoubleClick={edit}>
        <TaskNotice
          feature={
            {
              id: 'task',
              error: message,
              executionNotice: {
                kind: 'error',
                source: 'execution',
                message,
                occurredAt: '2026-09-19T10:00:00Z',
              },
            } as Feature
          }
        />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: '查看任务提示详情' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(message.replace('\n', ' ').trim());
    expect(screen.getByText(/执行器错误/)).toBeInTheDocument();
    expect(edit).not.toHaveBeenCalled();
  });

  it('does not label a legacy error with unrelated metadata', () => {
    render(
      <TaskNotice
        feature={
          {
            id: 'legacy',
            error: 'old delivery blocker',
            executionNotice: {
              kind: 'error',
              source: 'execution',
              message: 'different error',
              occurredAt: new Date().toISOString(),
            },
          } as Feature
        }
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('历史任务提示（来源时间未记录）')).toBeInTheDocument();
  });
});
