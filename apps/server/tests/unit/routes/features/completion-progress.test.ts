import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  createCompletionProgressHandler,
  createCompletionRepairHandler,
} from '../../../../src/routes/features/routes/completion-progress.js';
import { activeCompletions } from '../../../../src/services/delivery-completion.js';

function response() {
  const value = { statusCode: 200, body: null as any };
  const res = {
    status(code: number) {
      value.statusCode = code;
      return this;
    },
    json(body: unknown) {
      value.body = body;
      return this;
    },
  } as unknown as Response;
  return { value, res };
}
const progress = {
  status: 'failed' as const,
  updatedAt: new Date().toISOString(),
  steps: [
    { id: 'merge' as const, status: 'succeeded' as const, message: 'MR merged' },
    { id: 'jira' as const, status: 'failed' as const, message: 'Jira timed out' },
    { id: 'preview' as const, status: 'pending' as const },
  ],
};

describe('completion progress and repair routes', () => {
  it('returns persisted three-step progress without performing delivery work', async () => {
    const loader = {
      get: vi.fn(async () => ({ id: 'f', status: 'verified', deliveryCompletion: progress })),
      update: vi.fn(),
    } as any;
    const result = response();
    await createCompletionProgressHandler(loader)(
      { body: { projectPath: '/p', featureId: 'f' } } as Request,
      result.res
    );
    expect(result.value.body.progress.steps[1]).toMatchObject({ id: 'jira', status: 'failed' });
    expect(loader.update).not.toHaveBeenCalled();
  });
  it('marks an interrupted running delivery step failed after restart', async () => {
    const loader = {
      get: vi.fn(async () => ({
        id: 'f',
        status: 'verified',
        deliveryCompletion: {
          ...progress,
          status: 'running',
          steps: progress.steps.map((s) => (s.id === 'jira' ? { ...s, status: 'running' } : s)),
        },
      })),
      update: vi.fn(async (_p: string, _id: string, updates: unknown) => updates),
    } as any;
    activeCompletions.delete('/p:f');
    const result = response();
    await createCompletionProgressHandler(loader)(
      { body: { projectPath: '/p', featureId: 'f' } } as Request,
      result.res
    );
    expect(result.value.body.progress.status).toBe('failed');
    expect(loader.update).toHaveBeenCalled();
  });
  it('dispatches a failed step to the task agent with the reason and guards duplicate requests', async () => {
    const followUp = vi.fn(async () => {});
    const loader = {
      get: vi.fn(async () => ({ id: 'f', status: 'verified', deliveryCompletion: progress })),
    } as any;
    const executor = { getRunningAgents: vi.fn(async () => []), followUpFeature: followUp } as any;
    const result = response();
    await createCompletionRepairHandler(loader, executor)(
      {
        body: {
          projectPath: '/p',
          featureId: 'f',
          stepId: 'jira',
          instruction: 'check credentials',
        },
      } as Request,
      result.res
    );
    expect(result.value.body.success).toBe(true);
    expect(followUp).toHaveBeenCalledWith(
      '/p',
      'f',
      expect.stringMatching(/Jira timed out[\s\S]*check credentials/),
      undefined,
      true
    );
  });
  it('rejects repair for a successful step or a running agent', async () => {
    const loader = {
      get: vi.fn(async () => ({ id: 'f', status: 'verified', deliveryCompletion: progress })),
    } as any;
    const executor = {
      getRunningAgents: vi.fn(async () => [{ projectPath: '/p', featureId: 'f' }]),
      followUpFeature: vi.fn(),
    } as any;
    const result = response();
    await createCompletionRepairHandler(loader, executor)(
      { body: { projectPath: '/p', featureId: 'f', stepId: 'merge' } } as Request,
      result.res
    );
    expect(result.value.statusCode).toBe(409);
    expect(executor.followUpFeature).not.toHaveBeenCalled();
  });
});
