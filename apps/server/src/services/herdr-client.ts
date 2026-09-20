/**
 * HerdrControlClient - JSON-RPC client for the herdr socket API.
 *
 * Herdr exposes every control operation as a JSON request over a unix domain
 * socket (`HERDR_SOCKET_PATH`, one socket per named session). This module is the
 * only place that talks to that socket; nothing else in Automaker should shell
 * out to `herdr` for control operations.
 *
 * Protocol notes (verified against herdr 0.8.2, protocol 20):
 * - One request per connection: the server replies to a request then closes the
 *   socket, so the client opens a fresh connection per call. Reusing a
 *   connection after a response yields EPIPE.
 * - `events.subscribe` is the exception: that connection stays open and streams
 *   newline-delimited `{ event, data }` messages until it is closed.
 * - Errors arrive as `{ id, error: { code, message } }` and the socket closes.
 * - A missing/stopped session answers with `server_not_running`; callers that
 *   need the session alive should use `ensureSession()` first.
 */

import { connect, type Socket } from 'net';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '@automaker/utils';

const logger = createLogger('HerdrClient');

/**
 * Session name used when no project is known.
 *
 * Automaker keeps one herdr session per project (the session name is the project
 * directory name, see `buildProjectSessionName`); this fallback is only for
 * callers that have no project at hand.
 */
export const FALLBACK_HERDR_SESSION_NAME = 'automaker';

/**
 * Session name for a project: its directory name, slugified.
 *
 * herdr turns a session name into a directory under the config dir, so the name
 * must stay in `[a-z0-9-]`. `default` is reserved by herdr for its own session.
 */
export function buildProjectSessionName(projectPath: string): string {
  const base = path.basename(path.resolve(projectPath)) || '';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  if (!slug || slug === 'default') {
    return 'am-' + (slug || FALLBACK_HERDR_SESSION_NAME);
  }
  return slug;
}

/** Request timeout for one-shot control calls */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** How long `agent.start` waits for interactive readiness */
const DEFAULT_AGENT_START_TIMEOUT_MS = 30_000;

/** How long a scheduled turn may run before the scheduler gives up waiting */
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** Env vars that describe the *caller's* pane; a control client must never inherit them */
export const HERDR_CONTROL_ENV_KEYS = [
  'HERDR_ENV',
  'HERDR_SOCKET_PATH',
  'HERDR_WORKSPACE_ID',
  'HERDR_TAB_ID',
  'HERDR_PANE_ID',
  'HERDR_BIN_PATH',
] as const;

/** Agent lifecycle states reported by herdr */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** Read sources supported by pane/agent reads */
export type HerdrReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';

export interface HerdrErrorBody {
  code: string;
  message: string;
}

/** Error thrown for a herdr API `error` response */
export class HerdrApiError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HerdrApiError';
  }
}

export interface HerdrAgentSessionInfo {
  agent: string;
  kind: string;
  source: string;
  value: string;
}

export interface HerdrAgentInfo {
  name: string | null;
  agent: string | null;
  agent_status: HerdrAgentStatus;
  agent_session?: HerdrAgentSessionInfo | null;
  cwd: string | null;
  foreground_cwd?: string | null;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused: boolean;
  interactive_ready?: boolean;
  /**
   * True while herdr is still bringing the agent up. `agent.start` can return
   * with this set, and while it is set the agent's *name* is not resolvable as
   * a target - callers must address it by pane id and wait for readiness.
   */
  launch_pending?: boolean;
  /** Monotonic counter bumped on every lifecycle transition (idle->working->idle) */
  state_change_seq?: number;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
}

export interface HerdrWorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: HerdrAgentStatus;
}

export interface HerdrTabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: HerdrAgentStatus;
}

export interface HerdrTabCreateResult {
  tab: HerdrTabInfo;
  root_pane: HerdrPaneInfo;
}

export interface HerdrPaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string | null;
  agent_status: HerdrAgentStatus;
  agent_session?: HerdrAgentSessionInfo | null;
  cwd: string | null;
  focused: boolean;
}

export interface HerdrWorkspaceCreateResult {
  workspace: HerdrWorkspaceInfo;
  tab: { tab_id: string; workspace_id: string };
  root_pane: HerdrPaneInfo;
}

export interface HerdrPaneSplitResult {
  pane: HerdrPaneInfo;
}

export interface HerdrAgentStartResult {
  agent: HerdrAgentInfo;
  argv: string[];
}

export interface HerdrPaneReadResult {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: HerdrReadSource;
  format: string;
  text: string;
  truncated?: boolean;
}

/** One streamed message from `events.subscribe` */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface HerdrClientOptions {
  /** Explicit socket path; defaults to the resolved session socket */
  socketPath?: string;
  /** herdr binary path; defaults to the resolved binary */
  binaryPath?: string;
  /** Session name used when resolving the socket */
  sessionName?: string;
  /** Per-request timeout */
  requestTimeoutMs?: number;
}

/**
 * Resolve the herdr executable path.
 *
 * Mirrors `resolveHerdrBinary()` in herdr-service but keeps the client
 * self-contained so it can be used without a TerminalService.
 */
export function resolveHerdrExecutable(): string | null {
  for (const key of ['HERDR_BIN', 'HERDR_BIN_PATH'] as const) {
    const configured = process.env[key]?.trim();
    if (configured && existsSync(configured)) return configured;
  }
  for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of [path.join(entry, 'herdr'), path.join(entry, 'herdr.exe')]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the base herdr config directory.
 *
 * herdr follows XDG: `$XDG_CONFIG_HOME/herdr`, else `~/.config/herdr`. The
 * `default` session lives directly in the base directory; every named session
 * gets `sessions/<name>/`.
 *
 * `env.HOME` wins over `os.homedir()` so the resolution matches what a spawned
 * child process would compute with the same environment.
 */
export function resolveHerdrConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, 'herdr');
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, '.config', 'herdr');
}

/** Resolve the API socket path for a session (mirrors herdr's own layout) */
export function resolveHerdrSocketPath(
  sessionName: string = FALLBACK_HERDR_SESSION_NAME,
  env: NodeJS.ProcessEnv = process.env
): string {
  const base = resolveHerdrConfigDir(env);
  if (sessionName === 'default') return path.join(base, 'herdr.sock');
  return path.join(base, 'sessions', sessionName, 'herdr.sock');
}

/** Clean environment for a control client or a spawned session server */
export function buildHerdrControlEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if ((HERDR_CONTROL_ENV_KEYS as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export class HerdrControlClient {
  private readonly socketPath: string;
  private readonly binaryPath: string | null;
  private readonly requestTimeoutMs: number;
  private subscriptions = new Set<Socket>();
  private nextId = 1;

  constructor(options: HerdrClientOptions = {}) {
    this.socketPath =
      options.socketPath ??
      resolveHerdrSocketPath(options.sessionName ?? FALLBACK_HERDR_SESSION_NAME);
    this.binaryPath = options.binaryPath ?? resolveHerdrExecutable();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Socket this client talks to */
  getSocketPath(): string {
    return this.socketPath;
  }

  /** Whether the socket file exists (a running server also needs a live socket) */
  socketExists(): boolean {
    return existsSync(this.socketPath);
  }

  /** Whether herdr is usable at all on this machine */
  isAvailable(): boolean {
    return this.binaryPath !== null;
  }

  /**
   * Send one request and return its `result`.
   *
   * Opens a dedicated connection: the herdr server closes the connection after
   * each reply, so connection reuse is not attempted.
   */
  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `am-${this.nextId++}`;
      const socket = connect(this.socketPath);
      let buffer = '';
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(new HerdrApiError('timeout', `herdr ${method} timed out after ${timeoutMs}ms`))
        );
      }, timeoutMs);

      socket.on('error', (error) => {
        const code =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'server_not_running'
            : 'socket_error';
        finish(() => reject(new HerdrApiError(code, `herdr ${method} failed: ${error.message}`)));
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        try {
          const parsed = JSON.parse(line) as {
            result?: T;
            error?: HerdrErrorBody;
          };
          if (parsed.error) {
            finish(() => reject(new HerdrApiError(parsed.error!.code, parsed.error!.message)));
          } else {
            finish(() => resolve(parsed.result as T));
          }
        } catch (error) {
          finish(() =>
            reject(
              new HerdrApiError(
                'invalid_response',
                `Could not parse herdr ${method} response: ${(error as Error).message}`
              )
            )
          );
        }
      });

      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /** True when the session's server is reachable */
  async isSessionRunning(): Promise<boolean> {
    try {
      await this.request('workspace.list');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the session's headless server if it is not already running.
   *
   * The server is spawned detached and unref'ed so it outlives the Automaker
   * process - the whole point of the session is that the work keeps running and
   * can be re-attached to later.
   */
  async ensureSession(): Promise<{ started: boolean; socketPath: string }> {
    if (!this.binaryPath) {
      throw new HerdrApiError(
        'herdr_missing',
        'herdr is not installed on this machine (install herdr or set HERDR_BIN)'
      );
    }
    if (await this.isSessionRunning()) {
      return { started: false, socketPath: this.socketPath };
    }

    const sessionName = path.basename(path.dirname(this.socketPath));
    const env = buildHerdrControlEnv();
    const child = spawn(this.binaryPath, ['--session', sessionName, 'server'], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();

    // Poll for readiness - the socket appears shortly after the process starts.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (await this.isSessionRunning()) {
        logger.info(`Started herdr session '${sessionName}' (${this.socketPath})`);
        return { started: true, socketPath: this.socketPath };
      }
    }
    throw new HerdrApiError(
      'session_start_timeout',
      `herdr session '${sessionName}' did not become reachable at ${this.socketPath}`
    );
  }

  // ---------------------------------------------------------------------------
  // Workspaces (one workspace == one Automaker feature/task)
  // ---------------------------------------------------------------------------

  async listWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
    const result = await this.request<{ workspaces: HerdrWorkspaceInfo[] }>('workspace.list');
    return result.workspaces ?? [];
  }

  /** Find a workspace by its label (labels are the task names) */
  async findWorkspaceByLabel(label: string): Promise<HerdrWorkspaceInfo | null> {
    const workspaces = await this.listWorkspaces();
    return workspaces.find((workspace) => workspace.label === label) ?? null;
  }

  async createWorkspace(options: {
    cwd: string;
    label: string;
    env?: Record<string, string>;
  }): Promise<HerdrWorkspaceCreateResult> {
    return this.request<HerdrWorkspaceCreateResult>('workspace.create', {
      cwd: options.cwd,
      label: options.label,
      env: options.env ?? {},
      focus: false,
    });
  }

  async renameWorkspace(workspaceId: string, label: string): Promise<void> {
    await this.request('workspace.rename', { workspace_id: workspaceId, label });
  }

  /** Look up one workspace by id; returns null when herdr no longer has it */
  async getWorkspace(workspaceId: string): Promise<HerdrWorkspaceInfo | null> {
    try {
      const result = await this.request<{ workspace: HerdrWorkspaceInfo }>('workspace.get', {
        workspace_id: workspaceId,
      });
      return result.workspace ?? null;
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === 'workspace_not_found') return null;
      throw error;
    }
  }

  /**
   * Focus a workspace for every attached client.
   *
   * Focus is server state, not per-client: a TUI that attaches later (or is
   * already attached) renders the focused workspace, which is how a deep link
   * lands the user on the pane it promised.
   */
  async focusWorkspace(workspaceId: string): Promise<HerdrWorkspaceInfo> {
    const result = await this.request<{ workspace: HerdrWorkspaceInfo }>('workspace.focus', {
      workspace_id: workspaceId,
    });
    return result.workspace;
  }

  /** Focus the workspace, tab and pane an agent lives in (target: name or pane id) */
  async focusAgent(target: string): Promise<HerdrAgentInfo> {
    const result = await this.request<{ agent: HerdrAgentInfo }>('agent.focus', { target });
    return result.agent;
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.request('workspace.close', { workspace_id: workspaceId });
  }

  // ---------------------------------------------------------------------------
  // Tabs (one tab == one Automaker task inside a worktree's workspace)
  // ---------------------------------------------------------------------------

  async listTabs(workspaceId: string): Promise<HerdrTabInfo[]> {
    const result = await this.request<{ tabs: HerdrTabInfo[] }>('tab.list', {
      workspace_id: workspaceId,
    });
    return result.tabs ?? [];
  }

  /** Look up one tab by id; returns null when herdr no longer has it */
  async getTab(tabId: string): Promise<HerdrTabInfo | null> {
    try {
      const result = await this.request<{ tab: HerdrTabInfo }>('tab.get', { tab_id: tabId });
      return result.tab ?? null;
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === 'tab_not_found') return null;
      throw error;
    }
  }

  /** Find a tab by its label inside one workspace (labels are the task names) */
  async findTabByLabel(workspaceId: string, label: string): Promise<HerdrTabInfo | null> {
    const tabs = await this.listTabs(workspaceId);
    return tabs.find((tab) => tab.label === label) ?? null;
  }

  async createTab(options: {
    workspaceId: string;
    label: string;
    cwd?: string | null;
    env?: Record<string, string>;
  }): Promise<HerdrTabCreateResult> {
    return this.request<HerdrTabCreateResult>('tab.create', {
      workspace_id: options.workspaceId,
      label: options.label,
      cwd: options.cwd ?? null,
      env: options.env ?? {},
      focus: false,
    });
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.request('tab.rename', { tab_id: tabId, label });
  }

  /** Focus a tab for every attached client (deep links need this after the workspace) */
  async focusTab(tabId: string): Promise<HerdrTabInfo> {
    const result = await this.request<{ tab: HerdrTabInfo }>('tab.focus', { tab_id: tabId });
    return result.tab;
  }

  async closeTab(tabId: string): Promise<void> {
    await this.request('tab.close', { tab_id: tabId });
  }

  // ---------------------------------------------------------------------------
  // Panes
  // ---------------------------------------------------------------------------

  /**
   * Split a pane, returning the new pane.
   *
   * `target_pane_id` must be explicit: the `--current` shorthand only works
   * from inside a herdr pane, which the Automaker server is not.
   */
  async splitPane(options: {
    targetPaneId: string;
    direction: 'right' | 'down' | 'left' | 'up';
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<HerdrPaneInfo> {
    const result = await this.request<HerdrPaneSplitResult>('pane.split', {
      target_pane_id: options.targetPaneId,
      direction: options.direction,
      cwd: options.cwd,
      env: options.env ?? {},
      focus: false,
    });
    return result.pane;
  }

  async listPanes(workspaceId: string): Promise<HerdrPaneInfo[]> {
    const result = await this.request<{ panes: HerdrPaneInfo[] }>('pane.list', {
      workspace_id: workspaceId,
    });
    return result.panes ?? [];
  }

  async readPane(
    paneId: string,
    options: { source?: HerdrReadSource; lines?: number } = {}
  ): Promise<HerdrPaneReadResult> {
    const result = await this.request<{ read: HerdrPaneReadResult }>('pane.read', {
      pane_id: paneId,
      source: options.source ?? 'recent_unwrapped',
      lines: options.lines,
    });
    return result.read;
  }

  async closePane(paneId: string): Promise<void> {
    await this.request('pane.close', { pane_id: paneId });
  }

  // ---------------------------------------------------------------------------
  // Agents (one agent == one pi process: leader plans, workers execute)
  // ---------------------------------------------------------------------------

  async listAgents(): Promise<HerdrAgentInfo[]> {
    const result = await this.request<{ agents: HerdrAgentInfo[] }>('agent.list');
    return result.agents ?? [];
  }

  async getAgent(target: string): Promise<HerdrAgentInfo> {
    const result = await this.request<{ agent: HerdrAgentInfo }>('agent.get', { target });
    return result.agent;
  }

  /**
   * Start an agent in an existing shell pane.
   *
   * `args` are passed to the CLI verbatim, which is how the leader/worker model
   * selection reaches pi (`--provider litellm --model leader`).
   */
  async startAgent(options: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }): Promise<HerdrAgentStartResult> {
    // herdr only waits for interactive readiness when `timeout_ms` is present;
    // without it the call returns immediately with `launch_pending: true` and a
    // name that cannot be used as a target yet.
    const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS;
    return this.request<HerdrAgentStartResult>(
      'agent.start',
      {
        name: options.name,
        kind: options.kind,
        pane_id: options.paneId,
        args: options.args ?? [],
        timeout_ms: timeoutMs,
      },
      timeoutMs + 5_000
    );
  }

  /**
   * Submit a prompt to an agent.
   *
   * Without `wait` this returns as soon as the text is delivered, which is what
   * a scheduler wants: it keeps its own bookkeeping instead of blocking a
   * socket for the whole turn.
   */
  async promptAgent(options: {
    target: string;
    text: string;
    wait?: { until?: HerdrAgentStatus[]; timeoutMs?: number };
  }): Promise<HerdrAgentInfo> {
    const result = await this.request<{ agent: HerdrAgentInfo }>(
      'agent.prompt',
      {
        target: options.target,
        text: options.text,
        wait: options.wait
          ? { until: options.wait.until, timeout_ms: options.wait.timeoutMs }
          : null,
      },
      options.wait?.timeoutMs ? options.wait.timeoutMs + 5_000 : this.requestTimeoutMs
    );
    return result.agent;
  }

  /** Wait for an agent to reach one of the requested states */
  async waitForAgent(options: {
    target: string;
    until?: HerdrAgentStatus[];
    timeoutMs?: number;
  }): Promise<HerdrAgentInfo> {
    const result = await this.request<{ agent: HerdrAgentInfo }>(
      'agent.wait',
      {
        target: options.target,
        until: options.until ?? ['idle', 'done', 'blocked'],
        timeout_ms: options.timeoutMs,
      },
      (options.timeoutMs ?? this.requestTimeoutMs) + 5_000
    );
    return result.agent;
  }

  /**
   * Wait until an agent can actually receive input.
   *
   * `agent.start` is supposed to return only when the agent is ready, but in
   * practice it can return with `launch_pending: true`. Polling on the pane id
   * (which always resolves, unlike the agent name) is the reliable gate.
   */
  async waitForAgentReady(
    paneId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<HerdrAgentInfo> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    let last: HerdrAgentInfo | undefined;

    while (Date.now() < deadline) {
      try {
        last = await this.getAgent(paneId);
        if (last.interactive_ready && !last.launch_pending) return last;
      } catch (error) {
        // Between pane creation and detection the pane may not have an agent
        // yet; keep polling until the deadline.
        if (error instanceof HerdrApiError && error.code === 'timeout') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new HerdrApiError(
      'agent_not_ready',
      'agent in pane ' + paneId + ' was not ready within ' + timeoutMs + 'ms'
    );
  }

  /**
   * Submit a prompt, then wait for the turn to settle by watching the pane's
   * lifecycle counter.
   *
   * This is deliberately preferred over `agent prompt --wait`: the built-in wait
   * requires an *observed state change within 5s of submission*, which a slow
   * first token can violate even though the prompt was delivered fine. Polling
   * `state_change_seq` ourselves has no such race.
   */
  async promptAndWait(
    paneId: string,
    text: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<{ agent: HerdrAgentInfo; timedOut: boolean }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 500;

    const before = await this.getAgent(paneId);
    const baselineSeq = before.state_change_seq ?? 0;
    await this.promptAgent({ target: paneId, text });

    const deadline = Date.now() + timeoutMs;
    let last = before;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      last = await this.getAgent(paneId);
      const seq = last.state_change_seq ?? 0;
      const settled =
        last.agent_status === 'idle' ||
        last.agent_status === 'done' ||
        last.agent_status === 'blocked';
      if (seq > baselineSeq && settled) {
        return { agent: last, timedOut: false };
      }
    }
    return { agent: last, timedOut: true };
  }

  async readAgent(
    target: string,
    options: { source?: HerdrReadSource; lines?: number } = {}
  ): Promise<HerdrPaneReadResult> {
    const result = await this.request<{ read: HerdrPaneReadResult }>('agent.read', {
      target,
      source: options.source ?? 'recent_unwrapped',
      lines: options.lines,
    });
    return result.read;
  }

  // ---------------------------------------------------------------------------
  // Integrations
  // ---------------------------------------------------------------------------

  /**
   * Install a herdr agent integration (e.g. `pi`).
   *
   * The pi integration is what makes `agent_status` authoritative: without it
   * herdr falls back to screen heuristics and can report a working pi as `idle`.
   */
  async installIntegration(target: string): Promise<string[]> {
    const result = await this.request<{ messages?: string[] }>('integration.install', { target });
    return result.messages ?? [];
  }

  /** Report which integrations are installed */
  async agentManifests(): Promise<string> {
    try {
      const result = await this.request<Record<string, unknown>>('server.agent_manifests');
      return JSON.stringify(result);
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to herdr events.
   *
   * The returned function closes the subscription. `onError` is called if the
   * stream drops, so callers can reconnect instead of silently going stale.
   */
  subscribe(
    subscriptions: Array<Record<string, unknown>>,
    onEvent: (event: HerdrEvent) => void,
    onError?: (error: Error) => void
  ): () => void {
    const socket = connect(this.socketPath);
    let buffer = '';
    let closed = false;

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { event?: string; data?: Record<string, unknown> };
          if (parsed.event && parsed.data) {
            onEvent({ event: parsed.event, data: parsed.data });
          }
        } catch (error) {
          logger.debug(`Ignoring unparsable herdr event: ${(error as Error).message}`);
        }
      }
    });

    socket.on('error', (error) => {
      if (closed) return;
      closed = true;
      this.subscriptions.delete(socket);
      onError?.(error);
    });

    socket.on('close', () => {
      this.subscriptions.delete(socket);
      if (!closed) {
        closed = true;
        onError?.(new Error('herdr event subscription closed'));
      }
    });

    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ id: `sub-${this.nextId++}`, method: 'events.subscribe', params: { subscriptions } })}\n`
      );
    });

    this.subscriptions.add(socket);

    return () => {
      closed = true;
      this.subscriptions.delete(socket);
      socket.destroy();
    };
  }

  /** Close every open subscription */
  dispose(): void {
    for (const socket of this.subscriptions) socket.destroy();
    this.subscriptions.clear();
  }
}
