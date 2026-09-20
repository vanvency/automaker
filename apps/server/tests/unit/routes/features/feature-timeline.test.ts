import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const feature = {
  id: 'jira-dodo-aip-1',
  title: 'AIP-1: task',
  jiraKey: 'AIP-1',
  status: 'in_progress',
  createdAt: '2026-09-01T00:00:00.000Z',
  startedAt: '2026-09-01T01:00:00.000Z',
  jiraChanges: [
    { field: 'labels', before: 'a', after: 'b', detectedAt: '2026-09-02T00:00:00.000Z' },
    {
      field: 'requirements',
      before: '导出 CSV',
      after: '导出 CSV 与 XLSX',
      detectedAt: '2026-09-03T00:00:00.000Z',
    },
  ],
};

vi.mock('../../../../src/routes/features/routes/opencode-session.js', () => ({
  resolveFeatureWorkDir: async () => ({ feature, workDir: '/tmp/does-not-exist-wt' }),
}));
vi.mock('../../../../src/services/pi-session-store.js', () => ({
  listPiSessionFiles: () => [],
  readPiSessionFile: () => null,
  readSessionFeatureId: () => null,
}));

const { createFeatureTimelineHandler } =
  await import('../../../../src/routes/features/routes/timeline.js');

function fakeResponse() {
  const body: { value?: Record<string, unknown> } = {};
  const res = {
    status: () => res,
    json: (value: Record<string, unknown>) => {
      body.value = value;
      return res;
    },
  } as unknown as Response;
  return { res, body };
}

describe('feature timeline route', () => {
  it('adds Jira requirement edits to the card timeline', async () => {
    const { res, body } = fakeResponse();
    await createFeatureTimelineHandler({} as never)(
      { body: { projectPath: '/p', featureId: feature.id } } as unknown as Request,
      res
    );

    const entries = (body.value?.entries ?? []) as Array<Record<string, string>>;
    const jira = entries.filter((entry) => entry.kind === 'jira');

    // Metadata edits stay on the card's Jira list; requirement edits belong to
    // the timeline the agent and the reviewer read.
    expect(jira).toHaveLength(1);
    expect(jira[0].title).toBe('Jira 需求更新');
    expect(jira[0].at).toBe('2026-09-03T00:00:00.000Z');
    expect(jira[0].detail).toBe('原：导出 CSV → 新：导出 CSV 与 XLSX');
    // Newest first, like the run entries.
    expect(entries[0].kind).toBe('jira');
  });
});
