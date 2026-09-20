import { describe, it, expect } from 'vitest';
import {
  getChildFeaturesForParent,
  getBoardTaskTreeFeatures,
  parentFeatureIdsOf,
} from '@/components/views/board-view/lib/child-features';
import type { Feature } from '@/store/app-store';

function feature(id: string, overrides: Partial<Feature> = {}): Feature {
  return { id, category: 'Jira AIP', description: '', status: 'backlog', ...overrides } as Feature;
}

describe('getBoardTaskTreeFeatures', () => {
  it('keeps jiraKey children as their own cards while the parent aggregates them', () => {
    const parent = feature('jira-dodo-aip-114878', { jiraKey: 'AIP-114878' });
    const children = Array.from({ length: 3 }, (_unused, index) =>
      feature(`aip-114878-child-${index + 1}`, { jiraKey: 'AIP-114878' })
    );

    const merged = getBoardTaskTreeFeatures([parent, ...children]);
    expect(merged.map((item) => item.id)).toEqual([
      'jira-dodo-aip-114878',
      'aip-114878-child-1',
      'aip-114878-child-2',
      'aip-114878-child-3',
    ]);
    expect(getChildFeaturesForParent(parent, [parent, ...children])).toHaveLength(3);
  });

  it('keeps migrated subtasks linked by jiraParentKey / parentFeatureId', () => {
    const story = feature('jira-dodo-aip-114997', {
      jiraKey: 'AIP-114997',
      branchName: 'story/aip-114997-dodo',
    });
    const subtasks = ['AIP-114998', 'AIP-114999'].map((key, index) =>
      feature(`jira-dodo-${key.toLowerCase()}`, {
        jiraKey: key,
        branchName: 'story/aip-114997-dodo',
        jiraParentKey: 'AIP-114997',
        parentFeatureId: 'jira-dodo-aip-114997',
        createdAt: `2026-09-15T1${index}:00:00.000Z`,
      })
    );

    const merged = getBoardTaskTreeFeatures([story, ...subtasks]);
    expect(merged.map((item) => item.id)).toEqual([
      'jira-dodo-aip-114997',
      'jira-dodo-aip-114998',
      'jira-dodo-aip-114999',
    ]);
    expect(getChildFeaturesForParent(story, [story, ...subtasks]).map((item) => item.id)).toEqual([
      'jira-dodo-aip-114998',
      'jira-dodo-aip-114999',
    ]);
  });

  it('keeps features without any parent on the board', () => {
    const solo = feature('standalone', { jiraKey: 'AIP-999999' });
    expect(getBoardTaskTreeFeatures([solo]).map((item) => item.id)).toEqual(['standalone']);
    expect(parentFeatureIdsOf([solo]).size).toBe(0);
  });

  it('keeps a standalone-dispatched subtask listed on the parent card', () => {
    const parent = feature('jira-dodo-aip-114997', {
      jiraKey: 'AIP-114997',
      branchName: 'story/aip-114997-dodo',
      jiraSubtasks: [
        { key: 'AIP-114998', summary: 'frontend task' },
        { key: 'AIP-114999', summary: 'backend task' },
      ],
    });
    // Dispatched on its own: own feature, no jiraParentKey metadata yet.
    const subtask = feature('jira-dodo-aip-114998', {
      jiraKey: 'AIP-114998',
      branchName: 'story/aip-114997-dodo',
    });

    const merged = getBoardTaskTreeFeatures([parent, subtask]);
    expect(merged.map((item) => item.id)).toEqual(['jira-dodo-aip-114997', 'jira-dodo-aip-114998']);
    expect(getChildFeaturesForParent(parent, [parent, subtask]).map((item) => item.id)).toEqual([
      'jira-dodo-aip-114998',
    ]);
  });

  it('reports the parent ids so lanes can pin roots first', () => {
    const parent = feature('jira-dodo-aip-114997', { jiraKey: 'AIP-114997' });
    const subtask = feature('jira-dodo-aip-114998', {
      jiraKey: 'AIP-114998',
      parentFeatureId: 'jira-dodo-aip-114997',
      jiraParentKey: 'AIP-114997',
    });

    expect([...parentFeatureIdsOf([parent, subtask])]).toEqual(['jira-dodo-aip-114997']);
  });
});
