/**
 * Pi session store helpers.
 *
 * Pi keeps conversations as JSONL files under
 * `~/.pi/agent/sessions/--<project-path>--/<timestamp>_<id>.jsonl`.
 * These helpers locate the session that belongs to a feature's worktree and
 * turn the on-disk entries into a shape the Pi web page can render.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'fs';
import { createReadStream } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';

/** A single conversation entry, flattened for display */
export interface PiSessionMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'custom';
  timestamp?: number;
  text: string;
  thinking?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  isError?: boolean;
  errorMessage?: string;
  model?: string;
}

export interface PiSessionInfo {
  id: string;
  cwd: string;
  filePath: string;
  createdAt: string | null;
  updatedAt: string | null;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
  messages: PiSessionMessage[];
  userTurnCount: number;
}

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  content?: unknown;
}

interface PiSessionEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  message?: {
    role?: string;
    content?: PiContentBlock[] | string;
    timestamp?: number;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    isError?: boolean;
  };
}

/**
 * Root directory of Pi's stored sessions.
 */
export function getPiSessionsRoot(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/**
 * Pi derives the per-project directory from the working directory:
 * `/workspace/automaker` -> `--workspace-automaker--`.
 */
export function encodePiProjectDir(workDir: string): string {
  const normalized = path
    .resolve(workDir)
    .replace(/^[A-Za-z]:/, '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, '-');
  return `--${normalized}--`;
}

function listJsonlFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Read the header line of a session file (cheap cwd/id lookup).
 */
function readSessionHeader(filePath: string): { id?: string; cwd?: string; timestamp?: string } {
  try {
    const firstLine = readFileHead(filePath, 4096).split('\n', 1)[0];
    const parsed = JSON.parse(firstLine) as PiSessionEntry;
    if (parsed?.type !== 'session') return {};
    return { id: parsed.id, cwd: parsed.cwd, timestamp: parsed.timestamp };
  } catch {
    return {};
  }
}

/**
 * List session files that belong to a working directory, newest first.
 *
 * The project directory naming is Pi's own convention; when it does not exist
 * (different platform/version) we fall back to matching the `cwd` recorded in
 * each session header.
 */
export function listPiSessionFiles(workDir: string): string[] {
  const root = getPiSessionsRoot();
  if (!existsSync(root)) return [];

  const resolvedWorkDir = path.resolve(workDir);
  const projectDir = path.join(root, encodePiProjectDir(resolvedWorkDir));

  const candidates = existsSync(projectDir) ? listJsonlFiles(projectDir) : [];

  if (candidates.length === 0) {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const file of listJsonlFiles(path.join(root, dir.name))) {
        const header = readSessionHeader(file);
        if (header.cwd && path.resolve(header.cwd) === resolvedWorkDir) {
          candidates.push(file);
        }
      }
    }
  }

  return candidates.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function blocksToText(content: PiContentBlock[] | string | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function blocksToThinking(content: PiContentBlock[] | string | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const thinking = content
    .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking as string)
    .join('');
  return thinking || undefined;
}

function blocksToToolCalls(
  content: PiContentBlock[] | string | undefined
): Array<{ id: string; name: string; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block.type === 'toolCall' && block.id)
    .map((block) => ({
      id: block.id as string,
      name: block.name || 'tool',
      arguments: block.arguments ?? null,
    }));
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as PiContentBlock).text === 'string'
          ? String((block as PiContentBlock).text)
          : ''
      )
      .join('');
  }
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Parse a session file into displayable messages plus session metadata.
 */
export function readPiSessionFile(filePath: string): PiSessionInfo | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let header: PiSessionEntry | null = null;
  let modelProvider: string | undefined;
  let modelId: string | undefined;
  let thinkingLevel: string | undefined;
  const messages: PiSessionMessage[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: PiSessionEntry;
    try {
      entry = JSON.parse(trimmed) as PiSessionEntry;
    } catch {
      continue;
    }

    switch (entry.type) {
      case 'session':
        header = entry;
        break;
      case 'model_change':
        modelProvider = entry.provider ?? modelProvider;
        modelId = entry.modelId ?? modelId;
        break;
      case 'thinking_level_change':
        thinkingLevel = entry.thinkingLevel ?? thinkingLevel;
        break;
      case 'message': {
        const message = entry.message;
        if (!message) break;

        const role = message.role;
        if (role === 'user') {
          messages.push({
            role: 'user',
            timestamp: message.timestamp,
            text: blocksToText(message.content),
          });
        } else if (role === 'assistant') {
          messages.push({
            role: 'assistant',
            timestamp: message.timestamp,
            text: blocksToText(message.content),
            thinking: blocksToThinking(message.content),
            toolCalls: blocksToToolCalls(message.content),
            model: message.model ?? modelId,
            isError: message.stopReason === 'error' || message.stopReason === 'aborted',
            errorMessage: message.errorMessage,
          });
        } else if (role === 'toolResult') {
          messages.push({
            role: 'toolResult',
            timestamp: message.timestamp,
            text: stringifyToolResult(message.content),
            isError: message.isError === true,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  if (!header?.id) return null;

  let updatedAt: string | null = null;
  try {
    updatedAt = statSync(filePath).mtime.toISOString();
  } catch {
    updatedAt = null;
  }

  return {
    id: header.id,
    cwd: header.cwd ?? '',
    filePath,
    createdAt: header.timestamp ?? null,
    updatedAt,
    modelProvider,
    modelId,
    thinkingLevel,
    messages,
    userTurnCount: messages.filter((message) => message.role === 'user').length,
  };
}

/**
 * Find the Pi session for a worktree.
 *
 * When `sessionId` is provided (recorded on the feature as providerSessionId)
 * it wins; otherwise the most recently updated session in the worktree is used.
 */
export function findPiSession(workDir: string, sessionId?: string): PiSessionInfo | null {
  const files = listPiSessionFiles(workDir);
  if (files.length === 0) return null;

  if (sessionId) {
    for (const file of files) {
      const header = readSessionHeader(file);
      if (header.id === sessionId || path.basename(file).includes(sessionId)) {
        const session = readPiSessionFile(file);
        if (session) return session;
      }
    }
    // The pinned session is gone: say so instead of serving another
    // conversation as if it were the one that was asked for.
    return null;
  }

  for (const file of files) {
    const session = readPiSessionFile(file);
    if (session) return session;
  }
  return null;
}

/** Read at most `bytes` from the start of a file (cheap content probe) */
function readFileHead(filePath: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The feature id a session file was dispatched for.
 *
 * Automaker stamps every dispatched prompt with `**Feature ID:** <id>`; the
 * *first* marker in the file is the card that session ran for. Later markers can
 * legitimately belong to a parent or sibling card (a child's prompt quotes its
 * parent), so they must not be used for matching.
 */
export function readSessionFeatureId(filePath: string): string | null {
  const match = readFileHead(filePath, 8192).match(/\*\*Feature ID:\*\*\s*([^\s"\\]+)/i);
  return match ? match[1] : null;
}

/**
 * Find the newest session that ran for one of `featureKeys`.
 *
 * One worktree hosts several tasks - epic and children share a branch and a
 * session directory - so the dispatch marker is what ties a file back to a card
 * without extra state.
 */
export function findPiSessionForFeature(
  workDir: string,
  featureKeys: string[]
): PiSessionInfo | null {
  const wanted = new Set(featureKeys.map((key) => key.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return null;

  for (const file of listPiSessionFiles(workDir)) {
    const featureId = readSessionFeatureId(file);
    if (!featureId || !wanted.has(featureId.toLowerCase())) continue;
    const session = readPiSessionFile(file);
    if (session) return session;
  }
  return null;
}

/**
 * Session directories that belong to a project, i.e. all of its worktrees.
 *
 * A card can move between worktrees (an epic pulls a child into its branch), and
 * its conversation stays in the directory of the worktree it ran in, so the
 * lookup must not be limited to the card's current worktree.
 */
export function listProjectSessionDirs(projectPath: string): string[] {
  const root = getPiSessionsRoot();
  if (!existsSync(root)) return [];

  const projectDir = encodePiProjectDir(projectPath);
  const prefix = projectDir.slice(0, -2) + '-';
  try {
    return readdirSync(root)
      .filter((name) => name === projectDir || name.startsWith(prefix))
      .map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

/**
 * Find the newest session dispatched for one of `featureKeys` anywhere in the
 * project - including worktrees the card no longer belongs to.
 */
export function findPiSessionForFeatureInProject(
  projectPath: string,
  featureKeys: string[]
): PiSessionInfo | null {
  const wanted = new Set(featureKeys.map((key) => key.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return null;

  for (const dir of listProjectSessionDirs(projectPath)) {
    // Newest first, so a re-run wins over the card's older conversation.
    const files = listJsonlFiles(dir).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const file of files) {
      const featureId = readSessionFeatureId(file);
      if (!featureId || !wanted.has(featureId.toLowerCase())) continue;
      const session = readPiSessionFile(file);
      if (session) return session;
    }
  }
  return null;
}

/**
 * Resolve the model a follow-up message should use, preferring the model the
 * session last ran with.
 */
export function resolvePiSessionModel(
  session: PiSessionInfo | null
): { provider: string; modelId: string } | null {
  if (!session?.modelId) return null;
  return { provider: session.modelProvider || 'litellm', modelId: session.modelId };
}

/** How many sessions one search opens, newest first */
const SEARCH_MAX_SESSIONS = 300;
/** Hits counted per session before the UI shows "50+" */
const SEARCH_MAX_HITS = 50;
/** Characters of matched text kept on each side of the hit */
const SEARCH_SNIPPET_PAD = 60;

export interface PiConversationMatch {
  /** Card that was dispatched for this session, when the transcript says so */
  featureId: string | null;
  sessionId: string;
  filePath: string;
  cwd: string;
  /** Role of the first matched entry */
  role: 'user' | 'assistant' | 'toolResult' | 'other';
  /** Timestamp of the first matched entry */
  at: string | null;
  hitCount: number;
  snippet: string;
}

export interface PiConversationSearchResult {
  matches: PiConversationMatch[];
  /** Sessions actually opened for this query */
  scannedSessions: number;
  /** True when older sessions or further hits were left unread */
  truncated: boolean;
}

/**
 * Searchable text of one transcript entry.
 *
 * Tool arguments and results are included on purpose: a task is usually found by
 * the file it touched or the error it printed, not by the prompt.
 */
function entrySearchText(entry: PiSessionEntry | null): string | null {
  const message = entry?.type === 'message' ? entry.message : undefined;
  if (!message) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block?.text === 'string') parts.push(block.text);
    if (typeof block?.thinking === 'string') parts.push(block.thinking);
    if (typeof block?.name === 'string') {
      parts.push(block.name);
      if (block.arguments !== undefined) parts.push(JSON.stringify(block.arguments));
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function entryRole(entry: PiSessionEntry): PiConversationMatch['role'] {
  switch (entry.message?.role) {
    case 'user':
    case 'assistant':
    case 'toolResult':
      return entry.message.role;
    default:
      return 'other';
  }
}

function entryTimestamp(entry: PiSessionEntry): string | null {
  if (typeof entry.timestamp === 'string' && entry.timestamp) return entry.timestamp;
  const millis = entry.message?.timestamp;
  return typeof millis === 'number' && millis > 0 ? new Date(millis).toISOString() : null;
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SEARCH_SNIPPET_PAD);
  const end = Math.min(text.length, index + length + SEARCH_SNIPPET_PAD);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

/** Count hits in one transcript, keeping the first one for display */
async function searchSessionFile(
  filePath: string,
  needle: string
): Promise<PiConversationMatch | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header: { id?: string; cwd?: string } | null = null;
  let hitCount = 0;
  let first: { role: PiConversationMatch['role']; at: string | null; snippet: string } | null =
    null;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: PiSessionEntry;
      try {
        entry = JSON.parse(line) as PiSessionEntry;
      } catch {
        continue;
      }
      if (!header) {
        header = { id: entry.id, cwd: entry.cwd };
        continue;
      }
      const text = entrySearchText(entry);
      if (!text) continue;
      const index = text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      hitCount += 1;
      if (!first && hitCount <= SEARCH_MAX_HITS) {
        first = {
          role: entryRole(entry),
          at: entryTimestamp(entry),
          snippet: snippetAround(text, index, needle.length),
        };
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (!first || !header) return null;
  return {
    featureId: readSessionFeatureId(filePath),
    sessionId: header.id ?? path.basename(filePath),
    filePath,
    cwd: header.cwd ?? '',
    role: first.role,
    at: first.at,
    hitCount: Math.min(hitCount, SEARCH_MAX_HITS),
    snippet: first.snippet,
  };
}

/**
 * Find the task conversations that mention `query`.
 *
 * Every worktree of the project is searched, because a card's transcript stays
 * in the session directory of the worktree it ran in even after the card moved.
 * Newest sessions are read first and the scan stops at `limit` matches, so a
 * keyword that shows up everywhere still answers quickly.
 */
export async function searchPiConversations(
  projectPath: string,
  query: string,
  options: { limit?: number } = {}
): Promise<PiConversationSearchResult> {
  const needle = query.trim().toLowerCase();
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  if (!needle) return { matches: [], scannedSessions: 0, truncated: false };

  const files = listProjectSessionDirs(projectPath)
    .flatMap((dir) =>
      listJsonlFiles(dir).map((file) => {
        try {
          return { file, mtime: statSync(file).mtimeMs };
        } catch {
          return { file, mtime: 0 };
        }
      })
    )
    .sort((a, b) => b.mtime - a.mtime);
  const candidates = files.slice(0, SEARCH_MAX_SESSIONS);

  const matches: PiConversationMatch[] = [];
  // One row per card: a task that ran twenty times should not bury the others.
  const byFeature = new Map<string, PiConversationMatch>();
  const unstamped: PiConversationMatch[] = [];
  let scannedSessions = 0;
  for (const candidate of candidates) {
    scannedSessions += 1;
    const match = await searchSessionFile(candidate.file, needle);
    if (match?.featureId) {
      const existing = byFeature.get(match.featureId);
      if (existing)
        existing.hitCount = Math.min(existing.hitCount + match.hitCount, SEARCH_MAX_HITS);
      else byFeature.set(match.featureId, match);
    } else if (match) {
      unstamped.push(match);
    }
    if (byFeature.size + unstamped.length >= limit) break;
  }
  matches.push(...byFeature.values(), ...unstamped);
  // Newest first (ISO strings), so the most recent run of a task leads.
  matches.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

  return {
    matches,
    scannedSessions,
    truncated: files.length > candidates.length || matches.length >= limit,
  };
}
