import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoardWorktreePreview,
  WorktreePreviewControls,
} from '../../../src/components/views/worktree-preview';

const api = vi.hoisted(() => ({
  previewStatus: vi.fn(),
  previewStart: vi.fn(),
  previewStop: vi.fn(),
}));
vi.mock('@/lib/electron', () => ({ getElectronAPI: () => ({ worktree: api }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

describe('worktree preview controls', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    cleanup();
    client.clear();
  });

  function controls(paths = ['/project/a']) {
    return render(
      <QueryClientProvider client={client}>
        {paths.map((worktreePath) => (
          <WorktreePreviewControls
            key={worktreePath}
            projectPath="/project"
            worktreePath={worktreePath}
          />
        ))}
      </QueryClientProvider>
    );
  }

  it('shows a separate URL for each worktree', async () => {
    api.previewStatus.mockImplementation(async (_project, worktree) => ({
      success: true,
      configured: true,
      preview: { status: 'ready', url: `http://preview.test/${worktree.split('/').pop()}` },
    }));
    controls(['/project/a', '/project/b']);
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'Open Preview' })).toHaveLength(2)
    );
    const links = screen.getAllByRole('link', { name: 'Open Preview' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'http://preview.test/a',
      'http://preview.test/b',
    ]);
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never links a pending or failed deployment and exposes its error', async () => {
    api.previewStatus.mockResolvedValue({
      success: true,
      configured: true,
      preview: { status: 'failed', url: 'http://old.test', error: 'Build failed' },
    });
    controls();
    expect(await screen.findByText('Build failed')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('switches the board preview with its worktree without retaining the previous URL', async () => {
    api.previewStatus.mockResolvedValueOnce({
      success: true,
      configured: true,
      preview: { status: 'ready', url: 'http://preview.test/a' },
    });
    const board = (worktreePath: string, branch: string) => (
      <QueryClientProvider client={client}>
        <BoardWorktreePreview projectPath="/project" worktreePath={worktreePath} branch={branch} />
      </QueryClientProvider>
    );
    const view = render(board('/project/a', 'feature-a'));
    expect(await screen.findByRole('link', { name: 'Open Preview' })).toHaveAttribute(
      'href',
      'http://preview.test/a'
    );
    let resolveStatus!: (value: unknown) => void;
    api.previewStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );
    view.rerender(board('/project/b', 'feature-b'));
    expect(screen.getByText('feature-b')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Preview' })).not.toBeInTheDocument();
    await waitFor(() => expect(resolveStatus).toBeDefined());
    resolveStatus({
      success: true,
      configured: true,
      preview: { status: 'ready', url: 'http://preview.test/b' },
    });
    expect(await screen.findByRole('link', { name: 'Open Preview' })).toHaveAttribute(
      'href',
      'http://preview.test/b'
    );
    expect(api.previewStatus).toHaveBeenLastCalledWith('/project', '/project/b');
  });

  it('deploys the selected worktree and refreshes status', async () => {
    api.previewStatus.mockResolvedValue({ success: true, configured: true, preview: null });
    api.previewStart.mockResolvedValue({ success: true });
    controls();
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy Preview' }));
    await waitFor(() => expect(api.previewStart).toHaveBeenCalledWith('/project', '/project/a'));
    await waitFor(() => expect(api.previewStatus.mock.calls.length).toBeGreaterThan(1));
  });

  it('allows cleanup when project previews are disabled', async () => {
    api.previewStatus.mockResolvedValue({
      success: true,
      configured: false,
      preview: { status: 'ready', url: 'http://preview.test' },
    });
    api.previewStop.mockResolvedValue({ success: true });
    controls();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Preview' }));
    await waitFor(() => expect(api.previewStop).toHaveBeenCalledWith('/project', '/project/a'));
    expect(screen.queryByRole('button', { name: 'Redeploy' })).not.toBeInTheDocument();
  });
});
