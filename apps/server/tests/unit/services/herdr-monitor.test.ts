import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HerdrMonitor, resetHerdrMonitor } from '../../../src/services/herdr-monitor.js';
import { HerdrApiError } from '../../../src/services/herdr-client.js';
import type { HerdrControlClient, HerdrEvent } from '../../../src/services/herdr-client.js';

/** Client stub that records subscriptions so tests can push events. */
function createClient() {
  const listeners: Array<(event: HerdrEvent) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  const subscriptions: Array<Array<Record<string, unknown>>> = [];
  const client = {
    isAvailable: () => true,
    listWorkspaces: vi
      .fn()
      .mockResolvedValue([{ workspace_id: 'w1', label: 'Task A', agent_status: 'working' }]),
    listAgents: vi.fn().mockResolvedValue([
      {
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent_status: 'working',
        agent: 'pi',
        name: 'leader',
      },
      { pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'idle', agent: 'pi', name: 'worker-1' },
    ]),
    subscribe: vi.fn(
      (
        subs: Array<Record<string, unknown>>,
        onEvent: (event: HerdrEvent) => void,
        onError?: (error: Error) => void
      ) => {
        subscriptions.push(subs);
        listeners.push(onEvent);
        if (onError) errorHandlers.push(onError);
        return () => undefined;
      }
    ),
    dispose: () => undefined,
  } as unknown as HerdrControlClient;

  return {
    client,
    subscriptions,
    push: (event: HerdrEvent) => listeners.forEach((fn) => fn(event)),
    fail: (error: Error) => errorHandlers.forEach((fn) => fn(error)),
  };
}

describe('herdr-monitor', () => {
  afterEach(() => {
    resetHerdrMonitor();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('seeds the cache from one snapshot instead of per-card calls', async () => {
    const { client } = createClient();
    const monitor = new HerdrMonitor(client);
    await monitor.refreshSnapshot();

    expect(monitor.getWorkspaceStatus('w1')).toBe('working');
    expect(monitor.getWorkspacePanes('w1')).toHaveLength(2);
    expect(client.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(client.listAgents).toHaveBeenCalledTimes(1);
  });

  it('updates cached pane status and emits an event on status changes', async () => {
    const { client, push } = createClient();
    const emit = vi.fn();
    const monitor = new HerdrMonitor(client, { emit } as never);
    await monitor.start();

    push({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } });

    const panes = monitor.getWorkspacePanes('w1');
    expect(panes.find((p) => p.paneId === 'w1:p1')?.status).toBe('idle');
    expect(emit).toHaveBeenCalledWith(
      'auto-mode:event',
      expect.objectContaining({ type: 'herdr_agent_status', paneId: 'w1:p1', status: 'idle' })
    );
    monitor.stop();
  });

  it('subscribes to pane status events with the pane id herdr requires', async () => {
    const { client, subscriptions } = createClient();
    const monitor = new HerdrMonitor(client);
    await monitor.start();

    const statusSubs = subscriptions[0].filter((sub) => sub.type === 'pane.agent_status_changed');
    // herdr rejects the entry (and with it the whole request) without `pane_id`.
    expect(statusSubs).toEqual(
      expect.arrayContaining([
        { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
        { type: 'pane.agent_status_changed', pane_id: 'w1:p2' },
      ])
    );
    for (const sub of statusSubs) expect(typeof sub.pane_id).toBe('string');
    monitor.stop();
  });

  it('coalesces snapshot refreshes triggered by replayed events', async () => {
    const { client, push } = createClient();
    const monitor = new HerdrMonitor(client);
    await monitor.start();
    const before = (client.listWorkspaces as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;

    push({ event: 'pane_agent_detected', data: { pane_id: 'w1:p3' } });
    push({ event: 'pane_agent_detected', data: { pane_id: 'w1:p4' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Both events share one refresh instead of one herdr round-trip each.
    expect(
      (client.listWorkspaces as unknown as { mock: { calls: unknown[] } }).mock.calls.length -
        before
    ).toBe(1);
    monitor.stop();
  });

  it('refreshes and notifies on the snake_case topology events herdr streams', async () => {
    const { client, push } = createClient();
    const emit = vi.fn();
    const monitor = new HerdrMonitor(client, { emit } as never);
    await monitor.start();
    const before = (client.listAgents as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;

    // Wire names are snake_case even though the subscription types are dotted.
    push({ event: 'pane_agent_detected', data: { pane_id: 'w1:p3' } });
    push({ event: 'workspace_closed', data: { workspace_id: 'w9' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      (client.listAgents as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    ).toBeGreaterThan(before);
    expect(emit).toHaveBeenCalledWith(
      'auto-mode:event',
      expect.objectContaining({ type: 'herdr_topology_changed' })
    );
    monitor.stop();
  });

  it('ignores status events missing required fields', async () => {
    const { client, push } = createClient();
    const emit = vi.fn();
    const monitor = new HerdrMonitor(client, { emit } as never);
    await monitor.start();
    const before = monitor.getSnapshot().updatedAt;

    push({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1' } });
    expect(monitor.getSnapshot().updatedAt).toBe(before);
    expect(emit).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('resubscribes after the stream drops', async () => {
    vi.useFakeTimers();
    const { client, fail } = createClient();
    const monitor = new HerdrMonitor(client);
    await monitor.start();
    expect(client.subscribe).toHaveBeenCalledTimes(1);

    fail(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(client.subscribe).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('stops refreshing after stop()', async () => {
    const { client } = createClient();
    const monitor = new HerdrMonitor(client);
    await monitor.start();
    monitor.stop();
    const callsAfterStop = (client.listWorkspaces as ReturnType<typeof vi.fn>).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((client.listWorkspaces as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterStop
    );
  });

  it('treats a missing session as an empty cache instead of throwing', async () => {
    const { client } = createClient();
    (client.listWorkspaces as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HerdrApiError('server_not_running', 'no server')
    );
    const monitor = new HerdrMonitor(client);
    await expect(monitor.refreshSnapshot()).resolves.toBeUndefined();
    expect(monitor.getWorkspaceStatus('w1')).toBe('unknown');
  });
});
