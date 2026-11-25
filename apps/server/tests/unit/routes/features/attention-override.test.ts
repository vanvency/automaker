import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { FeatureLoader } from '../../../../src/services/feature-loader.js';
import { createUpdateHandler } from '../../../../src/routes/features/routes/update.js';

describe('manual attention override', () => {
  it('refuses an override while an agent is running despite a stale failure status', async () => {
    const loader = {
      get: vi.fn().mockResolvedValue({ id: 'task', status: 'failed' }),
      update: vi.fn(),
    };
    const running = vi.fn().mockResolvedValue(true);
    const handler = createUpdateHandler(
      loader as unknown as FeatureLoader,
      undefined,
      undefined,
      running
    );
    const req = {
      body: {
        projectPath: '/project',
        featureId: 'task',
        updates: {
          status: 'verified',
          attentionOverride: {
            fromStatus: 'failed',
            targetStatus: 'verified',
            acceptedAt: '2026-11-23T00:00:00Z',
          },
        },
      },
    } as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res as unknown as Response);
    expect(running).toHaveBeenCalledWith('/project', 'task');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(loader.update).not.toHaveBeenCalled();
  });
});
