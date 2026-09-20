import { describe, it, expect } from 'vitest';
import type { Feature } from '../../src/feature.js';
import {
  featureChildBaseId,
  getChildFeaturesForParent,
  getParentJiraKeys,
  hasChildFeatures,
  isFeatureParentCandidate,
  parentFeatureIdsOf,
} from '../../src/feature-hierarchy.js';

function feature(id: string, overrides: Partial<Feature> = {}): Feature {
  return { id, category: 'Jira AIP', description: '', status: 'backlog', ...overrides } as Feature;
}

describe('feature hierarchy rules', () => {
  it('detects the <base>-child-N convention', () => {
    expect(featureChildBaseId(feature('aip-114878-child-2'))).toBe('aip-114878');
    expect(featureChildBaseId(feature('jira-dodo-aip-114878'))).toBeUndefined();
    expect(isFeatureParentCandidate(feature('aip-114878-child-2'))).toBe(false);
    expect(isFeatureParentCandidate(feature('jira-dodo-aip-114878'))).toBe(true);
  });

  it('resolves children by shared Jira key', () => {
    const parent = feature('jira-dodo-aip-114878', { jiraKey: 'AIP-114878' });
    const children = [
      feature('aip-114878-child-1', { jiraKey: 'AIP-114878' }),
      feature('aip-114878-child-2', { jiraKey: 'AIP-114878' }),
    ];
    const unrelated = feature('jira-kaka-aip-114965', { jiraKey: 'AIP-114965' });

    const resolved = getChildFeaturesForParent(parent, [parent, ...children, unrelated]);

    expect(resolved.map((item) => item.id)).toEqual(['aip-114878-child-1', 'aip-114878-child-2']);
    expect(hasChildFeatures(parent, [parent, ...children, unrelated])).toBe(true);
    expect(hasChildFeatures(unrelated, [parent, ...children, unrelated])).toBe(false);
  });

  it('resolves children by id convention without a Jira key', () => {
    const parent = feature('plain-feature');
    const child = feature('plain-feature-child-1');

    expect(getChildFeaturesForParent(parent, [parent, child]).map((item) => item.id)).toEqual([
      'plain-feature-child-1',
    ]);
  });

  it('never treats a child card as a parent', () => {
    const child = feature('aip-114878-child-1', { jiraKey: 'AIP-114878' });
    const grandchild = feature('aip-114878-child-1-child-1');

    expect(getChildFeaturesForParent(child, [child, grandchild])).toEqual([]);
  });

  it('resolves explicit dispatcher links (jiraParentKey / parentFeatureId)', () => {
    const parent = feature('jira-dodo-aip-114878', { jiraKey: 'AIP-114878' });
    const byFeatureId = feature('task-frontend', { parentFeatureId: parent.id });
    const byJiraParentKey = feature('task-backend', { jiraParentKey: 'aip-114878' });

    const resolved = getChildFeaturesForParent(parent, [parent, byFeatureId, byJiraParentKey]);

    expect(resolved.map((item) => item.id)).toEqual(['task-frontend', 'task-backend']);
    expect(parentFeatureIdsOf([parent, byFeatureId, byJiraParentKey])).toEqual(
      new Set([parent.id])
    );
  });

  it('resolves a subtask listed on the parent card', () => {
    const parent = feature('jira-dodo-aip-114878', {
      jiraKey: 'AIP-114878',
      jiraSubtasks: [{ key: 'AIP-114900', summary: 'Backend task' }],
    });
    const dispatched = feature('task-114900', { jiraKey: 'AIP-114900' });

    expect(getChildFeaturesForParent(parent, [parent, dispatched]).map((item) => item.id)).toEqual([
      'task-114900',
    ]);
  });

  it('lists the parent Jira keys of the jira-* cards', () => {
    expect(
      getParentJiraKeys([
        feature('jira-dodo-aip-114878', { jiraKey: 'AIP-114878' }),
        feature('aip-114878-child-1', { jiraKey: 'AIP-114878' }),
      ])
    ).toEqual(new Set(['AIP-114878']));
  });
});
