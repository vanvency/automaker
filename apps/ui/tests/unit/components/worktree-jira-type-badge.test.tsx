import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorktreeDropdownItem } from '../../../src/components/views/board-view/worktree-panel/components/worktree-dropdown-item';
import type { WorktreeInfo } from '../../../src/components/views/board-view/worktree-panel/types';
import { DropdownMenu, DropdownMenuContent } from '../../../src/components/ui/dropdown-menu';

const worktree = {
  path: '/workspace/vibe-llmops/.worktrees/aip-114859-dodo',
  branch: 'jira/aip-114859-dodo',
  isMain: false,
} as unknown as WorktreeInfo;

describe('WorktreeDropdownItem Jira type badge', () => {
  /** DropdownMenuItem requires a menu context, so render inside an open menu. */
  function renderItem(props: React.ComponentProps<typeof WorktreeDropdownItem>) {
    return render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <WorktreeDropdownItem {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it('shows the Jira work type in front of the branch name', () => {
    renderItem({
      worktree,
      isSelected: false,
      isRunning: false,
      jiraType: 'impr',
      onSelect: vi.fn(),
    });

    const badge = screen.getByTestId('worktree-jira-type-jira/aip-114859-dodo');
    expect(badge).toHaveTextContent('IMPR');

    const row = badge.parentElement as HTMLElement;
    const children = Array.from(row.children);
    const badgeIndex = children.indexOf(badge);
    // The branch name renders after the badge, so the type reads first.
    expect(badgeIndex).toBeGreaterThanOrEqual(0);
    expect(badgeIndex).toBeLessThan(children.length - 1);
    expect(row.textContent?.indexOf('IMPR')).toBeLessThan(
      row.textContent?.indexOf('jira/aip-114859-dodo') ?? -1
    );
  });

  it('renders no badge without a Jira type', () => {
    renderItem({
      worktree,
      isSelected: false,
      isRunning: false,
      onSelect: vi.fn(),
    });

    expect(screen.queryByTestId('worktree-jira-type-jira/aip-114859-dodo')).not.toBeInTheDocument();
  });
});
