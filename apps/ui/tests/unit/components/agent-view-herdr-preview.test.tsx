/**
 * AgentView - herdr mode preview.
 *
 * The sidebar's Agent entry used to be the in-app chat runner. It is now a live
 * preview of the herdr workspace that supervises the current project/worktree,
 * so these tests pin the contract of that view: the preview request it makes
 * and what it renders for the happy path and for an unavailable herdr.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getPreview: vi.fn(),
  // Empty in web mode, an absolute URL in Electron (see getServerUrlSync).
  serverUrl: '',
  store: {
    currentProject: { path: '/projects/demo', name: 'Demo' } as {
      path: string;
      name: string;
    } | null,
    getCurrentWorktree: vi.fn(),
  },
}));

vi.mock('@/store/app-store', () => ({
  useAppStore: () => mocks.store,
}));

vi.mock('@/lib/http-api-client', () => ({
  getHttpApiClient: () => ({ herdr: { getPreview: mocks.getPreview } }),
  getApiKey: () => 'page-api-key',
  getSessionToken: () => null,
  getServerUrlSync: () => mocks.serverUrl,
}));

import { AgentView } from '@/components/views/agent-view';

function previewResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    sessionName: 'am-demo',
    terminalSessionId: 'term-1',
    workDir: '/projects/demo',
    reused: true,
    ...overrides,
  };
}

describe('AgentView herdr preview', () => {
  beforeEach(() => {
    mocks.getPreview.mockReset();
    mocks.serverUrl = '';
    mocks.store.getCurrentWorktree.mockReset();
    mocks.store.getCurrentWorktree.mockReturnValue(null);
    mocks.store.currentProject = { path: '/projects/demo', name: 'Demo' };
  });

  it('attaches a preview on mount and embeds the hosted terminal', async () => {
    mocks.getPreview.mockResolvedValue(previewResult());

    render(<AgentView />);

    // Without a worktree the project directory is the working directory.
    await waitFor(() =>
      expect(mocks.getPreview).toHaveBeenCalledWith('/projects/demo', '/projects/demo')
    );
    const frame = await screen.findByTestId('herdr-preview-frame');
    const src = frame.getAttribute('src') ?? '';
    expect(src).toContain('/api/herdr/view');
    expect(src).toContain('session=term-1');
    // Web mode shares an origin with the server (the Vite proxy).
    expect(src.startsWith(window.location.origin)).toBe(true);
    expect(screen.getByTestId('herdr-preview-reused')).toBeInTheDocument();
  });

  it('points the frame at the API server when the renderer has its own origin', async () => {
    // Electron serves the renderer from a static server that cannot proxy /api.
    mocks.serverUrl = 'http://localhost:3008';
    mocks.getPreview.mockResolvedValue(previewResult());

    render(<AgentView />);

    const frame = await screen.findByTestId('herdr-preview-frame');
    expect(frame.getAttribute('src')).toContain('http://localhost:3008/api/herdr/view');
  });

  it('scopes the preview to the active worktree', async () => {
    mocks.store.getCurrentWorktree.mockReturnValue({
      path: '/projects/demo/.worktrees/feature-a',
    });
    mocks.getPreview.mockResolvedValue(
      previewResult({ workDir: '/projects/demo/.worktrees/feature-a' })
    );

    render(<AgentView />);

    await waitFor(() =>
      expect(mocks.getPreview).toHaveBeenCalledWith(
        '/projects/demo',
        '/projects/demo/.worktrees/feature-a'
      )
    );
  });

  it('explains that herdr is unavailable instead of embedding a dead frame', async () => {
    mocks.getPreview.mockResolvedValue({
      success: false,
      error: 'herdr is not installed on this machine (install herdr or set HERDR_BIN)',
    });

    render(<AgentView />);

    expect(await screen.findByText(/herdr is not installed on this machine/)).toBeInTheDocument();
    expect(screen.queryByTestId('herdr-preview-frame')).not.toBeInTheDocument();
  });

  it('prompts for a project when none is selected', async () => {
    mocks.store.currentProject = null;

    render(<AgentView />);

    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(mocks.getPreview).not.toHaveBeenCalled();
  });
});
