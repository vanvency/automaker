/**
 * Merge ordering for a feature's merge requests.
 *
 * A monorepo MR only records a gitlink for each changed submodule, so the
 * submodule MRs must land on the target branch first; merging the root MR before
 * them would point the gitlink at commits the target branch does not have (which
 * is exactly why the root MR for AIP-114859 shows as conflicted).
 *
 * The plan therefore merges every non-root project first and the root project
 * last, preserving the order the feature recorded.
 */

import { parseMergeRequestUrl } from './gitlab-merge-service.js';

export interface MergePlanEntry {
  /** Project label shown on the card, e.g. `backend/sophon-mind`. */
  name: string;
  mrUrl: string;
  /** GitLab project path, e.g. `llm/llmops/sophon-mind`. */
  gitlabProject: string;
  iid: number;
  /** True for the repository the Automaker project itself lives in. */
  isRoot: boolean;
}

export interface MergePlanInput {
  changedProjects?: unknown;
  mergeRequests?: unknown;
  /** Repository basename of the Automaker project (e.g. `vibe-llmops`). */
  rootProjectName?: string;
}

function normalizeName(entry: unknown): { name: string; mrUrl?: string } | null {
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { name } : null;
  }
  if (entry && typeof entry === 'object') {
    const record = entry as { name?: unknown; mrUrl?: unknown; url?: unknown };
    const name = String(record.name ?? '').trim();
    if (!name) return null;
    const mrUrl = String(record.mrUrl ?? record.url ?? '').trim() || undefined;
    return { name, mrUrl };
  }
  return null;
}

function isRootProject(name: string, rootProjectName: string | undefined): boolean {
  if (!rootProjectName) return false;
  const leaf = name.split('/').filter(Boolean).pop() ?? name;
  return leaf.toLowerCase() === rootProjectName.toLowerCase();
}

/**
 * Build the ordered, de-duplicated merge plan for a feature.
 *
 * Projects without an MR are skipped: there is nothing to merge for them, and
 * reporting them would make the Complete flow look like it failed.
 */
export function buildFeatureMergePlan(input: MergePlanInput): MergePlanEntry[] {
  const entries: MergePlanEntry[] = [];
  const seen = new Set<string>();

  const push = (name: string, mrUrl: string | undefined) => {
    if (!mrUrl) return;
    const parsed = parseMergeRequestUrl(mrUrl);
    if (!parsed) return;
    const identity = `${parsed.host}/${parsed.project}/-/merge_requests/${parsed.iid}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    entries.push({
      name,
      mrUrl,
      gitlabProject: parsed.project,
      iid: parsed.iid,
      isRoot: isRootProject(parsed.project, input.rootProjectName),
    });
  };

  const changed = Array.isArray(input.changedProjects) ? input.changedProjects : [];
  const changedNames = new Set<string>();
  for (const raw of changed) {
    const entry = normalizeName(raw);
    if (!entry) continue;
    changedNames.add(entry.name);
    push(entry.name, entry.mrUrl);
  }

  // Fall back to the flat MR list for projects the receipt did not name.
  const flat = Array.isArray(input.mergeRequests) ? input.mergeRequests : [];
  for (const raw of flat) {
    if (typeof raw !== 'string') continue;
    const parsed = parseMergeRequestUrl(raw);
    if (!parsed) continue;
    const label =
      [...changedNames].find((name) => name.split('/').pop() === parsed.project.split('/').pop()) ??
      parsed.project;
    push(label, raw);
  }

  const subprojects = entries.filter((entry) => !entry.isRoot);
  const roots = entries.filter((entry) => entry.isRoot);
  return [...subprojects, ...roots];
}
