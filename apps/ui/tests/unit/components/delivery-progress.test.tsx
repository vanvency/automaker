import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DeliveryProgress } from '@/components/views/board-view/components/kanban-card/delivery-progress';
import type { FeatureDelivery } from '@automaker/types';
const apiFetch = vi.fn();
vi.mock('@/lib/api-fetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
const initial: FeatureDelivery = {
  status: 'failed',
  updatedAt: '2026-09-21T00:00:00Z',
  steps: [
    { id: 'merge', status: 'succeeded', message: '2 MR merged' },
    { id: 'jira', status: 'failed', message: 'Jira timed out' },
    { id: 'preview', status: 'pending' },
  ],
};
function renderProgress(onRetry = vi.fn()) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DeliveryProgress featureId="f" projectPath="/p" initial={initial} onRetry={onRetry} />
    </QueryClientProvider>
  );
}
beforeEach(() => apiFetch.mockReset());
describe('delivery progress', () => {
  it('renders the three delivery stages and detailed failure reason', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, progress: initial }),
    });
    renderProgress();
    expect(screen.getByText('MR 合并')).toBeInTheDocument();
    expect(screen.getByText('Jira 关闭')).toBeInTheDocument();
    expect(screen.getByText('预览释放')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Jira 关闭：失败' }));
    expect(screen.getByText('Jira timed out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '请求 Agent 修复' })).toBeInTheDocument();
  });
  it('sends a repair request with the failed step and user context', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, progress: initial }),
    });
    renderProgress();
    fireEvent.click(screen.getByRole('button', { name: 'Jira 关闭：失败' }));
    fireEvent.change(screen.getByLabelText('给 Agent 的修复请求'), {
      target: { value: '检查 Jira token' },
    });
    fireEvent.click(screen.getByRole('button', { name: '请求 Agent 修复' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/features/completion-repair', 'POST', {
        body: { projectPath: '/p', featureId: 'f', stepId: 'jira', instruction: '检查 Jira token' },
      })
    );
    expect(await screen.findByRole('button', { name: '已发送修复请求' })).toBeInTheDocument();
  });
  it('lets the operator retry Complete after a failed delivery', () => {
    const retry = vi.fn();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, progress: initial }),
    });
    renderProgress(retry);
    fireEvent.click(screen.getByRole('button', { name: '核对并重试 Complete' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
