/**
 * HerdrMonitor - one persistent status subscription for the whole server.
 *
 * Polling herdr per card (or forking the CLI to count turns, as the old
 * per-provider code did) does not scale: every feature would add a process or a
 * socket per render. Instead this service holds a single `events.subscribe`
 * stream on the shared session, keeps a cached snapshot of workspace/agent
 * status, and pushes deltas to the frontend over the existing event bus.
 *
 * The cache is also the source of truth for feature -> workspace status lookups,
 * so API handlers answer from memory instead of talking to herdr.
 */

import { createLogger } from '@automaker/utils';
import type { TypedEventBus } from './typed-event-bus.js';
import {
  HerdrApiError,
  type HerdrAgentStatus,
  type HerdrControlClient,
  type HerdrEvent,
  type HerdrWorkspaceInfo,
} from './herdr-client.js';

const logger = createLogger('HerdrMonitor');

/** How long to wait before re-subscribing after the event stream drops */
const RESUBSCRIBE_DELAY_MS = 3_000;

/** Safety-net refresh interval, in case an event is missed */
const SNAPSHOT_REFRESH_MS = 30_000;

export interface HerdrStatusSnapshot {
  /** workspace_id -> status */
  workspaces: Map<string, HerdrWorkspaceInfo>;
  /** pane_id -> status */
  panes: Map<
    string,
    { paneId: string; workspaceId: string; status: HerdrAgentStatus; agent: string | null }
  >;
  updatedAt: number;
}

export class HerdrMonitor {
  private snapshot: HerdrStatusSnapshot = {
    workspaces: new Map(),
    panes: new Map(),
    updatedAt: 0,
  };
  private unsubscribe: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight snapshot refresh, so replayed events cannot stack up calls */
  private refreshPromise: Promise<void> | null = null;
  /** Panes the current subscription asks status events for */
  private subscribedPaneIds: string[] = [];
  private stopped = false;

  constructor(
    private client: HerdrControlClient,
    private eventBus: TypedEventBus | null = null
  ) {}

  /** Start the stream and seed the cache with a first snapshot */
  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshSnapshot();
    this.subscribe();
    this.refreshTimer = setInterval(() => {
      void this.refreshSnapshot().catch((error) => {
        logger.debug(`herdr snapshot refresh failed: ${(error as Error).message}`);
      });
    }, SNAPSHOT_REFRESH_MS);
  }

  /** Stop the stream and timers */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.resubscribeTimer) clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = null;
  }

  /** The cached snapshot (never hits herdr) */
  getSnapshot(): HerdrStatusSnapshot {
    return this.snapshot;
  }

  /** Status of a workspace by id, from cache */
  getWorkspaceStatus(workspaceId: string): HerdrAgentStatus {
    return this.snapshot.workspaces.get(workspaceId)?.agent_status ?? 'unknown';
  }

  /** Every pane status in a workspace, from cache */
  getWorkspacePanes(
    workspaceId: string
  ): HerdrStatusSnapshot['panes'] extends Map<string, infer V> ? V[] : never {
    return [...this.snapshot.panes.values()].filter(
      (pane) => pane.workspaceId === workspaceId
    ) as never;
  }

  /** Re-read workspaces and agents from herdr into the cache */
  refreshSnapshot(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefreshSnapshot().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefreshSnapshot(): Promise<void> {
    if (!this.client.isAvailable()) return;
    try {
      const [workspaces, agents] = await Promise.all([
        this.client.listWorkspaces(),
        this.client.listAgents(),
      ]);
      const next: HerdrStatusSnapshot = {
        workspaces: new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace])),
        panes: new Map(
          agents.map((agent) => [
            agent.pane_id,
            {
              paneId: agent.pane_id,
              workspaceId: agent.workspace_id,
              status: agent.agent_status,
              agent: agent.agent,
            },
          ])
        ),
        updatedAt: Date.now(),
      };
      this.snapshot = next;
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === 'server_not_running') {
        logger.debug('herdr session is not running; status cache left as-is');
        return;
      }
      throw error;
    }
  }

  private subscribe(): void {
    if (this.stopped) return;
    // herdr rejects `pane.agent_status_changed` without a pane id (and a
    // rejected entry fails the whole request), so status events are subscribed
    // one pane at a time. Topology events need only their type.
    const paneSubscriptions = [...this.snapshot.panes.keys()].map((paneId) => ({
      type: 'pane.agent_status_changed',
      pane_id: paneId,
    }));
    this.unsubscribe?.();
    this.subscribedPaneIds = [...this.snapshot.panes.keys()];
    this.unsubscribe = this.client.subscribe(
      [
        ...paneSubscriptions,
        { type: 'pane.agent_detected' },
        { type: 'pane.exited' },
        { type: 'pane.created' },
        { type: 'pane.closed' },
        { type: 'workspace.created' },
        { type: 'workspace.updated' },
        { type: 'workspace.renamed' },
        { type: 'workspace.closed' },
      ],
      (event) => this.handleEvent(event),
      (error) => this.handleStreamError(error)
    );
  }

  private handleStreamError(error: Error): void {
    if (this.stopped) return;
    logger.warn(`herdr event stream dropped (${error.message}); resubscribing`);
    this.unsubscribe = null;
    if (this.resubscribeTimer) clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = setTimeout(() => {
      void this.refreshSnapshot().catch(() => undefined);
      this.subscribe();
    }, RESUBSCRIBE_DELAY_MS);
  }

  private handleEvent(event: HerdrEvent): void {
    switch (event.event) {
      case 'pane_agent_status_changed': {
        const paneId = typeof event.data.pane_id === 'string' ? event.data.pane_id : null;
        const status = event.data.agent_status as HerdrAgentStatus | undefined;
        if (!paneId || !status) return;
        const existing = this.snapshot.panes.get(paneId);
        this.snapshot.panes.set(paneId, {
          paneId,
          workspaceId: existing?.workspaceId ?? '',
          status,
          agent: (event.data.agent as string | null) ?? existing?.agent ?? null,
        });
        this.snapshot.updatedAt = Date.now();
        this.emit('herdr_agent_status', {
          paneId,
          workspaceId: existing?.workspaceId ?? null,
          status,
          agent: event.data.agent ?? null,
        });
        break;
      }
      // herdr streams snake_case event names (`pane_agent_detected`, ...), while
      // the subscription request uses dotted types - the two spellings differ.
      case 'pane_agent_detected':
      case 'pane_exited':
      case 'pane_created':
      case 'pane_closed':
      case 'workspace_created':
      case 'workspace_updated':
      case 'workspace_renamed':
      case 'workspace_closed':
        // Structural changes: refresh the cache, then notify.
        void this.refreshSnapshot()
          .then(() => {
            // New panes need their own status subscription.
            if (this.panesChangedSinceSubscribe()) this.subscribe();
            this.emit('herdr_topology_changed', { event: event.event });
          })
          .catch((error) => logger.debug(`refresh after ${event.event} failed: ${error}`));
        break;
      default:
        break;
    }
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.eventBus?.emit('auto-mode:event', { type, ...data });
  }

  private panesChangedSinceSubscribe(): boolean {
    const known = this.snapshot.panes;
    return (
      known.size !== this.subscribedPaneIds.length ||
      this.subscribedPaneIds.some((paneId) => !known.has(paneId))
    );
  }
}

let monitor: HerdrMonitor | null = null;

export function getHerdrMonitor(
  client: HerdrControlClient,
  eventBus?: TypedEventBus
): HerdrMonitor {
  if (!monitor) {
    monitor = new HerdrMonitor(client, eventBus ?? null);
  }
  return monitor;
}

export function resetHerdrMonitor(): void {
  monitor?.stop();
  monitor = null;
}
