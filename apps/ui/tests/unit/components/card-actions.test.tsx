import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CardActions } from '@/components/views/board-view/components/kanban-card/card-actions';
import type { Feature } from '@automaker/types';

describe('CardActions conversation entry', () => {
  it('opens human acceptance before completing an automatically verified task', () => {
    const onComplete = vi.fn();
    const onViewAcceptance = vi.fn();
    const props = {
      feature: { id: 'auto', status: 'verified' } as Feature,
      isCurrentAutoTask: false,
      onComplete,
      onViewAcceptance,
    };
    const { rerender } = render(<CardActions {...props} />);
    fireEvent.click(screen.getByTestId('complete-auto'));
    expect(onViewAcceptance).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    rerender(<CardActions {...props} feature={{ ...props.feature, completionSource: 'human' }} />);
    fireEvent.click(screen.getByTestId('complete-auto'));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('offers Verify in the approval lane to open the acceptance result', () => {
    const viewAcceptance = vi.fn();
    render(
      <CardActions
        feature={{ id: 'approval', status: 'waiting_approval' } as Feature}
        isCurrentAutoTask={false}
        onViewAcceptance={viewAcceptance}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('verify-acceptance-approval'));
    expect(viewAcceptance).toHaveBeenCalledOnce();
    // Reply stays available next to it.
    expect(screen.getByTestId('reply-approval')).toBeInTheDocument();
  });

  it('does not offer Verify outside the approval lane', () => {
    render(
      <CardActions
        feature={{ id: 'backlog', status: 'backlog' } as Feature}
        isCurrentAutoTask={false}
        onViewAcceptance={vi.fn()}
        onImplement={vi.fn()}
      />
    );
    expect(screen.queryByTestId('verify-acceptance-backlog')).not.toBeInTheDocument();
  });

  it('offers Reply but no Verify for a Needs Attention card', () => {
    const reply = vi.fn();
    render(
      <CardActions
        feature={
          {
            id: 'needs-attention',
            status: 'waiting_approval',
            error: 'No active execution after dispatch; manual review needed before retry',
          } as Feature
        }
        isCurrentAutoTask={false}
        onViewAcceptance={vi.fn()}
        onFollowUp={reply}
        onOpenHerdr={vi.fn()}
      />
    );

    // The notice blocks verification until a human resolves it.
    expect(screen.queryByTestId('verify-acceptance-needs-attention')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('reply-needs-attention'));
    expect(reply).toHaveBeenCalledOnce();
  });

  it('allows replying to a failed backlog task without forcing Retry', () => {
    const reply = vi.fn();
    render(
      <CardActions
        feature={{ id: 'failed', status: 'backlog', error: '429 model unavailable' } as Feature}
        isCurrentAutoTask={false}
        onFollowUp={reply}
        onImplement={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('reply-failed'));
    expect(reply).toHaveBeenCalledOnce();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('does not offer a duplicate reply while a backlog task is actually running', () => {
    render(
      <CardActions
        feature={{ id: 'running', status: 'backlog', error: 'old error' } as Feature}
        isCurrentAutoTask={false}
        isRunningTask
        onFollowUp={vi.fn()}
        onImplement={vi.fn()}
      />
    );
    expect(screen.queryByTestId('reply-running')).not.toBeInTheDocument();
  });

  it('renders backlog logs button when context exists', () => {
    const feature = {
      id: 'feature-logs',
      status: 'backlog',
      error: undefined,
    } as unknown as Feature;

    render(
      <CardActions
        feature={feature}
        isCurrentAutoTask={false}
        isRunningTask={false}
        hasContext
        onEdit={vi.fn()}
        onViewOutput={vi.fn()}
        onImplement={vi.fn()}
      />
    );

    expect(screen.getByTestId('view-output-backlog-feature-logs')).toBeInTheDocument();
  });

  it('does not render backlog logs button without context', () => {
    const feature = {
      id: 'feature-no-logs',
      status: 'backlog',
      error: undefined,
    } as unknown as Feature;

    render(
      <CardActions
        feature={feature}
        isCurrentAutoTask={false}
        isRunningTask={false}
        onEdit={vi.fn()}
        onViewOutput={vi.fn()}
        onImplement={vi.fn()}
      />
    );

    expect(screen.queryByTestId('view-output-backlog-feature-no-logs')).not.toBeInTheDocument();
  });

  it('shows the unified herdr conversation button for every provider', () => {
    for (const model of [
      'pi:litellm/worker',
      'opencode:litellm/auto',
      'claude-opus-4-6',
      'cursor-auto',
      undefined,
    ]) {
      const onOpenHerdr = vi.fn();
      const feature = {
        id: 'feature-herdr',
        status: 'waiting_approval',
        model,
        error: undefined,
      } as unknown as Feature;

      render(
        <CardActions
          feature={feature}
          isCurrentAutoTask={false}
          isRunningTask={false}
          onEdit={vi.fn()}
          onOpenHerdr={onOpenHerdr}
        />
      );

      const button = screen.getByTestId('open-herdr-feature-herdr');
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent('Agent');

      fireEvent.click(button);
      expect(onOpenHerdr).toHaveBeenCalledTimes(1);

      // The provider-specific entries are gone.
      expect(screen.queryByTestId('open-opencode-web-feature-herdr')).not.toBeInTheDocument();
      expect(screen.queryByTestId('open-pi-web-feature-herdr')).not.toBeInTheDocument();

      cleanup();
    }
  });

  it('hides the conversation button when herdr is unavailable', () => {
    const feature = {
      id: 'feature-hidden',
      status: 'in_progress',
      error: undefined,
    } as unknown as Feature;

    render(
      <CardActions
        feature={feature}
        isCurrentAutoTask={false}
        isRunningTask={false}
        onEdit={vi.fn()}
        onOpenWeb={vi.fn()}
        onOpenPiWeb={vi.fn()}
      />
    );

    expect(screen.queryByTestId('open-herdr-feature-hidden')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-opencode-web-feature-hidden')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-pi-web-feature-hidden')).not.toBeInTheDocument();
  });
});

import { cleanup } from '@testing-library/react';
