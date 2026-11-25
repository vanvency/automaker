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
Complete implementation and relevant verification, then prepare delivery for human review.
For Jira code-delivery tasks, commit and push every repository with task-owned source, documentation or configuration changes, then create or reuse one Draft MR per changed repository targeting the project's configured target branch.
For vibe-llmops, deliver submodule code in each submodule's own MR. Commit only root-owned files in a root MR; do not stage or commit submodule gitlink changes as part of routine tasks, and do not create a root MR solely because submodule checkouts changed. Update gitlinks only when the user explicitly requests an integration/release version-lock update. This overrides historical instructions requiring a root gitlink commit after every submodule change. For other projects, follow their explicit repository policy.
Read each MR back and confirm it is open, draft == true, uses this task's source branch, and contains the current pushed revision. GitLab 15 requires a "Draft: " title prefix; do not rely on a draft push option or draft=true.
Write the current runId and outcome "mr_created" in the feature-scoped jira-result.json, with changedProjects entries containing name and mrUrl, and mergeRequests containing those same URLs. Missing or non-draft MRs block delivery to Waiting Review. Preserve real development blockers and questions as blocked/needs_input.
This policy supersedes older instructions forbidding MR creation. Never mark MRs ready, enable auto-merge, merge branches or transition Jira; only the human-confirmed Complete flow may do that.`;

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
  return `${header}**Description:** ${feature.description}\n${feature.jiraExecutionInstructions ? `\n### Jira execution instructions\n${feature.jiraExecutionInstructions}\n` : ''}`;
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
