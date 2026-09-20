import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WorktreePreviewService,
  previewId,
  previewManifest,
  validatePreviewConfig,
  type PreviewConfig,
  type PreviewRunner,
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
  });

  it('rejects foreign worktrees before executing any build or kubectl command', async () => {
    await expect(service.start(project, '/some/other/worktree')).rejects.toThrow('does not belong');
    expect(run.mock.calls.every(([args]) => args[0] === 'git')).toBe(true);
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
  ])('rejects malformed config: %j', (override) => {
    expect(() => validatePreviewConfig({ ...config, ...override })).toThrow();
  });
});
