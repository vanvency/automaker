import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Feature } from '@automaker/types';
import type { FeatureLoader } from '../../../src/services/feature-loader.js';
import {
  TaskArchiveService,
  validateArchiveRequest,
} from '../../../src/services/task-archive-service.js';
import { createArchiveHandler } from '../../../src/routes/features/routes/archive.js';
import type { Request, Response } from 'express';
import {
  areDependenciesSatisfied,
  getBlockingDependencies,
  getBlockingDependenciesFromMap,
  resolveDependencies,
} from '@automaker/dependency-resolver';

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
    { reason: 'deferred', description: 123 },
    { reason: 'deferred' },
    { reason: 'duplicate', description: 'same scope' },
    { reason: 'completed', description: 'Cannot bypass Confirm' },
  ])('rejects missing or invalid reason metadata: %j', (input) => {
    expect(() => validateArchiveRequest(input)).toThrow();
  });
  it.each(['', '好', 'x'.repeat(8001)])(
    'accepts descriptions without a character count requirement',
    (description) => {
      expect(validateArchiveRequest({ reason: 'deferred', description }).description).toBe(
        description
      );
    }
  );
  it('archives Done locally without treating it as confirmed delivery', async () => {
    await service.archive('/project', ['a'], { reason: 'done', description: '' });
    expect(features[0].archive).toMatchObject({ reason: 'done', previousStatus: 'backlog' });
    expect(features[0].providerSessionId).toBe('session-a');
    expect(areDependenciesSatisfied({ ...features[1], dependencies: ['a'] }, features)).toBe(false);
    await service.restore('/project', 'a');
    expect(features[0].status).toBe('backlog');
  });
  it('archives already-taken work without a detailed description', async () => {
    await service.archive('/project', ['a'], { reason: 'already_taken', description: '' });
    expect(features[0].archive).toMatchObject({
      reason: 'already_taken',
      description: '',
      previousStatus: 'backlog',
    });
  });
  it('archives a historically covered task while preserving its coverage and delivery records', async () => {
    const coverage = {
      featureId: 'b',
      jiraKey: 'AIP-2',
      reason: 'Covered by the retained task',
      planId: 'old-plan',
      at: '2026-09-21T02:39:41.511Z',
    };
    Object.assign(features[0], {
      status: 'verified',
      supersededBy: coverage,
      mergeRequests: ['https://git.example/team/repo/-/merge_requests/1'],
    });
    await service.archive('/project', ['a'], { reason: 'already_taken', description: '' });
    expect(features[0].status).toBe('completed');
    expect(features[0].supersededBy).toEqual(coverage);
    expect(features[0].archive).toMatchObject({
      reason: 'already_taken',
      previousStatus: 'verified',
    });
    expect(features[0].providerSessionId).toBe('session-a');
    expect(features[0].mergeRequests).toEqual(['https://git.example/team/repo/-/merge_requests/1']);
    await service.archive('/project', ['a'], { reason: 'already_taken', description: '' });
    expect(features[0].archiveHistory).toHaveLength(1);
    await expect(service.restore('/project', 'a')).rejects.toThrow(
      'Resolve task consolidation first'
    );
  });
  it('keeps an active consolidation lock blocking the entire archive batch', async () => {
    features[1].consolidationPlanId = 'running-plan';
    await expect(
      service.archive('/project', ['a', 'b'], { reason: 'already_taken', description: '' })
    ).rejects.toThrow('being consolidated');
    expect(update).not.toHaveBeenCalled();
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
  it('archives already-taken work locally without modifying Jira or MR metadata', async () => {
    Object.assign(features[0], {
      jiraKey: 'AIP-1',
      jiraStatus: 'In Progress',
      mergeRequests: ['https://git.example/team/repo/-/merge_requests/1'],
    });
    await service.archive('/project', ['a'], {
      reason: 'already_taken',
      description: 'Completed by another developer; see MR 42.',
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(Object.keys(update.mock.calls[0][2]).sort()).toEqual([
      'archive',
      'archiveHistory',
      'status',
    ]);
    expect(features[0].archive).toMatchObject({
      reason: 'already_taken',
      previousStatus: 'backlog',
    });
    expect(features[0].jiraStatus).toBe('In Progress');
    expect(features[0].mergeRequests).toEqual(['https://git.example/team/repo/-/merge_requests/1']);
    expect(areDependenciesSatisfied({ ...features[1], dependencies: ['a'] }, features)).toBe(false);
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
  it('keeps dependencies satisfied after a confirmed delivery is archived', () => {
    features[0].status = 'completed';
    features[0].archive = {
      reason: 'completed',
      description: 'Confirmed delivery',
      previousStatus: 'verified',
      archivedAt: 'now',
    };
    const dependent = { ...features[1], dependencies: ['a'] };
    expect(areDependenciesSatisfied(dependent, features)).toBe(true);
    expect(getBlockingDependencies(dependent, features)).toEqual([]);
    expect(
      getBlockingDependenciesFromMap(dependent, new Map(features.map((f) => [f.id, f])))
    ).toEqual([]);
    expect(resolveDependencies([features[0], dependent]).blockedFeatures.size).toBe(0);
  });
  it('restores a delivered archive to the Done lane while retaining delivery history', async () => {
    features[0].status = 'completed';
    features[0].archive = {
      reason: 'completed',
      description: 'Confirmed delivery',
      previousStatus: 'verified',
      archivedAt: 'now',
    };
    features[0].archiveHistory = [features[0].archive];
    await service.restore('/project', 'a');
    expect(features[0].status).toBe('verified');
    expect(features[0].archive).toBeUndefined();
    expect(features[0].archiveHistory[0].restoredAt).toBeDefined();
  });
  it('restores legacy completed tasks through the same service without inventing archive history', async () => {
    features[0].status = 'completed';
    await service.restore('/project', 'a');
    expect(features[0].status).toBe('verified');
    expect(features[0].archive).toBeUndefined();
    expect(features[0].archiveHistory).toEqual([]);
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
