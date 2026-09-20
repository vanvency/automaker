import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createStartTestsHandler } from '../../../../src/routes/worktree/routes/start-tests.js';
import type { SettingsService } from '../../../../src/services/settings-service.js';

const mocks = vi.hoisted(() => ({ status: vi.fn(), startTests: vi.fn() }));
vi.mock('../../../../src/services/worktree-preview-service.js', () => ({
  worktreePreviewService: { status: mocks.status },
}));
vi.mock('../../../../src/services/test-runner-service.js', () => ({
  getTestRunnerService: () => ({ startTests: mocks.startTests }),
}));

describe('worktree tests use the matching preview', () => {
  const settings = {
    getProjectSettings: vi.fn(async () => ({ testCommand: 'npm run test:e2e' })),
  } as unknown as SettingsService;
  let response: Response;
  beforeEach(() => {
    response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    mocks.startTests.mockResolvedValue({ success: true, result: { sessionId: 'test-session' } });
  });

  async function start() {
    await createStartTestsHandler(settings)(
      {
        body: {
          projectPath: '/project',
          worktreePath: '/project/feature',
          testFile: 'smoke.spec.ts',
        },
      } as Request,
      response
    );
  }

  it('passes the ready preview URL only to this worktree test session', async () => {
    mocks.status.mockResolvedValue({
      preview: { status: 'ready', url: 'http://preview.test:31000' },
    });
    await start();
    expect(mocks.status).toHaveBeenCalledWith('/project', '/project/feature');
    expect(mocks.startTests).toHaveBeenCalledWith('/project/feature', {
      command: 'npm run test:e2e',
      testFile: 'smoke.spec.ts',
      previewUrl: 'http://preview.test:31000',
    });
  });

  it.each(['deploying', 'failed', 'unavailable', 'stopping'])(
    'blocks tests on %s previews',
    async (status) => {
      mocks.status.mockResolvedValue({ preview: { status, url: 'http://old.test' } });
      await start();
      expect(response.status).toHaveBeenCalledWith(400);
      expect(mocks.startTests).not.toHaveBeenCalled();
    }
  );

  it.each([null, { status: 'stopped', url: 'http://old.test' }])(
    'preserves local tests without an active preview: %j',
    async (preview) => {
      mocks.status.mockResolvedValue({ preview });
      await start();
      expect(mocks.startTests).toHaveBeenCalledWith(
        '/project/feature',
        expect.objectContaining({
          previewUrl: undefined,
        })
      );
    }
  );
});
