import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { WorktreePreview, WorktreePreviewResponse } from '@automaker/types';
import * as fs from '../lib/secure-fs.js';
import { createLogger } from '@automaker/utils';

const logger = createLogger('WorktreePreview');
const OWNER = 'automaker.dev/preview';
const ENABLED = 'automaker.dev/previews-enabled';
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface PreviewConfig {
  enabled: true;
  context: string;
  namespace: string;
  /** Argument array, executed in the selected worktree; {image} is substituted. */
  buildCommand: string[];
  loadCommand?: string[];
  imageRepository: string;
  containerPort: number;
  readinessPath: string;
  exposure:
    | { type: 'nodePort'; host: string }
    | { type: 'ingress'; domain: string; className: string };
  env?: Record<string, string>;
  /** Existing Secrets in the preview namespace; values never leave Kubernetes. */
  secretRefs?: string[];
}

export function validatePreviewConfig(value: unknown): PreviewConfig {
  const c = value as PreviewConfig;
  const command = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && !!s);
  if (
    !c ||
    c.enabled !== true ||
    typeof c.context !== 'string' ||
    !c.context ||
    c.context.startsWith('-') ||
    typeof c.namespace !== 'string' ||
    !dnsLabel.test(c.namespace) ||
    ['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(c.namespace) ||
    !command(c.buildCommand) ||
    !c.buildCommand.some((s) => s.includes('{image}')) ||
    (c.loadCommand !== undefined && !command(c.loadCommand)) ||
    typeof c.imageRepository !== 'string' ||
    !/^[a-z0-9][a-z0-9./:_-]*$/.test(c.imageRepository) ||
    !Number.isInteger(c.containerPort) ||
    c.containerPort < 1 ||
    c.containerPort > 65535 ||
    typeof c.readinessPath !== 'string' ||
    !c.readinessPath.startsWith('/') ||
    !c.exposure ||
    !['nodePort', 'ingress'].includes(c.exposure.type)
  )
    throw new Error('Invalid .automaker/preview.json; see docs/worktree-previews.md');
  const host = c.exposure.type === 'nodePort' ? c.exposure.host : c.exposure.domain;
  if (
    typeof host !== 'string' ||
    host.length > 200 ||
    !host.split('.').every((s) => dnsLabel.test(s))
  ) {
    throw new Error(
      'Preview host/domain must be a hostname or IPv4 address without protocol or port'
    );
  }
  if (
    c.exposure.type === 'ingress' &&
    (typeof c.exposure.className !== 'string' || !dnsLabel.test(c.exposure.className))
  ) {
    throw new Error('Preview ingress className is required');
  }
  if (
    c.env &&
    (typeof c.env !== 'object' ||
      Array.isArray(c.env) ||
      !Object.entries(c.env).every(
        ([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string'
      ))
  ) {
    throw new Error('Preview env must contain string environment variables');
  }
  if (
    c.secretRefs &&
    (!Array.isArray(c.secretRefs) ||
      !c.secretRefs.every((s) => typeof s === 'string' && dnsLabel.test(s)))
  ) {
    throw new Error('Preview secretRefs must contain Secret names');
  }
  return c;
}

export function previewId(projectPath: string, worktreePath: string): string {
  return `wt-${createHash('sha256')
    .update(JSON.stringify([projectPath, worktreePath]))
    .digest('hex')
    .slice(0, 20)}`;
}

/** Only these three owned resources are ever applied or deleted. */
export function previewManifest(c: PreviewConfig, id: string, image: string) {
  const labels = { [OWNER]: id };
  const metadata = { name: id, namespace: c.namespace, labels };
  const items: object[] = [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata,
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'preview',
                image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: c.containerPort }],
                env: Object.entries(c.env ?? {}).map(([name, value]) => ({ name, value })),
                envFrom: (c.secretRefs ?? []).map((name) => ({ secretRef: { name } })),
                readinessProbe: {
                  httpGet: { path: c.readinessPath, port: c.containerPort },
                  periodSeconds: 3,
                  timeoutSeconds: 2,
                  failureThreshold: 20,
                },
                resources: {
                  requests: { cpu: '100m', memory: '128Mi' },
                  limits: { cpu: '2', memory: '1Gi' },
                },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata,
      spec: {
        type: c.exposure.type === 'nodePort' ? 'NodePort' : 'ClusterIP',
        selector: labels,
        ports: [{ port: 80, targetPort: c.containerPort }],
      },
    },
  ];
  if (c.exposure.type === 'ingress')
    items.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata,
      spec: {
        ingressClassName: c.exposure.className,
        rules: [
          {
            host: `${id}.${c.exposure.domain}`,
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: { service: { name: id, port: { number: 80 } } },
                },
              ],
            },
          },
        ],
      },
    });
  return { apiVersion: 'v1', kind: 'List', items };
}

export type PreviewRunner = (
  command: string[],
  cwd: string,
  input?: string,
  timeout?: number
) => Promise<string>;

/** kube-proxy and ingress routing can lag behind a successful Pod rollout. */
export async function verifyPreviewUrl(url: string): Promise<void> {
  let lastError = 'unreachable';
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      await response.body?.cancel();
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      const cause = (error as Error & { cause?: { code?: string } }).cause?.code;
      lastError = cause || (error as Error).message;
    }
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Preview URL readiness failed: ${lastError}`);
}

/** No shell interpolation; bounded logs, time and process-group cleanup. */
export const runPreviewCommand: PreviewRunner = (command, cwd, input, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32_000);
    };
    child.stdout.on('data', append);
    child.stderr.resume();
    child.stdin.on('error', () => {
      /* A failed command can close stdin early. */
    });
    child.stdin.end(input);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      } else child.kill('SIGKILL');
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Build logs can contain credentials: report only the failing program, not output.
      if (code !== 0 || timedOut)
        reject(
          new Error(
            `${path.basename(command[0])} ${timedOut ? 'timed out' : `exited with code ${code}`}`
          )
        );
      else resolve(output);
    });
  });

export class WorktreePreviewService {
  private active = new Set<string>();
  private health = new Map<string, { until: number; value: Promise<WorktreePreview> }>();
  constructor(
    private run: PreviewRunner = runPreviewCommand,
    private verifyUrl: (url: string) => Promise<void> = verifyPreviewUrl
  ) {}

  private async identity(project: string, worktree: string, requireWorktree = false) {
    const projectPath = await realpath(project);
    // Keep cleanup possible after a worktree was removed outside Automaker.
    const worktreePath = await realpath(worktree).catch(() => path.resolve(worktree));
    if (requireWorktree) {
      const list = await this.run(['git', 'worktree', 'list', '--porcelain', '-z'], projectPath);
      if (!list.split('\0').includes(`worktree ${worktreePath}`)) {
        throw new Error('Worktree does not belong to this project');
      }
    }
    return { projectPath, worktreePath, id: previewId(projectPath, worktreePath) };
  }

  private statePath(project: string, id: string) {
    return path.join(project, '.automaker', 'previews', `${id}.json`);
  }

  async config(project: string): Promise<PreviewConfig | null> {
    let content: string;
    try {
      content = (await fs.readFile(
        path.join(project, '.automaker', 'preview.json'),
        'utf8'
      )) as string;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const config = JSON.parse(content);
    if (config.enabled === false) return null;
    return validatePreviewConfig(config);
  }

  private async read(project: string, id: string): Promise<WorktreePreview | null> {
    try {
      return JSON.parse((await fs.readFile(this.statePath(project, id), 'utf8')) as string);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async save(project: string, state: WorktreePreview) {
    const file = this.statePath(project, state.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, file);
    this.health.delete(state.id);
  }

  private kubectl(
    state: Pick<WorktreePreview, 'context' | 'namespace'>,
    args: string[],
    cwd: string,
    input?: string,
    timeout?: number
  ) {
    return this.run(
      [
        'kubectl',
        '--context',
        state.context,
        '--namespace',
        state.namespace,
        '--request-timeout=15s',
        ...args,
      ],
      cwd,
      input,
      timeout
    );
  }

  private async checkNamespace(state: WorktreePreview, project: string) {
    const ns = JSON.parse(
      await this.kubectl(state, ['get', 'namespace', state.namespace, '-o', 'json'], project)
    );
    if (ns.metadata?.labels?.[ENABLED] !== 'true') {
      throw new Error(`Namespace must have ${ENABLED}=true (non-production previews only)`);
    }
  }

  private async checkOwned(state: WorktreePreview, project: string) {
    for (const kind of ['deployment', 'service', 'ingress']) {
      const output = await this.kubectl(
        state,
        ['get', kind, state.id, '--ignore-not-found', '-o', 'json'],
        project
      );
      if (output.trim() && JSON.parse(output).metadata?.labels?.[OWNER] !== state.id) {
        throw new Error(`Refusing to modify unowned ${kind} ${state.id}`);
      }
    }
  }

  async status(project: string, worktree: string): Promise<WorktreePreviewResponse> {
    const { projectPath, id } = await this.identity(project, worktree);
    let config: PreviewConfig | null = null;
    let configError: string | undefined;
    try {
      config = await this.config(projectPath);
    } catch (error) {
      configError = (error as Error).message;
    }
    // A deployment can finish while the old state file is being read.
    const wasActive = this.active.has(id);
    let state = await this.read(projectPath, id);
    if (
      state &&
      ['deploying', 'stopping'].includes(state.status) &&
      !wasActive &&
      !this.active.has(id)
    ) {
      state = {
        ...state,
        status: 'failed',
        error: 'Operation interrupted by server restart; redeploy or stop to recover',
      };
    }
    if (state && ['ready', 'unavailable'].includes(state.status)) {
      let cached = this.health.get(id);
      if (!cached || cached.until < Date.now()) {
        const snapshot = state;
        cached = { until: Date.now() + 10_000, value: this.checkReady(projectPath, snapshot) };
        this.health.set(id, cached);
      }
      state = await cached.value;
    }
    return { success: true, configured: !!config, preview: state, error: configError };
  }

  private async checkReady(project: string, state: WorktreePreview): Promise<WorktreePreview> {
    try {
      const deployment = JSON.parse(
        await this.kubectl(state, ['get', 'deployment', state.id, '-o', 'json'], project)
      );
      if (
        deployment.metadata?.labels?.[OWNER] !== state.id ||
        deployment.status?.observedGeneration < deployment.metadata?.generation ||
        deployment.status?.readyReplicas !== 1 ||
        deployment.status?.updatedReplicas !== 1 ||
        deployment.spec?.template?.spec?.containers?.[0]?.image !== state.image
      ) {
        throw new Error('Preview deployment is not ready');
      }
      return { ...state, status: 'ready', error: undefined };
    } catch (error) {
      return { ...state, status: 'unavailable', error: (error as Error).message };
    }
  }

  async start(project: string, worktree: string): Promise<WorktreePreview> {
    const { projectPath, worktreePath, id } = await this.identity(project, worktree, true);
    if (this.active.has(id)) throw new Error('A preview operation is already running');
    this.active.add(id);
    try {
      const c = await this.config(projectPath);
      if (!c) throw new Error('Configure .automaker/preview.json first');
      const previous = await this.read(projectPath, id);
      if (
        previous &&
        previous.status !== 'stopped' &&
        (previous.context !== c.context || previous.namespace !== c.namespace)
      ) {
        throw new Error('Stop the existing preview before changing context or namespace');
      }
      const state: WorktreePreview = {
        id,
        worktreePath,
        context: c.context,
        namespace: c.namespace,
        status: 'deploying',
        image: `${c.imageRepository}:${id}-${randomUUID().slice(0, 8)}`,
        updatedAt: new Date().toISOString(),
      };
      await this.save(projectPath, state);
      void this.deploy(projectPath, state, c);
      return state;
    } catch (error) {
      this.active.delete(id);
      throw error;
    }
  }

  private async deploy(project: string, state: WorktreePreview, c: PreviewConfig) {
    try {
      await this.checkNamespace(state, project);
      await this.checkOwned(state, project);
      if (c.exposure.type === 'ingress') {
        await this.kubectl(state, ['get', 'ingressclass', c.exposure.className], project);
      }
      const substitute = (args: string[]) =>
        args.map((arg) => arg.replaceAll('{image}', state.image!));
      await this.run(substitute(c.buildCommand), state.worktreePath, undefined, 20 * 60_000);
      if (c.loadCommand)
        await this.run(substitute(c.loadCommand), state.worktreePath, undefined, 5 * 60_000);
      await this.kubectl(
        state,
        ['apply', '-f', '-'],
        project,
        JSON.stringify(previewManifest(c, state.id, state.image!))
      );
      if (c.exposure.type === 'nodePort') {
        // Handles switching from Ingress to NodePort without leaving an old route.
        await this.kubectl(state, ['delete', 'ingress', state.id, '--ignore-not-found'], project);
      }
      await this.kubectl(
        state,
        ['rollout', 'status', `deployment/${state.id}`, '--timeout=180s'],
        project,
        undefined,
        190_000
      );
      if (c.exposure.type === 'nodePort') {
        const service = JSON.parse(
          await this.kubectl(state, ['get', 'service', state.id, '-o', 'json'], project)
        );
        const port = service.spec?.ports?.[0]?.nodePort;
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error('No preview NodePort allocated');
        state.url = `http://${c.exposure.host}:${port}`;
      } else {
        state.url = `http://${state.id}.${c.exposure.domain}`;
      }
      // Verify the browser-facing route, in addition to the Pod readiness probe.
      await this.verifyUrl(`${state.url}${c.readinessPath}`);
      state.status = 'ready';
    } catch (error) {
      state.status = 'failed';
      state.error = (error as Error).message;
      delete state.url;
    } finally {
      state.updatedAt = new Date().toISOString();
      try {
        await this.save(project, state);
      } catch (error) {
        logger.error('Could not persist preview result', error);
      }
      this.active.delete(state.id);
    }
  }

  async stop(project: string, worktree: string): Promise<WorktreePreview | null> {
    const { projectPath, id } = await this.identity(project, worktree);
    if (this.active.has(id)) throw new Error('A preview operation is already running');
    this.active.add(id);
    try {
      const state = await this.read(projectPath, id);
      if (!state || state.status === 'stopped') return state;
      // Stored coordinates allow cleanup after settings are disabled or changed.
      state.status = 'stopping';
      await this.save(projectPath, state);
      try {
        await this.checkNamespace(state, projectPath);
        await this.checkOwned(state, projectPath);
        await this.kubectl(
          state,
          [
            'delete',
            'deployment,service,ingress',
            '-l',
            `${OWNER}=${id}`,
            '--ignore-not-found',
            '--wait=true',
            '--timeout=60s',
          ],
          projectPath,
          undefined,
          70_000
        );
        state.status = 'stopped';
        delete state.url;
        delete state.error;
      } catch (error) {
        state.status = 'failed';
        state.error = (error as Error).message;
        delete state.url;
        throw error;
      } finally {
        state.updatedAt = new Date().toISOString();
        await this.save(projectPath, state);
      }
      return state;
    } finally {
      this.active.delete(id);
    }
  }
}

export const worktreePreviewService = new WorktreePreviewService();
