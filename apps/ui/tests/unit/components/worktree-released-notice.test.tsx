// A card whose checkout was released after the Done retention window keeps its
// branch and history, so the card face says so instead of looking broken.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Feature } from '@automaker/types';

import { CardContentSections } from '@/components/views/board-view/components/kanban-card/card-content-sections';

function card(fields: Partial<Feature> = {}): Feature {
  return {
    id: 'card-1',
    title: 'Task',
    category: 'test',
    description: 'x',
    status: 'verified',
    ...fields,
  } as Feature;
}

describe('released worktree notice', () => {
  it('explains the released checkout and the rebuild', () => {
    render(
      <CardContentSections
        feature={card({
          worktreeRelease: {
            releasedAt: '2026-09-10T00:00:00.000Z',
            path: '/project/.worktrees/aip-1',
            branch: 'jira/aip-1-dodo',
          },
        })}
      />
    );

    const notice = screen.getByTestId('worktree-released-card-1');
    expect(notice).toHaveTextContent('worktree 已释放');
    expect(notice).toHaveTextContent('jira/aip-1-dodo');
    expect(notice).toHaveTextContent('自动重建');
  });

  it('stays quiet while the checkout is still on disk', () => {
    render(<CardContentSections feature={card()} />);
    expect(screen.queryByTestId('worktree-released-card-1')).toBeNull();
  });
});
