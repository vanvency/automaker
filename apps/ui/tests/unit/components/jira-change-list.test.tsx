import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JiraChangeList } from '../../../src/components/views/board-view/components/kanban-card/jira-change-list';

describe('JiraChangeList', () => {
  it('renders nothing without changes', () => {
    const { container } = render(<JiraChangeList changes={[]} data-testid="jira-changes-x" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the before and after value for an edit', () => {
    render(
      <JiraChangeList
        changes={[{ field: 'requirements', before: 'aaaa', after: 'bbbb' }]}
        data-testid="jira-changes-x"
      />
    );

    expect(screen.getByTestId('jira-changes-x')).toBeInTheDocument();
    expect(screen.getByText('Jira 已变更')).toBeInTheDocument();
    expect(screen.getByText('需求描述')).toBeInTheDocument();
    expect(screen.getByText(/aaaa/)).toBeInTheDocument();
    expect(screen.getByText(/bbbb/)).toBeInTheDocument();
  });

  it('shows only the removed value for a deletion', () => {
    render(
      <JiraChangeList
        changes={[{ field: 'subtasks', before: 'AIP-2 removed: x' }]}
        data-testid="jira-changes-y"
      />
    );

    expect(screen.getByText(/AIP-2 removed/)).toBeInTheDocument();
    expect(screen.queryByText('→')).not.toBeInTheDocument();
  });

  it('renders every change as its own row', () => {
    render(
      <JiraChangeList
        changes={[
          { field: 'assignee', before: 'a', after: 'b' },
          { field: 'labels', before: 'dodo', after: 'kaka' },
        ]}
        data-testid="jira-changes-z"
      />
    );

    expect(screen.getAllByTestId('jira-changes-z-item')).toHaveLength(2);
  });
});
