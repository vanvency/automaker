/**
 * Text shown on the card face.
 *
 * Jira-imported descriptions start with a repository/worktree preamble
 * (`Implement Jira <KEY>: <url>.` then
 * `Repository: <path>; isolated worktree: <path>; branch: <branch>.`). The board
 * is already scoped to that worktree and the details dialog keeps the full
 * description, so the card drops those two lines.
 */

const JIRA_IMPORTED_HEADER = /^Implement Jira [A-Za-z]+-\d+:.*$/gim;
const REPOSITORY_PREAMBLE = /^Repository:.*$/gim;

interface CardPreviewSource {
  description?: string | null;
  summary?: string | null;
  title?: string | null;
  id: string;
  jiraKey?: unknown;
  jiraImported?: unknown;
  jiraSummary?: unknown;
}

/** Read the legacy import snapshot without mutating historical task prompts. */
export function jiraRequirementText(feature: CardPreviewSource): string {
  const description = feature.description || '';
  if (!feature.jiraKey && !feature.jiraImported) return description;
  const marker = 'Initial Jira snapshot (refresh before implementing):';
  const start = description.lastIndexOf(marker);
  if (start < 0) return description;
  try {
    const snapshot = JSON.parse(description.slice(start + marker.length).trim());
    if (typeof snapshot.description === 'string' && snapshot.description.trim())
      return snapshot.description;
    if (typeof snapshot.summary === 'string') return snapshot.summary;
  } catch {
    // Custom or incomplete descriptions must remain visible, never be truncated.
  }
  return description;
}

/** Card-face preview of the task text, without the repository/worktree preamble. */
export function cardPreviewText(feature: CardPreviewSource): string {
  if (feature.jiraKey || feature.jiraImported) {
    if (typeof feature.jiraSummary === 'string' && feature.jiraSummary.trim())
      return feature.jiraSummary.trim();
    if (feature.title?.trim()) return feature.title.trim();
    return jiraRequirementText(feature) || feature.id;
  }
  const raw = feature.description || feature.summary || feature.title || feature.id;
  const cleaned = raw
    .replace(JIRA_IMPORTED_HEADER, '')
    .replace(REPOSITORY_PREAMBLE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || feature.title || feature.id;
}
