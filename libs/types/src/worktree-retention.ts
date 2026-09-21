/**
 * Worktree retention for cards that are done.
 *
 * A Done card keeps its checkout for a week so the human can still inspect or
 * rework it. After that the branch, the task record and the pi conversations are
 * all that is needed, so the checkout is released to give the disk back. The
 * same window drives both rules, which is why it lives here: the board hides
 * what the retention job releases.
 */

import type { Feature } from './feature.js';

/** Days a card stays in Done with its worktree checkout before it is released. */
export const DONE_WORKTREE_RETENTION_DAYS = 7;

type DoneTimestampFields = Pick<
  Feature,
  'verifiedAt' | 'updatedAt' | 'createdAt' | 'deliveryCompletion'
>;

/**
 * When the card entered Done.
 *
 * `verifiedAt` is written whenever a card becomes verified, so it is the exact
 * answer for everything verified after that field was introduced. Older cards
 * fall back to the most recent activity they recorded.
 */
export function featureDoneAt(feature: DoneTimestampFields): string | null {
  const candidates = [
    feature.verifiedAt,
    feature.deliveryCompletion?.updatedAt,
    feature.updatedAt,
    feature.createdAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

/** True once a done card has outlived the worktree retention window. */
export function isWorktreeRetentionExpired(
  feature: DoneTimestampFields,
  options: { days?: number; now?: Date } = {}
): boolean {
  const doneAt = featureDoneAt(feature);
  if (!doneAt) return false;
  const done = Date.parse(doneAt);
  if (Number.isNaN(done)) return false;
  const days = options.days ?? DONE_WORKTREE_RETENTION_DAYS;
  const now = (options.now ?? new Date()).getTime();
  return now - done >= days * 24 * 60 * 60 * 1000;
}
