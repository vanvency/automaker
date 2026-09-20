import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Feature } from '@automaker/types';

const listTaskAgents = vi.fn();
const prompt = vi.fn();
const streamingQuery = vi.fn();

vi.mock('../../../src/services/herdr-task-service.js', () => ({
  getHerdrTaskService: () => ({ listTaskAgents, prompt }),
}));
vi.mock('../../../src/providers/simple-query-service.js', () => ({
  streamingQuery: (...args: unknown[]) => streamingQuery(...args),
}));

const { notifyRunningAgentOfJiraChanges, requirementChanges, summarizeRequirementChanges } =
  await import('../../../src/services/jira-change-notifier.js');

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'jira-dodo-aip-1',
    title: 'AIP-1: task',
    jiraKey: 'AIP-1',
    status: 'in_progress',
    herdrWorkspaceId: 'w1',
    herdrTabId: 'w1:t1',
    ...overrides,
  } as Feature;
}

describe('jira-change-notifier', () => {
  beforeEach(() => {
    listTaskAgents.mockReset();
    prompt.mockReset();
    streamingQuery.mockReset();
    listTaskAgents.mockResolvedValue([
      { pane_id: 'w1:p2', name: 'w1-t1-worker-1', agent: 'pi' },
      { pane_id: 'w1:p1', name: 'w1-t1-leader', agent: 'pi' },
    ]);
    prompt.mockResolvedValue({ pane_id: 'w1:p1' });
    streamingQuery.mockResolvedValue({ text: '- 变更点一\n- 变更点二' });
  });

  it('keeps only requirement-level edits', () => {
    expect(
      requirementChanges([
        { field: 'labels', before: 'a', after: 'b' },
        { field: 'requirements', before: 'v1', after: 'v2' },
        { field: 'description', before: 'old', after: 'new' },
      ]).map((change) => change.field)
    ).toEqual(['requirements', 'description']);
  });

  it('summarises the change points for the agent', () => {
    const text = summarizeRequirementChanges(feature(), [
      { field: 'description', before: '导出 CSV', after: '导出 CSV 与 XLSX' },
    ]);

    expect(text).toContain('Jira AIP-1');
    expect(text).toContain('描述：导出 CSV → 导出 CSV 与 XLSX');
  });

  it('delivers the summary to the leader pane of a running task', async () => {
    const result = await notifyRunningAgentOfJiraChanges({
      projectPath: '/p',
      feature: feature(),
      changes: [{ field: 'requirements', before: 'v1', after: 'v2' }],
    });

    expect(result).toEqual({ sent: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    const [paneId, message] = prompt.mock.calls[0];
    expect(paneId).toBe('w1:p1');
    expect(message).toContain('需求正文：v1 → v2');
  });

  it('summarises with the configured phase model when settings are available', async () => {
    const settingsService = {
      getGlobalSettings: vi.fn().mockResolvedValue({
        phaseModels: { jiraChangeSummaryModel: { model: 'pi:litellm/worker' } },
      }),
    };

    const result = await notifyRunningAgentOfJiraChanges({
      projectPath: '/p',
      feature: feature(),
      changes: [{ field: 'description', before: '旧需求', after: '新需求' }],
      settingsService: settingsService as never,
    });

    expect(result).toEqual({ sent: true });
    expect(streamingQuery).toHaveBeenCalledTimes(1);
    expect(streamingQuery.mock.calls[0][0]).toMatchObject({
      model: 'pi:litellm/worker',
      maxTurns: 1,
      allowedTools: [],
    });
    expect(prompt.mock.calls[0][1]).toBe('- 变更点一\n- 变更点二');
  });

  it('falls back to the raw diff when the model call fails', async () => {
    streamingQuery.mockRejectedValue(new Error('gateway down'));

    const result = await notifyRunningAgentOfJiraChanges({
      projectPath: '/p',
      feature: feature(),
      changes: [{ field: 'description', before: '旧需求', after: '新需求' }],
      settingsService: { getGlobalSettings: vi.fn().mockResolvedValue({}) } as never,
    });

    expect(result).toEqual({ sent: true });
    expect(prompt.mock.calls[0][1]).toContain('描述：旧需求 → 新需求');
  });

  it('does not message a task that is not running', async () => {
    const result = await notifyRunningAgentOfJiraChanges({
      projectPath: '/p',
      feature: feature({ status: 'waiting_approval' }),
      changes: [{ field: 'requirements', after: 'v2' }],
    });

    expect(result).toEqual({ sent: false, reason: 'task is not running' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('skips tasks without a herdr pane', async () => {
    const result = await notifyRunningAgentOfJiraChanges({
      projectPath: '/p',
      feature: feature({ herdrWorkspaceId: undefined, herdrTabId: undefined }),
      changes: [{ field: 'requirements', after: 'v2' }],
    });

    expect(result).toEqual({ sent: false, reason: 'task has no herdr pane' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('ignores metadata-only updates', async () => {
    const result = await notifyRunningAgentOfJiraChanges({
      projectPath: '/p',
      feature: feature(),
      changes: [{ field: 'labels', before: 'a', after: 'b' }],
    });

    expect(result).toEqual({ sent: false, reason: 'no requirement change' });
    expect(prompt).not.toHaveBeenCalled();
  });
});
