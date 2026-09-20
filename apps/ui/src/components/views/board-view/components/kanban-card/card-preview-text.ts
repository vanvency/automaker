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
}

/** Card-face preview of the task text, without the repository/worktree preamble. */
export function cardPreviewText(feature: CardPreviewSource): string {
  const raw = feature.description || feature.summary || feature.title || feature.id;
  const cleaned = raw
    .replace(JIRA_IMPORTED_HEADER, '')
    .replace(REPOSITORY_PREAMBLE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || feature.title || feature.id;
}
