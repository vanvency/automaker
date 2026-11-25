import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const mocks = vi.hoisted(() => ({
  files: vi.fn(),
  read: vi.fn(),
  stamp: vi.fn(),
  replies: vi.fn(),
}));
vi.mock('../../../../src/services/feature-reply-history.js', () => ({
  readFeatureReplies: mocks.replies,
}));

vi.mock('../../../../src/routes/features/routes/opencode-session.js', () => ({
  resolveFeatureWorkDir: async () => ({ feature, workDir: '/tmp/does-not-exist-wt' }),
}));
vi.mock('../../../../src/services/pi-session-store.js', () => ({
  listPiSessionFiles: mocks.files,
  readPiSessionFile: mocks.read,
  readSessionFeatureId: mocks.stamp,
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
  beforeEach(() => {
    mocks.files.mockReturnValue([]);
    mocks.replies.mockResolvedValue([]);
  });
  it('includes every reply, preserves identical repeated messages, and recovers only this task’s conversation', async () => {
    mocks.replies.mockResolvedValue([
      {
        id: 'new-1',
        at: '2026-09-04T00:00:00Z',
        text: 'Please verify again',
        imagePaths: ['/task/shot.png'],
      },
      { id: 'new-2', at: '2026-09-05T00:00:00Z', text: 'Please verify again' },
    ]);
    mocks.files.mockReturnValue(['own', 'sibling', 'oneshot']);
    mocks.stamp.mockImplementation((file) =>
      file === 'own' ? feature.id : file === 'sibling' ? 'another-task' : undefined
    );
    mocks.read.mockImplementation((file) => ({
      id: file,
      messages: [
        {
          role: 'user',
          text: `## Feature Task\n**Feature ID:** ${file}\n**Description:** Build the original requirement`,
          timestamp: Date.parse('2026-09-01T00:00:00Z'),
        },
        {
          role: 'assistant',
          text: 'Working on the task',
          timestamp: Date.parse('2026-09-01T00:01:00Z'),
        },
        {
          role: 'assistant',
          text: '',
          timestamp: Date.parse('2026-09-01T00:02:00Z'),
          toolCalls: [{ name: 'bash', arguments: { command: 'npm run test:server' } }],
        },
        {
          role: 'user',
          text: '## Follow-up Instructions\nOld full reply\nwith another line\n\n## Task\nAddress the follow-up instructions above.',
          timestamp: Date.parse('2026-09-02T00:00:00Z'),
        },
        {
          role: 'assistant',
          text: 'Continuing',
          timestamp: Date.parse('2026-09-02T00:01:00Z'),
        },
        {
          role: 'user',
          text: 'Direct terminal reply',
          timestamp: Date.parse('2026-09-03T00:00:00Z'),
        },
        {
          role: 'user',
          text: '## Follow-up Instructions\nPlease verify again\n\n## Task\nContinue\nAutomaker reply ID: new-1',
          timestamp: Date.parse('2026-09-04T00:00:01Z'),
        },
      ],
    }));
    const { res, body } = fakeResponse();
    await createFeatureTimelineHandler({} as never)(
      { body: { projectPath: '/p', featureId: feature.id } } as Request,
      res
    );
    const replies = (body.value?.entries as Array<Record<string, unknown>>).filter(
      (entry) => entry.kind === 'reply'
    );
    expect(replies.map((entry) => entry.detail)).toEqual([
      'Please verify again',
      'Please verify again',
      'Direct terminal reply',
      'Old full reply\nwith another line',
    ]);
    expect(replies[1].imagePaths).toEqual(['/task/shot.png']);
    expect(replies.some((reply) => String(reply.id).includes('sibling'))).toBe(false);
    expect(
      (body.value?.entries as Array<Record<string, unknown>>).some(
        (entry) => entry.id === 'session:sibling'
      )
    ).toBe(false);
    expect(
      replies.find((reply) => reply.detail === 'Old full reply\nwith another line')
    ).toMatchObject({
      developmentAt: '2026-09-02T00:01:00.000Z',
    });
    const resident = (body.value?.entries as Array<Record<string, unknown>>).find(
      (entry) => entry.id === 'session:own'
    );
    expect(resident).toMatchObject({
      detail: expect.stringContaining('**Description:** Build the original requirement'),
      developmentAt: '2026-09-01T00:01:00.000Z',
      verificationAt: '2026-09-01T00:02:00.000Z',
    });
    expect(
      (body.value?.entries as Array<Record<string, unknown>>).find(
        (entry) => entry.id === 'session:oneshot'
      )
    ).toMatchObject({
      kind: 'one-shot',
      detail: expect.stringContaining('**Description:** Build the original requirement'),
    });
    expect(replies.find((reply) => reply.id === 'reply:new-1')).not.toHaveProperty(
      'verificationAt'
    );
  });

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
