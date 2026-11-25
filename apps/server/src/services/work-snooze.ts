import path from 'node:path';
import type { Feature } from '@automaker/types';
import { atomicWriteJson } from '@automaker/utils';
import * as fs from '../lib/secure-fs.js';

type Snooze = NonNullable<Feature['worktreeSnooze']>;
type WorkSnoozes = Record<string, Snooze>;

// ponytail: single-server lock; use a shared lock if multiple API instances write project state.
export const changingWorkSnoozes = new Set<string>();
export class WorkSnoozedError extends Error {}

export async function readWorkSnoozes(project: string): Promise<WorkSnoozes> {
  try {
    const value = JSON.parse(
      (await fs.readFile(path.join(project, '.automaker', 'work-snoozes.json'), 'utf8')) as string
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid work snooze state');
    for (const snooze of Object.values(value) as Snooze[]) {
      if (
        !snooze ||
        typeof snooze.snoozedAt !== 'string' ||
        !Number.isFinite(Date.parse(snooze.snoozedAt)) ||
        (snooze.reason !== undefined && typeof snooze.reason !== 'string')
      )
        throw new Error('Invalid work snooze state');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error; // Unreadable pause state must never enable dispatch.
  }
}

export async function writeWorkSnoozes(project: string, value: WorkSnoozes): Promise<void> {
  await atomicWriteJson(path.join(project, '.automaker', 'work-snoozes.json'), value);
}

export function workSnoozeFor(snoozes: WorkSnoozes, branch?: string | null): Snooze | undefined {
  return branch && Object.hasOwn(snoozes, branch) ? snoozes[branch] : undefined;
}

export async function assertWorkNotSnoozed(project: string, branch?: string | null): Promise<void> {
  try {
    if (
      changingWorkSnoozes.has(path.resolve(project)) ||
      workSnoozeFor(await readWorkSnoozes(project), branch)
    )
      throw new WorkSnoozedError(
        'This work is snoozed. Resume it in Work Board before starting an agent.'
      );
  } catch (error) {
    if (error instanceof WorkSnoozedError) throw error;
    throw new WorkSnoozedError(`Could not verify work snooze state: ${(error as Error).message}`);
  }
}
