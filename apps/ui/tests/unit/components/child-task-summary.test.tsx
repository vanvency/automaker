import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChildTaskSummary } from '@/components/views/board-view/components/kanban-card/child-task-summary';
import type { Feature } from '@/store/app-store';

function feature(id: string, overrides: Partial<Feature> = {}): Feature {
  return {
    id,
    category: 'Jira AIP',
    description: `description of ${id}`,
    status: 'backlog',
    ...overrides,
  } as Feature;
}

describe('ChildTaskSummary', () => {
  const parent = feature('jira-dodo-aip-114879', {
    title: 'AIP-114879 parent',
    jiraKey: 'AIP-114879',
    branchName: 'jira/aip-114879-dodo',
    status: 'waiting_approval',
  });

  const children = [
    feature('aip-114879-child-1', {
      title: 'child one',
      jiraKey: 'AIP-114879',
      status: 'verified',
      createdAt: '2026-09-14T10:00:00.000Z',
    }),
    feature('aip-114879-child-2', {
      title: 'child two',
      status: 'waiting_approval',
      createdAt: '2026-09-14T11:00:00.000Z',
    }),
    feature('aip-114879-child-3', {
      title: 'child three',
      status: 'backlog',
      createdAt: '2026-09-14T12:00:00.000Z',
    }),
  ];

  it('lists every child of the parent with its status and progress', () => {
    render(<ChildTaskSummary feature={parent} allFeatures={[parent, ...children]} />);

    expect(screen.getByTestId('child-task-summary-jira-dodo-aip-114879')).toBeInTheDocument();
    expect(screen.getByText('子任务 3')).toBeInTheDocument();
    expect(screen.getByText(/1\/3 已完成/)).toBeInTheDocument();
    expect(screen.getByText('child one')).toBeInTheDocument();
    expect(screen.getByText('child three')).toBeInTheDocument();
    // one verified child, two others pending
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('待验收')).toBeInTheDocument();
    expect(screen.getByText('待执行')).toBeInTheDocument();
  });

  it('renders nothing when the feature has no children', () => {
    const { container } = render(<ChildTaskSummary feature={parent} allFeatures={[parent]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
