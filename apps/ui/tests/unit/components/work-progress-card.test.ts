import { describe, it, expect } from 'vitest';
import { getWorktreeLane, selectCardSubtasks } from '../../../src/components/views/worktrees-view';
import type { WorktreeProgressTask } from '@automaker/types';

function task(
  overrides: Partial<WorktreeProgressTask> & Pick<WorktreeProgressTask, 'id'>
): WorktreeProgressTask {
  return {
    stage: 'backlog',
    isParent: false,
    childIds: [],
    ...overrides,
  };
}

describe('selectCardSubtasks', () => {
  it('lists the children of the worktree task and uses it for the conversation', () => {
    const parent = task({
      id: 'jira-dodo-aip-1',
      isParent: true,
      childIds: ['aip-1-child-1', 'aip-1-child-2'],
    });
    const children = [
      task({ id: 'aip-1-child-1', stage: 'complete' }),
      task({ id: 'aip-1-child-2', stage: 'in_progress' }),
    ];

    const selection = selectCardSubtasks([parent, ...children]);

    expect(selection.mainTask?.id).toBe('jira-dodo-aip-1');
    expect(selection.children.map((item) => item.id)).toEqual(['aip-1-child-1', 'aip-1-child-2']);
  });

  it('uses a standalone card as the conversation owner without listing subtasks', () => {
    const only = task({ id: 'standalone', stage: 'in_progress' });

    const selection = selectCardSubtasks([only]);

    expect(selection.mainTask?.id).toBe('standalone');
    expect(selection.children).toEqual([]);
  });

  it('lists no subtasks when the branch has no parent card', () => {
    const siblings = [task({ id: 'a' }), task({ id: 'b' })];

    const selection = selectCardSubtasks(siblings);

    // The worktree's cards are siblings, not a decomposition.
    expect(selection.children).toEqual([]);
    expect(selection.mainTask?.id).toBe('a');
  });

  it('has nothing to open for a worktree without cards', () => {
    expect(selectCardSubtasks([])).toEqual({ mainTask: null, children: [] });
  });
});

describe('worktree lane assignment for counters and filters', () => {
  const row = (overrides: Record<string, unknown>) =>
    ({ stage: 'backlog', hasConflicts: false, ...overrides }) as Parameters<
      typeof getWorktreeLane
    >[0];

  it('groups unlinked and unknown worktrees into Backlog', () => {
    for (const stage of ['backlog', 'empty', 'unknown'])
      expect(getWorktreeLane(row({ stage }), false)).toBe('planned');
  });

  it('places failure, conflict and input requests in Needs Attention, even without an attention flag', () => {
    expect(getWorktreeLane(row({ stage: 'failed' }), false)).toBe('failed');
    expect(getWorktreeLane(row({ stage: 'waiting_approval', hasConflicts: true }), false)).toBe(
      'failed'
    );
    expect(
      getWorktreeLane(row({ stage: 'waiting_approval', attention: 'needs_input' }), false)
    ).toBe('failed');
    expect(getWorktreeLane(row({ stage: 'waiting_approval', attention: 'failed' }), false)).toBe(
      'failed'
    );
  });

  it('keeps live agents in In Progress until they stop', () => {
    const worktree = row({ stage: 'waiting_approval', attention: 'needs_input' });
    expect(getWorktreeLane(worktree, true)).toBe('in_progress');
    expect(getWorktreeLane(worktree, false)).toBe('failed');
  });

  it('keeps ordinary review and completed work in their lifecycle lanes', () => {
    expect(getWorktreeLane(row({ stage: 'waiting_approval' }), false)).toBe('waiting');
    expect(getWorktreeLane(row({ stage: 'complete' }), false)).toBe('done');
  });
});
