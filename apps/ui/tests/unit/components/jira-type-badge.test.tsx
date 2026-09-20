import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JiraTypeBadge } from '../../../src/components/views/board-view/components/jira-type-badge';

describe('JiraTypeBadge', () => {
  it('labels each normalized Jira work type', () => {
    const cases: Array<[string, string]> = [
      ['epic', 'EPIC'],
      ['story', 'STORY'],
      ['task', 'TASK'],
      ['feat', 'FEAT'],
      ['impr', 'IMPR'],
      ['bugfix', 'BUGFIX'],
    ];
    for (const [type, label] of cases) {
      const { unmount } = render(<JiraTypeBadge type={type} data-testid={`badge-${type}`} />);
      expect(screen.getByTestId(`badge-${type}`)).toHaveTextContent(label);
      unmount();
    }
  });

  it('renders nothing without a type', () => {
    const { container } = render(<JiraTypeBadge type={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
