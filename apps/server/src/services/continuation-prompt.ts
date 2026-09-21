/**
 * Prompt blocks for turns that continue an existing provider conversation.
 *
 * Once a feature owns a provider session, that session already holds the full
 * task description, the implementation instructions and everything the agent
 * has done so far. Re-sending the description and the previous agent output on
 * every follow-up duplicates the transcript, inflates token usage and pushes the
 * conversation toward its context limit sooner. Continuation prompts therefore
 * carry only a short task anchor.
 */

import type { Feature } from '@automaker/types';

export const DEVELOPMENT_COMPLETION_POLICY = `Current task completion policy (supersedes historical delivery instructions):
Complete implementation and relevant verification, then hand off for review. MR creation, reviewer assignment, MR conflict resolution and merge are separate from this task; do not perform them or add them to development goals unless a human explicitly requested MR work for this run.
For Jira delivery receipts, use outcome "development_complete" when development and checks are complete; no MR is required. Preserve genuine development blockers and questions.`;

/** True once a provider session id is recorded, i.e. this is not the first turn. */
export function hasProviderSession(feature: Feature | null | undefined): boolean {
  if (!feature) return false;
  return Boolean((feature as { providerSessionId?: string }).providerSessionId);
}

/**
 * Feature header used by follow-up/resume prompts.
 *
 * The full description is only included for the first turn. For later turns the
 * id and title are kept as an anchor so that a prompt replayed into a lost
 * session still identifies the work.
 */
export function featurePromptBlock(
  feature: Feature,
  options: { continuing?: boolean } = {}
): string {
  const header = `## Feature Implementation Task\n\n**Feature ID:** ${feature.id}\n**Title:** ${feature.title || 'Untitled Feature'}\n`;
  if (options.continuing) return header;
  return `${header}**Description:** ${feature.description}\n`;
}

/**
 * Previous agent output is only useful when the conversation cannot provide it.
 * A continuing session already contains the real transcript.
 */
export function previousContextBlock(
  previousContext: string,
  options: { continuing?: boolean } = {}
): string {
  return options.continuing ? '' : previousContext;
}
