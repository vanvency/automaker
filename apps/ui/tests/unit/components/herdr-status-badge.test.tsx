import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HerdrStatusBadge } from '@/components/views/board-view/components/kanban-card/herdr-status-badge';

const getHerdrTask = vi.fn();

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({
    features: {
      getHerdrTask: (...args: unknown[]) => getHerdrTask(...args),
    },
  }),
}));

describe('HerdrStatusBadge', () => {
  beforeEach(() => {
    getHerdrTask.mockReset();
  });

  it('renders nothing when the feature has no herdr workspace', async () => {
    getHerdrTask.mockResolvedValue({ success: true, status: null });
    const { container } = render(
      <TooltipProvider>
        <HerdrStatusBadge projectPath="/proj" featureId="f1" />
      </TooltipProvider>
    );
    await waitFor(() => expect(getHerdrTask).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="herdr-status-badge-f1"]')).toBeNull();
  });

  it('shows a working badge when any agent is working', async () => {
    getHerdrTask.mockResolvedValue({
      success: true,
      status: {
        workspaceId: 'w1',
        label: 'Task',
        leaderPaneId: 'w1:p1',
        agents: [
          { paneId: 'w1:p1', name: 'leader', agent: 'pi', status: 'idle' },
          { paneId: 'w1:p2', name: 'worker-1', agent: 'pi', status: 'working' },
        ],
      },
    });
    render(
      <TooltipProvider>
        <HerdrStatusBadge projectPath="/proj" featureId="f2" />
      </TooltipProvider>
    );
    await waitFor(() => expect(screen.getByTestId('herdr-status-badge-f2')).toBeInTheDocument());
  });

  it('shows a blocked badge when an agent is blocked', async () => {
    getHerdrTask.mockResolvedValue({
      success: true,
      status: {
        workspaceId: 'w1',
        label: 'Task',
        leaderPaneId: 'w1:p1',
        agents: [{ paneId: 'w1:p1', name: 'leader', agent: 'pi', status: 'blocked' }],
      },
    });
    render(
      <TooltipProvider>
        <HerdrStatusBadge projectPath="/proj" featureId="f3" />
      </TooltipProvider>
    );
    await waitFor(() => expect(screen.getByTestId('herdr-status-badge-f3')).toBeInTheDocument());
  });

  it('keeps polling after a transient error', async () => {
    getHerdrTask.mockRejectedValueOnce(new Error('socket unavailable')).mockResolvedValue({
      success: true,
      status: {
        workspaceId: 'w2',
        label: 'Later',
        leaderPaneId: 'w2:p1',
        agents: [{ paneId: 'w2:p1', name: 'leader', agent: 'pi', status: 'working' }],
      },
    });
    render(
      <TooltipProvider>
        <HerdrStatusBadge projectPath="/proj" featureId="f5" pollIntervalMs={10} />
      </TooltipProvider>
    );
    await waitFor(() => expect(screen.getByTestId('herdr-status-badge-f5')).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(getHerdrTask).toHaveBeenCalledTimes(2);
  });
});
