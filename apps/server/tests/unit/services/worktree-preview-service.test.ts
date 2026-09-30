import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DevbridgePreview } from '../../../src/services/devbridge-preview.js';
import {
  WorktreePreviewService,
  previewId,
  previewManifest,
  validatePreviewConfig,
  type PreviewConfig,
  type PreviewRunner,
  redactPreviewLog,
  runPreviewCommand,
} from '../../../src/services/worktree-preview-service.js';

const config: PreviewConfig = {
  enabled: true,
  context: 'local-k3s',
  namespace: 'automaker-preview',
  buildCommand: ['builder', '--tag', '{image}', '.'],
  imageRepository: 'local/preview',
  containerPort: 8080,
  readinessPath: '/health',
  exposure: { type: 'nodePort', host: '127.0.0.1' },
};

describe('worktree previews', () => {
  let project: string;
  let worktree: string;
  let run: ReturnType<typeof vi.fn<PreviewRunner>>;
  let service: WorktreePreviewService;
  let currentImage: string;

  it('captures actual subprocess stdout, stderr and exit code on failure', async () => {
    let result: { stdout: string; stderr: string; exitCode: number | null } | undefined;
    await expect(
      runPreviewCommand(
        [
          process.execPath,
          '-e',
          'process.stdout.write("built");process.stderr.write("compile error");process.exit(7)',
        ],
        os.tmpdir(),
        undefined,
        5000,
        (value) => {
          result = value;
        }
      )
    ).rejects.toThrow('exited with code 7');
    expect(result).toEqual({ stdout: 'built', stderr: 'compile error', exitCode: 7 });
  });

  beforeEach(async () => {
    project = await mkdtemp(path.join(os.tmpdir(), 'automaker-preview-'));
    worktree = path.join(project, 'feature');
    await mkdir(worktree);
    await mkdir(path.join(project, '.automaker'));
    await writeFile(path.join(project, '.automaker', 'preview.json'), JSON.stringify(config));
    run = vi.fn<PreviewRunner>(async (args, _cwd, input) => {
      if (args[0] === 'git')
        return `worktree ${project}\0\0worktree ${worktree}\0branch refs/heads/feature\0\0`;
      if (args.includes('namespace'))
        return JSON.stringify({
          metadata: { labels: { 'automaker.dev/previews-enabled': 'true' } },
        });
      if (args.includes('apply')) {
        currentImage = JSON.parse(input!).items[0].spec.template.spec.containers[0].image;
      }
      if (args.includes('--ignore-not-found')) return '';
      if (args.includes('service') && args.includes('get'))
        return JSON.stringify({ spec: { ports: [{ nodePort: 31001 }] } });
      if (args.includes('deployment') && args.includes('get'))
        return JSON.stringify({
          metadata: {
            generation: 1,
            labels: { 'automaker.dev/preview': previewId(project, worktree) },
          },
          spec: { template: { spec: { containers: [{ image: currentImage }] } } },
          status: { observedGeneration: 1, readyReplicas: 1, updatedReplicas: 1 },
        });
      return '';
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok'))
    );
    service = new WorktreePreviewService(run, async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(project, { recursive: true, force: true });
  });

  async function settled() {
    await vi.waitFor(async () => {
      const data = JSON.parse(
        await readFile(
          path.join(project, '.automaker', 'previews', `${previewId(project, worktree)}.json`),
          'utf8'
        )
      );
      expect(data.status).not.toBe('deploying');
    });
    return (await service.status(project, worktree)).preview!;
  }

  it('isolates names even when projects or sanitized branch names collide', () => {
    expect(previewId('/a', '/a/feature/x')).not.toBe(previewId('/a', '/a/feature-x'));
    expect(previewId('/a', '/shared/x')).not.toBe(previewId('/b', '/shared/x'));
    expect(previewId('/a', '/a/x')).toMatch(/^[a-z0-9-]{1,63}$/);
  });

  it('builds from the selected worktree and publishes only after rollout and URL readiness', async () => {
    const state = await service.start(project, worktree);
    expect(state.status).toBe('deploying');
    expect(state.url).toBeUndefined();
    const ready = await settled();
    expect(ready.status).toBe('ready');
    expect(ready.url).toBe('http://127.0.0.1:31001');
    const build = run.mock.calls.find(([args]) => args[0] === 'builder')!;
    expect(build[1]).toBe(worktree);
    expect(build[0][2]).toBe(ready.image);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:31001/health');
    const restart = new WorktreePreviewService(run);
    expect((await restart.status(project, worktree)).preview?.status).toBe('ready');
    expect(
      ready.logs?.filter((entry) => entry.status === 'succeeded').map((entry) => entry.step)
    ).toContain('Check preview HTTP readiness');
    expect((await restart.status(project, worktree)).preview?.logs).toEqual(ready.logs);
  });

  it('uses worktree bridge configuration without changing shared frontend defaults or other tasks', async () => {
    await mkdir(path.join(worktree, '.automaker'));
    const devbridge = {
      command: ['/tools/devbridge'],
      configFile: '.devbridge.yaml',
      host: 'preview-host',
      bindHost: '127.0.0.1',
    };
    await writeFile(path.join(worktree, '.automaker/preview.json'), JSON.stringify({ devbridge }));
    expect(await service.config(project, worktree)).toEqual({ ...config, devbridge });
    expect(await service.config(project)).toEqual(config);
    await writeFile(
      path.join(worktree, '.automaker/preview.json'),
      JSON.stringify({ devbridge: { configFile: '../escape.yaml' } })
    );
    await expect(service.start(project, worktree)).rejects.toThrow('Invalid preview devbridge');
    expect(run.mock.calls.some(([args]) => args[0] === 'builder')).toBe(false);
  });

  it('does not call a frontend-only deployment ready after the worktree requires backend bridges', async () => {
    await service.start(project, worktree);
    expect((await settled()).status).toBe('ready');
    await mkdir(path.join(worktree, '.automaker'));
    await writeFile(
      path.join(worktree, '.automaker/preview.json'),
      JSON.stringify({
        devbridge: {
          command: ['/tools/devbridge'],
          configFile: '.devbridge.yaml',
          host: 'preview-host',
          bindHost: '127.0.0.1',
        },
      })
    );
    const status = (await service.status(project, worktree)).preview;
    expect(status?.status).toBe('unavailable');
    expect(status?.error).toContain('without the required backend bridges');
  });

  it('persists the running build step before completion and keeps failure diagnostics', async () => {
    const original = run.getMockImplementation()!;
    let failBuild!: (error: Error) => void;
    run.mockImplementation((...args) =>
      args[0][0] === 'builder'
        ? new Promise((_resolve, reject) => {
            failBuild = reject;
          })
        : original(...args)
    );
    await service.start(project, worktree);
    await vi.waitFor(() => expect(failBuild).toBeDefined());
    const running = (await service.status(project, worktree)).preview!;
    expect(running.status).toBe('deploying');
    expect(running.logs?.at(-1)).toMatchObject({ step: 'Build preview image', status: 'running' });
    failBuild(new Error('builder exited with code 1'));
    const failed = await settled();
    expect(failed.status).toBe('failed');
    const entry = failed.logs?.find((entry) => entry.status === 'failed');
    expect(entry?.step).toBe('Build preview image');
    expect(entry?.message).toContain('builder exited with code 1');
    expect(entry?.message).toContain('Dockerfile');
    expect(failed.logs?.some((entry) => entry.step === 'Apply deployment and service')).toBe(false);
  });

  it('shows the exact build command, redacted output and exit code for a failed step', async () => {
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (args, cwd, input, timeout, capture) => {
      if (args[0] === 'builder') {
        capture?.({
          stdout: 'building',
          stderr: 'Error: missing module\nAuthorization: Bearer example-secret',
          exitCode: 1,
        });
        throw new Error('builder exited with code 1');
      }
      return original(args, cwd, input, timeout, capture);
    });
    await service.start(project, worktree);
    const failed = await settled();
    const entry = failed.logs?.find(
      (log) => log.step === 'Build preview image' && log.status === 'failed'
    );
    expect(entry).toMatchObject({
      command: `builder --tag ${failed.image} .`,
      exitCode: 1,
    });
    expect(entry?.output).toContain('Error: missing module');
    expect(entry?.output).not.toContain('example-secret');
    expect(
      redactPreviewLog('https://user:pass@example.test?token=abc\napi_key=private')
    ).not.toContain('private');
  });

  it('rejects foreign worktrees before executing any build or kubectl command', async () => {
    await expect(service.start(project, '/some/other/worktree')).rejects.toThrow('does not belong');
    expect(run.mock.calls.every(([args]) => args[0] === 'git')).toBe(true);
  });

  it('publishes the devbridge entry only after backend validation and cleans it after config removal', async () => {
    const bridge = new DevbridgePreview(run);
    const bridgeLogs = [
      {
        at: '2026-09-23T01:00:00Z',
        step: 'Devbridge · backend: upload runtime',
        status: 'succeeded' as const,
        message: 'Completed',
      },
    ];
    vi.spyOn(bridge, 'logs').mockResolvedValue(bridgeLogs);
    const start = vi.spyOn(bridge, 'start').mockResolvedValue('http://preview-host:41001');
    const preflight = vi.spyOn(bridge, 'preflight').mockResolvedValue();
    const check = vi.spyOn(bridge, 'check').mockResolvedValue();
    const stop = vi.spyOn(bridge, 'stop').mockResolvedValue();
    const devbridge = {
      command: ['/tools/devbridge'],
      configFile: '.devbridge.yaml',
      host: 'preview-host',
      bindHost: '0.0.0.0',
    };
    await writeFile(
      path.join(project, '.automaker/preview.json'),
      JSON.stringify({ ...config, devbridge })
    );
    service = new WorktreePreviewService(run, async () => {}, bridge);
    await service.start(project, worktree);
    const ready = await settled();
    expect(ready.url).toBe('http://preview-host:41001');
    expect(ready.devbridge).toBe(true);
    expect(ready.logs).toEqual(expect.arrayContaining(bridgeLogs));
    expect(start).toHaveBeenCalledWith(
      project,
      worktree,
      ready.id,
      devbridge,
      'http://127.0.0.1:31001'
    );
    expect(preflight).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith(project, ready.id, ready.url);
    check.mockRejectedValue(new Error('wrong backend session'));
    const restarted = new WorktreePreviewService(run, async () => {}, bridge);
    expect((await restarted.status(project, worktree)).preview?.status).toBe('unavailable');
    await rm(path.join(project, '.automaker/preview.json'));
    await restarted.stop(project, worktree);
    expect(stop).toHaveBeenLastCalledWith(project, ready.id);
  });

  it('withholds the frontend URL when devbridge fails and blocks deletion if session cleanup fails', async () => {
    const bridge = new DevbridgePreview(run);
    vi.spyOn(bridge, 'preflight').mockResolvedValue();
    vi.spyOn(bridge, 'start').mockRejectedValue(new Error('shared backend lacks route guard'));
    const stop = vi.spyOn(bridge, 'stop').mockResolvedValue();
    await writeFile(
      path.join(project, '.automaker/preview.json'),
      JSON.stringify({
        ...config,
        devbridge: {
          command: ['/tools/devbridge'],
          configFile: '.devbridge.yaml',
          host: 'preview-host',
          bindHost: '0.0.0.0',
        },
      })
    );
    service = new WorktreePreviewService(run, async () => {}, bridge);
    await service.start(project, worktree);
    const failed = await settled();
    expect(failed.status).toBe('failed');
    expect(failed.url).toBeUndefined();
    expect(failed.error).toContain('route guard');
    stop.mockRejectedValue(new Error('SSH unavailable'));
    await expect(service.stop(project, worktree)).rejects.toThrow('SSH unavailable');
    expect(run.mock.calls.some(([args]) => args.includes('deployment,service,ingress'))).toBe(
      false
    );
    expect((await service.status(project, worktree)).preview?.status).toBe('failed');
  });

  it('refuses a failed route-guard preflight without replacing an existing preview', async () => {
    const bridge = new DevbridgePreview(run);
    const preflight = vi
      .spyOn(bridge, 'preflight')
      .mockRejectedValue(new Error('cvat-backend route guard unavailable'));
    const start = vi.spyOn(bridge, 'start');
    await writeFile(
      path.join(project, '.automaker/preview.json'),
      JSON.stringify({
        ...config,
        devbridge: {
          command: ['/tools/devbridge'],
          configFile: '.devbridge.yaml',
          host: 'preview-host',
          bindHost: '0.0.0.0',
        },
      })
    );
    service = new WorktreePreviewService(run, async () => {}, bridge);
    await expect(service.start(project, worktree)).rejects.toThrow(
      'cvat-backend route guard unavailable'
    );
    expect(preflight).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([args]) => args[0] === 'builder' || args.includes('apply'))).toBe(
      false
    );
    expect((await service.status(project, worktree)).preview).toBeNull();
  });

  it('refuses namespaces without explicit preview opt-in', async () => {
    run.mockImplementation(async (args) => (args[0] === 'git' ? `worktree ${worktree}\0` : '{}'));
    await service.start(project, worktree);
    expect((await settled()).error).toContain('previews-enabled');
    expect(run.mock.calls.some(([args]) => args[0] === 'builder')).toBe(false);
  });

  it('refuses to overwrite resources it does not own', async () => {
    const normal = run.getMockImplementation()!;
    run.mockImplementation(async (...args) => {
      if (args[0].includes('get') && args[0].includes('deployment')) {
        return JSON.stringify({ metadata: { labels: {} } });
      }
      return normal(...args);
    });
    await service.start(project, worktree);
    expect((await settled()).error).toContain('unowned deployment');
    expect(run.mock.calls.some(([args]) => args[0] === 'builder')).toBe(false);
  });

  it('does not publish an unreachable URL and can clean partial deployment after config removal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('unreachable');
      })
    );
    await service.start(project, worktree);
    const failed = await settled();
    expect(failed.status).toBe('failed');
    expect(failed.url).toBeUndefined();
    await rm(path.join(project, '.automaker', 'preview.json'));
    const stopped = await service.stop(project, worktree);
    expect(stopped?.status).toBe('stopped');
    const deletion = run.mock.calls.find(([args]) =>
      args.includes('deployment,service,ingress')
    )![0];
    expect(deletion).toContain(`automaker.dev/preview=${failed.id}`);
    expect(deletion).toContain(config.context);
    expect(deletion).toContain(config.namespace);
    expect(deletion).not.toContain('--all');
  });

  it('does not show ready when the cluster check fails', async () => {
    await service.start(project, worktree);
    await vi.waitFor(async () => {
      const data = JSON.parse(
        await readFile(
          path.join(project, '.automaker', 'previews', `${previewId(project, worktree)}.json`),
          'utf8'
        )
      );
      expect(data.status).toBe('ready');
    });
    run.mockRejectedValue(new Error('cluster unavailable'));
    expect((await service.status(project, worktree)).preview?.status).toBe('unavailable');
  });

  it('serializes deployment and cleanup and reports interrupted operations after restart', async () => {
    let finishBuild!: () => void;
    const normal = run.getMockImplementation()!;
    run.mockImplementation(async (...args) => {
      if (args[0][0] === 'builder')
        await new Promise<void>((resolve) => {
          finishBuild = resolve;
        });
      return normal(...args);
    });
    await service.start(project, worktree);
    await vi.waitFor(() => expect(finishBuild).toBeDefined());
    await expect(service.start(project, worktree)).rejects.toThrow('already running');
    await expect(service.stop(project, worktree)).rejects.toThrow('already running');
    const restart = new WorktreePreviewService(run);
    expect((await restart.status(project, worktree)).preview?.error).toContain('interrupted');
    finishBuild();
    await settled();
  });

  it('does not report an interrupted operation when deployment finishes during a status read', async () => {
    let finishBuild!: () => void;
    const normal = run.getMockImplementation()!;
    run.mockImplementation(async (...args) => {
      if (args[0][0] === 'builder')
        await new Promise<void>((resolve) => {
          finishBuild = resolve;
        });
      return normal(...args);
    });
    await service.start(project, worktree);
    await vi.waitFor(() => expect(finishBuild).toBeDefined());
    const internals = service as unknown as {
      read: (project: string, id: string) => Promise<unknown>;
    };
    const read = internals.read.bind(service);
    let releaseRead!: () => void;
    const delayedRead = vi.spyOn(internals, 'read').mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args);
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      return snapshot;
    });
    const status = service.status(project, worktree);
    await vi.waitFor(() => expect(releaseRead).toBeDefined());
    finishBuild();
    await settled();
    releaseRead();
    expect((await status).preview?.error).toBeUndefined();
    delayedRead.mockRestore();
  });

  it('keeps cleanup available after deployment configuration becomes invalid', async () => {
    await service.start(project, worktree);
    await settled();
    await writeFile(path.join(project, '.automaker', 'preview.json'), '{');
    const status = await service.status(project, worktree);
    expect(status.success).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.error).toBeTruthy();
    expect(status.preview?.status).toBe('ready');
    expect((await service.stop(project, worktree))?.status).toBe('stopped');
  });

  it('keeps existing workload credentials in Kubernetes and routes ingress only to its own service', () => {
    const manifest = previewManifest(
      {
        ...config,
        secretRefs: ['preview-db'],
        env: { FOO_DEVBRIDGE_API_ONLY: 'true' },
        exposure: { type: 'ingress', domain: 'preview.test', className: 'traefik' },
      },
      'wt-123',
      'local/preview:unique'
    );
    const [deployment, svc, ingress] = manifest.items as any[];
    expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(deployment.spec.template.spec.containers[0].envFrom).toEqual([
      { secretRef: { name: 'preview-db' } },
    ]);
    expect(svc.spec.selector).toEqual(deployment.spec.selector.matchLabels);
    expect(ingress.spec.rules[0].host).toBe('wt-123.preview.test');
    expect(ingress.spec.rules[0].http.paths[0].backend.service.name).toBe('wt-123');
  });

  it.each([
    { namespace: 'default' },
    { namespace: undefined },
    { buildCommand: 'sh -c arbitrary' },
    { containerPort: 0 },
    { exposure: { type: 'nodePort', host: 'host/path' } },
    { exposure: { type: 'ingress', domain: 'preview.test' } },
    { devbridge: {} },
    {
      devbridge: {
        command: ['devbridge'],
        configFile: '../elsewhere.yaml',
        host: 'localhost',
        bindHost: '127.0.0.1',
      },
    },
  ])('rejects malformed config: %j', (override) => {
    expect(() => validatePreviewConfig({ ...config, ...override })).toThrow();
  });
});
