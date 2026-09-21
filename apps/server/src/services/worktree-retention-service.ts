/**
 * Worktree retention for the Done lane.
 *
 * A Done card only needs its checkout while a human may still inspect or rework
 * it. After `DONE_WORKTREE_RETENTION_DAYS` the branch already lives on the
 * remote, the task record lives in `.automaker/features/<id>` and pi keeps its
 * conversations under `~/.pi/agent/sessions`, so the checkout is dead weight.
 * This service removes it and records where it was, and rebuilds it at the same
 * path when the card is picked up again - same path on purpose, because pi keys
 * the session directory by working directory.
 *
 * Removing a checkout is destructive, so every guard fails towards keeping it:
 * another card on the branch still being worked on, a running agent, a branch
 * that is not on the remote, or a checkout with local changes all skip it.
 */

import * as path from 'node:path';
import { createLogger } from '@automaker/utils';
import { DONE_WORKTREE_RETENTION_DAYS, featureDoneAt, type Feature } from '@automaker/types';
import { execGitCommand } from '../lib/git.js';
import { releaseDeliveryPreview } from './delivery-completion.js';
import type { FeatureLoader } from './feature-loader.js';
import { WorktreeResolver, type WorktreeInfo } from './worktree-resolver.js';

const logger = createLogger('WorktreeRetention');

/** Bound for the remote checks; a hung fetch must not stall the job. */
const GIT_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorktreeRetentionDeps {
  /** Runs git; injectable so tests need no repository. */
  git?: (args: string[], cwd: string) => Promise<string>;
  /** Stops the worktree's hosted preview before its checkout goes away. */
  releasePreview?: (projectPath: string, feature: Feature) => Promise<unknown>;
  listWorktrees?: (projectPath: string) => Promise<WorktreeInfo[]>;
  /** Feature ids with a live agent; card status is trusted when it is absent. */
  running?: (projectPath: string) => Promise<string[]>;
}

export interface WorktreeRetentionOptions {
  days?: number;
  now?: Date;
  /** Report the decision without removing anything. */
  dryRun?: boolean;
}

export interface ReleasedWorktree {
  branch: string;
  /** Checkout that was removed (and that a rebuild restores) */
  path: string;
  featureIds: string[];
  /** Latest Done timestamp among the branch's cards */
  doneAt: string;
}

export interface KeptWorktree {
  branch: string;
  reason: string;
}

export interface WorktreeRetentionResult {
  released: ReleasedWorktree[];
  kept: KeptWorktree[];
}

/** Where a branch is checked out: `.worktrees/<branch>` minus path-hostile characters. */
export function worktreePathForBranch(projectPath: string, branch: string): string {
  return path.join(projectPath, '.worktrees', branch.replace(/[^a-zA-Z0-9_-]/g, '-'));
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function groupByBranch(features: Feature[]): Map<string, Feature[]> {
  const groups = new Map<string, Feature[]>();
  for (const feature of features) {
    const branch = feature.branchName;
    if (typeof branch !== 'string' || branch.trim() === '') continue;
    const cards = groups.get(branch) ?? [];
    cards.push(feature);
    groups.set(branch, cards);
  }
  return groups;
}

export class WorktreeRetentionService {
  private readonly resolver = new WorktreeResolver();

  constructor(
    private loader: FeatureLoader,
    private deps: WorktreeRetentionDeps = {}
  ) {}

  private async git(args: string[], cwd: string): Promise<string> {
    if (this.deps.git) return this.deps.git(args, cwd);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GIT_TIMEOUT_MS);
    try {
      return await execGitCommand(args, cwd, undefined, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  private listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
    return (this.deps.listWorktrees ?? ((project) => this.resolver.listWorktrees(project)))(
      projectPath
    );
  }

  /**
   * Decide, branch by branch, whether the checkout can go.
   *
   * A worktree is shared by every card on its branch, so the branch is only a
   * candidate when all of them are done and the newest of them is past the
   * retention window.
   */
  async plan(
    projectPath: string,
    options: WorktreeRetentionOptions = {}
  ): Promise<WorktreeRetentionResult> {
    const days = options.days ?? DONE_WORKTREE_RETENTION_DAYS;
    const now = options.now ?? new Date();
    const running = new Set(await (this.deps.running?.(projectPath) ?? []));
    const trees = await this.listWorktrees(projectPath);
    const features = await this.loader.getAll(projectPath);

    const released: ReleasedWorktree[] = [];
    const kept: KeptWorktree[] = [];
    for (const [branch, cards] of groupByBranch(features)) {
      const tree = trees.find((candidate) => candidate.branch === branch);
      if (!tree || tree.isMain) continue; // Already released, or never checked out.
      const verdict = await this.inspect(projectPath, branch, cards, tree.path, {
        days,
        now,
        running,
      });
      if ('reason' in verdict) kept.push({ branch, reason: verdict.reason });
      else
        released.push({
          branch,
          path: tree.path,
          featureIds: cards.map((card) => card.id),
          doneAt: verdict.doneAt,
        });
    }
    return { released, kept };
  }

  /** Remove every checkout the plan released, and mark the cards it covered. */
  async run(
    projectPath: string,
    options: WorktreeRetentionOptions = {}
  ): Promise<WorktreeRetentionResult> {
    const planned = await this.plan(projectPath, options);
    if (options.dryRun) return planned;
    const released: ReleasedWorktree[] = [];
    const kept = [...planned.kept];
    for (const candidate of planned.released) {
      try {
        await this.release(projectPath, candidate);
        released.push(candidate);
        logger.info(
          `Released worktree ${candidate.path} for ${candidate.branch} (${candidate.featureIds.length} card(s))`
        );
      } catch (error) {
        kept.push({ branch: candidate.branch, reason: `释放失败：${message(error)}` });
        logger.warn(`Could not release worktree for ${candidate.branch}: ${message(error)}`);
      }
    }
    return { released, kept };
  }

  /**
   * Rebuild a released checkout from its branch, reusing the original path.
   *
   * Returns null when the card has no branch; throws when the branch cannot be
   * checked out again (nothing left to rebuild from).
   */
  async ensureWorktree(projectPath: string, feature: Feature): Promise<string | null> {
    const branch = feature.branchName;
    if (typeof branch !== 'string' || branch.trim() === '') return null;
    const existing = (await this.listWorktrees(projectPath)).find((tree) => tree.branch === branch);
    if (existing) return existing.path;

    try {
      await this.git(['fetch', '--quiet', 'origin', branch], projectPath);
    } catch (error) {
      // The local branch may still hold everything; try to check it out anyway.
      logger.warn(`Could not fetch origin/${branch} before rebuilding: ${message(error)}`);
    }
    // Reuse the path the checkout had before it was released: pi keys its
    // session directory by working directory, so a rebuilt card finds its
    // conversation history again. A recorded path outside the project (or none,
    // for cards released before this was recorded) falls back to the standard
    // location.
    const recorded = feature.worktreeRelease?.path;
    const workDir =
      recorded && path.resolve(recorded).startsWith(path.resolve(projectPath) + path.sep)
        ? recorded
        : worktreePathForBranch(projectPath, branch);
    const hasLocalBranch = await this.hasBranch(projectPath, `refs/heads/${branch}`);
    await this.git(
      hasLocalBranch
        ? ['worktree', 'add', workDir, branch]
        : ['worktree', 'add', '-b', branch, workDir, `origin/${branch}`],
      projectPath
    );
    logger.info(`Rebuilt worktree for ${branch} at ${workDir}`);
    await this.clearReleaseMarks(projectPath, branch);
    return workDir;
  }

  private async inspect(
    projectPath: string,
    branch: string,
    cards: Feature[],
    workDir: string,
    context: { days: number; now: Date; running: Set<string> }
  ): Promise<{ doneAt: string } | { reason: string }> {
    const active = cards.filter(
      (card) => card.status !== 'verified' && card.status !== 'completed'
    );
    if (active.length > 0) return { reason: `${active.length} 张卡还未完成` };
    if (cards.some((card) => context.running.has(card.id))) return { reason: '任务正在运行' };

    const stamps = cards
      .map((card) => featureDoneAt(card))
      .filter((value): value is string => value !== null);
    if (stamps.length === 0) return { reason: '没有完成时间记录' };
    const doneAt = stamps.sort().at(-1)!;
    if (context.now.getTime() - Date.parse(doneAt) < context.days * DAY_MS)
      return { reason: `完成未满 ${context.days} 天` };

    if (!(await this.isOnRemote(projectPath, branch)))
      return { reason: '分支尚未推送到远端，无法重建' };
    if (!(await this.isClean(workDir))) return { reason: 'worktree 有未提交改动' };
    return { doneAt };
  }

  private async release(projectPath: string, candidate: ReleasedWorktree): Promise<void> {
    const cards = (await this.loader.getAll(projectPath)).filter(
      (card) => card.branchName === candidate.branch
    );
    if (cards.length === 0) throw new Error('分支上已没有卡片');

    // The preview is bookkept by checkout path, so it has to go first; the
    // delivery flow already knows how to leave another task's preview alone.
    const releasePreview =
      this.deps.releasePreview ??
      ((project: string, feature: Feature) =>
        releaseDeliveryPreview(this.loader, project, feature));
    try {
      await releasePreview(projectPath, cards[0]);
    } catch (error) {
      logger.warn(`Could not release the preview for ${candidate.branch}: ${message(error)}`);
    }

    await this.removeCheckout(projectPath, candidate.path);
    const releasedAt = new Date().toISOString();
    for (const card of cards) {
      await this.loader.update(projectPath, card.id, {
        worktreeRelease: { releasedAt, path: candidate.path, branch: candidate.branch },
      });
    }
  }

  private async removeCheckout(projectPath: string, workDir: string): Promise<void> {
    try {
      await this.git(['worktree', 'remove', workDir], projectPath);
    } catch (error) {
      // Already missing or in a bad state: drop the registration instead.
      logger.warn(`git worktree remove failed for ${workDir}, pruning: ${message(error)}`);
      await this.git(['worktree', 'prune'], projectPath);
    }
    const stillThere = (await this.listWorktrees(projectPath)).some(
      (tree) => path.resolve(tree.path) === path.resolve(workDir)
    );
    if (stillThere) throw new Error(`worktree ${workDir} 仍然存在`);
  }

  /** Forget the release mark once the checkout is back. */
  private async clearReleaseMarks(projectPath: string, branch: string): Promise<void> {
    const cards = (await this.loader.getAll(projectPath)).filter(
      (card) => card.branchName === branch && card.worktreeRelease
    );
    for (const card of cards) {
      await this.loader.update(projectPath, card.id, { worktreeRelease: undefined });
    }
  }

  private async isOnRemote(projectPath: string, branch: string): Promise<boolean> {
    try {
      await this.git(['fetch', '--quiet', 'origin', branch], projectPath);
    } catch (error) {
      logger.warn(`Could not refresh origin/${branch}: ${message(error)}`);
      return false;
    }
    return this.hasBranch(projectPath, `refs/remotes/origin/${branch}`);
  }

  private async hasBranch(projectPath: string, ref: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', ref], projectPath);
      return true;
    } catch {
      return false;
    }
  }

  private async isClean(workDir: string): Promise<boolean> {
    try {
      return (await this.git(['status', '--porcelain'], workDir)).trim() === '';
    } catch (error) {
      logger.warn(`Could not read the status of ${workDir}: ${message(error)}`);
      return false;
    }
  }
}
