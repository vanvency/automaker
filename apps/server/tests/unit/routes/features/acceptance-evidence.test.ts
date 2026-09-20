import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { FeatureLoader } from '../../../../src/services/feature-loader.js';
import { createAcceptanceEvidenceHandler } from '../../../../src/routes/features/routes/acceptance-evidence.js';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  collect: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../../../src/services/worktree-resolver.js', () => ({
  WorktreeResolver: class {
    listWorktrees = mocks.list;
  },
}));
vi.mock('../../../../src/services/acceptance-evidence-service.js', () => ({
  collectAcceptanceEvidence: mocks.collect,
}));

describe('import acceptance evidence API', () => {
  let response: Response;
  const loader = { get: mocks.get, update: mocks.update } as unknown as FeatureLoader;
  beforeEach(() => {
    response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    mocks.get.mockResolvedValue({ id: 'task-1', branchName: 'feature/one' });
    mocks.list.mockResolvedValue([
      { path: '/project', branch: 'main', isMain: true },
      { path: '/project/worktree-one', branch: 'feature/one' },
      { path: '/project/worktree-two', branch: 'feature/two' },
    ]);
  });
  const invoke = (extra: object = {}) =>
    createAcceptanceEvidenceHandler(loader)(
      {
        body: { projectPath: '/project', featureId: 'task-1', ...extra },
      } as Request,
      response
    );

  it('resolves the task branch and ignores caller-supplied paths; never approves the task', async () => {
    const evidence = { status: 'passed', summary: 'verified' };
    mocks.collect.mockResolvedValue(evidence);
    mocks.update.mockResolvedValue({ id: 'task-1', acceptanceEvidence: evidence });
    await invoke({ worktreePath: '/project/worktree-two', manifestPath: '/tmp/unrelated.json' });
    expect(mocks.collect).toHaveBeenCalledWith('/project', 'task-1', '/project/worktree-one');
    expect(mocks.update).toHaveBeenCalledWith('/project', 'task-1', {
      acceptanceEvidence: evidence,
    });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('does not overwrite prior evidence when no manifest exists', async () => {
    mocks.collect.mockResolvedValue(null);
    await invoke();
    expect(response.status).toHaveBeenCalledWith(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects malformed artifacts before updating the card', async () => {
    mocks.collect.mockRejectedValue(new Error('Image is not a raster image'));
    await invoke();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('never falls back to another worktree when the task branch is missing', async () => {
    mocks.list.mockResolvedValue([{ path: '/project', branch: 'main', isMain: true }]);
    await invoke();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});
