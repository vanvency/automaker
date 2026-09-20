import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  HerdrApiError,
  HerdrControlClient,
  buildHerdrControlEnv,
  resolveHerdrConfigDir,
  resolveHerdrSocketPath,
} from '../../../src/services/herdr-client.js';

/**
 * A fake herdr server implementing the observed protocol: one request per
 * connection, a single newline-delimited JSON reply, then close.
 */
function createFakeHerdrServer(
  handler: (method: string, params: Record<string, unknown>) => unknown
): Promise<{ server: Server; socketPath: string; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'herdr-client-'));
  const socketPath = path.join(dir, 'herdr.sock');
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      const outcome = handler(request.method, request.params);
      socket.write(`${JSON.stringify(outcome)}\n`, () => socket.end());
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ server, socketPath, dir }));
  });
}

describe('herdr-client', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  function trackServer(server: Server, dir: string) {
    cleanups.push(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it('resolves the default session socket under the herdr config dir', () => {
    expect(resolveHerdrConfigDir({ HOME: '/home/x', XDG_CONFIG_HOME: undefined } as never)).toBe(
      path.join('/home/x', '.config', 'herdr')
    );
    expect(resolveHerdrConfigDir({ XDG_CONFIG_HOME: '/tmp/xdg' } as never)).toBe(
      path.join('/tmp/xdg', 'herdr')
    );
    expect(resolveHerdrSocketPath('automaker', { XDG_CONFIG_HOME: '/tmp/xdg' } as never)).toBe(
      path.join('/tmp/xdg', 'herdr', 'sessions', 'automaker', 'herdr.sock')
    );
    expect(resolveHerdrSocketPath('default', { XDG_CONFIG_HOME: '/tmp/xdg' } as never)).toBe(
      path.join('/tmp/xdg', 'herdr', 'herdr.sock')
    );
  });

  it('strips caller pane variables from the control environment', () => {
    const previous = { ...process.env };
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_SOCKET_PATH = '/somewhere/else/herdr.sock';
    process.env.KEEP_ME = 'yes';
    try {
      const env = buildHerdrControlEnv();
      expect(env.HERDR_ENV).toBeUndefined();
      expect(env.HERDR_PANE_ID).toBeUndefined();
      expect(env.HERDR_SOCKET_PATH).toBeUndefined();
      expect(env.KEEP_ME).toBe('yes');
      expect(buildHerdrControlEnv({ HERDR_SOCKET_PATH: '/x' }).HERDR_SOCKET_PATH).toBe('/x');
    } finally {
      process.env = previous;
    }
  });

  it('sends one request per connection and parses the result', async () => {
    const { server, socketPath, dir } = await createFakeHerdrServer((method) => ({
      id: 'x',
      result: { type: 'ok', method },
    }));
    trackServer(server, dir);

    const client = new HerdrControlClient({ socketPath });
    const result = await client.request<{ method: string }>('workspace.list');
    expect(result.method).toBe('workspace.list');
  });

  it('raises a typed error for herdr error responses', async () => {
    const { server, socketPath, dir } = await createFakeHerdrServer(() => ({
      id: 'x',
      error: { code: 'pane_not_found', message: 'pane missing' },
    }));
    trackServer(server, dir);

    const client = new HerdrControlClient({ socketPath });
    await expect(client.request('pane.read', {})).rejects.toMatchObject({
      name: 'HerdrApiError',
      code: 'pane_not_found',
    });
  });

  it('reports server_not_running when the socket is absent', async () => {
    const client = new HerdrControlClient({
      socketPath: path.join(tmpdir(), `missing-${Date.now()}`, 'herdr.sock'),
    });
    await expect(client.request('workspace.list')).rejects.toBeInstanceOf(HerdrApiError);
    expect(await client.isSessionRunning()).toBe(false);
  });

  it('maps typed control calls onto the socket protocol', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    const { server, socketPath, dir } = await createFakeHerdrServer((method, params) => {
      seen.push({ method, params });
      const results: Record<string, unknown> = {
        'workspace.list': { workspaces: [{ workspace_id: 'w1', label: 'Feature A' }] },
        'workspace.create': {
          workspace: { workspace_id: 'w2', label: 'Feature B' },
          tab: { tab_id: 'w2:t1', workspace_id: 'w2' },
          root_pane: { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1' },
        },
        'pane.split': { pane: { pane_id: 'w2:p2', workspace_id: 'w2', tab_id: 'w2:t1' } },
        'agent.start': { agent: { name: 'worker-1', pane_id: 'w2:p2' }, argv: ['pi'] },
        'agent.prompt': { agent: { name: 'worker-1', agent_status: 'working' } },
        'agent.read': { read: { pane_id: 'w2:p2', text: 'hello', source: 'recent_unwrapped' } },
        'workspace.get': { workspace: { workspace_id: 'w1', label: 'Feature A', focused: false } },
        'workspace.focus': { workspace: { workspace_id: 'w1', label: 'Feature A', focused: true } },
        'agent.focus': { agent: { name: 'worker-1', pane_id: 'w2:p2', focused: true } },
        'tab.list': { tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'Feature A' }] },
        'tab.get': { tab: { tab_id: 'w1:t1', workspace_id: 'w1', label: 'Feature A' } },
        'tab.create': {
          tab: { tab_id: 'w1:t2', workspace_id: 'w1', label: 'Feature B' },
          root_pane: { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2' },
        },
        'tab.focus': { tab: { tab_id: 'w1:t1', workspace_id: 'w1', focused: true } },
      };
      return { id: 'x', result: results[method] ?? { type: 'ok' } };
    });
    trackServer(server, dir);

    const client = new HerdrControlClient({ socketPath });
    expect((await client.listWorkspaces())[0].label).toBe('Feature A');
    expect((await client.findWorkspaceByLabel('Feature A'))?.workspace_id).toBe('w1');
    expect(await client.findWorkspaceByLabel('nope')).toBeNull();

    const created = await client.createWorkspace({ cwd: '/tmp/wt', label: 'Feature B' });
    expect(created.root_pane.pane_id).toBe('w2:p1');
    expect(seen.at(-1)?.params).toMatchObject({ focus: false, label: 'Feature B' });

    const pane = await client.splitPane({
      targetPaneId: 'w2:p1',
      direction: 'down',
      cwd: '/tmp/wt',
    });
    expect(pane.pane_id).toBe('w2:p2');
    expect(seen.at(-1)?.params).toMatchObject({ target_pane_id: 'w2:p1', focus: false });

    const started = await client.startAgent({
      name: 'worker-1',
      kind: 'pi',
      paneId: 'w2:p2',
      args: ['--provider', 'litellm', '--model', 'worker'],
    });
    expect(started.argv).toEqual(['pi']);
    expect(seen.at(-1)?.params).toMatchObject({
      name: 'worker-1',
      kind: 'pi',
      pane_id: 'w2:p2',
      args: ['--provider', 'litellm', '--model', 'worker'],
    });

    await client.promptAgent({ target: 'worker-1', text: 'do work' });
    expect(seen.at(-1)?.params).toMatchObject({ target: 'worker-1', text: 'do work', wait: null });

    const read = await client.readAgent('worker-1');
    expect(read.text).toBe('hello');

    expect((await client.getWorkspace('w1'))?.label).toBe('Feature A');
    expect(seen.at(-1)?.params).toEqual({ workspace_id: 'w1' });

    expect((await client.focusWorkspace('w1')).focused).toBe(true);
    expect(seen.at(-1)).toEqual({ method: 'workspace.focus', params: { workspace_id: 'w1' } });

    expect((await client.focusAgent('w2:p2')).focused).toBe(true);
    expect(seen.at(-1)).toEqual({ method: 'agent.focus', params: { target: 'w2:p2' } });

    expect((await client.listTabs('w1'))[0].label).toBe('Feature A');
    expect(seen.at(-1)).toEqual({ method: 'tab.list', params: { workspace_id: 'w1' } });
    expect((await client.findTabByLabel('w1', 'Feature A'))?.tab_id).toBe('w1:t1');

    const tab = await client.createTab({ workspaceId: 'w1', label: 'Feature B', cwd: '/tmp/wt' });
    expect(tab.root_pane.pane_id).toBe('w1:p2');
    expect(seen.at(-1)?.params).toMatchObject({
      workspace_id: 'w1',
      label: 'Feature B',
      focus: false,
    });

    await client.renameTab('w1:t2', 'Feature C');
    expect(seen.at(-1)).toEqual({
      method: 'tab.rename',
      params: { tab_id: 'w1:t2', label: 'Feature C' },
    });

    expect((await client.focusTab('w1:t1')).focused).toBe(true);
    expect(seen.at(-1)).toEqual({ method: 'tab.focus', params: { tab_id: 'w1:t1' } });
  });

  it('treats a missing workspace as null instead of an error', async () => {
    const { server, socketPath, dir } = await createFakeHerdrServer((method) => {
      if (method === 'workspace.get') {
        return { id: 'x', error: { code: 'workspace_not_found', message: 'gone' } };
      }
      return { id: 'x', result: { type: 'ok' } };
    });
    trackServer(server, dir);

    const client = new HerdrControlClient({ socketPath });
    expect(await client.getWorkspace('w42')).toBeNull();
  });

  it('streams subscribe events and stops when unsubscribed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'herdr-events-'));
    const socketPath = path.join(dir, 'herdr.sock');
    const server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes('\n')) return;
        socket.write(
          `${JSON.stringify({ id: 'sub', result: { type: 'subscription_started' } })}\n`
        );
        socket.write(
          `${JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'working' } })}\n`
        );
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    trackServer(server, dir);

    const client = new HerdrControlClient({ socketPath });
    const events: string[] = [];
    const received = new Promise<void>((resolve) => {
      client.subscribe([{ type: 'pane.agent_status_changed' }], (event) => {
        events.push(event.event);
        resolve();
      });
    });
    await received;
    client.dispose();
    expect(events).toContain('pane_agent_status_changed');
  });
});
