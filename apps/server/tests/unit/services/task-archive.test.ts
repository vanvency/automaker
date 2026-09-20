import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Feature } from '@automaker/types';
import type { FeatureLoader } from '../../../src/services/feature-loader.js';
import {
  TaskArchiveService,
  validateArchiveRequest,
} from '../../../src/services/task-archive-service.js';
import { createArchiveHandler } from '../../../src/routes/features/routes/archive.js';
import type { Request, Response } from 'express';
import { areDependenciesSatisfied, getBlockingDependencies } from '@automaker/dependency-resolver';

describe('task archiving', () => {
  let features: Feature[];
  let service: TaskArchiveService;
  let update: ReturnType<typeof vi.fn>;
  let running: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    features = [
      {
        id: 'a',
        title: 'Old task',
        description: 'scope',
        category: 'test',
        status: 'backlog',
        providerSessionId: 'session-a',
        imagePaths: ['/evidence.png'],
      },
      {
        id: 'b',
        title: 'Retained task',
        jiraKey: 'AIP-2',
        description: 'broader scope',
        category: 'test',
        status: 'waiting_approval',
      },
    ];
    update = vi.fn(async (_project, id, values) =>
      Object.assign(features.find((f) => f.id === id)!, values)
    );
    const loader = {
      get: vi.fn(async (_p, id) => features.find((f) => f.id === id) ?? null),
      update,
    } as unknown as FeatureLoader;
    running = vi.fn(async () => []);
    service = new TaskArchiveService(loader, running, async () => false);
  });
  it.each([
    undefined,
    {},
    { reason: 'invalid', description: 'reason text' },
    { reason: 'deferred', description: ' ' },
    { reason: 'duplicate', description: 'same scope' },
  ])('rejects missing or invalid reason metadata: %j', (input) => {
    expect(() => validateArchiveRequest(input)).toThrow();
  });
  it('records reason, duplicate target and details without deleting history or screenshots', async () => {
    await service.archive('/project', ['a'], {
      reason: 'duplicate',
      description: 'The export flow is covered by AIP-2',
      duplicateOf: 'b',
    });
    expect(features[0].status).toBe('completed');
    expect(features[0].archive).toMatchObject({
      reason: 'duplicate',
      duplicateOf: 'b',
      duplicateTitle: 'Retained task',
      duplicateJiraKey: 'AIP-2',
      previousStatus: 'backlog',
    });
    expect(features[0].providerSessionId).toBe('session-a');
    expect(features[0].imagePaths).toEqual(['/evidence.png']);
    expect(features[0].archiveHistory).toHaveLength(1);
    await service.archive('/project', ['a'], {
      reason: 'duplicate',
      description: 'same reason',
      duplicateOf: 'b',
    });
    expect(features[0].archiveHistory).toHaveLength(1);
  });
  it.each(['a', 'missing'])('rejects self or unknown duplicate target %s', async (duplicateOf) => {
    await expect(
      service.archive('/project', ['a'], {
        reason: 'duplicate',
        description: 'duplicates this task',
        duplicateOf,
      })
    ).rejects.toThrow('another active task');
    expect(update).not.toHaveBeenCalled();
  });
  it('validates the whole batch before writing any archive', async () => {
    running.mockResolvedValue(['b']);
    await expect(
      service.archive('/project', ['a', 'b'], {
        reason: 'deferred',
        description: 'Do not proceed this quarter',
      })
    ).rejects.toThrow('Stop');
    expect(update).not.toHaveBeenCalled();
  });
  it('restores the original status and retains the reason audit trail', async () => {
    await service.archive('/project', ['a'], {
      reason: 'obsolete',
      description: 'Requirement was replaced',
    });
    await service.restore('/project', 'a');
    expect(features[0].archive).toBeUndefined();
    expect(features[0].status).toBe('backlog');
    expect(features[0].archiveHistory?.[0].restoredAt).toBeDefined();
    expect(features[0].archiveHistory?.[0].description).toBe('Requirement was replaced');
  });
  it('does not treat deferred archive as satisfying a dependency', async () => {
    await service.archive('/project', ['a'], {
      reason: 'deferred',
      description: 'Not proceeding this quarter',
    });
    const dependent = { ...features[1], dependencies: ['a'] };
    expect(areDependenciesSatisfied(dependent, features)).toBe(false);
    expect(getBlockingDependencies(dependent, features)).toEqual(['a']);
  });
  it('legacy delete request without a reason fails without mutating any task', async () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    await createArchiveHandler(service)(
      { body: { projectPath: '/project', featureId: 'a' } } as Request,
      response
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(update).not.toHaveBeenCalled();
  });
});
