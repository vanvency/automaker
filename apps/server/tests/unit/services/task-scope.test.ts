import { describe, it, expect } from 'vitest';
import type { Feature } from '@automaker/types';
import {
  TASK_SCOPE_MARKERS,
  buildJiraSubtaskPrompt,
  buildTasksFromJiraSubtasks,
  resolveTaskScope,
} from '../../../src/services/task-scope.js';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'jira-dodo-aip-1',
    title: 'AIP-1: example',
    category: 'Jira AIP / dodo',
    description: 'Do the thing.',
    ...overrides,
  };
}

describe('task-scope', () => {
  it('treats the Jira sub-tasks as the units when Jira already split the issue', () => {
    const scope = resolveTaskScope(
      feature({
        jiraKey: 'AIP-1',
        jiraSubtasks: [{ key: 'AIP-2', summary: 'first' }],
        description: `Scope: ${TASK_SCOPE_MARKERS.jiraSubtasks} (do NOT decompose again):`,
      })
    );
    expect(scope).toEqual({
      kind: 'jira-subtasks',
      subtasks: [{ key: 'AIP-2', summary: 'first' }],
    });
  });

  it('refuses container cards whose sub-tasks have their own cards', () => {
    const scope = resolveTaskScope(
      feature({
        jiraKey: 'AIP-1',
        jiraSubtasks: [{ key: 'AIP-2' }, { key: 'AIP-3' }],
        description: 'Scope: Jira subtasks are separate cards (do NOT implement them here)',
      })
    );
    expect(scope).toEqual({ kind: 'separate-cards', pending: ['AIP-2', 'AIP-3'] });
  });

  it('stops an unsplit parent issue that only a human may split', () => {
    const scope = resolveTaskScope(
      feature({
        jiraKey: 'AIP-9',
        description: 'Manual decomposition only (this Story issue has no Jira subtasks):',
      })
    );
    expect(scope.kind).toBe('needs-input');
    if (scope.kind === 'needs-input') expect(scope.reason).toContain('AIP-9');
  });

  it('proposes a split for an unsplit card, including plain board cards', () => {
    expect(
      resolveTaskScope(
        feature({
          jiraKey: 'AIP-9',
          description: 'Scope: Jira has not split this Story yet (explicitly authorized):',
        })
      )
    ).toEqual({ kind: 'propose-decomposition' });
    expect(resolveTaskScope(feature({ description: 'A hand written card' }))).toEqual({
      kind: 'propose-decomposition',
    });
  });

  it('turns Jira sub-tasks into dispatchable tasks', () => {
    expect(
      buildTasksFromJiraSubtasks([
        { key: 'AIP-2', summary: 'first', type: 'Backend-Task' },
        { key: 'AIP-3' },
      ])
    ).toEqual([
      { id: 'AIP-2', description: 'first', phase: 'Backend-Task', status: 'pending' },
      { id: 'AIP-3', description: 'Implement Jira AIP-3', phase: undefined, status: 'pending' },
    ]);
  });

  it('tells a worker which sub-task it owns and never to re-split', () => {
    const prompt = buildJiraSubtaskPrompt({ key: 'AIP-2', summary: 'first' }, 0, 2, 'AIP-1');
    expect(prompt).toContain('AIP-2 (1 of 2) of AIP-1');
    expect(prompt).toContain('do not re-split it');
    expect(prompt).toContain('[AIP-2]');
    // Only the last sub-task writes the card's acceptance evidence.
    expect(prompt).not.toContain('acceptance evidence');
  });

  it('asks the last sub-task to write the acceptance evidence', () => {
    const prompt = buildJiraSubtaskPrompt(
      { key: 'AIP-3', summary: 'last' },
      1,
      2,
      'AIP-1',
      'jira-dodo-aip-1'
    );
    expect(prompt).toContain('.automaker/acceptance/jira-dodo-aip-1/manifest.json');
  });
});
