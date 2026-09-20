import type { Feature, SimilarTask, SimilarTaskPair } from '@automaker/types';
import { featureChildBaseId } from '@automaker/types';

/** Missing/archived parents do not turn a known subtask into an independent task. */
export function independentTaskRoots(features: Feature[]): Feature[] {
  const key = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : '');
  const listedChildren = new Map<string, Set<string>>();
  for (const parent of features) {
    for (const child of parent.jiraSubtasks ?? []) {
      const childKey = key(child.key);
      if (!childKey) continue;
      const parents = listedChildren.get(childKey) ?? new Set<string>();
      parents.add(parent.id);
      listedChildren.set(childKey, parents);
    }
  }
  return features.filter((feature) => {
    if (
      feature.archive ||
      feature.supersededBy ||
      feature.consolidationPlanId ||
      featureChildBaseId(feature)
    )
      return false;
    if (
      typeof feature.parentFeatureId === 'string' &&
      feature.parentFeatureId.trim() &&
      feature.parentFeatureId !== feature.id
    )
      return false;
    const ownKey = key(feature.jiraKey);
    for (const parentKey of [feature.parentJiraKey, feature.jiraParentKey, feature.epicJiraKey]) {
      if (key(parentKey) && key(parentKey) !== ownKey) return false;
    }
    if ([...(listedChildren.get(ownKey) ?? [])].some((id) => id !== feature.id)) return false;
    if (
      typeof feature.issueType === 'string' &&
      /^(?:sub[- ]?task|子任务)$/i.test(feature.issueType.trim())
    )
      return false;
    return true;
  });
}

/** Exclude shared Agent instructions, MR templates and error logs from similarity. */
export function taskScope(feature: Feature): string {
  const description = feature.description || '';
  const snapshot = description.lastIndexOf('Initial Jira snapshot');
  if (snapshot >= 0) {
    const start = description.indexOf('{', snapshot);
    if (start >= 0) {
      // Snapshot may have instructions appended after JSON. Find the first complete object.
      let depth = 0,
        quoted = false,
        escaped = false;
      for (let i = start; i < description.length; i++) {
        const ch = description[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quoted = false;
        } else if (ch === '"') quoted = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try {
            const data = JSON.parse(description.slice(start, i + 1));
            return [data.summary, data.description]
              .filter((v) => typeof v === 'string')
              .join('\n')
              .slice(0, 12000);
          } catch {
            break;
          }
        }
      }
    }
  }
  return description
    .split(/\n(?:Requirements:|Delivery:|## Previous Agent Work|Repository:)/)[0]
    .replace(/^Implement Jira[^\n]*\n?/i, '')
    .slice(0, 12000);
}

const stopWords = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'task',
  'jira',
  '实现',
  '支持',
  '功能',
  '需要',
  '用户',
  '任务',
]);
function terms(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/https?:\/\/\S+|[a-z]+-\d+|image-[\w.-]+/g, ' ');
  const result = new Set<string>();
  for (const match of clean.matchAll(/[a-z][a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g)) {
    const word = match[0];
    if (/^[a-z]/.test(word)) {
      if (!stopWords.has(word)) result.add(word);
    } else {
      for (let i = 0; i < word.length - 1; i++) {
        const term = word.slice(i, i + 2);
        if (!stopWords.has(term)) result.add(term);
      }
    }
  }
  return result;
}
function overlap(a: Set<string>, b: Set<string>) {
  const common = [...a].filter((term) => b.has(term));
  return { common, dice: a.size + b.size ? (2 * common.length) / (a.size + b.size) : 0 };
}
export function taskSummary(feature: Feature): SimilarTask {
  return {
    id: feature.id,
    title: feature.title || feature.id,
    jiraKey: feature.jiraKey,
    status: feature.status,
    scope: taskScope(feature),
    description: feature.description,
    summary: feature.summary?.slice(0, 12000),
  };
}

export function findSimilarTasks(features: Feature[]): SimilarTaskPair[] {
  const candidates = independentTaskRoots(features);
  const entries = candidates.map((f) => ({
    feature: f,
    title: terms(f.title || ''),
    scope: terms(taskScope(f)),
  }));
  const result: SimilarTaskPair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i],
        b = entries[j];
      if (a.feature.jiraKey && a.feature.jiraKey.toUpperCase() === b.feature.jiraKey?.toUpperCase())
        continue;
      const title = overlap(a.title, b.title),
        scope = overlap(a.scope, b.scope);
      const containment = Math.min(a.title.size, b.title.size)
        ? title.common.length / Math.min(a.title.size, b.title.size)
        : 0;
      const score = Math.round(100 * (0.45 * title.dice + 0.35 * containment + 0.2 * scope.dice));
      if (title.common.length < 2 || score < 38) continue;
      const reasons = [
        `${title.common.length} shared title terms`,
        `${scope.common.length} shared requirement terms`,
      ];
      if (a.feature.branchName && a.feature.branchName === b.feature.branchName)
        reasons.push('Shared branch; merge requests may be shared');
      result.push({
        left: taskSummary(a.feature),
        right: taskSummary(b.feature),
        score,
        reasons,
        sharedTerms: [...new Set([...title.common, ...scope.common])].slice(0, 16),
        leftOverlap: a.scope.size ? Math.round((100 * scope.common.length) / a.scope.size) : 0,
        rightOverlap: b.scope.size ? Math.round((100 * scope.common.length) / b.scope.size) : 0,
      });
    }
  }
  return result.sort((a, b) => b.score - a.score).slice(0, 200);
}
