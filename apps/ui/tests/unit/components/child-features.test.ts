import { describe, it, expect } from 'vitest';
import {
  getChildFeaturesForParent,
  shouldShowJiraSubtaskList,
} from '@/components/views/board-view/lib/child-features';
import type { Feature } from '@/store/app-store';

function feature(id: string, overrides: Partial<Feature> = {}): Feature {
  return {
    id,
    category: 'Jira AIP',
    description: '',
    status: 'backlog',
    ...overrides,
  } as Feature;
}

describe('getChildFeaturesForParent', () => {
  const parent = feature('jira-dodo-aip-114878', {
    jiraKey: 'AIP-114878',
    status: 'in_progress',
    branchName: 'jira/aip-114878-dodo',
  });
  const children = Array.from({ length: 12 }, (_unused, index) =>
    feature(`aip-114878-child-${index + 1}`, {
      jiraKey: 'AIP-114878',
      status: index % 2 === 0 ? 'waiting_approval' : 'backlog',
      branchName: 'jira/aip-114878-dodo',
      createdAt: `2026-09-14T10:${String(index).padStart(2, '0')}:00.000Z`,
    })
  );
  const unrelated = feature('jira-kaka-aip-114819', {
    jiraKey: 'AIP-114819',
    branchName: 'jira/aip-114819-kaka',
  });

  it('lists every child under its parent in creation order', () => {
    const result = getChildFeaturesForParent(parent, [parent, ...children.reverse()]);

    expect(result).toHaveLength(12);
    expect(result[0].id).toBe('aip-114878-child-1');
    expect(result[11].id).toBe('aip-114878-child-12');
  });

  it('ignores cards of other issues and the parent itself', () => {
    const result = getChildFeaturesForParent(parent, [parent, ...children, unrelated]);

    expect(result.map((item) => item.id)).not.toContain(parent.id);
    expect(result.map((item) => item.id)).not.toContain(unrelated.id);
    expect(result).toHaveLength(12);
  });

  it('groups legacy children that were created without a jiraKey', () => {
    const legacyParent = feature('jira-dodo-aip-114952', {
      jiraKey: 'AIP-114952',
      branchName: 'jira/aip-114952-dodo',
    });
    const legacyChildren = Array.from({ length: 8 }, (_unused, index) =>
      feature(`aip-114952-child-${index + 1}`, {
        // no jiraKey: created before the monitor stamped children
        branchName: 'jira/aip-114952-dodo',
        createdAt: `2026-09-14T10:${String(index).padStart(2, '0')}:00.000Z`,
      })
    );

    const listed = getChildFeaturesForParent(legacyParent, [legacyParent, ...legacyChildren]);

    expect(listed).toHaveLength(8);
    expect(listed[0].id).toBe('aip-114952-child-1');
  });

  it('finds children through an explicit Jira hierarchy link', () => {
    const story = feature('jira-dodo-aip-200000', { jiraKey: 'AIP-200000' });
    const task = feature('jira-dodo-aip-200001', {
      jiraKey: 'AIP-200001',
      parentFeatureId: story.id,
    });

    expect(getChildFeaturesForParent(story, [story, task]).map((item) => item.id)).toEqual([
      task.id,
    ]);
  });

  it('links imported cards through parentJiraKey as well', () => {
    const story = feature('jira-kaka-aip-114993', { jiraKey: 'AIP-114993' });
    const importedTask = feature('jira-dodo-aip-114996', {
      jiraKey: 'AIP-114996',
      parentJiraKey: 'AIP-114993',
    });

    expect(getChildFeaturesForParent(story, [story, importedTask]).map((item) => item.id)).toEqual([
      importedTask.id,
    ]);
  });
});

describe('shouldShowJiraSubtaskList', () => {
  const parent = feature('jira-kaka-aip-114993', {
    jiraKey: 'AIP-114993',
    jiraSubtasks: [{ key: 'AIP-114994' }, { key: 'AIP-114995' }, { key: 'AIP-114996' }],
  } as Partial<Feature>);
  const children = ['AIP-114994', 'AIP-114995', 'AIP-114996'].map((key) =>
    feature(`jira-dodo-${key.toLowerCase()}`, { jiraKey: key, parentJiraKey: 'AIP-114993' })
  );

  it('hides the Jira list once the subtasks exist as cards', () => {
    expect(shouldShowJiraSubtaskList(parent, [parent, ...children])).toBe(false);
  });

  it('shows the Jira list while the subtasks have no cards', () => {
    expect(shouldShowJiraSubtaskList(parent, [parent])).toBe(true);
  });

  it('renders nothing without Jira subtasks', () => {
    const plain = feature('plain', {});
    expect(shouldShowJiraSubtaskList(plain, [plain])).toBe(false);
  });
});
