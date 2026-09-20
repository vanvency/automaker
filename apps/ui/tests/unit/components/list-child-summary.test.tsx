import { describe, it, expect } from 'vitest';
import { buildChildSummaries } from '../../../src/components/views/board-view/components/list-view/list-view';
import type { Feature } from '@automaker/types';

function feature(id: string, jiraKey: string, status: string): Feature {
  return { id, jiraKey, status, category: 'Jira AIP / dodo', description: '' } as Feature;
}

describe('buildChildSummaries', () => {
  it('counts the auto-decomposed children of a Jira parent card', () => {
    const features = [
      feature('jira-dodo-aip-114878', 'AIP-114878', 'waiting_approval'),
      feature('aip-114878-child-1', 'AIP-114878', 'verified'),
      feature('aip-114878-child-2', 'AIP-114878', 'waiting_approval'),
      feature('jira-kaka-aip-114965', 'AIP-114965', 'backlog'),
    ];

    expect(buildChildSummaries(features)).toEqual({
      'jira-dodo-aip-114878': { total: 2, completed: 1 },
    });
  });

  it('counts id-convention children of a card that was not imported from Jira', () => {
    // Children stay on the board as their own rows; the parent row still has to
    // roll them up even without a Jira key.
    const features = [
      { id: 'plain-feature', status: 'backlog', category: 'feature', description: '' } as Feature,
      {
        id: 'plain-feature-child-1',
        status: 'verified',
        category: 'feature',
        description: '',
      } as Feature,
      { id: 'lonely-feature', status: 'backlog', category: 'feature', description: '' } as Feature,
    ];

    expect(buildChildSummaries(features)).toEqual({
      'plain-feature': { total: 1, completed: 1 },
    });
  });
});
