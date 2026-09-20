import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createApprovePlanHandler } from '../../../../src/routes/auto-mode/routes/approve-plan.js';

function setup() {
  const original = '- [ ] T001: Original task';
  const loader = {
    get: vi.fn(async () => ({
      decompositionRequest: {
        status: 'proposed',
        tasks: [{ id: 'T001', description: 'Original task' }],
      },
      planSpec: { content: original, status: 'generated' },
    })),
    update: vi.fn(),
  };
  const run = async (editedPlan: string) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await createApprovePlanHandler({} as never, loader as never)(
      { body: { projectPath: '/p', featureId: 'f', approved: true, editedPlan } } as Request,
      res as unknown as Response
    );
    return res;
  };
  return { loader, run };
}
describe('decomposition approval', () => {
  it('creates Jira tasks from the edited approved plan, not the original proposal', async () => {
    const { loader, run } = setup();
    const plan = '- [ ] T002: Edited backend work\n- [ ] T003: New regression tests';
    await run(plan);
    const updates = loader.update.mock.calls[0][2];
    expect(updates.planSpec.content).toBe(plan);
    expect(updates.decompositionRequest.tasks.map((task: { id: string }) => task.id)).toEqual([
      'T002',
      'T003',
    ]);
    expect(updates.decompositionRequest.status).toBe('creating-jira');
  });
  it('rejects empty or duplicate task definitions without approving the original plan', async () => {
    const { loader, run } = setup();
    for (const plan of ['', '- [ ] T001: one\n- [ ] T001: two']) {
      const res = await run(plan);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(loader.update).not.toHaveBeenCalled();
  });
});
