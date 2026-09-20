/**
 * Herdr Service
 *
 * Herdr is the terminal workspace manager that supervises the CLI agents a
 * worktree runs (workspaces -> tabs -> panes -> agents). Automaker keeps one
 * named herdr session per project, so every conversation of every worktree in
 * that project lives in the same multiplexer session: a worktree is a space, a
 * task is a tab inside it.
 *
 * This service currently covers the "attach" half of that model: it hands the
 * browser an xterm.js PTY that runs `herdr --session <name>`, which is the same
 * TUI a user would get in their own terminal. The control half (workspace and
 * agent lifecycle over the herdr socket API) builds on the same primitives:
 * see docs/herdr-session-architecture.md.
 */

import { existsSync, accessSync, constants as fsConstants } from 'fs';
import * as path from 'path';
import { createLogger } from '@automaker/utils';
import type { TerminalService } from './terminal-service.js';
import { buildProjectSessionName } from './herdr-client.js';

const logger = createLogger('Herdr');

/**
 * Herdr control variables.
 *
 * A herdr client refuses to start a nested TUI when it inherits the pane it is
 * running in, and `HERDR_SOCKET_PATH` would pin the client to the wrong session,
 * so an attach session must not inherit any of them.
 */
export const HERDR_CONTROL_ENV_KEYS = [
  'HERDR_ENV',
  'HERDR_SOCKET_PATH',
  'HERDR_WORKSPACE_ID',
  'HERDR_TAB_ID',
  'HERDR_PANE_ID',
  'HERDR_BIN_PATH',
] as const;

/** Environment overrides that point at the herdr binary */
const HERDR_BINARY_ENV_KEYS = ['HERDR_BIN', 'HERDR_BIN_PATH'] as const;

let cachedBinary: string | null = null;

/**
 * Resolve the herdr binary.
 *
 * Explicit configuration wins, then PATH lookup. The result is cached because
 * this runs on every card deep-link and the answer does not change while the
 * process lives.
 */
export function resolveHerdrBinary(): string | null {
  if (cachedBinary) return cachedBinary;

  const candidates: string[] = [];
  for (const key of HERDR_BINARY_ENV_KEYS) {
    const configured = process.env[key]?.trim();
    if (configured) candidates.push(configured);
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(path.join(entry, 'herdr'));
    if (process.platform === 'win32') {
      candidates.push(path.join(entry, 'herdr.exe'));
    }
  }

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      accessSync(candidate, fsConstants.X_OK);
      cachedBinary = candidate;
      return cachedBinary;
    } catch {
      // Not executable or not readable - keep looking.
    }
  }

  logger.info('herdr binary not found; herdr entry points are unavailable');
  return null;
}

/** Whether herdr can be launched on this machine */
export function isHerdrAvailable(): boolean {
  return resolveHerdrBinary() !== null;
}

/** Reset the cached binary lookup (used by tests) */
export function resetHerdrBinaryCache(): void {
  cachedBinary = null;
}

/**
 * Build the herdr session name for a project.
 *
 * One session per project (named after its directory, e.g. `vibe-llmops`) holds
 * every worktree's space. Keeping it stable across restarts is what lets herdr
 * re-attach instead of rebuilding the layout.
 */
export function buildHerdrSessionName(projectPath: string): string {
  return buildProjectSessionName(projectPath);
}

/** Arguments for the attach client that renders herdr's TUI */
export function buildHerdrAttachArgs(sessionName: string): string[] {
  return ['--session', sessionName];
}

/** Stable terminal session reuse key for a project's herdr session */
export function buildHerdrSessionKey(sessionName: string): string {
  return `herdr:${sessionName}`;
}

export interface HerdrAttachOptions {
  projectPath: string;
  workDir: string;
  /**
   * Session to attach to. Defaults to the project's session (the project
   * directory name).
   */
  sessionName?: string;
  cols?: number;
  rows?: number;
}

export interface HerdrAttachResult {
  sessionName: string;
  terminalSessionId: string;
  reused: boolean;
}

export class HerdrService {
  private attachments = new Map<string, Promise<HerdrAttachResult>>();
  constructor(private terminalService: TerminalService) {}

  /**
   * Get (or create) the PTY that renders the project's herdr session.
   *
   * The session is keyed by herdr session name so repeated clicks reuse the
   * same attach instead of stacking TUI clients.
   */
  async attachWorktreeSession(options: HerdrAttachOptions): Promise<HerdrAttachResult> {
    const key = options.sessionName?.trim() || buildHerdrSessionName(options.projectPath);
    const pending = this.attachments.get(key);
    if (pending) return pending;
    const operation = this.createAttachment(options);
    this.attachments.set(key, operation);
    try {
      return await operation;
    } finally {
      this.attachments.delete(key);
    }
  }

  private async createAttachment(options: HerdrAttachOptions): Promise<HerdrAttachResult> {
    const binary = resolveHerdrBinary();
    if (!binary) {
      throw new Error('herdr is not installed on this machine (install herdr or set HERDR_BIN)');
    }

    const sessionName = options.sessionName?.trim() || buildHerdrSessionName(options.projectPath);
    const key = buildHerdrSessionKey(sessionName);
    const existing = this.terminalService.getSessionByKey(key);
    if (existing) {
      return { sessionName, terminalSessionId: existing.id, reused: true };
    }

    const session = await this.terminalService.createSession({
      cwd: options.workDir,
      command: binary,
      args: buildHerdrAttachArgs(sessionName),
      key,
      envExcludeKeys: [...HERDR_CONTROL_ENV_KEYS],
      cols: options.cols,
      rows: options.rows,
    });

    if (!session) {
      throw new Error('Could not start a herdr terminal session (session limit reached?)');
    }

    return { sessionName, terminalSessionId: session.id, reused: false };
  }

  /** Kill the attach PTY for a worktree, if one is running */
  stopWorktreeSession(sessionName: string): boolean {
    const session = this.terminalService.getSessionByKey(buildHerdrSessionKey(sessionName));
    if (!session) return false;
    return this.terminalService.killSession(session.id);
  }
}

let herdrService: HerdrService | null = null;

export function getHerdrService(terminalService: TerminalService): HerdrService {
  if (!herdrService) {
    herdrService = new HerdrService(terminalService);
  }
  return herdrService;
}
