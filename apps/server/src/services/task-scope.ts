/**
 * Task scope - what a card is allowed to do, decided when it was imported.
 *
 * The Jira monitor owns the split: it either splits the work in Jira (sub-tasks
 * are then the units) or leaves the issue unsplit and tells the card, in its
 * description, whether an Automaker-side decomposition is allowed at all. herdr
 * dispatch has to honour the same rules, otherwise an Automaker-side split ends
 * up contradicting the Jira backlog the reporter sees.
 *
 * The markers below are the ones `scripts/jira-monitor.py`
 * (`subtask_scope_directive`, `task_description`) writes into the card text; the
 * monitor itself re-reads them the same way when it refreshes a card.
 */

import type { Feature, JiraSubtask, ParsedTask } from '@automaker/types';

export const TASK_SCOPE_MARKERS = {
  /** Jira already split this issue; the listed sub-tasks are the units */
  jiraSubtasks: 'existing Jira subtasks',
  /** Sub-tasks are separate board cards; this card is only their container */
  separateCards: 'separate cards',
  /** Parent issue without Jira sub-tasks: only a human may split it */
  manualOnly: 'Manual decomposition only',
  /** Parent issue without Jira sub-tasks, explicitly allowed to split here */
  authorizedSplit: 'explicitly authorized',
  /** Legacy wording used for agent-side decomposition */
  autonomousSplit: 'Autonomous decomposition',
} as const;

export type TaskScope =
  /** Nothing to split: run the Jira sub-tasks as the work units, in order */
  | { kind: 'jira-subtasks'; subtasks: JiraSubtask[] }
  /** The sub-tasks have their own cards; this card must not implement them */
  | { kind: 'separate-cards'; pending: string[] }
  /** Unsplit and not allowed to split: a human has to split it in Jira first */
  | { kind: 'needs-input'; reason: string }
  /** Unsplit: the leader may propose a split, but a human has to confirm it */
  | { kind: 'propose-decomposition' };

/** Raised when a card cannot be dispatched because of its scope */
export class TaskScopeError extends Error {
  constructor(
    public readonly code: 'needs_input' | 'separate_cards',
    message: string
  ) {
    super(message);
    this.name = 'TaskScopeError';
  }
}

/** Decide what this card may do, from the fields the monitor wrote */
export function resolveTaskScope(feature: Feature): TaskScope {
  const subtasks = feature.jiraSubtasks ?? [];
  const description = feature.description ?? '';

  if (subtasks.length > 0) {
    if (description.includes(TASK_SCOPE_MARKERS.separateCards)) {
      return { kind: 'separate-cards', pending: subtasks.map((subtask) => subtask.key) };
    }
    return { kind: 'jira-subtasks', subtasks };
  }

  if (description.includes(TASK_SCOPE_MARKERS.manualOnly)) {
    const key = feature.jiraKey ?? feature.id;
    return {
      kind: 'needs-input',
      reason:
        `${key} has no Jira sub-tasks and is not authorized to be split by Automaker. ` +
        'Split it in Jira (or ask the reporter to) before dispatching it.',
    };
  }

  // No Jira split and no directive forbidding one: an explicit dispatch still
  // proposes the split first, because creating Jira work needs a human decision.
  return { kind: 'propose-decomposition' };
}

/** The Jira sub-tasks as dispatchable work units, in the order Jira lists them */
export function buildTasksFromJiraSubtasks(subtasks: JiraSubtask[]): ParsedTask[] {
  return subtasks.map((subtask) => ({
    id: subtask.key,
    description: subtask.summary?.trim() || `Implement Jira ${subtask.key}`,
    phase: subtask.type ?? undefined,
    status: 'pending' as const,
  }));
}

/** Worker prompt for one Jira sub-task (mirrors the monitor's delivery rules) */
export function buildJiraSubtaskPrompt(
  subtask: JiraSubtask,
  index: number,
  total: number,
  issueKey: string,
  /** Automaker card id, used for the acceptance-evidence directory */
  featureId: string = issueKey
): string {
  return [
    `You are implementing Jira sub-task ${subtask.key} (${index + 1} of ${total}) of ${issueKey}.`,
    'Jira already split this issue; do not re-split it and do not create more cards.',
    '',
    `Sub-task: ${subtask.summary ?? subtask.key}`,
    subtask.type ? `Type: ${subtask.type}` : '',
    subtask.status ? `Jira status: ${subtask.status}` : '',
    '',
    'Implement exactly this sub-task in this worktree and branch. Files of other',
    'sub-tasks may already be present - build on them instead of rewriting them.',
    `Every commit must start with this issue's key (${issueKey}); commit with a`,
    `message prefix "[${subtask.key}]".`,
    'Run the relevant tests, then reply with a one-paragraph summary of what changed.',
    index === total - 1
      ? 'This is the last sub-task: after verifying, also write the card acceptance evidence at ' +
        `.automaker/acceptance/${featureId}/manifest.json (status, checks, and a prototype plus ` +
        'a real screenshot of the running result) so the card can show what was verified.'
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
