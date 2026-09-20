import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const existsSyncMock = vi.fn<() => boolean>(() => true);
const isHerdrAvailableMock = vi.fn<() => boolean>(() => true);
const attachWorktreeSessionMock = vi.fn(async () => ({
  sessionName: 'am-automaker',
  terminalSessionId: 'term-1',
  reused: true,
}));

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: existsSyncMock,
}));
vi.mock('../../../src/services/terminal-service.js', () => ({
  getTerminalService: vi.fn(() => ({ name: 'terminal-service', mocked: true })),
}));
vi.mock('../../../src/services/herdr-service.js', () => ({
  isHerdrAvailable: isHerdrAvailableMock,
  getHerdrService: vi.fn(() => ({
    attachWorktreeSession: attachWorktreeSessionMock,
  })),
}));

const { createHerdrPreviewHandler } = await import('../../../src/routes/herdr/routes/preview.js');

function fakeResponse() {
  const recorded: { body: Record<string, unknown> | null; statusCalls: number[] } = {
    body: null,
    statusCalls: [],
  };
  const res = {
    status(code: number) {
      recorded.statusCalls.push(code);
      return this;
    },
    json(body: unknown) {
      recorded.body = body as Record<string, unknown>;
      return this;
    },
  } as unknown as Response;
  return { res, recorded };
}

describe('herdr preview route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockImplementation(() => true);
    isHerdrAvailableMock.mockImplementation(() => true);
  });

  it('attaches to the current worktree session', async () => {
    const { res, recorded } = fakeResponse();
    await createHerdrPreviewHandler()(
      { body: { projectPath: '/p', workDir: '/p/wt' } } as unknown as Request,
      res
    );
    expect(recorded.body).toMatchObject({
      success: true,
      workDir: '/p/wt',
    });
    expect(attachWorktreeSessionMock).toHaveBeenCalledWith({
      projectPath: '/p',
      workDir: '/p/wt',
      cols: undefined,
      rows: undefined,
    });
  });

  it('rejects a missing project path', async () => {
    const { res, recorded } = fakeResponse();
    await createHerdrPreviewHandler()({ body: {} } as unknown as Request, res);
    expect(recorded.statusCalls).toEqual([400]);
    expect(recorded.body).toMatchObject({ success: false });
  });

  it('reports a missing herdr binary as unavailable', async () => {
    isHerdrAvailableMock.mockReset();
    isHerdrAvailableMock.mockReturnValue(false);
    const { res, recorded } = fakeResponse();
    await createHerdrPreviewHandler()({ body: { projectPath: '/p' } } as unknown as Request, res);
    expect(recorded.statusCalls).toEqual([503]);
    expect(existsSyncMock).toHaveBeenCalledWith('/p');
  });
});
