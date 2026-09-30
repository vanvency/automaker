import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DevbridgePreview } from '../../../src/services/devbridge-preview.js';
import { runPreviewCommand } from '../../../src/services/worktree-preview-service.js';

let project: string;
let bridge: DevbridgePreview;

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), 'devbridge-preview-'));
  bridge = new DevbridgePreview(runPreviewCommand);
  // Real subprocesses and HTTP listeners exercise lifetime/port isolation without SSH or a cluster.
  await writeFile(
    path.join(project, 'devbridge.mjs'),
    `
import { createServer } from 'node:http';
import { writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
const [action, ...args] = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const dir = value('-state-dir');
const progress = value('-progress-file');
if (args.includes('-progress-file')) {
  await appendFile(progress, JSON.stringify({ at: new Date().toISOString(), step: 'Devbridge · ' + action, status: 'running', message: 'Started' }) + '\\n');
}
if (action === 'up') {
  const configBody = await (await import('node:fs/promises')).readFile(value('-f'), 'utf8');
  if (configBody !== 'worktree config') throw new Error('wrong configuration source');
  const source = value('-root');
  const route = path.basename(source);
  const server = createServer((req, res) => {
    res.setHeader('X-Devbridge-Route', req.url === '/wrong' ? 'someone-else' : route);
    res.end(source);
  });
  server.listen(0, '127.0.0.1', async () => {
    await writeFile(path.join(dir, 'session.json'), JSON.stringify({ ready: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
    await writeFile(path.join(dir, 'session.json'), JSON.stringify({
      ready: true, route_id: route, health_path: '/health',
      preview_address: '127.0.0.1:' + server.address().port
    }));
  });
  process.stdin.resume();
  process.stdin.on('end', () => server.close(() => process.exit(0)));
} else if (action === 'down') {
  await rm(path.join(dir, 'session.json'), { force: true });
}
`
  );
});

afterEach(async () => {
  await bridge.stop(project, 'a');
  await bridge.stop(project, 'b');
  await bridge.stop(project, 'multi');
  await rm(project, { force: true, recursive: true });
});

it('hands the worktree root to the tool when no sourcePath is configured', async () => {
  // A session that bridges several services resolves each app dir itself, so the
  // tool must receive the worktree root rather than one service directory.
  const config = {
    command: [process.execPath, path.join(project, 'devbridge.mjs')],
    configFile: '.devbridge.yaml',
    sourceRoot: '/worktree',
    stripPrefix: '/gateway',
    host: '127.0.0.1',
    bindHost: '127.0.0.1',
  };
  const tree = path.join(project, 'tree');
  await mkdir(tree);
  await writeFile(path.join(tree, '.devbridge.yaml'), 'worktree config');
  const url = await bridge.start(project, tree, 'multi', config, 'http://frontend');
  expect(await (await fetch(url)).text()).toBe(tree);
  expect((await bridge.logs(project, 'multi')).map((entry) => entry.step)).toEqual([
    'Devbridge · doctor',
    'Devbridge · up',
  ]);
  await bridge.stop(project, 'multi');
  expect((await bridge.logs(project, 'multi')).at(-1)?.step).toBe('Devbridge · down');
  const restarted = new DevbridgePreview(runPreviewCommand);
  expect(await restarted.logs(project, 'multi')).toEqual(await bridge.logs(project, 'multi'));
  await restarted.clearLogs(project, 'multi');
  expect(await restarted.logs(project, 'multi')).toEqual([]);
});

it('reads only allowlisted component configuration and retains it across restarts', async () => {
  await bridge.clearLogs(project, 'a');
  const file = path.join(project, '.automaker/previews/a.devbridge/config-summary.json');
  const snapshot = {
    capturedAt: '2026-09-23T00:00:00Z',
    configFile: '.devbridge.yaml',
    sourceRoot: '/worktree',
    stripPrefix: '/gateway',
    namespace: 'preview',
    gateway: 'http://gateway',
    listen: '127.0.0.1:0',
    autoReattach: true,
    maxAttempts: 5,
    password: 'secret-value',
    components: [
      {
        name: 'backend',
        dir: 'backend',
        target: 'deployment/backend/container/api',
        localPort: 8080,
        remotePort: 80,
        routes: ['/api'],
        healthPath: '/health',
        buildTool: 'go',
        environmentKeys: ['API_TOKEN'],
        changeStatus: 'changed',
        changedFiles: 3,
        baseRef: 'origin/dev',
        env: { API_TOKEN: 'secret-value' },
      },
    ],
  };
  await writeFile(file, JSON.stringify(snapshot));
  const result = await bridge.configSummary(project, 'a');
  expect(result?.components[0]).toMatchObject({ name: 'backend', changedFiles: 3 });
  expect(JSON.stringify(result)).not.toContain('secret-value');
  expect(await new DevbridgePreview(runPreviewCommand).configSummary(project, 'a')).toEqual(result);
  await writeFile(file, '{"components": "bad"}');
  await expect(bridge.configSummary(project, 'a')).rejects.toThrow(
    'Invalid devbridge configuration snapshot'
  );
  await bridge.clearLogs(project, 'a');
  expect(await bridge.configSummary(project, 'a')).toBeUndefined();
});

it('reports safe preflight HTTP diagnostics without exposing command output', async () => {
  const worktree = path.join(project, 'worktree');
  await mkdir(worktree);
  await writeFile(path.join(worktree, '.devbridge.yaml'), 'worktree config');
  const runner = async (args: string[]) => {
    const progressPath = args[args.indexOf('-progress-file') + 1];
    await writeFile(
      progressPath,
      JSON.stringify({
        at: new Date().toISOString(),
        step: 'Devbridge · cvat-backend: verify managed gateway routing',
        status: 'failed',
        message:
          'shared backend must reject mismatched X-Devbridge-Required-Route before executing handlers (HTTP 404; rejection header present: false); secret-token-must-not-appear',
      }) + '\n'
    );
    throw new Error('preflight exited with code 1');
  };
  const devbridge = new DevbridgePreview(runner);
  try {
    await devbridge.preflight(project, worktree, 'preview-a', {
      command: ['devbridge'],
      configFile: '.devbridge.yaml',
      host: '127.0.0.1',
      bindHost: '127.0.0.1',
    });
    expect.fail('unguarded shared backend must reject the preflight');
  } catch (error) {
    expect((error as Error).message).toContain(
      'cvat-backend: shared backend returned HTTP 404; rejection header present: false. Deploy the shared route guard before retrying'
    );
    expect((error as Error).message).not.toContain('secret-token-must-not-appear');
  }
});

it('gives concurrent worktrees distinct processes, ports and state; stopping A leaves B usable', async () => {
  const config = {
    command: [process.execPath, path.join(project, 'devbridge.mjs')],
    configFile: '.devbridge.yaml',
    sourceRoot: '/worktree',
    stripPrefix: '/gateway',
    host: '127.0.0.1',
    bindHost: '127.0.0.1',
  };
  const a = path.join(project, 'a');
  const b = path.join(project, 'b');
  await mkdir(a);
  await mkdir(b);
  await writeFile(path.join(a, '.devbridge.yaml'), 'worktree config');
  await writeFile(path.join(b, '.devbridge.yaml'), 'worktree config');
  await writeFile(path.join(project, '.devbridge.yaml'), 'wrong shared project config');
  const [urlA, urlB] = await Promise.all([
    bridge.start(project, a, 'a', config, 'http://frontend-a'),
    bridge.start(project, b, 'b', config, 'http://frontend-b'),
  ]);
  expect(urlA).not.toBe(urlB);
  expect(await (await fetch(urlA)).text()).toBe(a);
  expect(await (await fetch(urlB)).text()).toBe(b);
  // Every configured backend must pass, not just the first top-level health check.
  const bStateFile = path.join(project, '.automaker/previews/b.devbridge/session.json');
  const bState = JSON.parse(await readFile(bStateFile, 'utf8'));
  await writeFile(
    bStateFile,
    JSON.stringify({
      ...bState,
      apps: [
        { name: 'first', ready: true, route_id: 'b', health_path: '/health' },
        { name: 'second', ready: true, route_id: 'second', health_path: '/health' },
      ],
    })
  );
  await expect(bridge.check(project, 'b', urlB)).rejects.toThrow('did not match');
  await writeFile(bStateFile, JSON.stringify(bState));
  const stateFile = path.join(project, '.automaker/previews/a.devbridge/session.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(stateFile, JSON.stringify({ ...state, health_path: '/wrong' }));
  await expect(bridge.check(project, 'a', urlA)).rejects.toThrow('did not match');
  await bridge.stop(project, 'a');
  await expect(fetch(urlA)).rejects.toThrow();
  await bridge.check(project, 'b', urlB);
  expect(await (await fetch(urlB)).text()).toBe(b);
  // Stored cleanup command works even if the project config/worktree no longer exists.
  await rm(b, { recursive: true });
  const restarted = new DevbridgePreview(runPreviewCommand);
  await restarted.stop(project, 'b');
  await expect(restarted.check(project, 'b', urlB)).rejects.toThrow();
});

it('never falls back to project config or follows component config outside the worktree', async () => {
  const tree = path.join(project, 'tree');
  await mkdir(tree);
  await writeFile(path.join(project, '.devbridge.yaml'), 'shared');
  const config = {
    command: [process.execPath],
    configFile: '.devbridge.yaml',
    host: '127.0.0.1',
    bindHost: '127.0.0.1',
  };
  await expect(bridge.start(project, tree, 'a', config, 'http://frontend')).rejects.toThrow();
  await symlink(path.join(project, '.devbridge.yaml'), path.join(tree, '.devbridge.yaml'));
  await expect(bridge.start(project, tree, 'a', config, 'http://frontend')).rejects.toThrow(
    'configuration must stay inside'
  );
});
