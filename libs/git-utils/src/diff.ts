/**
 * Git diff generation utilities
 */

import { createLogger } from '@automaker/utils';
import { secureFs } from '@automaker/platform';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  BINARY_EXTENSIONS,
  GIT_STATUS_MAP,
  type FileStatus,
  type MergeStateInfo,
} from './types.js';
import { isGitRepo, parseGitStatus, detectMergeState, detectMergeCommit } from './status.js';
import { execGitCommand } from './exec.js';

const execAsync = promisify(exec);
const logger = createLogger('GitUtils');

// Max file size for generating synthetic diffs (1MB)
const MAX_SYNTHETIC_DIFF_SIZE = 1024 * 1024;

/**
 * Default ceiling for a single diff payload returned to a client.
 *
 * Diffing a large monorepo (or a repo with big untracked directories) can
 * otherwise produce tens or hundreds of megabytes, which makes the UI appear to
 * hang forever while the payload is generated and transferred.
 */
export const DEFAULT_MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** Marker appended to a bounded diff so the UI can tell the payload is partial. */
const TRUNCATION_MARKER = '[diff truncated:';

function truncationNote(omittedBytes: number): string {
  return `\n\n${TRUNCATION_MARKER} ${omittedBytes} more bytes of changes were not included]\n`;
}

/** Note for a cut-off diff where the omitted size is unknown (or nothing was cut yet). */
function truncationNoteForUnknownSize(detail: string): string {
  return `\n\n${TRUNCATION_MARKER} ${detail}]\n`;
}

/**
 * Cut a string to a byte budget without splitting a UTF-8 character in half,
 * which would otherwise leave a replacement character at the end.
 */
export function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const decoded = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  return decoded.replace(/\uFFFD+$/, '');
}

/**
 * Check if a file is likely binary based on extension
 */
function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Create a synthetic diff for a new file with the given content lines
 * This helper reduces duplication in diff generation logic
 */
function createNewFileDiff(relativePath: string, mode: string, contentLines: string[]): string {
  const lineCount = contentLines.length;
  const addedLines = contentLines.map((line) => `+${line}`).join('\n');

  return `diff --git a/${relativePath} b/${relativePath}
new file mode ${mode}
index 0000000..0000000
--- /dev/null
+++ b/${relativePath}
@@ -0,0 +${lineCount === 1 ? '1' : `1,${lineCount}`} @@
${addedLines}
`;
}

/**
 * Generate a synthetic unified diff for an untracked (new) file
 * This is needed because `git diff HEAD` doesn't include untracked files
 *
 * If the path is a directory, this will recursively generate diffs for all files inside
 */
export async function generateSyntheticDiffForNewFile(
  basePath: string,
  relativePath: string
): Promise<string> {
  // Remove trailing slash if present (git status reports directories with trailing /)
  const cleanPath = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
  const fullPath = path.join(basePath, cleanPath);

  try {
    // Get file stats to check size and type
    const stats = await secureFs.stat(fullPath);

    // Check if it's a directory first (before binary check)
    // This handles edge cases like directories named "images.png/"
    if (stats.isDirectory()) {
      const filesInDir = await listAllFilesInDirectory(basePath, cleanPath);
      if (filesInDir.length === 0) {
        // Empty directory
        return createNewFileDiff(cleanPath, '040000', ['[Empty directory]']);
      }
      // Generate diffs for all files in the directory sequentially
      // Using sequential processing to avoid exhausting file descriptors on large directories
      const diffs: string[] = [];
      for (const filePath of filesInDir) {
        diffs.push(await generateSyntheticDiffForNewFile(basePath, filePath));
      }
      return diffs.join('');
    }

    // Check if it's a binary file (after directory check to handle dirs with binary extensions)
    if (isBinaryFile(cleanPath)) {
      return `diff --git a/${cleanPath} b/${cleanPath}
new file mode 100644
index 0000000..0000000
Binary file ${cleanPath} added
`;
    }

    const fileSize = Number(stats.size);
    if (fileSize > MAX_SYNTHETIC_DIFF_SIZE) {
      const sizeKB = Math.round(fileSize / 1024);
      return createNewFileDiff(cleanPath, '100644', [`[File too large to display: ${sizeKB}KB]`]);
    }

    // Read file content
    const content = (await secureFs.readFile(fullPath, 'utf-8')) as string;
    const hasTrailingNewline = content.endsWith('\n');
    const lines = content.split('\n');

    // Remove trailing empty line if the file ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    // Generate diff format
    const lineCount = lines.length;
    const addedLines = lines.map((line) => `+${line}`).join('\n');

    let diff = `diff --git a/${cleanPath} b/${cleanPath}
new file mode 100644
index 0000000..0000000
--- /dev/null
+++ b/${cleanPath}
@@ -0,0 +1,${lineCount} @@
${addedLines}`;

    // Add "No newline at end of file" indicator if needed
    if (!hasTrailingNewline && content.length > 0) {
      diff += '\n\\ No newline at end of file';
    }

    return diff + '\n';
  } catch (error) {
    // Log the error for debugging
    logger.error(`Failed to generate synthetic diff for ${fullPath}:`, error);
    // Return a placeholder diff
    return createNewFileDiff(cleanPath, '100644', ['[Unable to read file content]']);
  }
}

/**
 * Generate synthetic diffs for all untracked files and combine with existing diff
 */
export async function appendUntrackedFileDiffs(
  basePath: string,
  existingDiff: string,
  files: Array<{ status: string; path: string }>,
  maxBytes?: number
): Promise<string> {
  // Find untracked files (status "?")
  const untrackedFiles = files.filter((f) => f.status === '?');

  if (untrackedFiles.length === 0) {
    return existingDiff;
  }

  // Generate synthetic diffs for each untracked file. When a byte budget is
  // supplied, stop early instead of materializing every untracked file: a repo
  // with large untracked directories can otherwise exhaust memory and block the
  // request for minutes.
  const budget = maxBytes ?? Number.POSITIVE_INFINITY;
  let used = Buffer.byteLength(existingDiff, 'utf8');
  if (used >= budget) {
    return existingDiff + truncationNoteForUnknownSize('remaining untracked files were skipped');
  }

  const parts: string[] = [];
  let truncated = false;
  for (const file of untrackedFiles) {
    const synthetic = await generateSyntheticDiffForNewFile(basePath, file.path);
    const size = Buffer.byteLength(synthetic, 'utf8');
    if (used + size > budget) {
      truncated = true;
      break;
    }
    parts.push(synthetic);
    used += size;
  }

  const combinedDiff = existingDiff + parts.join('');
  if (!truncated) {
    return combinedDiff;
  }
  const omittedFiles = untrackedFiles.length - parts.length;
  const plural = omittedFiles === 1 ? '' : 's';
  return (
    combinedDiff +
    truncationNoteForUnknownSize(
      `${omittedFiles} untracked file${plural} ${omittedFiles === 1 ? 'was' : 'were'} not included`
    )
  );
}

/**
 * List all files in a directory recursively (for non-git repositories)
 * Excludes hidden files/folders and common build artifacts
 */
export async function listAllFilesInDirectory(
  basePath: string,
  relativePath: string = ''
): Promise<string[]> {
  const files: string[] = [];
  const fullPath = path.join(basePath, relativePath);

  // Directories to skip
  const skipDirs = new Set([
    'node_modules',
    '.git',
    '.automaker',
    'dist',
    'build',
    '.next',
    '.nuxt',
    '__pycache__',
    '.cache',
    'coverage',
    '.venv',
    'venv',
    'target',
    'vendor',
    '.gradle',
    'out',
    'tmp',
    '.tmp',
  ]);

  try {
    const entries = await secureFs.readdir(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files/folders (except we want to allow some)
      if (entry.name.startsWith('.') && entry.name !== '.env') {
        continue;
      }

      const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          const subFiles = await listAllFilesInDirectory(basePath, entryRelPath);
          files.push(...subFiles);
        }
      } else if (entry.isFile()) {
        files.push(entryRelPath);
      }
    }
  } catch (error) {
    // Log the error to help diagnose file system issues
    logger.error(`Error reading directory ${fullPath}:`, error);
  }

  return files;
}

/**
 * Generate diffs for all files in a non-git directory
 * Treats all files as "new" files
 */
export async function generateDiffsForNonGitDirectory(
  basePath: string
): Promise<{ diff: string; files: FileStatus[] }> {
  const allFiles = await listAllFilesInDirectory(basePath);

  const files: FileStatus[] = allFiles.map((filePath) => ({
    status: '?',
    path: filePath,
    statusText: 'New',
  }));

  // Generate synthetic diffs for all files
  const syntheticDiffs = await Promise.all(
    files.map((f) => generateSyntheticDiffForNewFile(basePath, f.path))
  );

  return {
    diff: syntheticDiffs.join(''),
    files,
  };
}

/** Ref names accepted before being handed to git (defensive; refs are not shell-escaped). */
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

function parseNameStatus(output: string): FileStatus[] {
  const files: FileStatus[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]?.trim();
    const filePath = parts[parts.length - 1]?.trim();
    if (!code || !filePath) continue;
    const letter = code[0];
    files.push({
      status: letter,
      path: filePath,
      statusText: GIT_STATUS_MAP[letter] ?? 'Changed',
    });
  }
  return files;
}

// ============================================================================
// Submodule change expansion
//
// `git diff` only records the submodule gitlink (a "Subproject commit" pointer
// line), which tells a reviewer nothing about the code that actually changed
// inside the submodule. These helpers resolve each changed gitlink to the
// submodule's own commit range and diff that range so the real work shows up.
// ============================================================================

/** Git's well-known empty tree - used when a submodule was added or removed. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** File mode git uses for a submodule entry (a "gitlink"). */
const GITLINK_MODE = '160000';

/** How a submodule changed between two revisions. */
export type SubmoduleChangeStatus = 'added' | 'removed' | 'modified' | 'uncommitted';

/** A submodule gitlink change parsed out of `git diff --raw`. */
export interface GitlinkChange {
  /** Path of the submodule inside the parent repository */
  path: string;
  oldSha: string;
  newSha: string;
  status: 'added' | 'removed' | 'modified';
}

/**
 * Summary of what happened inside one submodule.
 *
 * `files` and `diff` are not included here on purpose: the parent diff already
 * carries the submodule's files (prefixed with the submodule path), so the UI
 * can render them with its normal per-file machinery.
 */
export interface SubmoduleDiffSummary {
  /** Path of the submodule inside the parent repository (e.g. `frontend/saas-frontend`) */
  path: string;
  status: SubmoduleChangeStatus;
  /** Commit recorded by the parent before the change (null when the submodule was added) */
  oldCommit: string | null;
  /** Commit recorded by the parent after the change (null when removed) */
  newCommit: string | null;
  /** Files changed inside the submodule */
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** The submodule diff was cut off because the byte budget ran out */
  truncated: boolean;
  /** Set when the submodule content could not be diffed (not initialised, commits not fetched, ...) */
  error?: string;
}

interface SubmoduleContentDiff {
  files: FileStatus[];
  diff: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
  error?: string;
}

/**
 * Parse `git diff --raw -M -z` output and keep only submodule (gitlink) entries.
 *
 * Both `-z` (NUL separated) and tab separated output are accepted so the parser
 * can be unit tested with either form.
 */
export function parseRawGitlinkChanges(raw: string): GitlinkChange[] {
  // `-z` output keeps paths in their own NUL-delimited token (so paths that
  // contain a newline survive), while plain output separates entries by newline.
  const tokens = (raw.includes('\0') ? raw.split('\0') : raw.split('\n')).flatMap((token) =>
    token.split('\t')
  );
  const changes: GitlinkChange[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || !token.startsWith(':')) continue;

    const [oldMode, newMode, oldSha, newSha, statusCode] = token.slice(1).split(' ');
    if (!oldMode || !newMode || !oldSha || !newSha) continue;
    if (oldMode !== GITLINK_MODE && newMode !== GITLINK_MODE) continue;

    // Renames/copies carry two paths; the last one is the current location.
    const isRename = statusCode?.startsWith('R') || statusCode?.startsWith('C');
    const path = isRename ? tokens[i + 2] : tokens[i + 1];
    i += isRename ? 2 : 1;
    if (!path) continue;

    const status: GitlinkChange['status'] = statusCode?.startsWith('A')
      ? 'added'
      : statusCode?.startsWith('D')
        ? 'removed'
        : 'modified';

    changes.push({ path, oldSha, newSha, status });
  }

  return changes;
}

/**
 * Prefix a submodule's diff headers with the submodule path so the combined
 * diff keeps one namespace (`frontend/saas-frontend/ui/src/...`).
 */
export function prefixSubmoduleDiff(diff: string, submodulePath: string): string {
  const prefix = submodulePath.replace(/\/+$/, '');
  if (!prefix || !diff) return diff;
  return diff.replace(
    /^diff --git a\/(.*?) b\/(.*)$/gm,
    (_match, before, after) => `diff --git a/${prefix}/${before} b/${prefix}/${after}`
  );
}

/** Extract insertion/deletion totals from `git diff --shortstat` output. */
export function parseShortstat(output: string): { insertions: number; deletions: number } {
  const insertions = /(\d+)\s+insertions?\(\+\)/.exec(output);
  const deletions = /(\d+)\s+deletions?\(-\)/.exec(output);
  return {
    insertions: insertions ? Number.parseInt(insertions[1], 10) : 0,
    deletions: deletions ? Number.parseInt(deletions[1], 10) : 0,
  };
}

/** Turn a git failure into something a reviewer can act on. */
function describeSubmoduleError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not a git repository|does not exist|No such file/i.test(message)) {
    return 'Submodule is not initialised in this worktree';
  }
  if (/bad object|unknown revision|Not a valid object name|Invalid revision range/i.test(message)) {
    return 'Submodule commits are not available locally (run: git submodule update --init --recursive)';
  }
  return message.split('\n')[0]?.trim() || 'Could not read submodule changes';
}

/**
 * Diff the contents of one submodule.
 *
 * @param revisionArgs - `[from, to]` for a commit range, or `[]` to diff the
 *   submodule's HEAD against its working tree.
 */
async function readSubmoduleContent(
  submodulePath: string,
  labelPath: string,
  revisionArgs: string[],
  maxBytes: number
): Promise<SubmoduleContentDiff> {
  const empty: SubmoduleContentDiff = {
    files: [],
    diff: '',
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    truncated: false,
  };

  try {
    const nameStatus = await execGitCommand(
      ['diff', '--name-status', '-M', ...revisionArgs],
      submodulePath
    );
    const files = parseNameStatus(nameStatus).map((file) => ({
      ...file,
      path: `${labelPath}/${file.path}`,
    }));

    let insertions = 0;
    let deletions = 0;
    try {
      const shortstat = await execGitCommand(
        ['diff', '--shortstat', ...revisionArgs],
        submodulePath
      );
      ({ insertions, deletions } = parseShortstat(shortstat));
    } catch {
      // Counts are cosmetic - a failure here must not lose the file list.
    }

    if (files.length === 0) {
      return { ...empty, filesChanged: 0, insertions, deletions };
    }

    if (maxBytes <= 0) {
      // Diff budget already spent: keep the file list, skip the content.
      return { ...empty, filesChanged: files.length, insertions, deletions, truncated: true };
    }

    const raw = await execGitCommand(['diff', ...revisionArgs], submodulePath);
    const size = Buffer.byteLength(raw, 'utf8');
    const truncated = size > maxBytes;
    const body = truncated ? truncateToUtf8Bytes(raw, maxBytes) : raw;
    const diff =
      prefixSubmoduleDiff(body, labelPath) + (truncated ? truncationNote(size - maxBytes) : '');

    return { files, diff, filesChanged: files.length, insertions, deletions, truncated };
  } catch (error) {
    return { ...empty, error: describeSubmoduleError(error) };
  }
}

/**
 * Expand every submodule gitlink change between two revisions into the
 * submodule's own files and diff text.
 *
 * The returned `diff`/`files` are meant to be appended to the parent diff so the
 * existing per-file viewer renders them; `summaries` describes each submodule
 * for a dedicated section in the UI.
 */
export async function collectRangeSubmoduleDiffs(
  repoPath: string,
  from: string,
  to: string,
  options: { maxDiffBytes?: number } = {}
): Promise<{ diff: string; files: FileStatus[]; summaries: SubmoduleDiffSummary[] }> {
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const result = { diff: '', files: [] as FileStatus[], summaries: [] as SubmoduleDiffSummary[] };

  let raw: string;
  try {
    raw = await execGitCommand(['diff', '--raw', '-M', '-z', from, to], repoPath);
  } catch (error) {
    logger.warn(`Failed to list submodule changes in ${repoPath}:`, error);
    return result;
  }

  const gitlinks = parseRawGitlinkChanges(raw);
  let usedBytes = 0;

  for (const [index, link] of gitlinks.entries()) {
    const summary: SubmoduleDiffSummary = {
      path: link.path,
      status: link.status,
      oldCommit: link.status === 'added' ? null : link.oldSha,
      newCommit: link.status === 'removed' ? null : link.newSha,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      truncated: false,
    };
    result.summaries.push(summary);

    const submodulePath = path.join(repoPath, link.path);
    const submoduleIsRepo = await isGitRepo(submodulePath).catch(() => false);
    if (!submoduleIsRepo) {
      summary.error = 'Submodule is not initialised in this worktree';
      continue;
    }

    const fromSha = link.status === 'added' ? EMPTY_TREE_SHA : link.oldSha;
    const toSha = link.status === 'removed' ? EMPTY_TREE_SHA : link.newSha;

    // Share the remaining budget between the submodules that still need it so one
    // huge submodule cannot starve the others; unused bytes roll over.
    const remainingCount = gitlinks.length - index;
    const share = Math.max(0, Math.floor((maxDiffBytes - usedBytes) / remainingCount));

    const content = await readSubmoduleContent(submodulePath, link.path, [fromSha, toSha], share);

    summary.filesChanged = content.filesChanged;
    summary.insertions = content.insertions;
    summary.deletions = content.deletions;
    summary.truncated = content.truncated;
    if (content.error) summary.error = content.error;

    result.files.push(...content.files);
    if (content.diff.trim()) {
      result.diff += content.diff;
      usedBytes += Buffer.byteLength(content.diff, 'utf8');
    }
  }

  return result;
}

/**
 * Expand submodule gitlink moves committed on the current branch.
 *
 * A worktree often has both uncommitted edits *and* committed submodule work
 * (the feature commits its submodule bump, then keeps editing the parent). The
 * working-tree diff never contains the committed submodule content, so callers
 * merge this in as well.
 *
 * @param baseRefs - Candidate base refs, tried in order (first one with submodule
 *   changes wins).
 */
export async function collectBranchSubmoduleDiffs(
  repoPath: string,
  baseRefs: string[],
  options: { maxDiffBytes?: number } = {}
): Promise<{
  diff: string;
  files: FileStatus[];
  summaries: SubmoduleDiffSummary[];
  base?: string;
}> {
  for (const baseRef of baseRefs) {
    if (!SAFE_REF.test(baseRef)) continue;

    let mergeBase: string;
    try {
      const { stdout } = await execAsync(`git merge-base ${baseRef} HEAD`, {
        cwd: repoPath,
        timeout: 20000,
      });
      mergeBase = stdout.trim();
    } catch {
      continue;
    }
    if (!/^[0-9a-f]{7,40}$/i.test(mergeBase)) continue;

    const result = await collectRangeSubmoduleDiffs(repoPath, mergeBase, 'HEAD', options);
    if (result.summaries.length > 0) {
      return { ...result, base: mergeBase };
    }
  }

  return { diff: '', files: [], summaries: [] };
}

/**
 * Expand submodules that have uncommitted changes in their working tree.
 *
 * @param statusEntries - Parent status entries (`git status --porcelain`); every
 *   entry whose path is itself a git repository is treated as a submodule.
 */
// ============================================================================
// Task-scoped commit filtering
//
// A feature branch is often shared by a whole epic: several tasks commit to the
// same branch, so "diff the branch against its base" shows other tasks' work.
// Task commits carry the Jira key (and usually the child index) in the commit
// message, so the diff can be narrowed to the commits that belong to the task.
// ============================================================================

/** A commit on a branch, as read from the log. */
export interface BranchCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

/** Which commits belong to a task. */
export interface TaskCommitMatcher {
  /** Jira key from the feature (e.g. `AIP-114878`) */
  jiraKey?: string | null;
  /** Child index for sub-tasks (e.g. `12` for "... child 12") */
  childIndex?: number | null;
}

/** Minimal feature shape needed to derive a matcher. */
export interface TaskScopeFeature {
  id?: string;
  title?: string;
  jiraKey?: unknown;
}

/** Lowercase and strip separators so `#AIP-114878` and `AIP114878` both match. */
export function normalizeCommitText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Extract every `child <n>` marker from a string (handles `child-3`, `child 12`). */
export function extractChildIndexes(source: string): number[] {
  const indexes: number[] = [];
  for (const match of source.matchAll(/child[\s_-]*0*(\d+)/gi)) {
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value)) indexes.push(value);
  }
  return indexes;
}

/** First `child <n>` marker found across the given strings. */
export function extractChildIndex(...sources: Array<string | undefined | null>): number | null {
  for (const source of sources) {
    if (!source) continue;
    const [first] = extractChildIndexes(source);
    if (first !== undefined) return first;
  }
  return null;
}

/**
 * Derive a Jira key from an id or directory name:
 * `aip-114878-child-1` → `AIP-114878`, `jira-dodo-aip-114878` → `AIP-114878`.
 */
export function deriveJiraKeyFromId(id: string | undefined | null): string | null {
  if (!id) return null;
  const match = /([a-z]{2,10})-(\d{2,7})/i.exec(id);
  if (!match) return null;
  return `${match[1].toUpperCase()}-${match[2]}`;
}

/**
 * Build the commit matcher for a feature from its Jira key and child marker.
 * Returns null when no Jira key can be determined (nothing to filter by).
 */
export function resolveTaskCommitMatcher(
  feature: TaskScopeFeature | null
): TaskCommitMatcher | null {
  if (!feature) return null;

  const rawKey = typeof feature.jiraKey === 'string' ? feature.jiraKey.trim() : '';
  // Cards created from an id alone (e.g. monitor-created sub-tasks) still carry
  // the Jira key inside the id.
  const jiraKey = rawKey || deriveJiraKeyFromId(feature.id);
  const childIndex = extractChildIndex(feature.id, feature.title);
  if (!jiraKey && childIndex === null) return null;

  return { jiraKey, childIndex };
}

/** Does a commit subject belong to the task described by `matcher`? */
export function matchesTaskCommit(subject: string, matcher: TaskCommitMatcher): boolean {
  const text = normalizeCommitText(subject);
  if (!text) return false;

  if (matcher.jiraKey) {
    const key = normalizeCommitText(matcher.jiraKey);
    if (key) {
      const index = text.indexOf(key);
      if (index < 0) return false;
      // Guard against AIP-114878 matching AIP-1148780.
      const next = text[index + key.length];
      if (next !== undefined && /\d/.test(next)) return false;
    }
  }

  if (matcher.childIndex !== null && matcher.childIndex !== undefined) {
    if (!extractChildIndexes(subject).includes(matcher.childIndex)) return false;
  }

  return true;
}

/**
 * A parent ("epic") task owns the whole branch: its children commit to it, and
 * showing every change on the branch is the correct review view.
 */
export function isParentTask(
  feature: TaskScopeFeature | null,
  features: TaskScopeFeature[] = []
): boolean {
  if (!feature) return false;

  const selfId = feature.id ?? '';
  const childPattern = /child[\s_-]*0*\d+/i;
  const ownKey = typeof feature.jiraKey === 'string' ? normalizeCommitText(feature.jiraKey) : '';

  return features.some((candidate) => {
    if (!candidate?.id || candidate.id === selfId) return false;
    const text = `${candidate.id} ${candidate.title ?? ''}`;
    if (!childPattern.test(text)) return false;
    if (!ownKey) return false;
    return normalizeCommitText(text).includes(ownKey);
  });
}

/** Resolve the merge base of a branch against `baseRef` (null when unusable). */
export async function resolveMergeBase(repoPath: string, baseRef: string): Promise<string | null> {
  if (!SAFE_REF.test(baseRef)) return null;
  try {
    const { stdout } = await execAsync(`git merge-base ${baseRef} HEAD`, {
      cwd: repoPath,
      timeout: 20000,
    });
    const mergeBase = stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(mergeBase) ? mergeBase : null;
  } catch {
    return null;
  }
}

/** Commits reachable from HEAD but not from the merge base, newest first. */
export async function listBranchCommits(
  repoPath: string,
  mergeBase: string
): Promise<BranchCommit[]> {
  try {
    const stdout = await execGitCommand(
      ['log', '--format=%H%x1f%s%x1f%an%x1f%cI', `${mergeBase}..HEAD`],
      repoPath
    );
    const commits: BranchCommit[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [sha, subject, author, date] = line.split('\x1f');
      if (!sha) continue;
      commits.push({ sha, subject: subject ?? '', author: author ?? '', date: date ?? '' });
    }
    return commits;
  } catch (error) {
    logger.warn(`Failed to list commits in ${repoPath}:`, error);
    return [];
  }
}

/** How the diff was scoped when it was produced. */
export interface TaskScopeInfo {
  mode: 'task' | 'branch';
  reason:
    | 'task-commits'
    | 'parent-task'
    | 'no-jira-key'
    | 'no-matching-commits'
    | 'all-commits-match'
    | 'requested-branch';
  jiraKey?: string | null;
  childIndex?: number | null;
  matchedCommits?: number;
  totalCommits?: number;
  commits?: Array<{ sha: string; subject: string }>;
}

/**
 * Pick the commits that belong to the task.
 *
 * Returns `mode: 'branch'` (with a reason) whenever narrowing would be wrong or
 * pointless, so callers can fall back to the whole-branch diff.
 */
export function selectTaskCommits(
  commits: BranchCommit[],
  options: {
    matcher?: TaskCommitMatcher | null;
    isParent?: boolean;
    forceBranchScope?: boolean;
  } = {}
): { mode: 'task' | 'branch'; commits: BranchCommit[]; info: TaskScopeInfo } {
  const { matcher, isParent = false, forceBranchScope = false } = options;

  const base: TaskScopeInfo = {
    mode: 'branch',
    reason: 'no-jira-key',
    jiraKey: matcher?.jiraKey ?? null,
    childIndex: matcher?.childIndex ?? null,
    totalCommits: commits.length,
  };

  if (forceBranchScope) {
    return { mode: 'branch', commits, info: { ...base, reason: 'requested-branch' } };
  }
  if (!matcher || (!matcher.jiraKey && (matcher.childIndex ?? null) === null)) {
    return { mode: 'branch', commits, info: base };
  }
  // A detected parent (epic) owns the whole branch: its children commit on it and
  // their messages may not all repeat the parent key.
  if (isParent) {
    return { mode: 'branch', commits, info: { ...base, reason: 'parent-task' } };
  }

  // Otherwise narrow by whatever the matcher can identify. Branches are often
  // shared by several tasks, and their commit messages carry the task's key (and
  // usually a child marker), so matching only those commits keeps the review
  // focused. When every commit matches, the branch scope is reported instead.
  const matched = commits.filter((commit) => matchesTaskCommit(commit.subject, matcher));
  if (matched.length === 0) {
    return { mode: 'branch', commits, info: { ...base, reason: 'no-matching-commits' } };
  }
  if (matched.length === commits.length) {
    return { mode: 'branch', commits, info: { ...base, reason: 'all-commits-match' } };
  }

  return {
    mode: 'task',
    commits: matched,
    info: {
      ...base,
      mode: 'task',
      reason: 'task-commits',
      matchedCommits: matched.length,
      commits: matched.map((commit) => ({ sha: commit.sha, subject: commit.subject })),
    },
  };
}

/** Diff selected commits supplied newest-first, matching git log and task commit searches. */
/** Parent of a commit, or the empty tree when the commit is a root commit. */
async function resolveParentRef(repoPath: string, sha: string): Promise<string> {
  try {
    await execGitCommand(['rev-parse', '--verify', '--quiet', `${sha}^`], repoPath);
    return `${sha}^`;
  } catch {
    return EMPTY_TREE_SHA;
  }
}

export async function collectCommitSetDiffs(
  repoPath: string,
  shas: string[],
  options: { maxDiffBytes?: number; submodulesOnly?: boolean } = {}
): Promise<{
  diff: string;
  files: FileStatus[];
  hasChanges: boolean;
  summaries: SubmoduleDiffSummary[];
}> {
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const result = {
    diff: '',
    files: [] as FileStatus[],
    hasChanges: false,
    summaries: [] as SubmoduleDiffSummary[],
  };
  if (shas.length === 0) return result;

  const knownFiles = new Set<string>();
  // Submodule gitlink moves across the selected commits, collapsed per submodule
  // so the diff shows the cumulative delta (first old → last new), not each step.
  const submoduleRanges = new Map<
    string,
    { oldSha: string; newSha: string; status: GitlinkChange['status'] }
  >();
  let usedBytes = 0;

  for (const sha of [...shas].reverse()) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    // A root commit has no parent - diff it against the empty tree instead.
    const parent = await resolveParentRef(repoPath, sha);

    try {
      const raw = await execGitCommand(['diff', '--raw', '-M', '-z', parent, sha], repoPath);
      for (const link of parseRawGitlinkChanges(raw)) {
        const existing = submoduleRanges.get(link.path);
        submoduleRanges.set(link.path, {
          oldSha: existing ? existing.oldSha : link.oldSha,
          newSha: link.newSha,
          status: existing ? existing.status : link.status,
        });
      }
    } catch (error) {
      logger.warn(`Failed to inspect submodule changes in ${sha}:`, error);
    }

    if (options.submodulesOnly) continue;

    try {
      const nameStatus = await execGitCommand(
        ['diff', '--name-status', '-M', parent, sha],
        repoPath
      );
      for (const file of parseNameStatus(nameStatus)) {
        if (knownFiles.has(file.path)) continue;
        knownFiles.add(file.path);
        result.files.push(file);
      }
    } catch (error) {
      logger.warn(`Failed to list files changed in ${sha}:`, error);
    }

    if (usedBytes < maxDiffBytes) {
      try {
        const raw = await execGitCommand(['diff', parent, sha], repoPath);
        const remaining = maxDiffBytes - usedBytes;
        const size = Buffer.byteLength(raw, 'utf8');
        const body =
          size > remaining ? Buffer.from(raw, 'utf8').subarray(0, remaining).toString('utf8') : raw;
        result.diff += body;
        usedBytes += Buffer.byteLength(body, 'utf8');
      } catch (error) {
        logger.warn(`Failed to diff commit ${sha}:`, error);
      }
    }
  }

  // Expand each changed submodule into its own files and diff text.
  const entries = [...submoduleRanges.entries()].filter(
    ([, range]) => range.oldSha && range.newSha && range.oldSha !== range.newSha
  );
  for (const [index, [labelPath, range]] of entries.entries()) {
    const summary: SubmoduleDiffSummary = {
      path: labelPath,
      status: range.status,
      oldCommit: range.status === 'added' ? null : range.oldSha,
      newCommit: range.status === 'removed' ? null : range.newSha,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      truncated: false,
    };
    result.summaries.push(summary);

    const submodulePath = path.join(repoPath, labelPath);
    const submoduleIsRepo = await isGitRepo(submodulePath).catch(() => false);
    if (!submoduleIsRepo) {
      summary.error = 'Submodule is not initialised in this worktree';
      continue;
    }

    const remainingCount = entries.length - index;
    const share = Math.max(0, Math.floor((maxDiffBytes - usedBytes) / remainingCount));
    const content = await readSubmoduleContent(
      submodulePath,
      labelPath,
      [range.oldSha, range.newSha],
      share
    );

    summary.filesChanged = content.filesChanged;
    summary.insertions = content.insertions;
    summary.deletions = content.deletions;
    summary.truncated = content.truncated;
    if (content.error) summary.error = content.error;

    for (const file of content.files) {
      if (knownFiles.has(file.path)) continue;
      knownFiles.add(file.path);
      result.files.push(file);
    }
    if (content.diff.trim()) {
      result.diff += content.diff;
      usedBytes += Buffer.byteLength(content.diff, 'utf8');
    }
  }

  result.hasChanges = result.files.length > 0 || result.diff.trim().length > 0;
  return result;
}

export async function collectWorkingTreeSubmoduleDiffs(
  repoPath: string,
  statusEntries: FileStatus[],
  options: { maxDiffBytes?: number } = {}
): Promise<{ diff: string; files: FileStatus[]; summaries: SubmoduleDiffSummary[] }> {
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const result = { diff: '', files: [] as FileStatus[], summaries: [] as SubmoduleDiffSummary[] };

  const candidates = statusEntries.filter((file) => file.path && !file.path.endsWith('/'));
  let usedBytes = 0;

  for (const file of candidates) {
    const submodulePath = path.join(repoPath, file.path);
    const submoduleIsRepo = await isGitRepo(submodulePath).catch(() => false);
    if (!submoduleIsRepo) continue;

    let headSha: string | null = null;
    try {
      headSha = (await execGitCommand(['rev-parse', 'HEAD'], submodulePath)).trim() || null;
    } catch {
      headSha = null;
    }

    const content = await readSubmoduleContent(
      submodulePath,
      file.path,
      ['HEAD'],
      maxDiffBytes - usedBytes
    );

    // `git diff` never reports untracked files, so add them the same way the
    // parent repository does - otherwise brand new submodule files stay invisible.
    const submoduleStatus = await execGitCommand(['status', '--porcelain'], submodulePath).catch(
      () => ''
    );
    const submoduleEntries = parseGitStatus(submoduleStatus);
    const untracked = submoduleEntries.filter((entry) => entry.status === '?');
    if (untracked.length > 0 && !content.truncated) {
      const untrackedDiff = await appendUntrackedFileDiffs(
        submodulePath,
        '',
        untracked,
        Math.max(0, maxDiffBytes - usedBytes - Buffer.byteLength(content.diff, 'utf8'))
      );
      if (untrackedDiff.trim()) {
        content.diff += prefixSubmoduleDiff(untrackedDiff, file.path);
        content.files.push(
          ...untracked.map((entry) => ({
            ...entry,
            path: `${file.path}/${entry.path}`,
          }))
        );
        content.filesChanged = content.files.length;
      }
    }

    const summary: SubmoduleDiffSummary = {
      path: file.path,
      status: 'uncommitted',
      oldCommit: headSha,
      newCommit: headSha,
      filesChanged: content.filesChanged,
      insertions: content.insertions,
      deletions: content.deletions,
      truncated: content.truncated,
    };
    if (content.error) summary.error = content.error;
    result.summaries.push(summary);

    result.files.push(...content.files);
    if (content.diff.trim()) {
      result.diff += content.diff;
      usedBytes += Buffer.byteLength(content.diff, 'utf8');
    }
  }

  return result;
}

/**
 * Diff a committed branch against its merge base with `baseRef`.
 *
 * A finished feature has no uncommitted changes, so `git diff HEAD` reports
 * nothing even though the branch delivered real work. Reviewers still need to
 * see that work (for a monorepo, the changed submodule gitlinks), so the worktree
 * diff view falls back to this branch-level diff.
 */
export async function getCommittedBranchDiffs(
  repoPath: string,
  baseRef: string,
  maxDiffBytes: number = DEFAULT_MAX_DIFF_BYTES
): Promise<{
  diff: string;
  files: FileStatus[];
  hasChanges: boolean;
  base?: string;
  submodules?: SubmoduleDiffSummary[];
}> {
  if (!SAFE_REF.test(baseRef)) return { diff: '', files: [], hasChanges: false };

  let mergeBase: string;
  try {
    const { stdout } = await execAsync(`git merge-base ${baseRef} HEAD`, {
      cwd: repoPath,
      timeout: 20000,
    });
    mergeBase = stdout.trim();
  } catch {
    return { diff: '', files: [], hasChanges: false };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(mergeBase)) {
    return { diff: '', files: [], hasChanges: false };
  }

  try {
    const { stdout: nameStatus } = await execAsync(`git diff --name-status -M ${mergeBase} HEAD`, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000,
    });
    const files = parseNameStatus(nameStatus);
    const { stdout: rawDiff } = await execAsync(`git diff ${mergeBase} HEAD`, {
      cwd: repoPath,
      maxBuffer: maxDiffBytes * 2 + 1024 * 1024,
      timeout: 120000,
    });
    const size = Buffer.byteLength(rawDiff, 'utf8');
    let diff =
      size > maxDiffBytes
        ? truncateToUtf8Bytes(rawDiff, maxDiffBytes) + truncationNote(size - maxDiffBytes)
        : rawDiff;

    // A submodule gitlink only records a pointer move; pull in the submodule's
    // own files and diff text so reviewers see the code that actually changed.
    const submodules = await collectRangeSubmoduleDiffs(repoPath, mergeBase, 'HEAD', {
      maxDiffBytes: Math.max(0, maxDiffBytes - Buffer.byteLength(diff, 'utf8')),
    });
    if (submodules.files.length > 0 || submodules.diff.trim()) {
      files.push(...submodules.files);
      diff += submodules.diff;
    }

    return {
      diff,
      files,
      hasChanges: files.length > 0,
      base: mergeBase,
      submodules: submodules.summaries,
    };
  } catch (error) {
    logger.warn(`Failed to diff ${repoPath} against ${baseRef}:`, error);
    return { diff: '', files: [], hasChanges: false };
  }
}

/**
 * Get git repository diffs for a given path
 * Handles both git repos and non-git directories.
 * Also detects merge state and annotates files accordingly.
 */
/** Paths of other worktrees nested inside `repoPath` (relative, POSIX separators). */
export function worktreePrefixesFromList(repoPath: string, worktreePaths: string[]): string[] {
  const normalizedRepo = path.resolve(repoPath);
  return worktreePaths
    .map((worktreePath) => path.resolve(worktreePath))
    .filter((worktreePath) => worktreePath !== normalizedRepo)
    .filter((worktreePath) => worktreePath.startsWith(`${normalizedRepo}${path.sep}`))
    .map((worktreePath) => path.relative(normalizedRepo, worktreePath).split(path.sep).join('/'));
}

/** Resolve the nested-worktree prefixes of a repository (empty when git is unavailable). */
async function listNestedWorktreePrefixes(repoPath: string): Promise<string[]> {
  try {
    const stdout = await execGitCommand(['worktree', 'list', '--porcelain'], repoPath);
    const paths = stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter(Boolean);
    return worktreePrefixesFromList(repoPath, paths);
  } catch {
    // Git unavailable or not a repository - fall back to nothing filtered.
    return [];
  }
}

/** Is a repo-relative path inside another worktree (or the `.worktrees` folder)? */
export function isInsideNestedWorktree(filePath: string, prefixes: string[]): boolean {
  const normalized = filePath.replace(/\/+$/, '');
  if (normalized === '.worktrees' || normalized.startsWith('.worktrees/')) return true;
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export async function getGitRepositoryDiffs(repoPath: string): Promise<{
  diff: string;
  files: FileStatus[];
  hasChanges: boolean;
  mergeState?: MergeStateInfo;
  submodules?: SubmoduleDiffSummary[];
}> {
  return getGitRepositoryDiffsWithOptions(repoPath, {});
}

/**
 * Same as {@link getGitRepositoryDiffs} but allows bounding the returned diff
 * size so a caller cannot be blocked by an enormous payload.
 */
export async function getGitRepositoryDiffsWithOptions(
  repoPath: string,
  options: { maxDiffBytes?: number }
): Promise<{
  diff: string;
  files: FileStatus[];
  hasChanges: boolean;
  mergeState?: MergeStateInfo;
  submodules?: SubmoduleDiffSummary[];
}> {
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  // Check if it's a git repository
  const isRepo = await isGitRepo(repoPath);

  if (!isRepo) {
    // Not a git repo - list all files and treat them as new
    const result = await generateDiffsForNonGitDirectory(repoPath);
    return {
      diff: result.diff,
      files: result.files,
      hasChanges: result.files.length > 0,
    };
  }

  // Get git diff and status
  const { stdout: diff } = await execAsync('git diff HEAD', {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024,
  });
  const { stdout: status } = await execAsync('git status --porcelain', {
    cwd: repoPath,
  });

  // Nested worktrees live inside the project directory and are usually untracked,
  // so `git status` reports the whole `.worktrees/` folder. Diffing it would list
  // every file of every other worktree as a brand new file - never what the
  // reviewer asked for - so those paths are dropped here.
  const nestedWorktreePrefixes = await listNestedWorktreePrefixes(repoPath);
  const files = parseGitStatus(status).filter(
    (file) => !isInsideNestedWorktree(file.path, nestedWorktreePrefixes)
  );

  // Generate synthetic diffs for untracked (new) files
  let combinedDiff = await appendUntrackedFileDiffs(repoPath, diff, files, maxDiffBytes);
  let budgetExhausted = Buffer.byteLength(combinedDiff, 'utf8') >= maxDiffBytes;

  // `git status --porcelain` reports only the gitlink for a dirty submodule, while
  // `git diff HEAD` does not show the nested repository's source changes. Surface the
  // gitlink change plus the submodule's actual changed files so users can inspect
  // implementation work delivered through submodules.
  const submodules = budgetExhausted
    ? { diff: '', files: [], summaries: [] }
    : await collectWorkingTreeSubmoduleDiffs(repoPath, files, {
        maxDiffBytes: Math.max(0, maxDiffBytes - Buffer.byteLength(combinedDiff, 'utf8')),
      });
  if (submodules.files.length > 0) {
    files.push(
      ...submodules.files.map((file) => ({
        ...file,
        statusText: `Submodule: ${file.statusText}`,
      }))
    );
  }
  if (submodules.diff.trim()) {
    // Untracked files inside the submodule are not part of `git diff`, so append
    // their synthetic diffs the same way the parent repository does.
    combinedDiff += submodules.diff;
    budgetExhausted = Buffer.byteLength(combinedDiff, 'utf8') >= maxDiffBytes;
  }

  // Detect merge state (in-progress merge/rebase/cherry-pick)
  const mergeState = await detectMergeState(repoPath);

  // If no in-progress merge, check if HEAD is a completed merge commit
  // and include merge commit changes in the diff and file list
  if (!mergeState.isMerging) {
    const mergeCommitInfo = await detectMergeCommit(repoPath);

    if (mergeCommitInfo.isMergeCommit && mergeCommitInfo.mergeAffectedFiles.length > 0) {
      // Get the diff of the merge commit relative to first parent
      try {
        const { stdout: mergeDiff } = await execAsync('git diff HEAD~1 HEAD', {
          cwd: repoPath,
          maxBuffer: 10 * 1024 * 1024,
        });

        // Add merge-affected files to the file list (avoid duplicates with working tree changes)
        const fileByPath = new Map(files.map((f) => [f.path, f]));
        const existingPaths = new Set(fileByPath.keys());
        for (const filePath of mergeCommitInfo.mergeAffectedFiles) {
          if (!existingPaths.has(filePath)) {
            const newFile = {
              status: 'M',
              path: filePath,
              statusText: 'Merged',
              indexStatus: ' ',
              workTreeStatus: ' ',
              isMergeAffected: true,
              mergeType: 'merged',
            };
            files.push(newFile);
            fileByPath.set(filePath, newFile);
            existingPaths.add(filePath);
          } else {
            // Mark existing file as also merge-affected
            const existing = fileByPath.get(filePath);
            if (existing) {
              existing.isMergeAffected = true;
              existing.mergeType = 'merged';
            }
          }
        }

        // Prepend merge diff to the combined diff so merge changes appear
        // For files that only exist in the merge (not in working tree), we need their diffs
        if (mergeDiff.trim()) {
          // Parse the existing working tree diff to find which files it covers
          const workingTreeDiffPaths = new Set<string>();
          const diffLines = combinedDiff.split('\n');
          for (const line of diffLines) {
            if (line.startsWith('diff --git')) {
              const match = line.match(/diff --git a\/(.*?) b\/(.*)/);
              if (match) {
                workingTreeDiffPaths.add(match[2]);
              }
            }
          }

          // Only include merge diff entries for files NOT already in working tree diff
          const mergeDiffFiles = mergeDiff.split(/(?=diff --git)/);
          const newMergeDiffs: string[] = [];
          for (const fileDiff of mergeDiffFiles) {
            if (!fileDiff.trim()) continue;
            const match = fileDiff.match(/diff --git a\/(.*?) b\/(.*)/);
            if (match && !workingTreeDiffPaths.has(match[2])) {
              newMergeDiffs.push(fileDiff);
            }
          }

          if (newMergeDiffs.length > 0) {
            combinedDiff = newMergeDiffs.join('') + combinedDiff;
          }
        }
      } catch (mergeError) {
        // Best-effort: log and continue without merge diff
        logger.error('Failed to get merge commit diff:', mergeError);

        // Ensure files[] is consistent with mergeState.mergeAffectedFiles even when the
        // diff command failed. Without this, mergeAffectedFiles would list paths that have
        // no corresponding entry in the files array.
        const existingPathsAfterError = new Set(files.map((f) => f.path));
        for (const filePath of mergeCommitInfo.mergeAffectedFiles) {
          if (!existingPathsAfterError.has(filePath)) {
            files.push({
              status: 'M',
              path: filePath,
              statusText: 'Merged',
              indexStatus: ' ',
              workTreeStatus: ' ',
              isMergeAffected: true,
              mergeType: 'merged',
            });
            existingPathsAfterError.add(filePath);
          } else {
            // Mark existing file as also merge-affected
            const existing = files.find((f) => f.path === filePath);
            if (existing) {
              existing.isMergeAffected = true;
              existing.mergeType = 'merged';
            }
          }
        }
      }

      // Return with merge commit info in the mergeState
      return {
        diff: combinedDiff,
        files,
        hasChanges: files.length > 0,
        mergeState: {
          isMerging: false,
          mergeOperationType: 'merge',
          isCleanMerge: true,
          mergeAffectedFiles: mergeCommitInfo.mergeAffectedFiles,
          conflictFiles: [],
          isMergeCommit: true,
        },
      };
    }
  }

  // Enforce the payload ceiling last so merge/cherry-pick additions are covered too.
  const finalDiffBytes = Buffer.byteLength(combinedDiff, 'utf8');
  if (finalDiffBytes > maxDiffBytes) {
    const truncatedDiff = truncateToUtf8Bytes(combinedDiff, maxDiffBytes);
    combinedDiff = truncatedDiff + truncationNote(finalDiffBytes - maxDiffBytes);
  } else if (budgetExhausted && !combinedDiff.includes(TRUNCATION_MARKER)) {
    combinedDiff += truncationNoteForUnknownSize('the diff hit its size budget');
  }

  return {
    diff: combinedDiff,
    files,
    hasChanges: files.length > 0,
    ...(mergeState.isMerging ? { mergeState } : {}),
  };
}
