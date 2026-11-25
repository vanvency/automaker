import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JIRA_SYNC_CONFIG } from '@automaker/types';
import { JiraSyncSection } from '../../../src/components/views/project-settings-view/jira-sync-section';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/api-fetch', () => ({ apiFetch: mocks.fetch }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/components/views/settings-view/model-defaults/phase-model-selector', () => ({
  PhaseModelSelector: () => <div>Agent model selector</div>,
}));
const config = {
  ...DEFAULT_JIRA_SYNC_CONFIG,
  jiraUrl: 'https://jira.example',
  jiraProject: 'AIP',
  jql: 'project = AIP',
  enabled: true,
};
describe('project Jira configuration', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.fetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({
        success: true,
        result: url.endsWith('/status')
          ? {
              config,
              runs: [],
              running: false,
              jobCount: 199,
              migrated: true,
              legacyAvailable: true,
            }
          : {},
      }),
    }));
  });
  afterEach(() => {
    cleanup();
    client.clear();
  });
  function view() {
    render(
      <QueryClientProvider client={client}>
        <JiraSyncSection project={{ path: '/project' }} />
      </QueryClientProvider>
    );
  }
  it('explains fixed parent delivery and confines the old knobs to explicit hierarchy import', async () => {
    view();
    await waitFor(() => expect(screen.getByLabelText('JQL')).toHaveValue('project = AIP'));
    expect(screen.getByText('Jira 拆分规则')).toBeInTheDocument();
    expect(screen.getByText(/没有 Jira 子任务的 Epic\/Story 不会自动拆分/)).toBeInTheDocument();
    const advanced = screen.getByText('高级层级导入（不影响正常 Jira 同步）').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(advanced?.querySelectorAll('select')).toHaveLength(2);
    fireEvent.click(screen.getByText('高级层级导入（不影响正常 Jira 同步）'));
    fireEvent.change(screen.getByLabelText('层级导入执行单元'), { target: { value: 'task' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith('/api/jira-sync/save', 'POST', {
        body: {
          projectPath: '/project',
          config: {
            ...config,
            hierarchyImport: { executionUnit: 'task', worktreeScope: 'epic' },
          },
        },
      })
    );
  });
  it('previews unsaved JQL without applying synchronization', async () => {
    view();
    await waitFor(() => expect(screen.getByLabelText('JQL')).toHaveValue('project = AIP'));
    fireEvent.change(screen.getByLabelText('JQL'), {
      target: { value: 'project = AIP AND key = AIP-1' },
    });
    expect(screen.getByRole('button', { name: '立即同步' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '预览匹配与变更' }));
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        '/api/jira-sync/preview',
        'POST',
        expect.objectContaining({
          body: expect.objectContaining({
            projectPath: '/project',
            config: expect.objectContaining({ jql: 'project = AIP AND key = AIP-1' }),
          }),
        })
      )
    );
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/sync'))).toBe(false);
  });
  it('pauses the saved configuration without applying unrelated draft edits', async () => {
    view();
    await waitFor(() => expect(screen.getByLabelText('JQL')).toHaveValue('project = AIP'));
    fireEvent.change(screen.getByLabelText('JQL'), { target: { value: 'draft query' } });
    fireEvent.click(screen.getByRole('button', { name: '暂停同步' }));
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith('/api/jira-sync/save', 'POST', {
        body: { projectPath: '/project', config: { ...config, enabled: false } },
      })
    );
  });
  it('previews the latest Jira work and requires a second click before discarding it', async () => {
    mocks.fetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({
        success: true,
        result: url.endsWith('/status')
          ? {
              config,
              runs: [],
              running: false,
              jobCount: 1,
              jobs: [{ issueKey: 'AIP-1', featureId: 'old-card', status: 'ready', claimed: false }],
            }
          : url.endsWith('/reset-preview')
            ? {
                reset: {
                  featureId: 'old-card',
                  issueKey: 'AIP-1',
                  title: 'Latest title',
                  oldBranch: 'old',
                  oldWorktree: '/project/.worktrees/old',
                  newBranch: 'new',
                  hasLocalChanges: true,
                  snapshot: 'a'.repeat(64),
                },
              }
            : { reset: { featureId: 'new-card' } },
      }),
    }));
    view();
    fireEvent.click(await screen.findByText('任务映射与派发状态（1）'));
    fireEvent.click(screen.getByRole('button', { name: '重置 Work' }));
    await screen.findByText(/旧 Worktree 有未提交修改/);
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/reset-work'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认丢弃旧 Work 并重建' }));
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith('/api/jira-sync/reset-work', 'POST', {
        body: { projectPath: '/project', featureId: 'old-card', snapshot: 'a'.repeat(64) },
      })
    );
  });
});
