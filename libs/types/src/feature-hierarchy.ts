/**
 * Feature hierarchy rules (parent card ⇄ child cards).
 *
 * A monitor-dispatched Jira issue produces one parent card plus
 * `<base>-child-N` cards (or explicit `parentFeatureId` / `jiraParentKey` links
 * written by the Jira tree importer). The board renders parent and children as
 * separate cards, so these rules only answer "who belongs to whom" - they never
 * hide a card.
 *
 * They live in `@automaker/types` because both the board (UI) and the worktree
 * progress rollup (server) must resolve children the same way; two copies would
 * drift the moment the naming convention changes.
 *
 * The helpers are generic over a minimal structural shape so the UI's stricter
 * `Feature` (required `steps`, pipeline statuses, ...) keeps its own type
 * through the call instead of being widened to the base `Feature`.
 */

/** The fields the hierarchy rules read from a card. */
export interface HierarchyFeature {
  id: string;
  /** Jira issue key; cards of one issue are siblings. */
  jiraKey?: unknown;
  /** Subtask list rendered on the parent card. */
  jiraSubtasks?: unknown;
  /** Creation time, used to order children under their parent. */
  createdAt?: string;
  /** Explicit parent card id written by the dispatcher. */
  parentFeatureId?: string;
  /** Parent issue key written by the dispatcher (`jiraParentKey`) or importer. */
  jiraParentKey?: string;
  parentJiraKey?: string;
}

/** Monitor convention for an auto-decomposed child card: `<base>-child-N`. */
const CHILD_ID_PATTERN = /^(?<base>.+)-child-\d+$/;

/** The `<base>` of a `<base>-child-N` id, or undefined for a root card. */
export function featureChildBaseId(feature: HierarchyFeature): string | undefined {
  return CHILD_ID_PATTERN.exec(feature.id)?.groups?.base;
}

/** Whether a card may be a task-tree root (children are never roots). */
export function isFeatureParentCandidate(feature: HierarchyFeature): boolean {
  return !CHILD_ID_PATTERN.test(feature.id);
}

function jiraKeyOf(feature: HierarchyFeature): string | undefined {
  return typeof feature.jiraKey === 'string' && feature.jiraKey !== ''
    ? feature.jiraKey
    : undefined;
}

function parentMatchesBase(parent: HierarchyFeature, base: string): boolean {
  const normalizedBase = base.toLowerCase();
  if (parent.id.toLowerCase().endsWith(normalizedBase)) return true;
  return jiraKeyOf(parent)?.toLowerCase() === normalizedBase;
}

function parentFeatureIdOf(feature: HierarchyFeature): string | undefined {
  const value = feature.parentFeatureId;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function jiraParentKeyOf(feature: HierarchyFeature): string | undefined {
  // The dispatcher writes `jiraParentKey`, the Jira tree importer writes
  // `parentJiraKey`; both mean "this card's parent issue".
  const value = feature.jiraParentKey ?? feature.parentJiraKey;
  return typeof value === 'string' && value !== '' ? value.toUpperCase() : undefined;
}

function hasHierarchyLink<F extends HierarchyFeature>(feature: F, features: F[]): boolean {
  const parentFeatureId = parentFeatureIdOf(feature);
  if (parentFeatureId && features.some((candidate) => candidate.id === parentFeatureId)) {
    return true;
  }

  const jiraParentKey = jiraParentKeyOf(feature);
  if (!jiraParentKey) return false;
  return features.some(
    (candidate) =>
      candidate.id !== feature.id && jiraKeyOf(candidate)?.toUpperCase() === jiraParentKey
  );
}

/**
 * Jira subtask keys the parent card declares (`jiraSubtasks`).
 *
 * A subtask dispatched as its own feature is linked through that list even
 * before/without explicit `jiraParentKey` metadata.
 */
function listedJiraSubtasks(parent: HierarchyFeature): string[] {
  const subtasks = parent.jiraSubtasks;
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .map((entry) =>
      entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string'
        ? String((entry as { key: string }).key).toUpperCase()
        : ''
    )
    .filter((key) => key !== '');
}

function isListedSubtaskOf(child: HierarchyFeature, parent: HierarchyFeature): boolean {
  const childKey = jiraKeyOf(child)?.toUpperCase();
  if (!childKey) return false;
  return listedJiraSubtasks(parent).includes(childKey);
}

/** Explicit hierarchy link written by the dispatcher / Jira importer. */
function isHierarchyChildOf(child: HierarchyFeature, parent: HierarchyFeature): boolean {
  const parentFeatureId = parentFeatureIdOf(child);
  if (parentFeatureId && parentFeatureId === parent.id) return true;

  const jiraParentKey = jiraParentKeyOf(child);
  return Boolean(jiraParentKey && jiraKeyOf(parent)?.toUpperCase() === jiraParentKey);
}

/**
 * Children that belong under a given parent card, ordered by creation time.
 *
 * A card is a child when it is linked explicitly (`parentFeatureId` /
 * `jiraParentKey`), listed in the parent's `jiraSubtasks`, follows the
 * `<base>-child-N` convention of the parent, or simply shares the parent's
 * `jiraKey`.
 */
export function getChildFeaturesForParent<F extends HierarchyFeature>(
  parent: F,
  features: F[]
): F[] {
  if (!isFeatureParentCandidate(parent)) return [];

  return features
    .filter((candidate) => {
      if (candidate.id === parent.id) return false;

      if (isHierarchyChildOf(candidate, parent)) return true;
      if (isListedSubtaskOf(candidate, parent)) return true;

      const base = featureChildBaseId(candidate);
      if (base && parentMatchesBase(parent, base)) return true;

      // Children that do not follow the id convention still share the Jira key
      const parentKey = jiraKeyOf(parent);
      return Boolean(parentKey && candidate.jiraKey === parent.jiraKey);
    })
    .sort((left, right) =>
      String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
    );
}

/**
 * Whether this card is the root of a task tree (has child cards).
 *
 * The board shows both the parent and every child card; the parent is rendered
 * first in its lane and carries the aggregate progress, so "parent" is used for
 * ordering and summary, never for hiding children.
 */
export function hasChildFeatures<F extends HierarchyFeature>(feature: F, features: F[]): boolean {
  return getChildFeaturesForParent(feature, features).length > 0;
}

/** Parent feature ids of the given cards (for pinning roots first). */
export function parentFeatureIdsOf<F extends HierarchyFeature>(features: F[]): Set<string> {
  const ids = new Set<string>();
  for (const feature of features) {
    const parentFeatureId = parentFeatureIdOf(feature);
    const jiraParentKey = jiraParentKeyOf(feature);
    if (parentFeatureId) ids.add(parentFeatureId);
    if (!jiraParentKey) continue;
    const parent = features.find(
      (candidate) =>
        candidate.id !== feature.id && jiraKeyOf(candidate)?.toUpperCase() === jiraParentKey
    );
    if (parent) ids.add(parent.id);
  }
  return ids;
}

/** Jira keys of the `jira-*` cards in the list (legacy folding helper). */
export function getParentJiraKeys<F extends HierarchyFeature>(features: F[]): Set<string> {
  return new Set(
    features
      .filter((feature) => feature.id.startsWith('jira-'))
      .map((feature) => jiraKeyOf(feature))
      .filter((jiraKey): jiraKey is string => jiraKey !== undefined)
  );
}
