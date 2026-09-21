import { describe, expect, it, vi } from 'vitest';
import type { Feature } from '@automaker/types';
import {
  WorktreeRetentionService,
  worktreePathForBranch,
} from '../../../src/services/worktree-retention-service.js';
import type { FeatureLoader } from '../../../src/services/feature-loader.js';

const PROJECT = '/project';
const BRANCH = 'jira/aip-114859-dodo';
const WORKTREE = '/project/.worktrees/aip-114859-dodo';
const OLD = new Date('2026-09-01T00:00:00.000Z').toISOString();
const NOW = new Date('2026-09-21T00:00:00.000Z');

function card(id: string, fields: Partial<Feature> = {}): Feature {
  return {
    id,
    title: id,
    category: 'test',
    description: 'x',
    status: 'verified',
    branchName: BRANCH,
    verifiedAt: OLD,
    ...fields,
  } as Feature;
}

function setup(
  options: {
    cards?: Feature[];
    clean?: boolean;
    pushed?: boolean;
    /** Whether the checkout exists right now */
    present?: boolean;
    /** Whether `git worktree remove` succeeds */
    removable?: boolean;
    running?: string[];
    localBranch?: boolean;
  } = {}
) {
  const cards = options.cards ?? [card('card-1')];
  let present = options.present ?? true;
  const removable = options.removable ?? true;
  const loader = {
    getAll: vi.fn(async () => cards),
    update: vi.fn(async (_p: string, id: string, updates: Partial<Feature>) => ({
      ...cards.find((entry) => entry.id === id),
      ...updates,
    })),
  };
  const calls: string[][] = [];
  const git = vi.fn(async (args: string[]) => {
    calls.push(args);
    const [command, ...rest] = args;
    if (command === 'fetch') {
      if (!(options.pushed ?? true)) throw new Error('couldn’t find remote ref');
      return '';
    }
    if (command === 'rev-parse') {
      const ref = rest.at(-1) ?? '';
      if (ref.startsWith('refs/remotes/origin/')) {
        if (options.pushed ?? true) return 'abc123\n';
        throw new Error('unknown revision');
      }
      if (options.localBranch ?? true) return 'abc123\n';
      throw new Error('unknown revision');
    }
    if (command === 'status') return options.clean === false ? ' M src/a.ts\n' : '';
    if (command === 'worktree' && rest[0] === 'remove') {
      if (!removable) throw new Error('worktree is dirty');
      present = false;
      return '';
    }
    if (command === 'worktree' && rest[0] === 'add') return '';
    if (command === 'worktree' && rest[0] === 'prune') return '';
    return '';
  });
  const releasePreview = vi.fn(async () => ({}));
  const service = new WorktreeRetentionService(loader as unknown as FeatureLoader, {
    git: git as unknown as (args: string[], cwd: string) => Promise<string>,
    releasePreview,
    listWorktrees: async () => (present ? [{ path: WORKTREE, branch: BRANCH, isMain: false }] : []),
    running: async () => options.running ?? [],
  });
  return { service, loader, git, releasePreview, calls };
}

describe('WorktreeRetentionService.plan', () => {
  it('releases a branch whose cards have all been done past the window', async () => {
    const { service } = setup();
    const result = await service.plan(PROJECT, { now: NOW });
    expect(result.released).toEqual([
      { branch: BRANCH, path: WORKTREE, featureIds: ['card-1'], doneAt: OLD },
    ]);
    expect(result.kept).toEqual([]);
  });

  it('keeps the checkout while any card on the branch is still being worked on', async () => {
    const { service } = setup({ cards: [card('done'), card('open', { status: 'backlog' })] });
    const result = await service.plan(PROJECT, { now: NOW });
    expect(result.released).toEqual([]);
    expect(result.kept[0].reason).toContain('1 张卡还未完成');
  });

  it('keeps the checkout while a card is inside the retention window', async () => {
    const { service } = setup({
      cards: [card('fresh', { verifiedAt: '2026-09-20T00:00:00.000Z' })],
    });
    const result = await service.plan(PROJECT, { now: NOW });
    expect(result.released).toEqual([]);
    expect(result.kept[0].reason).toContain('完成未满 7 天');
  });

  it('keeps the checkout of a running task', async () => {
    const { service } = setup({ running: ['card-1'] });
    const result = await service.plan(PROJECT, { now: NOW });
    expect(result.released).toEqual([]);
    expect(result.kept[0].reason).toBe('任务正在运行');
  });

  it('keeps the checkout when the branch is not on the remote', async () => {
    const { service } = setup({ pushed: false });
    const result = await service.plan(PROJECT, { now: NOW });
    expect(result.released).toEqual([]);
    expect(result.kept[0].reason).toContain('尚未推送到远端');
  });

  it('keeps the checkout when it has local changes', async () => {
    const { service } = setup({ clean: false });
    const result = await service.plan(PROJECT, { now: NOW });
    expect(result.released).toEqual([]);
    expect(result.kept[0].reason).toBe('worktree 有未提交改动');
  });

  it('ignores branches that have no checkout', async () => {
    const { service } = setup({ cards: [card('gone', { branchName: 'jira/other' })] });
    const result = await service.plan(PROJECT, { now: NOW });
    expect(result.released).toEqual([]);
    expect(result.kept).toEqual([]);
  });
});

describe('WorktreeRetentionService.run', () => {
  it('removes the checkout, releases the preview and marks every card', async () => {
    const { service, loader, releasePreview, calls } = setup({
      cards: [card('card-1'), card('card-2')],
    });
    const result = await service.run(PROJECT, { now: NOW });
    expect(result.released).toHaveLength(1);
    expect(releasePreview).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual(['worktree', 'remove', WORKTREE]);
    const marked = loader.update.mock.calls.map((call) => call[1]);
    expect(marked).toEqual(['card-1', 'card-2']);
    expect(loader.update.mock.calls[0][2]).toEqual({
      worktreeRelease: {
        releasedAt: expect.any(String),
        path: WORKTREE,
        branch: BRANCH,
      },
    });
  });

  it('does not touch anything in a dry run', async () => {
    const { service, loader, git } = setup();
    const result = await service.run(PROJECT, { now: NOW, dryRun: true });
    expect(result.released).toHaveLength(1);
    expect(git).not.toHaveBeenCalledWith(['worktree', 'remove', WORKTREE], PROJECT);
    expect(loader.update).not.toHaveBeenCalled();
  });

  it('keeps the card unmarked when the checkout survives the removal', async () => {
    const { service, loader } = setup({ removable: false });
    const result = await service.run(PROJECT, { now: NOW });
    expect(result.released).toEqual([]);
    expect(result.kept[0].reason).toContain('释放失败');
    expect(loader.update).not.toHaveBeenCalled();
  });
});

describe('WorktreeRetentionService.ensureWorktree', () => {
  it('rebuilds from origin when only the remote branch exists', async () => {
    const released = card('card-1', {
      worktreeRelease: { releasedAt: OLD, path: WORKTREE, branch: BRANCH },
    });
    const { service, loader, calls } = setup({
      cards: [released],
      localBranch: false,
      present: false,
    });
    const workDir = await service.ensureWorktree(PROJECT, released);
    // The recorded path is reused so pi finds the card's session directory again.
    expect(workDir).toBe(WORKTREE);
    expect(calls).toContainEqual(['worktree', 'add', '-b', BRANCH, WORKTREE, `origin/${BRANCH}`]);
    expect(loader.update).toHaveBeenCalledWith(PROJECT, 'card-1', { worktreeRelease: undefined });
  });

  it('falls back to the standard path when nothing was recorded', async () => {
    const { service, calls } = setup({ localBranch: true, present: false });
    const workDir = await service.ensureWorktree(PROJECT, card('card-1'));
    expect(workDir).toBe(worktreePathForBranch(PROJECT, BRANCH));
    expect(calls).toContainEqual([
      'worktree',
      'add',
      worktreePathForBranch(PROJECT, BRANCH),
      BRANCH,
    ]);
  });

  it('checks out the local branch when it is still there', async () => {
    const { service, calls } = setup({ localBranch: true, present: false });
    await service.ensureWorktree(PROJECT, card('card-1'));
    expect(calls).toContainEqual([
      'worktree',
      'add',
      worktreePathForBranch(PROJECT, BRANCH),
      BRANCH,
    ]);
  });

  it('returns the existing checkout untouched', async () => {
    const { service, loader, calls } = setup();
    expect(await service.ensureWorktree(PROJECT, card('card-1'))).toBe(WORKTREE);
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(false);
    expect(loader.update).not.toHaveBeenCalled();
  });

  it('has nothing to rebuild without a branch', async () => {
    const { service } = setup();
    expect(await service.ensureWorktree(PROJECT, card('card-1', { branchName: null }))).toBeNull();
  });
});
