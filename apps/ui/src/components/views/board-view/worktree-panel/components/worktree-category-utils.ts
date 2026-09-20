/**
 * Worktree switcher categories.
 *
 * The worktree switcher (desktop dropdown + mobile dropdown) renders its list
 * grouped into a fixed set of categories, always in this order:
 *
 *   工作中 (working) → 空闲 (idle) → 新增 (new) → 已完成 (done)
 *
 * Classification rules (first match wins):
 *
 * - working: an agent / auto-mode run / test run is active in the worktree, or
 *   one of its cards is in an active status (running / planning / pipeline step).
 * - done: no active work and either the linked PR is merged or every card on the
 *   branch is in a terminal status (verified / completed / merged / …).
 * - new: the worktree has no card at all — a freshly created worktree.
 * - idle: everything else (backlog cards, cards waiting for review, failures…).
 *
 * The main worktree is never reported as `new`: it always existed, so an empty
 * main branch shows up as `idle`.
 *
 * The same module builds the keyword haystack used by the switcher filter, so a
 * query can match a branch name, a path, a card title/id/Jira key or a PR.
 */

import type { FeatureInfo, WorktreeInfo } from '../types';

export type WorktreeCategory = 'working' | 'idle' | 'new' | 'done';

/** Display order of the switcher groups. */
export const WORKTREE_CATEGORY_ORDER: readonly WorktreeCategory[] = [
  'working',
  'idle',
  'new',
  'done',
];

export interface WorktreeCategoryMeta {
  /** Group header label */
  label: string;
  /** Explanation shown in the group header tooltip */
  hint: string;
  /** Tailwind class of the status dot next to the label */
  dotClass: string;
}

export const WORKTREE_CATEGORY_META: Record<WorktreeCategory, WorktreeCategoryMeta> = {
  working: {
    label: '工作中',
    hint: '有 agent / 自动模式 / 测试正在这个 worktree 里运行',
    dotClass: 'bg-[var(--status-in-progress)]',
  },
  idle: {
    label: '空闲',
    hint: '有卡片，但没有正在运行的任务',
    dotClass: 'bg-[var(--status-waiting)]',
  },
  new: {
    label: '新增',
    hint: '刚创建，还没有关联卡片',
    dotClass: 'bg-[var(--status-backlog)]',
  },
  done: {
    label: '已完成',
    hint: '卡片全部完成，或 PR 已合并',
    dotClass: 'bg-[var(--status-success)]',
  },
};

/**
 * Card statuses that mean work is in flight.
 * Mirrors the lifecycle mapping used by the worktree progress endpoint.
 */
const ACTIVE_STATUSES = new Set([
  'planning',
  'running',
  'in_progress',
  'executing',
  'implementing',
]);

/** Card statuses that mean the work is finished. */
const COMPLETE_STATUSES = new Set(['verified', 'completed', 'complete', 'done', 'merged']);

function normalizeStatus(status: string | null | undefined): string | null {
  if (!status) return null;
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return normalized || null;
}

/** Whether a card status means the agent is (or should be) working on it. */
export function isActiveFeatureStatus(status?: string | null): boolean {
  const normalized = normalizeStatus(status);
  if (!normalized) return false;
  return ACTIVE_STATUSES.has(normalized) || normalized.startsWith('pipeline_');
}

/** Whether a card status means the card is finished. */
export function isCompleteFeatureStatus(status?: string | null): boolean {
  const normalized = normalizeStatus(status);
  return normalized !== null && COMPLETE_STATUSES.has(normalized);
}

/**
 * Cards attached to a worktree: cards whose branch matches, plus the cards
 * without a branch (they live in the main worktree).
 */
export function getWorktreeFeatures(
  worktree: WorktreeInfo,
  features?: FeatureInfo[]
): FeatureInfo[] {
  if (!features || features.length === 0) return [];
  return features.filter((feature) =>
    feature.branchName ? feature.branchName === worktree.branch : worktree.isMain
  );
}

export interface WorktreeCategorySignals {
  /** Whether an agent / auto-mode run / test run is active for the worktree. */
  isRunning?: (worktree: WorktreeInfo) => boolean;
  /** Board cards, used to read the lifecycle stage of the worktree. */
  features?: FeatureInfo[];
  /** Unarchived card count per branch. */
  cardCounts?: Record<string, number>;
}

/** Resolve which switcher group a worktree belongs to. */
export function classifyWorktreeCategory(
  worktree: WorktreeInfo,
  signals: WorktreeCategorySignals = {}
): WorktreeCategory {
  const relatedFeatures = getWorktreeFeatures(worktree, signals.features);
  const statuses = relatedFeatures.map((feature) => feature.status);

  if (signals.isRunning?.(worktree) || statuses.some(isActiveFeatureStatus)) {
    return 'working';
  }

  if (worktree.pr?.state === 'MERGED') return 'done';

  if (statuses.length > 0 && statuses.every(isCompleteFeatureStatus)) return 'done';

  const cardCount = signals.cardCounts?.[worktree.branch] ?? 0;
  if (relatedFeatures.length > 0 || cardCount > 0) return 'idle';

  return worktree.isMain ? 'idle' : 'new';
}

/**
 * Lower-cased text a worktree can be matched against by the keyword filter.
 * `extraTerms` lets callers fold in the worktree's own category label.
 */
export function buildWorktreeSearchText(
  worktree: WorktreeInfo,
  features?: FeatureInfo[],
  extraTerms: Array<string | number | null | undefined> = []
): string {
  const relatedFeatures = getWorktreeFeatures(worktree, features);
  const parts: Array<string | number | null | undefined> = [
    worktree.branch,
    worktree.path,
    worktree.path.split('/').filter(Boolean).pop(),
    worktree.pr?.number,
    worktree.pr?.title,
    ...extraTerms,
  ];

  for (const feature of relatedFeatures) {
    parts.push(feature.id, feature.title, feature.jiraKey);
  }

  return parts
    .filter((value) => value !== undefined && value !== null && value !== '')
    .join(' ')
    .toLowerCase();
}

/**
 * Keyword match for the switcher filter. Every whitespace separated term in the
 * query must appear somewhere in the worktree text.
 */
export function matchesWorktreeSearch(
  worktree: WorktreeInfo,
  features: FeatureInfo[] | undefined,
  query: string,
  extraTerms: Array<string | number | null | undefined> = []
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = buildWorktreeSearchText(worktree, features, extraTerms);
  return terms.every((term) => haystack.includes(term));
}

export interface WorktreeCategoryGroup {
  category: WorktreeCategory | 'recent';
  label: string;
  hint: string;
  dotClass: string;
  worktrees: WorktreeInfo[];
}

/**
 * Filter the worktree list by `query` and group it into the switcher categories,
 * skipping empty groups. Groups are returned in WORKTREE_CATEGORY_ORDER.
 */
export function buildWorktreeCategoryGroups(
  worktrees: WorktreeInfo[],
  signals: WorktreeCategorySignals = {},
  query = ''
): WorktreeCategoryGroup[] {
  const buckets = new Map<WorktreeCategory, WorktreeInfo[]>(
    WORKTREE_CATEGORY_ORDER.map((category) => [category, []])
  );

  for (const worktree of worktrees) {
    const category = classifyWorktreeCategory(worktree, signals);
    const matches = matchesWorktreeSearch(worktree, signals.features, query, [
      WORKTREE_CATEGORY_META[category].label,
    ]);
    if (!matches) continue;
    buckets.get(category)?.push(worktree);
  }

  return WORKTREE_CATEGORY_ORDER.map((category) => ({
    category,
    ...WORKTREE_CATEGORY_META[category],
    worktrees: buckets.get(category) ?? [],
  })).filter((group) => group.worktrees.length > 0);
}

/** Recent entries retain visit order and appear only once in the switcher. */
export function withRecentWorktrees(
  groups: WorktreeCategoryGroup[],
  recentPaths: readonly string[] = []
): WorktreeCategoryGroup[] {
  const available = new Map(
    groups.flatMap((group) => group.worktrees).map((tree) => [tree.path, tree])
  );
  const recent = [...new Set(recentPaths)]
    .slice(0, 5)
    .map((path) => available.get(path))
    .filter((tree): tree is WorktreeInfo => !!tree);
  if (!recent.length) return groups;
  const paths = new Set(recent.map((tree) => tree.path));
  return [
    {
      category: 'recent',
      label: '最近访问',
      hint: '最近访问的 5 个 worktree，按访问时间排序',
      dotClass: 'bg-brand-500',
      worktrees: recent,
    },
    ...groups
      .map((group) => ({
        ...group,
        worktrees: group.worktrees.filter((tree) => !paths.has(tree.path)),
      }))
      .filter((group) => group.worktrees.length > 0),
  ];
}
