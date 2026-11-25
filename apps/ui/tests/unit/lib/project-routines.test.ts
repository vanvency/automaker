import { expect, it } from 'vitest';
import type { Feature, WorktreeProgressItem } from '@automaker/types';
import { summarizeProjectRoutines } from '@/lib/project-routines';

const now = Date.parse('2026-09-22T12:00:00Z');
const feature = (id: string, fields: Partial<Feature> = {}): Feature => ({
  id,
  category: '',
  description: '',
  status: 'backlog',
  ...fields,
});
const tree: WorktreeProgressItem = {
  path: '/project/.worktrees/a',
  branch: 'work/a',
  isMain: false,
  stage: 'in_progress',
  feature: null,
  featureCount: 0,
  ahead: 1,
  behind: 0,
  changedFilesCount: 3,
  hasChanges: true,
  hasConflicts: true,
  pr: null,
  lastActivityAt: null,
  head: { sha: '123', subject: 'fix', author: 'User', date: '2026-09-22T10:00:00Z' },
};

it('derives risks from dependencies, recorded validation, recent changes and agent tracking', () => {
  const features = [
    feature('done', { status: 'verified' }),
    feature('blocked', { dependencies: ['missing', 'pending', 'done'] }),
    feature('pending'),
    feature('review', {
      status: 'waiting_approval',
      updatedAt: '2026-09-22T10:00:00Z',
      skipTests: true,
    }),
    feature('failed', {
      status: 'failed',
      passes: false,
      deliveryCompletion: { status: 'failed', updatedAt: '', steps: [] },
    }),
    feature('stale', { status: 'in_progress', updatedAt: '2026-09-20T00:00:00Z' }),
    feature('live', {
      status: 'in_progress',
      updatedAt: '2026-09-22T10:00:00Z',
      acceptanceEvidence: {
        status: 'passed',
        summary: '',
        checks: [],
        screenshots: [],
        verifiedAt: '',
        importedAt: '',
      },
    }),
  ];
  const [health, release, review, queue] = summarizeProjectRoutines(
    features,
    [tree],
    new Set(['live']),
    now
  );
  expect(health.metrics.map(([, value]) => value)).toEqual([1, 1, 1, 1]);
  expect(health.findings.find((item) => item.featureId === 'blocked')?.reason).toBe(
    '2 unresolved task dependencies'
  );
  expect(release.metrics.map(([, value]) => value)).toEqual([3, 1, 1, 2]);
  expect(review.metrics.map(([, value]) => value)).toEqual([2, 1, 1, 1]);
  expect(queue.metrics.map(([, value]) => value)).toEqual([1, 1, 1, 1]);
  expect(queue.findings.some((item) => item.featureId === 'live')).toBe(false);
});

it('does not call archived, snoozed, future-dated or missing-timestamp work stuck', () => {
  const features = [
    feature('archived', {
      status: 'failed',
      archive: { reason: 'completed' } as Feature['archive'],
    }),
    feature('paused', {
      status: 'in_progress',
      updatedAt: '2026-09-01T00:00:00Z',
      worktreeSnooze: { snoozedAt: '2026-09-01T00:00:00Z' },
    }),
    feature('future', { updatedAt: '2026-09-23T00:00:00Z' }),
    feature('unknown', { status: 'in_progress' }),
  ];
  const [health, , review, queue] = summarizeProjectRoutines(
    features,
    [{ ...tree, checkoutMissing: true }],
    new Set(['unknown']),
    now
  );
  expect(health.metrics.map(([, value]) => value)).toEqual([0, 0, 0, 0]);
  expect(review.metrics.map(([, value]) => value)).toEqual([0, 0, 0, 0]);
  expect(queue.metrics.map(([, value]) => value)).toEqual([0, 0, 0, 0]);
});
