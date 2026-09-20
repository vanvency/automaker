import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JiraSubtaskList } from '../../../src/components/views/board-view/components/kanban-card/jira-subtask-list';
import type { Feature } from '@automaker/types';

function featureWith(subtasks: Feature['jiraSubtasks']): Feature {
  return {
    id: 'jira-dodo-aip-114927',
    title: 'AIP-114927: 【载荷】整理入口与目标版本',
    category: 'Jira AIP / dodo',
    description: 'Implement Jira AIP-114927',
    jiraKey: 'AIP-114927',
    jiraUrl: 'https://jira.transwarp.io/browse/AIP-114927',
    jiraSubtasks: subtasks,
  } as Feature;
}

describe('JiraSubtaskList', () => {
  it('lists every Jira subtask the worktree covers, with links', () => {
    render(
      <JiraSubtaskList
        feature={featureWith([
          {
            key: 'AIP-114928',
            summary: '[S4·FE] 整理入口、三档 ask card 与目标版本卡',
            status: '待办',
            type: 'Frontend-Task',
          },
          {
            key: 'AIP-114929',
            summary: '[S4·BE·SM] 会话提交契约扩展与计划快照持久化',
            status: 'In Progress',
            type: 'Backend-Task',
          },
          {
            key: 'AIP-114932',
            summary: '[S4·QA] 进入整理与目标版本验收',
            status: '完成',
            type: 'QA-Task',
          },
        ])}
      />
    );

    expect(screen.getByTestId('jira-subtasks-jira-dodo-aip-114927')).toBeInTheDocument();
    expect(screen.getByText('Jira 子任务 3')).toBeInTheDocument();
    expect(screen.getByText('1/3 已完成 · 33%')).toBeInTheDocument();
    for (const key of ['AIP-114928', 'AIP-114929', 'AIP-114932']) {
      const link = screen.getByTestId(`jira-subtask-link-jira-dodo-aip-114927-${key}`);
      expect(link).toHaveAttribute('href', `https://jira.transwarp.io/browse/${key}`);
    }
    expect(screen.getByText('待办')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });

  it('renders nothing without subtasks', () => {
    render(<JiraSubtaskList feature={featureWith(undefined)} />);
    expect(screen.queryByTestId('jira-subtasks-jira-dodo-aip-114927')).not.toBeInTheDocument();
  });
});
