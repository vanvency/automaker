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
  previewConfigRead: vi.fn(),
  previewConfigSave: vi.fn(),
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

  it('edits the project preview JSON and saves it without starting a deployment', async () => {
    api.previewStatus.mockResolvedValue({ success: true, configured: true, preview: null });
    api.previewConfigRead.mockResolvedValue({
      success: true,
      content: '{"enabled":true}',
      revision: 'rev1',
    });
    api.previewConfigSave.mockResolvedValue({ success: true, revision: 'rev2' });
    controls();
    fireEvent.click(screen.getByRole('button', { name: 'Edit project preview configuration' }));
    const field = await screen.findByRole('textbox', { name: 'Preview JSON' });
    expect(field).toHaveValue('{"enabled":true}');
    fireEvent.change(field, { target: { value: '{"enabled":true,"namespace":"preview"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() =>
      expect(api.previewConfigSave).toHaveBeenCalledWith(
        '/project',
        '{"enabled":true,"namespace":"preview"}',
        'rev1'
      )
    );
    expect(api.previewStart).not.toHaveBeenCalled();
  });

  it('shows the last deployment attempt and its readiness time', async () => {
    api.previewStatus.mockResolvedValue({
      success: true,
      configured: true,
      preview: {
        status: 'ready',
        url: 'http://preview.test/a',
        deploymentStartedAt: '2026-11-07T09:00:00Z',
        deployedAt: '2026-11-07T09:02:00Z',
      },
    });
    controls();
    const stamp = await screen.findByText(/最近部署：/);
    expect(stamp).toHaveAttribute('dateTime', '2026-11-07T09:00:00Z');
    expect(stamp.title).toContain('就绪：');
  });

  it('uses the recorded deployment step for previews created before timestamps existed', async () => {
    api.previewStatus.mockResolvedValue({
      success: true,
      configured: true,
      preview: {
        status: 'ready',
        url: 'http://preview.test/a',
        logs: [
          { step: 'Validate preview namespace', status: 'running', at: '2026-11-06T09:00:00Z' },
        ],
      },
    });
    controls();
    expect(await screen.findByText(/最近部署：/)).toHaveAttribute(
      'dateTime',
      '2026-11-06T09:00:00Z'
    );
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
    expect(screen.queryByText('feature-b')).not.toBeInTheDocument();
    expect(screen.queryByText('Feature Preview')).not.toBeInTheDocument();
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
    expect(await screen.findByText('Preview not deployed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Deploy Preview' })).toHaveTextContent(
      'Deploy Preview'
    );
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

  it('shows a status lamp, visible Stop label and recorded step failures', async () => {
    api.previewStatus.mockResolvedValue({
      success: true,
      configured: true,
      preview: {
        status: 'failed',
        error: 'builder exited with code 1',
        logs: [
          {
            at: '2026-09-23T01:00:00Z',
            step: 'Build preview image',
            status: 'running',
            message: 'Started',
          },
          {
            at: '2026-09-23T01:00:01Z',
            step: 'Build preview image',
            status: 'failed',
            message: 'Check buildCommand and Dockerfile.',
            command: 'bash /project/.automaker/preview-build.sh local/image',
            exitCode: 1,
            output: 'stderr:\nError: missing dependency',
          },
        ],
      },
    });
    controls();
    expect(await screen.findByRole('img', { name: 'Preview status: error' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop Preview' })).toHaveTextContent('Stop Preview');
    fireEvent.click(screen.getByRole('button', { name: 'Deployment logs' }));
    expect(await screen.findByRole('dialog')).toBeVisible();
    expect(screen.getByText('Check buildCommand and Dockerfile.')).toBeVisible();
    expect(screen.getByText(/bash \/project\/.automaker\/preview-build\.sh/)).toBeVisible();
    expect(screen.getByText(/Error: missing dependency/)).toBeVisible();
    expect(screen.getByText('failed · exit 1')).toBeVisible();
    expect(screen.getByRole('list', { name: 'Deployment steps' }).children).toHaveLength(1);
  });

  it('shows changed component configuration and filters its steps', async () => {
    api.previewStatus.mockResolvedValue({
      success: true,
      configured: true,
      preview: {
        status: 'deploying',
        devbridge: true,
        devbridgeConfig: {
          capturedAt: '2026-09-23T00:00:00Z',
          configFile: '.devbridge.yaml',
          sourceRoot: '/worktree',
          stripPrefix: '/gateway',
          namespace: 'preview',
          gateway: 'http://gateway',
          listen: '127.0.0.1:0',
          autoReattach: true,
          maxAttempts: 5,
          components: [
            {
              name: 'backend',
              dir: 'backend/api',
              target: 'deployment/backend/container/api',
              localPort: 8080,
              remotePort: 80,
              routes: ['/api'],
              healthPath: '/health',
              buildTool: 'go',
              environmentKeys: ['API_TOKEN'],
              changeStatus: 'changed',
              changedFiles: 3,
              baseRef: 'origin/dev',
            },
          ],
        },
        logs: [
          {
            at: '2026-09-23T00:00:01Z',
            step: 'Devbridge · backend: build application',
            status: 'running',
            message: 'Compute source fingerprint.',
          },
          {
            at: '2026-09-23T00:00:02Z',
            step: 'Apply deployment and service',
            status: 'succeeded',
            message: 'Completed',
          },
        ],
      },
    });
    controls();
    fireEvent.click(await screen.findByRole('button', { name: 'Deployment logs' }));
    expect(screen.getByText('backend · 3 changed files')).toBeVisible();
    expect(screen.getByText('deployment/backend/container/api')).toBeVisible();
    expect(screen.getByText('origin/dev')).toBeVisible();
    expect(screen.getByText('API_TOKEN')).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter component steps' }), {
      target: { value: 'backend' },
    });
    expect(screen.getByText('Devbridge · backend: build application')).toBeVisible();
    expect(screen.queryByText('Apply deployment and service')).not.toBeInTheDocument();
  });
});
