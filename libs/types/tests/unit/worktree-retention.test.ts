import { describe, it, expect } from 'vitest';
import {
  DONE_WORKTREE_RETENTION_DAYS,
  featureDoneAt,
  isWorktreeRetentionExpired,
  type Feature,
} from '@automaker/types';

const card = (fields: Partial<Feature>): Feature =>
  ({ id: 'f1', category: 'test', description: 'x', ...fields }) as Feature;

describe('featureDoneAt', () => {
  it('prefers the Done stamp over later activity', () => {
    expect(
      featureDoneAt(
        card({
          verifiedAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-19T00:00:00.000Z',
        })
      )
    ).toBe('2026-09-01T00:00:00.000Z');
  });

  it('falls back to the delivery receipt, then activity, for older cards', () => {
    expect(
      featureDoneAt(
        card({
          deliveryCompletion: {
            status: 'succeeded',
            updatedAt: '2026-09-02T00:00:00.000Z',
            steps: [],
          },
          updatedAt: '2026-09-19T00:00:00.000Z',
        })
      )
    ).toBe('2026-09-02T00:00:00.000Z');
    expect(featureDoneAt(card({ updatedAt: '2026-09-19T00:00:00.000Z' }))).toBe(
      '2026-09-19T00:00:00.000Z'
    );
    expect(featureDoneAt(card({}))).toBeNull();
  });
});

describe('isWorktreeRetentionExpired', () => {
  const now = new Date('2026-09-21T00:00:00.000Z');

  it('keeps a card that finished inside the window', () => {
    const fresh = card({ verifiedAt: '2026-09-20T00:00:00.000Z' });
    expect(isWorktreeRetentionExpired(fresh, { now })).toBe(false);
  });

  it('expires a card once the window has passed', () => {
    const old = card({
      verifiedAt: new Date(now.getTime() - DONE_WORKTREE_RETENTION_DAYS * 86_400_000).toISOString(),
    });
    expect(isWorktreeRetentionExpired(old, { now })).toBe(true);
  });

  it('does not expire a card without any timestamp', () => {
    expect(isWorktreeRetentionExpired(card({}), { now })).toBe(false);
  });
});
