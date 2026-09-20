import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Feature } from '@automaker/types';
import { CardDetailsDialog } from '@/components/views/board-view/components/kanban-card/card-details-dialog';
import {
  GoalList,
  GoalSummaryBar,
  splitGoals,
} from '@/components/views/board-view/components/kanban-card/goal-list';

const collectAcceptanceEvidence = vi.fn(async () => ({ success: true }));
vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({ features: { collectAcceptanceEvidence } }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const GOALS = [
  { goal: '解析 Jira 需求', status: 'done' as const, note: '从 AIP-114859 拉取' },
  { goal: '实现导出', status: 'in_progress' as const },
  { goal: '补齐测试', status: 'blocked' as const, note: '等 QA 环境' },
  { goal: '写回 Jira', status: 'pending' as const },
  { goal: '三个 MR 评审并合入 dev', status: 'pending' as const },
];

const FEATURE = {
  id: 'jira-dodo-aip-114859',
  title: 'AIP-114859: 审计日志导出',
  description: '第一行\n第二行\n第三行\n第四行\n第五行',
  jiraKey: 'AIP-114859',
  goals: GOALS,
  jiraSubtasks: [{ key: 'AIP-114860', summary: '导出接口' }],
} as unknown as Feature;

describe('card details dialog', () => {
  beforeEach(() => {
    collectAcceptanceEvidence.mockClear();
  });

  it('shows the full description, every goal and the Jira sub-tasks', () => {
    renderWithQuery(
      <CardDetailsDialog feature={FEATURE} isOpen onOpenChange={vi.fn()} projectPath="/p" />
    );

    expect(screen.getByTestId('card-details-jira-dodo-aip-114859')).toBeInTheDocument();
    expect(screen.getByText(/第五行/)).toBeInTheDocument();
    expect(screen.getByText('目标 1/4')).toBeInTheDocument();
    expect(screen.getByText('实现导出')).toBeInTheDocument();
    expect(screen.getByText('等 QA 环境')).toBeInTheDocument();
    expect(screen.getByText('Jira 子任务')).toBeInTheDocument();
    // MR work is not a development goal: it gets its own section.
    expect(screen.getByText('合并 / 评审 1')).toBeInTheDocument();
    expect(screen.getByText('三个 MR 评审并合入 dev')).toBeInTheDocument();
  });

  it('renders nothing but the frame for a card with no long material', () => {
    renderWithQuery(
      <CardDetailsDialog
        feature={{ id: 'plain', description: '', title: 'plain' } as unknown as Feature}
        isOpen
        onOpenChange={vi.fn()}
      />
    );

    expect(screen.queryByText('任务描述')).not.toBeInTheDocument();
    expect(screen.queryByText('目标 0/0')).not.toBeInTheDocument();
  });

  it('offers to collect an existing acceptance manifest', async () => {
    renderWithQuery(
      <CardDetailsDialog feature={FEATURE} isOpen onOpenChange={vi.fn()} projectPath="/p" />
    );

    fireEvent.click(screen.getByTestId('collect-acceptance-jira-dodo-aip-114859'));

    expect(collectAcceptanceEvidence).toHaveBeenCalledWith('/p', 'jira-dodo-aip-114859');
    expect(await screen.findByText('已收集')).toBeInTheDocument();
  });
});

describe('goal phases', () => {
  it('separates merge/after-complete goals from development goals', () => {
    const { development, merge } = splitGoals(GOALS);
    expect(development.map((goal) => goal.goal)).toEqual([
      '解析 Jira 需求',
      '实现导出',
      '补齐测试',
      '写回 Jira',
    ]);
    expect(merge.map((goal) => goal.goal)).toEqual(['三个 MR 评审并合入 dev']);
  });
});

describe('goal progress', () => {
  it('keeps the card face compact and opens the details on click', () => {
    const openDetails = vi.fn();
    render(<GoalSummaryBar goals={GOALS} onOpenDetails={openDetails} />);

    expect(screen.getByText('Goals')).toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeInTheDocument();
    // The merge goal does not hold back the development progress.
    expect(screen.getByText('+1 合并')).toBeInTheDocument();
    // The full goal text stays in the dialog, not on the card face.
    expect(screen.queryByText('解析 Jira 需求')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('goal-progress-解析 Jira 需求'));
    expect(openDetails).toHaveBeenCalledOnce();
  });

  it('lists every goal with its status and note when expanded', () => {
    render(<GoalList goals={GOALS} />);
    expect(screen.getByText('解析 Jira 需求')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('阻塞')).toBeInTheDocument();
  });
});
