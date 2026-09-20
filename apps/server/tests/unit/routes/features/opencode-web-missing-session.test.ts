import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const findOpenCodeSession = vi.fn();
const resolveFeatureWorkDir = vi.fn();

vi.mock('../../../../src/routes/features/routes/opencode-session.js', () => ({
  findOpenCodeSession: (...args: unknown[]) => findOpenCodeSession(...args),
  resolveFeatureWorkDir: (...args: unknown[]) => resolveFeatureWorkDir(...args),
  runCaptured: vi.fn(),
}));

const { createOpenCodeWebHandler } =
  await import('../../../../src/routes/features/routes/opencode-web.js');

interface RecordedResponse {
  body: { success?: boolean; error?: string } | null;
  res: Response;
}

function fakeResponse(): RecordedResponse {
  const recorded: RecordedResponse = { body: null, res: null as unknown as Response };
  recorded.res = {
    status() {
      return this;
    },
    json(body: unknown) {
      recorded.body = body as RecordedResponse['body'];
      return this;
    },
  } as unknown as Response;
  return recorded;
}

describe('opencode-web missing session memo', () => {
  beforeEach(() => {
    findOpenCodeSession.mockReset();
    resolveFeatureWorkDir.mockReset();
    resolveFeatureWorkDir.mockResolvedValue({
      feature: { id: 'feature-1', title: 'A feature', status: 'backlog' },
      workDir: '/workspace/automaker/.worktrees/feature-1',
    });
    // `opencode session list` finds nothing for this worktree.
    findOpenCodeSession.mockResolvedValue(null);
  });

  async function callHandler(projectPath: string, featureId: string) {
    const recorded = fakeResponse();
    const handler = createOpenCodeWebHandler({} as never);
    await handler({ body: { projectPath, featureId } } as unknown as Request, recorded.res);
    return recorded;
  }

  it('reports no session and does not look up the CLI again on the next poll', async () => {
    const first = await callHandler('/workspace/automaker', 'feature-1');
    expect(first.body).toMatchObject({ success: false });
    expect(findOpenCodeSession).toHaveBeenCalledTimes(1);

    const second = await callHandler('/workspace/automaker', 'feature-1');
    expect(second.body).toMatchObject({ success: false });
    // The board polls every card on focus; a memoized miss keeps that cheap.
    expect(findOpenCodeSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the memo per feature', async () => {
    const before = findOpenCodeSession.mock.calls.length;
    await callHandler('/workspace/automaker', 'feature-per-key-a');
    const afterFirst = findOpenCodeSession.mock.calls.length;
    expect(afterFirst).toBe(before + 1);

    await callHandler('/workspace/automaker', 'feature-per-key-b');

    expect(findOpenCodeSession.mock.calls.length).toBe(afterFirst + 1);
  });
});
