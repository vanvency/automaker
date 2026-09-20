import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createHerdrReattachHandler } from '../../../src/routes/herdr/routes/reattach.js';

const mocks = vi.hoisted(() => ({ attach: vi.fn(), git: vi.fn(), validate: vi.fn() }));
vi.mock('../../../src/services/terminal-service.js', () => ({ getTerminalService: () => ({}) }));
vi.mock('../../../src/services/herdr-service.js', () => ({
  getHerdrService: () => ({ attachWorktreeSession: mocks.attach }),
}));
vi.mock('../../../src/lib/git.js', () => ({ execGitCommand: mocks.git }));
vi.mock('@automaker/platform', () => ({ validatePath: mocks.validate }));

describe('herdr browser reattachment', () => {
  let response: Response;
  beforeEach(() => {
    response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    mocks.attach.mockResolvedValue({
      terminalSessionId: 'new-pty',
      sessionName: 'project',
      reused: false,
    });
    mocks.git.mockResolvedValue('/workspace/project/.git\n');
  });
  it('recovers old URLs using Git project identity without trusting a supplied session name', async () => {
    await createHerdrReattachHandler()(
      {
        body: { workDir: '/workspace/project/.worktrees/task', sessionName: 'unrelated' },
      } as Request,
      response
    );
    expect(mocks.attach).toHaveBeenCalledWith({
      projectPath: '/workspace/project',
      workDir: '/workspace/project/.worktrees/task',
    });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, terminalSessionId: 'new-pty' })
    );
  });
  it('reuses the project identity carried by new conversation links', async () => {
    await createHerdrReattachHandler()(
      {
        body: { projectPath: '/project', workDir: '/project/wt' },
      } as Request,
      response
    );
    expect(mocks.git).not.toHaveBeenCalled();
    expect(mocks.validate).toHaveBeenCalledWith('/project');
    expect(mocks.validate).toHaveBeenCalledWith('/project/wt');
  });
  it('does not create an attachment when paths fail validation', async () => {
    mocks.validate.mockImplementationOnce(() => {
      throw new Error('Path not allowed');
    });
    await createHerdrReattachHandler()(
      {
        body: { projectPath: '/project', workDir: '/outside' },
      } as Request,
      response
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});
