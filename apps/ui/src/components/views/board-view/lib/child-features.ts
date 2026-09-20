import type { Feature } from '@/store/app-store';

/**
 * Board view of a task tree.
 *
 * Every card in the tree stays on the board - the root is pinned first in its
 * lane and aggregates child progress through `ChildTaskSummary`. The rules
 * themselves live in `@automaker/types` (`feature-hierarchy.ts`) so the server
 * resolves children exactly like the board does; they are re-exported here for
 * existing imports.
 */
export { getChildFeaturesForParent, hasChildFeatures, parentFeatureIdsOf } from '@automaker/types';
import { getChildFeaturesForParent } from '@automaker/types';

/** The board keeps every task-tree card; ordering/pinning is applied by the lane hook. */
export function getBoardTaskTreeFeatures(features: Feature[]): Feature[] {
  return features;
}

/**
 * Whether the card should fall back to the raw Jira subtask list.
 *
 * Once the subtasks exist as board cards the child summary renders them with
 * their real execution state, so showing the Jira list as well would duplicate
 * the same subtasks twice on one card.
 */
export function shouldShowJiraSubtaskList(feature: Feature, features: Feature[]): boolean {
  const subtasks = feature.jiraSubtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) return false;
  return getChildFeaturesForParent(feature, features).length === 0;
}
