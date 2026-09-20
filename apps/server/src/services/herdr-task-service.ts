/**
 * HerdrTaskService - maps Automaker tasks onto herdr topology.
 *
 * Topology (one session for the whole machine, one workspace per worktree, one
 * tab per task):
 *
 *   session: "automaker"
 *   workspace wN: "aip-114878-dodo"      <- a worktree (branch) everyone shares
 *     tab t1: "AIP-114878: ..."          <- the feature / task
 *       pane p1: pi (leader)             <- plans, decomposes, reviews
 *       pane p2: pi (worker 1)           <- executes subtask 1
 *     tab t2: "AIP-115065: ..."          <- another task in the same worktree
 *       pane p1: pi (leader)
 *
 * The worktree is the unit that shares code, cwd and pi session directory, so it
 * owns the space; the task owns a tab inside it and its agents live in that
 * tab's panes. Every worker gets its own pane and its own pi process started
 * with `--model worker`.
 *
 * All control flow goes through HerdrControlClient (the socket API); nothing
 * here spawns a herdr CLI process.
 */

import * as path from 'path';
import { createHash } from 'node:crypto';
import { createLogger } from '@automaker/utils';
import {
  findPiSession,
  findPiSessionForFeature,
  findPiSessionForFeatureInProject,
  listPiSessionFiles,
  readSessionFeatureId,
  resolvePiSessionModel,
  type PiSessionInfo,
} from './pi-session-store.js';
import {
  readAgentTranscript,
  transcriptToText,
  type HerdrAgentTranscript,
} from './herdr-transcript.js';
import {
  FALLBACK_HERDR_SESSION_NAME,
  HerdrApiError,
  HerdrControlClient,
  buildProjectSessionName,
  type HerdrAgentInfo,
  type HerdrAgentStatus,
  type HerdrTabInfo,
  type HerdrWorkspaceInfo,
} from './herdr-client.js';

const logger = createLogger('HerdrTaskService');

/** herdr agent kind for the pi CLI */
export const HERDR_PI_KIND = 'pi';

/** LiteLLM model group the leader pane runs on */
export const HERDR_LEADER_MODEL = 'leader';

/** LiteLLM model group the worker panes run on */
export const HERDR_WORKER_MODEL = 'worker';

/**
 * Legacy agent name for a task's planning agent.
 *
 * herdr agent names are unique per *session*, not per workspace, so this name
 * could only ever address one task. Workspaces carry their own scoped names now
 * (see `buildLeaderAgentName`); the old name is still recognised so workspaces
 * created before that change keep working.
 */
export const HERDR_LEADER_AGENT_NAME = 'leader';

/** Upper bound on worker panes per task, keeping the layout usable */
export const MAX_WORKERS_PER_TASK = 8;

export interface HerdrTaskAgent {
  name: string;
  role: 'leader' | 'worker';
  paneId: string;
  model: string;
  /** Index of the subtask this worker owns (absent for the leader) */
  subtaskIndex?: number;
  lastStatus: HerdrAgentStatus;
}

/** Where an attaching client should land for a task's conversation */
export interface HerdrConversationTarget {
  workspaceId: string;
  tabId: string;
  /** Pane of the task's pi agent, when one is running (or was restored) */
  paneId: string | null;
  /** Pane to show even when no agent could be started */
  rootPaneId: string;
  /** True when the worktree's workspace had to be created for this deep link */
  createdWorkspace: boolean;
  /** True when a new tab had to be created for this task */
  createdTab: boolean;
  /** True when this call started the pi agent */
  startedAgent: boolean;
  /** Pi session id the restored agent resumed, when there was one on disk */
  resumedSessionId: string | null;
  /** Pi session id the tab's agent is running now (resumed or freshly created) */
  sessionId: string | null;
}

/** One card that belongs in a worktree's space */
export interface HerdrTaskTabRequest {
  /** Strings that identify the card in the worktree's pi sessions */
  taskKeys: string[];
  /** Tab label (the card's title) */
  title: string;
  /** Tab the card already owns, when it is known */
  tabId?: string | null;
  providerSessionId?: string | null;
}

/** Result of placing (and optionally rehydrating) one card in a space */
export interface HerdrTaskTabResult {
  taskKeys: string[];
  tabId: string;
  createdTab: boolean;
  paneId: string | null;
  startedAgent: boolean;
  resumedSessionId: string | null;
  sessionId: string | null;
}

/** herdr rejects agent names outside `[a-z][a-z0-9_-]{0,31}` */
function sanitizeAgentScope(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

/**
 * Stable agent name for a task's leader.
 *
 * Agent names must be unique across the whole herdr session, and every task of
 * every worktree shares one session, so the tab id is part of the name
 * (`w3:t2` -> `w3-t2-leader`).
 */
export function buildLeaderAgentName(tabId: string): string {
  return sanitizeAgentScope(tabId) + '-leader';
}

/** Stable worker agent name: `w3-t2-worker-1`, `w3-t2-worker-2`, ... */
export function buildWorkerAgentName(tabId: string, index: number): string {
  return sanitizeAgentScope(tabId) + '-worker-' + (index + 1);
}

/**
 * Whether an agent name is this task's leader.
 *
 * Names written by earlier builds are still recognised: `<workspace>-leader`
 * (when a workspace was one task) and the bare `leader`.
 */
export function isLeaderAgentName(name: string | null | undefined, tabId: string): boolean {
  if (!name) return false;
  const workspaceId = tabId.split(':')[0];
  return (
    name === buildLeaderAgentName(tabId) ||
    name === workspaceId + '-leader' ||
    name === HERDR_LEADER_AGENT_NAME
  );
}

/**
 * Turn a feature/task title into a tab label.
 *
 * herdr labels are free text, but they are also what the user sees in the
 * sidebar, so collapse whitespace and trim to a readable length.
 */
export function buildTabLabel(taskName: string): string {
  const normalized = taskName.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? normalized.slice(0, 77) + '...' : normalized;
}

/**
 * Workspace label for a worktree: the directory name
 * (`.../.worktrees/aip-114878-dodo` -> `aip-114878-dodo`). Features that run in
 * the project itself get the project directory name, which is the same identity
 * rule.
 */
export function buildWorktreeWorkspaceLabel(workDir: string): string {
  const base = path.basename(path.resolve(workDir)) || 'workspace';
  return base.length > 80 ? base.slice(0, 80) : base;
}

/**
 * Pi session id encoded in a session file name.
 *
 * pi names the file `<timestamp>_<uuid>.jsonl`, and herdr reports that path as
 * the agent's session. The id is what `pi --session` accepts as a target, so it
 * is what Automaker persists per card.
 */
export function piSessionIdFromFile(sessionFile: string | null | undefined): string | null {
  if (!sessionFile) return null;
  const base = path.basename(sessionFile).replace(/\.jsonl$/, '');
  const separator = base.indexOf('_');
  return separator >= 0 ? base.slice(separator + 1) : null;
}

/**
 * The pi conversation that belongs to one card, when it can be identified.
 *
 * A worktree's session directory holds every conversation that ran there, so
 * "the newest one" is only a last resort:
 *
 * 1. the session id the card already persists wins;
 * 2. otherwise the session that was dispatched for this card (`**Feature ID:**`
 *    marker Automaker stamps into every dispatched prompt) in this worktree, then
 *    anywhere in the project - a card that moved between worktrees keeps its
 *    conversation in the directory it ran in;
 * 3. otherwise the only session, when the worktree never ran anything else.
 *
 * Returning null means "start a fresh conversation" rather than resuming a
 * sibling task's.
 */
export function resolveTaskPiSession(
  workDir: string,
  options: {
    providerSessionId?: string | null;
    taskKeys?: string[];
    /** Project root, used to look outside the card's current worktree */
    projectPath?: string | null;
  } = {}
): PiSessionInfo | null {
  const keys = (options.taskKeys ?? []).map((key) => key.toLowerCase());

  if (options.providerSessionId) {
    const byId = findPiSession(workDir, options.providerSessionId);
    if (byId) {
      // A pin written by an older build (or by a mis-match) can point at another
      // card's conversation. When the session carries a dispatch marker, only a
      // matching one is trusted; sessions without a marker are taken at face
      // value, because the pin is Automaker's own record.
      const marker = readSessionFeatureId(byId.filePath);
      if (!marker || keys.includes(marker.toLowerCase())) return byId;
      logger.warn(
        'Ignoring pinned pi session ' +
          options.providerSessionId +
          ' for this card: it belongs to ' +
          marker
      );
    }
  }

  const byMarker =
    findPiSessionForFeature(workDir, options.taskKeys ?? []) ??
    (options.projectPath
      ? findPiSessionForFeatureInProject(options.projectPath, options.taskKeys ?? [])
      : null);
  if (byMarker) return byMarker;

  if (keys.length || options.providerSessionId) return null;
  return listPiSessionFiles(workDir).length === 1 ? findPiSession(workDir) : null;
}

export class HerdrTaskService {
  private conversationLocks = new Map<string, Promise<void>>();
  constructor(
    private client: HerdrControlClient = new HerdrControlClient({
      sessionName: FALLBACK_HERDR_SESSION_NAME,
    })
  ) {}

  /** The underlying control client (exposed for status/telemetry) */
  getClient(): HerdrControlClient {
    return this.client;
  }

  /** Whether this project's session is reachable right now */
  async isAvailable(): Promise<boolean> {
    if (!this.client.isAvailable()) return false;
    return this.client.isSessionRunning();
  }

  /**
   * Ensure the worktree's workspace (the herdr "space") exists.
   *
   * One space per worktree: the label is the worktree directory name, the cwd is
   * the worktree itself, and every task that shares that branch works inside it.
   * A workspace id persisted on the feature is only trusted when it really is
   * the one for this worktree (ids are session-local and a stale id from another
   * session could point at an unrelated space).
   */
  async ensureWorktreeWorkspace(options: {
    workDir: string;
    workspaceId?: string | null;
    env?: Record<string, string>;
  }): Promise<{ workspace: HerdrWorkspaceInfo; created: boolean }> {
    await this.client.ensureSession();
    const label = buildWorktreeWorkspaceLabel(options.workDir);

    if (options.workspaceId) {
      const persisted = await this.client.getWorkspace(options.workspaceId);
      if (persisted && (await this.workspaceMatchesWorkDir(persisted, options.workDir))) {
        return { workspace: persisted, created: false };
      }
    }

    const existing = await this.client.findWorkspaceByLabel(label);
    if (existing) {
      return { workspace: existing, created: false };
    }

    const created = await this.client.createWorkspace({
      cwd: options.workDir,
      label,
      env: options.env,
    });
    logger.info(
      'Created herdr workspace ' +
        created.workspace.workspace_id +
        " ('" +
        label +
        "') for worktree " +
        options.workDir
    );
    return { workspace: created.workspace, created: true };
  }

  /** Whether a workspace really covers this worktree (same cwd or same label) */
  private async workspaceMatchesWorkDir(
    workspace: HerdrWorkspaceInfo,
    workDir: string
  ): Promise<boolean> {
    if (workspace.label === buildWorktreeWorkspaceLabel(workDir)) return true;
    const panes = await this.client.listPanes(workspace.workspace_id);
    return panes.some((pane) => path.resolve(pane.cwd ?? '') === path.resolve(workDir));
  }

  /**
   * Ensure the task's tab inside the worktree's workspace.
   *
   * Tab labels are the task titles, so re-opening a card finds its own tab
   * again. `adoptRootTab` exists for spaces written by an older build (one space
   * per task): the space's root tab already is this task's conversation, so it is
   * renamed and adopted instead of leaving the pi pane orphaned in a second tab.
   */
  async ensureTaskTab(options: {
    workspaceId: string;
    taskName: string;
    taskId?: string;
    workDir: string;
    tabId?: string | null;
    adoptRootTab?: boolean;
    env?: Record<string, string>;
  }): Promise<{ tab: HerdrTabInfo; created: boolean; rootPaneId: string }> {
    const ownerKey = options.taskId
      ? createHash('sha256').update(options.taskId).digest('hex').slice(0, 12)
      : null;
    const label = ownerKey
      ? `${buildTabLabel(options.taskName).slice(0, 62)} [${ownerKey}]`
      : buildTabLabel(options.taskName);

    if (options.tabId) {
      const persisted = await this.client.getTab(options.tabId);
      const persistedOwner = persisted?.label.match(/\[([a-f0-9]{12})\]$/)?.[1];
      if (
        persisted &&
        persisted.workspace_id === options.workspaceId &&
        (!ownerKey || !persistedOwner || persistedOwner === ownerKey)
      ) {
        // The tab this card opened before: keep its label in sync with the card
        // (a rename here also repairs tabs that a legacy card adopted by mistake).
        if (persisted.label !== label) {
          await this.client.renameTab(persisted.tab_id, label);
          persisted.label = label;
        }
        return {
          tab: persisted,
          created: false,
          rootPaneId: await this.firstPaneOfTab(persisted.workspace_id, persisted.tab_id),
        };
      }
    }

    const existing = await this.client.findTabByLabel(options.workspaceId, label);
    if (existing) {
      return {
        tab: existing,
        created: false,
        rootPaneId: await this.firstPaneOfTab(options.workspaceId, existing.tab_id),
      };
    }

    if (options.adoptRootTab) {
      const tabs = await this.client.listTabs(options.workspaceId);
      const only = tabs.length === 1 ? tabs[0] : null;
      if (only) {
        if (only.label !== label) {
          await this.client.renameTab(only.tab_id, label);
        }
        logger.info(
          'Adopted herdr tab ' + only.tab_id + " as '" + label + "' (root tab of the space)"
        );
        return {
          tab: { ...only, label },
          created: false,
          rootPaneId: await this.firstPaneOfTab(options.workspaceId, only.tab_id),
        };
      }
    }

    const created = await this.client.createTab({
      workspaceId: options.workspaceId,
      label,
      cwd: options.workDir,
      env: options.env,
    });
    return { tab: created.tab, created: true, rootPaneId: created.root_pane.pane_id };
  }

  /** Root pane of a tab (herdr always keeps at least one pane per tab) */
  private async firstPaneOfTab(workspaceId: string, tabId: string): Promise<string> {
    const panes = await this.client.listPanes(workspaceId);
    return panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? tabId + ':p1';
  }

  /**
   * Start the leader agent for a task.
   *
   * The agent runs in the task tab's root pane and its name is scoped by the tab
   * (`w3-t2-leader`), because herdr only guarantees uniqueness per session.
   */
  async startLeader(options: { rootPaneId: string; tabId: string }): Promise<HerdrAgentInfo> {
    await this.client.startAgent({
      name: buildLeaderAgentName(options.tabId),
      kind: HERDR_PI_KIND,
      paneId: options.rootPaneId,
      args: ['--provider', 'litellm', '--model', HERDR_LEADER_MODEL],
    });
    // Do not trust the start response's status: it can report `unknown` with
    // `launch_pending: true`. Poll the pane until the agent really accepts input.
    return this.client.waitForAgentReady(options.rootPaneId);
  }

  /**
   * Make a task's conversation visible (again) inside herdr.
   *
   * herdr restores layout, not agent processes: after a server restart (or for a
   * task written by an older Automaker build) the task's tab exists at best as a
   * plain shell. This brings the conversation back:
   *
   * 1. resolve the worktree's space (persisted id, then label, then create);
   * 2. resolve the task's tab inside it (persisted id, then label, then create);
   * 2. if no pi agent occupies the pane, start one that *resumes the pi session
   *    the worktree already has on disk*, so the old conversation is on screen
   *    instead of a fresh prompt;
   * 3. focus the workspace, tab and agent, because focus - not the attach order -
   *    is what decides which pane an attaching client lands on.
   */
  async restoreConversation(options: {
    taskName: string;
    workDir: string;
    workspaceId?: string | null;
    tabId?: string | null;
    /** Pi session this card already owns, when it is known */
    providerSessionId?: string | null;
    /** Strings that identify the card in the worktree's pi sessions */
    taskKeys?: string[];
    /** Project root, so the card's conversation is also found in old worktrees */
    projectPath?: string | null;
    env?: Record<string, string>;
    /** Execution starts a fresh interactive process over the authoritative transcript. */
    executionArgs?: string[];
  }): Promise<HerdrConversationTarget> {
    const key = `${options.workDir}:${options.taskKeys?.[0] ?? options.taskName}`;
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    this.conversationLocks.set(key, current);
    await previous;
    // Let the promise above install its release callback before entering the critical section.
    await Promise.resolve();
    try {
      return await this.restoreConversationUnlocked(options);
    } finally {
      release();
      if (this.conversationLocks.get(key) === current) this.conversationLocks.delete(key);
    }
  }

  private async restoreConversationUnlocked(options: {
    taskName: string;
    workDir: string;
    workspaceId?: string | null;
    tabId?: string | null;
    providerSessionId?: string | null;
    taskKeys?: string[];
    projectPath?: string | null;
    env?: Record<string, string>;
    executionArgs?: string[];
  }): Promise<HerdrConversationTarget> {
    const { workspace, created: createdWorkspace } = await this.ensureWorktreeWorkspace({
      workDir: options.workDir,
      workspaceId: options.workspaceId,
      env: options.env,
    });

    // The root tab is this task's only when the space was just created for it (so
    // it is still empty) or when the space itself is a legacy one-space-per-task
    // space (its label is this task's title). A worktree space holds many cards,
    // so "I persisted this workspace id" must NOT let a card claim its root tab.
    const legacyTaskSpace = workspace.label === buildTabLabel(options.taskName);
    const adoptRootTab = !options.tabId && (createdWorkspace || legacyTaskSpace);
    const taskTab = await this.ensureTaskTab({
      workspaceId: workspace.workspace_id,
      taskName: options.taskName,
      taskId: options.taskKeys?.[0],
      workDir: options.workDir,
      tabId: options.tabId,
      adoptRootTab,
      env: options.env,
    });
    const { tab, rootPaneId } = taskTab;

    const agents = await this.listTaskAgents(workspace.workspace_id, tab.tab_id);
    // Prefer the leader pane: a workspace that already ran a plan also has
    // worker panes, and the conversation the card promises is the leader's.
    let agent =
      agents.find(
        (candidate) =>
          candidate.agent === HERDR_PI_KIND && isLeaderAgentName(candidate.name, tab.tab_id)
      ) ??
      agents.find((candidate) => candidate.agent === HERDR_PI_KIND) ??
      null;
    let startedAgent = false;
    let resumedSessionId: string | null = null;

    const authoritative = resolveTaskPiSession(options.workDir, {
      providerSessionId: options.providerSessionId,
      taskKeys: options.taskKeys,
      projectPath: options.projectPath,
    });
    const wrongTranscript =
      !!agent && !!authoritative && agent.agent_session?.value !== authoritative.filePath;
    if (agent && (options.executionArgs || wrongTranscript)) {
      if (agent.agent_status !== 'idle' && agent.agent_status !== 'done') {
        throw new Error('The task conversation is busy; wait for its current turn before replying');
      }
      // An idle TUI never reloads messages appended by the old headless runner.
      // Quit only this task's idle process; preserve its pane, tab and transcript.
      await this.client.promptAgent({ target: agent.pane_id, text: '/quit' });
      const deadline = Date.now() + 10_000;
      const paneId = agent.pane_id;
      while (Date.now() < deadline) {
        const live = await this.listTaskAgents(workspace.workspace_id, tab.tab_id);
        if (!live.some((item) => item.pane_id === paneId && item.agent === HERDR_PI_KIND)) {
          agent = null;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (agent)
        throw new Error('The old task conversation did not exit; no duplicate process was started');
    }
    if (!agent) {
      // The card asked for its conversation, so a fresh pi is the floor here.
      const outcome = await this.ensureTabPiAgent({
        workspaceId: workspace.workspace_id,
        tabId: tab.tab_id,
        rootPaneId,
        workDir: options.workDir,
        taskKeys: options.taskKeys ?? [],
        providerSessionId: options.providerSessionId,
        projectPath: options.projectPath,
        force: true,
        executionArgs: options.executionArgs,
      });
      agent = outcome.agent;
      startedAgent = outcome.started;
      resumedSessionId = outcome.resumedSessionId;
    }

    await this.client.focusWorkspace(workspace.workspace_id);
    try {
      await this.client.focusTab(tab.tab_id);
    } catch (error) {
      logger.debug('Could not focus tab ' + tab.tab_id + ': ' + (error as Error).message);
    }
    if (agent) {
      try {
        await this.client.focusAgent(agent.pane_id);
      } catch (error) {
        logger.debug('Could not focus pane ' + agent.pane_id + ': ' + (error as Error).message);
      }
    }

    return {
      workspaceId: workspace.workspace_id,
      tabId: tab.tab_id,
      paneId: agent?.pane_id ?? null,
      rootPaneId,
      createdWorkspace,
      createdTab: taskTab.created,
      startedAgent,
      resumedSessionId,
      sessionId: piSessionIdFromFile(agent?.agent_session?.value) ?? resumedSessionId,
    };
  }

  /**
   * Place every card of a worktree in its space.
   *
   * A space is the worktree, so it should read like the branch: the epic and all
   * its sub-tasks are tabs, not just the card that was clicked. `agents: 'none'`
   * only creates the tabs (cheap, so a deep link can await it); `'all'`
   * additionally gives every tab its pi conversation - resuming the card's own
   * session when it has one - which is slow enough to belong in the background.
   */
  async restoreSpaceTabs(options: {
    workspaceId: string;
    workDir: string;
    targets: HerdrTaskTabRequest[];
    agents?: 'none' | 'all';
    projectPath?: string | null;
    env?: Record<string, string>;
  }): Promise<HerdrTaskTabResult[]> {
    const results: HerdrTaskTabResult[] = [];

    for (const target of options.targets) {
      const tab = await this.ensureTaskTab({
        workspaceId: options.workspaceId,
        taskName: target.title,
        taskId: target.taskKeys[0],
        workDir: options.workDir,
        tabId: target.tabId ?? null,
        env: options.env,
      });

      const outcome =
        options.agents === 'all'
          ? await this.ensureTabPiAgent({
              workspaceId: options.workspaceId,
              tabId: tab.tab.tab_id,
              rootPaneId: tab.rootPaneId,
              workDir: options.workDir,
              taskKeys: target.taskKeys,
              providerSessionId: target.providerSessionId,
              projectPath: options.projectPath,
              force: true,
            })
          : { agent: null, started: false, resumedSessionId: null, sessionId: null };

      results.push({
        taskKeys: target.taskKeys,
        tabId: tab.tab.tab_id,
        createdTab: tab.created,
        paneId: outcome.agent?.pane_id ?? null,
        startedAgent: outcome.started,
        resumedSessionId: outcome.resumedSessionId,
        sessionId: outcome.sessionId,
      });
    }

    return results;
  }

  /**
   * Make sure one tab runs this card's pi conversation.
   *
   * `force` opens a fresh conversation when none can be identified (the card was
   * just clicked); without it, a card that never ran anything keeps its plain
   * shell instead of burning a pi process.
   */
  async ensureConversationAgent(options: {
    workspaceId: string;
    tabId: string;
    rootPaneId: string;
    workDir: string;
    taskKeys: string[];
    providerSessionId?: string | null;
    projectPath?: string | null;
    force?: boolean;
    executionArgs?: string[];
    env?: Record<string, string>;
  }): Promise<{
    agent: HerdrAgentInfo | null;
    started: boolean;
    resumedSessionId: string | null;
    sessionId: string | null;
  }> {
    return this.ensureTabPiAgent(options);
  }

  private async ensureTabPiAgent(options: {
    workspaceId: string;
    tabId: string;
    rootPaneId: string;
    workDir: string;
    taskKeys: string[];
    providerSessionId?: string | null;
    projectPath?: string | null;
    force?: boolean;
    executionArgs?: string[];
  }): Promise<{
    agent: HerdrAgentInfo | null;
    started: boolean;
    resumedSessionId: string | null;
    sessionId: string | null;
  }> {
    const agents = await this.listTaskAgents(options.workspaceId, options.tabId);
    const existing = agents.find((candidate) => candidate.agent === HERDR_PI_KIND) ?? null;
    if (existing) {
      return {
        agent: existing,
        started: false,
        resumedSessionId: null,
        sessionId: piSessionIdFromFile(existing.agent_session?.value),
      };
    }

    // Resume this card's own conversation rather than opening a blank one; the
    // model also comes from that session so a follow-up keeps working. Several
    // tasks share a worktree, so "the newest session here" is never a guess.
    const session = resolveTaskPiSession(options.workDir, {
      providerSessionId: options.providerSessionId,
      taskKeys: options.taskKeys,
      projectPath: options.projectPath,
    });
    if (!session && !options.force) {
      return { agent: null, started: false, resumedSessionId: null, sessionId: null };
    }

    const model = resolvePiSessionModel(session);
    const args = options.executionArgs
      ? [...options.executionArgs]
      : [
          '--provider',
          model?.provider ?? 'litellm',
          '--model',
          model?.modelId ?? HERDR_WORKER_MODEL,
        ];
    // pi refuses to resume a conversation recorded under another cwd (it stops at
    // "Fork this session into current directory? [y/N]"), which happens when a
    // card moved between worktrees. `--fork` copies that history into a new
    // session in this worktree instead.
    const forkFromOtherDir =
      !!session?.cwd &&
      !!options.workDir &&
      path.resolve(session.cwd) !== path.resolve(options.workDir);
    if (session) {
      // Exact file path matters: older runs can leave multiple files with the same UUID.
      args.push(forkFromOtherDir ? '--fork' : '--session', session.filePath ?? session.id);
    }

    try {
      await this.client.startAgent({
        name: buildLeaderAgentName(options.tabId),
        kind: HERDR_PI_KIND,
        paneId: options.rootPaneId,
        args,
      });
      const agent = await this.client.waitForAgentReady(options.rootPaneId);
      const runningSessionId =
        piSessionIdFromFile(agent.agent_session?.value) ??
        (forkFromOtherDir ? null : (session?.id ?? null));
      return {
        agent,
        started: true,
        resumedSessionId: session?.id ?? null,
        sessionId: runningSessionId,
      };
    } catch (error) {
      // A busy pane (leftover command, another agent kind) is not fatal: the tab
      // is still worth showing, the user just starts pi there.
      logger.warn(
        'Could not restore a pi agent for tab ' + options.tabId + ': ' + (error as Error).message
      );
      return { agent: null, started: false, resumedSessionId: null, sessionId: null };
    }
  }

  /**
   * Wait for the already-running leader agent in a pane.
   *
   * Re-running a feature reuses its workspace, whose leader from the previous
   * run still owns the pane; `agent.start` would fail with `agent_name_taken`.
   */
  async waitForLeader(paneId: string): Promise<HerdrAgentInfo> {
    return this.client.waitForAgentReady(paneId);
  }

  /**
   * Add one worker pane per subtask and start a pi agent in each.
   *
   * Panes are split from the newest pane alternating right/down so the layout
   * stays readable instead of collapsing into slivers.
   */
  async startWorkers(options: {
    leaderPaneId: string;
    tabId: string;
    workDir: string;
    subtaskCount: number;
    env?: Record<string, string>;
  }): Promise<HerdrTaskAgent[]> {
    const workerCount = Math.min(Math.max(options.subtaskCount, 0), MAX_WORKERS_PER_TASK);
    if (options.subtaskCount > MAX_WORKERS_PER_TASK) {
      logger.warn(
        'Task requested ' + options.subtaskCount + ' workers; capping at ' + MAX_WORKERS_PER_TASK
      );
    }

    const agents: HerdrTaskAgent[] = [];
    let anchorPaneId = options.leaderPaneId;

    for (let index = 0; index < workerCount; index++) {
      const direction = index % 2 === 0 ? 'right' : 'down';
      const pane = await this.client.splitPane({
        targetPaneId: anchorPaneId,
        direction,
        cwd: options.workDir,
        env: options.env,
      });
      const name = buildWorkerAgentName(options.tabId, index);
      await this.client.startAgent({
        name,
        kind: HERDR_PI_KIND,
        paneId: pane.pane_id,
        args: ['--provider', 'litellm', '--model', HERDR_WORKER_MODEL],
      });
      const ready = await this.client.waitForAgentReady(pane.pane_id);
      agents.push({
        name,
        role: 'worker',
        paneId: pane.pane_id,
        model: HERDR_WORKER_MODEL,
        subtaskIndex: index,
        lastStatus: ready.agent_status,
      });
      // Subsequent splits fan out from the newest pane to keep panes even.
      anchorPaneId = pane.pane_id;
    }

    return agents;
  }

  /**
   * Send a prompt and wait for the turn to settle.
   *
   * Targets are pane ids: an agent's *name* stops resolving while herdr still
   * considers the launch pending, and names can also be cleared when an agent
   * is replaced in a pane. Pane ids are stable for the pane's lifetime.
   */
  async promptAndWait(
    paneId: string,
    text: string,
    options: { timeoutMs?: number } = {}
  ): Promise<{ agent: HerdrAgentInfo; timedOut: boolean }> {
    return this.client.promptAndWait(paneId, text, options);
  }

  /** Send a prompt without waiting for the turn to finish */
  async prompt(paneId: string, text: string): Promise<HerdrAgentInfo> {
    return this.client.promptAgent({ target: paneId, text });
  }

  /**
   * Read an agent's terminal output.
   *
   * Lossy for long output: agents run on the alternate screen, so rows that
   * scroll off are unrecoverable. Prefer `readAgentTranscript` for anything that
   * must be complete (a plan, a summary).
   */
  async readAgent(paneId: string, lines = 400): Promise<string> {
    const result = await this.client.readAgent(paneId, {
      source: 'recent_unwrapped',
      lines,
    });
    return result.text ?? '';
  }

  /**
   * Read an agent's full, structured transcript.
   *
   * Uses the pi session file herdr reports for the pane, so the result is not
   * subject to alternate-screen truncation.
   */
  async readAgentTranscript(paneId: string): Promise<HerdrAgentTranscript> {
    const agent = await this.client.getAgent(paneId);
    return readAgentTranscript(this.client, agent);
  }

  /** Read an agent's transcript as plain text */
  async readAgentText(paneId: string): Promise<string> {
    return transcriptToText(await this.readAgentTranscript(paneId));
  }

  /** Current agents in a workspace, or only in one of its tabs when given */
  async listTaskAgents(workspaceId: string, tabId?: string): Promise<HerdrAgentInfo[]> {
    const agents = await this.client.listAgents();
    return agents.filter(
      (agent) =>
        agent.workspace_id === workspaceId && (tabId === undefined || agent.tab_id === tabId)
    );
  }

  /** Close a task's tab, keeping the worktree's space for its other tasks */
  async closeTaskTab(tabId: string): Promise<void> {
    try {
      await this.client.closeTab(tabId);
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === 'tab_not_found') return;
      throw error;
    }
  }

  /** Close a task's workspace (used when the feature's worktree is deleted) */
  async closeWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.client.closeWorkspace(workspaceId);
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === 'workspace_not_found') {
        logger.debug('Workspace ' + workspaceId + ' already closed');
        return;
      }
      throw error;
    }
  }
}

const taskServices = new Map<string, HerdrTaskService>();

/**
 * Task service for a project's herdr session.
 *
 * Sessions are per project, so the service (and its socket client) is too; the
 * map keeps one client per session instead of reconnecting on every call.
 */
export function getHerdrTaskService(projectPath: string): HerdrTaskService {
  const sessionName = buildProjectSessionName(projectPath);
  let service = taskServices.get(sessionName);
  if (!service) {
    service = new HerdrTaskService(new HerdrControlClient({ sessionName }));
    taskServices.set(sessionName, service);
  }
  return service;
}

/** Reset every project's service (used by tests) */
export function resetHerdrTaskService(): void {
  for (const service of taskServices.values()) service.getClient().dispose();
  taskServices.clear();
}
