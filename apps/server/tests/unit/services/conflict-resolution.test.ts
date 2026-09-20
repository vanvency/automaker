import { describe, it, expect } from 'vitest';
import type { Feature } from '@automaker/types';
import {
  buildConflictResolutionPrompt,
  findConflictOwner,
} from '../../../src/services/conflict-resolution.js';
import type { MergePlanEntry } from '../../../src/services/feature-merge-plan.js';

const ENTRY: MergePlanEntry = {
  name: 'backend/sophon-mind',
  mrUrl: 'http://gl/group/sophon-mind/-/merge_requests/261',
  gitlabProject: 'group/sophon-mind',
  iid: 261,
  isRoot: false,
};

function feature(id: string, extra: Partial<Feature> = {}): Feature {
  return { id, category: 'Jira AIP / dodo', description: '', ...extra } as Feature;
}

describe('findConflictOwner', () => {
  it('hands the conflict to the sub-task that changed that repository', () => {
    const parent = feature('jira-dodo-aip-114878', { jiraKey: 'AIP-114878' });
    const backendChild = feature('aip-114878-child-6', {
      jiraKey: 'AIP-114878',
      changedProjects: [{ name: 'backend/sophon-mind' }],
    } as Partial<Feature>);
    const frontendChild = feature('aip-114878-child-1', {
      jiraKey: 'AIP-114878',
      changedProjects: [{ name: 'frontend/saas-frontend' }],
    } as Partial<Feature>);

    const owner = findConflictOwner(
      parent,
      [parent, backendChild, frontendChild],
      ENTRY,
      ENTRY.name
    );

    expect(owner.id).toBe('aip-114878-child-6');
  });

  it('matches by repository leaf so labelled and raw names both work', () => {
    const parent = feature('jira-dodo-aip-114859', { jiraKey: 'AIP-114859' });
    const child = feature('aip-114859-child-1', {
      jiraKey: 'AIP-114859',
      changedProjects: [{ name: 'sophon-mind' }],
    } as Partial<Feature>);

    expect(findConflictOwner(parent, [parent, child], ENTRY, ENTRY.name).id).toBe(
      'aip-114859-child-1'
    );
  });

  it('keeps the work on the main task when no sub-task claims the repository', () => {
    const parent = feature('jira-dodo-aip-114859', { jiraKey: 'AIP-114859' });
    const unrelated = feature('aip-114859-child-9', {
      jiraKey: 'AIP-114859',
      changedProjects: [{ name: 'frontend/saas-frontend' }],
    } as Partial<Feature>);

    expect(findConflictOwner(parent, [parent, unrelated], ENTRY, ENTRY.name).id).toBe(parent.id);
  });

  it('does not dispatch unrelated non-Jira tasks that changed the same repo', () => {
    const parent = feature('standalone');
    const other = feature('unrelated', { changedProjects: [{ name: ENTRY.name }] });
    expect(findConflictOwner(parent, [parent, other], ENTRY, ENTRY.name).id).toBe(parent.id);
  });

  it('recognises explicit children with their own Jira keys', () => {
    const parent = feature('epic', { jiraKey: 'AIP-1' });
    const child = feature('story', {
      parentFeatureId: parent.id,
      jiraKey: 'AIP-2',
      changedProjects: [{ name: ENTRY.name }],
    });
    expect(findConflictOwner(parent, [parent, child], ENTRY, ENTRY.name).id).toBe(child.id);
  });

  it('never crosses to another Jira issue', () => {
    const parent = feature('jira-dodo-aip-114859', { jiraKey: 'AIP-114859' });
    const otherIssue = feature('aip-114900-child-1', {
      jiraKey: 'AIP-114900',
      changedProjects: [{ name: 'backend/sophon-mind' }],
    } as Partial<Feature>);

    expect(findConflictOwner(parent, [parent, otherIssue], ENTRY, ENTRY.name).id).toBe(parent.id);
  });
});

describe('buildConflictResolutionPrompt', () => {
  const STATE = {
    iid: 261,
    project: 'group/sophon-mind',
    state: 'opened',
    title: 'Draft: AIP-114859',
    draft: true,
    sourceBranch: 'jira/aip-114859-dodo',
    targetBranch: 'dev',
    hasConflicts: true,
  };
  const prompt = buildConflictResolutionPrompt(
    [{ entry: ENTRY, state: STATE }],
    '/workspace/vibe-llmops/.worktrees/aip-114859-dodo'
  );

  it('names the repository, both branches and the merge request', () => {
    expect(prompt).toContain('backend/sophon-mind');
    expect(prompt).toContain('jira/aip-114859-dodo');
    expect(prompt).toContain('dev');
    expect(prompt).toContain('!261');
  });

  it('scopes the work and forbids merging', () => {
    expect(prompt).toContain('change nothing outside `backend/sophon-mind`');
    expect(prompt).toContain('do not merge the merge');
    expect(prompt).toContain('Do not touch other repositories');
  });

  it('asks for a report instead of guessing when a decision is needed', () => {
    expect(prompt).toContain('stop and report');
  });

  it('covers every repository handed to one owner', () => {
    const multi = buildConflictResolutionPrompt(
      [
        { entry: ENTRY, state: STATE },
        {
          entry: {
            name: 'frontend/saas-frontend',
            mrUrl: 'http://gl/group/saas-frontend/-/merge_requests/2065',
            gitlabProject: 'group/saas-frontend',
            iid: 2065,
            isRoot: true,
          },
          state: { ...STATE, iid: 2065, sourceBranch: 'jira/aip-114859-dodo' },
        },
      ],
      '/w'
    );
    expect(multi).toContain('`backend/sophon-mind`');
    expect(multi).toContain('`frontend/saas-frontend`');
    expect(multi).toContain('!2065');
    expect(multi).toContain('!261');
  });
});
