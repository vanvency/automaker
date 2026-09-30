import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { WorktreePreview, WorktreePreviewResponse } from '@automaker/types';
import * as fs from '../lib/secure-fs.js';
import { createLogger } from '@automaker/utils';
import {
  DevbridgePreview,
  validateDevbridgeConfig,
  type DevbridgePreviewConfig,
} from './devbridge-preview.js';

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
  devbridge?: DevbridgePreviewConfig;
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
  if (c.devbridge !== undefined) validateDevbridgeConfig(c.devbridge);
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
  timeout?: number,
  onComplete?: (result: { stdout: string; stderr: string; exitCode: number | null }) => void
) => Promise<string>;

// Never persist raw process output: builds and CLIs may echo their environment.
export function redactPreviewLog(value: string): string {
  let safe = value.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[redacted]');
  safe = safe.replace(
    /((?:authorization|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    '$1[redacted]'
  );
  safe = safe.replace(
    /([?&](?:token|password|secret|api[_-]?key|authorization)=)[^&\s]+/gi,
    '$1[redacted]'
  );
  safe = safe.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  for (const [key, secret] of Object.entries(process.env)) {
    if (
      /(?:token|password|passwd|secret|api[_-]?key|credential)/i.test(key) &&
      secret &&
      secret.length >= 6
    ) {
      safe = safe.replaceAll(secret, '[redacted]');
    }
  }
  return safe.slice(-4000);
}

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
export const runPreviewCommand: PreviewRunner = (
  command,
  cwd,
  input,
  timeout = 30_000,
  onComplete
) =>
  new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let stderr = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-32_000);
    });
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
      onComplete?.({ stdout: output, stderr, exitCode: code });
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
  private bridge: DevbridgePreview;
  constructor(
    private run: PreviewRunner = runPreviewCommand,
    private verifyUrl: (url: string) => Promise<void> = verifyPreviewUrl,
    bridge?: DevbridgePreview
  ) {
    this.bridge = bridge ?? new DevbridgePreview(run);
  }

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

  async config(project: string, worktree = project): Promise<PreviewConfig | null> {
    const read = async (root: string) => {
      try {
        const file = await realpath(path.join(root, '.automaker', 'preview.json'));
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative))
          throw new Error('Preview configuration must stay inside its checkout');
        return JSON.parse((await fs.readFile(file, 'utf8')) as string);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const shared = await read(project);
    const local = worktree === project ? null : await read(worktree);
    if (!shared && !local) return null;
    // A worktree can select its components without duplicating the frontend build
    // defaults. devbridge is replaced as a unit, never merged with another task.
    const config = { ...shared, ...local };
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

  private async step<T>(
    project: string,
    state: WorktreePreview,
    step: string,
    action: (
      capture: (result: { stdout: string; stderr: string; exitCode: number | null }) => void
    ) => Promise<T>,
    hint: string,
    command?: string[]
  ): Promise<T> {
    let result: { stdout: string; stderr: string; exitCode: number | null } | undefined;
    const capture = (value: { stdout: string; stderr: string; exitCode: number | null }) => {
      result = value;
    };
    const record = async (status: 'running' | 'succeeded' | 'failed', message: string) => {
      const at = new Date().toISOString();
      const previous = state.logs?.at(-1);
      const output =
        result &&
        redactPreviewLog(
          [
            result.stdout && `stdout:\n${result.stdout}`,
            result.stderr && `stderr:\n${result.stderr}`,
          ]
            .filter(Boolean)
            .join('\n')
        );
      const entry = {
        at,
        step,
        status,
        message,
        ...(command ? { command: redactPreviewLog(command.join(' ')) } : {}),
        ...(output ? { output } : {}),
        ...(result ? { exitCode: result.exitCode } : {}),
      };
      state.logs = [...(state.logs ?? []), entry].slice(-100);
      state.updatedAt = at;
      await this.save(project, state);
    };
    await record('running', 'Started');
    try {
      const value = await action(capture);
      await record('succeeded', 'Completed');
      return value;
    } catch (error) {
      await record('failed', `${(error as Error).message}. ${hint}`);
      throw error;
    }
  }

  private kubectl(
    state: Pick<WorktreePreview, 'context' | 'namespace'>,
    args: string[],
    cwd: string,
    input?: string,
    timeout?: number,
    capture?: (result: { stdout: string; stderr: string; exitCode: number | null }) => void
  ) {
    const safeCapture =
      capture &&
      ((result: { stdout: string; stderr: string; exitCode: number | null }) =>
        capture({
          ...result,
          stdout: args.includes('json') ? '[Kubernetes JSON omitted]' : result.stdout,
        }));
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
      timeout,
      safeCapture
    );
  }

  private kubectlCommand(
    state: Pick<WorktreePreview, 'context' | 'namespace'>,
    args: string[]
  ): string[] {
    return [
      'kubectl',
      '--context',
      state.context,
      '--namespace',
      state.namespace,
      '--request-timeout=15s',
      ...args,
    ];
  }

  private async checkNamespace(
    state: WorktreePreview,
    project: string,
    capture?: (result: { stdout: string; stderr: string; exitCode: number | null }) => void
  ) {
    const ns = JSON.parse(
      await this.kubectl(
        state,
        ['get', 'namespace', state.namespace, '-o', 'json'],
        project,
        undefined,
        undefined,
        capture
      )
    );
    if (ns.metadata?.labels?.[ENABLED] !== 'true') {
      throw new Error(`Namespace must have ${ENABLED}=true (non-production previews only)`);
    }
  }

  private async checkOwned(
    state: WorktreePreview,
    project: string,
    capture?: (result: { stdout: string; stderr: string; exitCode: number | null }) => void
  ) {
    for (const kind of ['deployment', 'service', 'ingress']) {
      const output = await this.kubectl(
        state,
        ['get', kind, state.id, '--ignore-not-found', '-o', 'json'],
        project,
        undefined,
        undefined,
        capture
      );
      if (output.trim() && JSON.parse(output).metadata?.labels?.[OWNER] !== state.id) {
        throw new Error(`Refusing to modify unowned ${kind} ${state.id}`);
      }
    }
  }

  async status(project: string, worktree: string): Promise<WorktreePreviewResponse> {
    const { projectPath, worktreePath, id } = await this.identity(project, worktree);
    let config: PreviewConfig | null = null;
    let configError: string | undefined;
    try {
      config = await this.config(projectPath, worktreePath);
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
    if (state && config?.devbridge && state.status === 'ready' && !state.devbridge) {
      state = {
        ...state,
        status: 'unavailable',
        error:
          'This preview was deployed without the required backend bridges; redeploy after route-guard preflight passes.',
      };
    }
    if (state) {
      try {
        state.devbridgeConfig = await this.bridge.configSummary(projectPath, id);
      } catch (error) {
        state.devbridgeConfigError = (error as Error).message;
      }
      state = {
        ...state,
        logs: [...(state.logs ?? []), ...(await this.bridge.logs(projectPath, id))].sort(
          (a, b) => Date.parse(a.at) - Date.parse(b.at)
        ),
      };
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
      if (state.devbridge) await this.bridge.check(project, state.id, state.url!);
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
      const c = await this.config(projectPath, worktreePath);
      if (!c) throw new Error('Configure .automaker/preview.json first');
      const previous = await this.read(projectPath, id);
      if (
        previous &&
        previous.status !== 'stopped' &&
        (previous.context !== c.context || previous.namespace !== c.namespace)
      ) {
        throw new Error('Stop the existing preview before changing context or namespace');
      }
      if (c.devbridge) await this.bridge.preflight(projectPath, worktreePath, id, c.devbridge);
      const state: WorktreePreview = {
        id,
        worktreePath,
        context: c.context,
        namespace: c.namespace,
        status: 'deploying',
        image: `${c.imageRepository}:${id}-${randomUUID().slice(0, 8)}`,
        updatedAt: new Date().toISOString(),
        devbridge: !!c.devbridge,
        logs: [],
      };
      await this.bridge.clearLogs(projectPath, id);
      await this.save(projectPath, state);
      void this.deploy(projectPath, state, c);
      return state;
    } catch (error) {
      this.active.delete(id);
      throw error;
    }
  }

  private async deploy(project: string, state: WorktreePreview, c: PreviewConfig) {
    const step = <T>(
      name: string,
      action: (
        capture: (result: { stdout: string; stderr: string; exitCode: number | null }) => void
      ) => Promise<T>,
      hint: string,
      command?: string[]
    ) => this.step(project, state, name, action, hint, command);
    try {
      await step(
        'Validate preview namespace',
        (capture) => this.checkNamespace(state, project, capture),
        'Check cluster connectivity, credentials and the previews-enabled namespace label.',
        this.kubectlCommand(state, ['get', 'namespace', state.namespace, '-o', 'json'])
      );
      await step(
        'Check resource ownership',
        (capture) => this.checkOwned(state, project, capture),
        'Inspect existing resources; Automaker will not overwrite resources owned by another deployment.',
        ['deployment', 'service', 'ingress'].flatMap((kind) => [
          ...this.kubectlCommand(state, [
            'get',
            kind,
            state.id,
            '--ignore-not-found',
            '-o',
            'json',
          ]),
          ';',
        ])
      );
      await step(
        'Clean up previous backend bridge',
        () => this.bridge.stop(project, state.id),
        'Inspect the previous devbridge session and its cleanup permissions.'
      );
      if (c.exposure.type === 'ingress') {
        const className = c.exposure.className;
        await step(
          'Validate ingress class',
          (capture) =>
            this.kubectl(
              state,
              ['get', 'ingressclass', className],
              project,
              undefined,
              undefined,
              capture
            ),
          'Check the ingress class in preview.json and the cluster ingress controller.',
          this.kubectlCommand(state, ['get', 'ingressclass', className])
        );
      }
      const substitute = (args: string[]) =>
        args.map((arg) => arg.replaceAll('{image}', state.image!));
      await step(
        'Build preview image',
        (capture) =>
          this.run(substitute(c.buildCommand), state.worktreePath, undefined, 20 * 60_000, capture),
        'Run preview.json buildCommand in this Worktree to inspect compiler output; check dependencies, Dockerfile and builder availability.',
        substitute(c.buildCommand)
      );
      if (c.loadCommand)
        await step(
          'Load preview image',
          (capture) =>
            this.run(
              substitute(c.loadCommand!),
              state.worktreePath,
              undefined,
              5 * 60_000,
              capture
            ),
          'Check loadCommand, the image registry and cluster image access.',
          substitute(c.loadCommand)
        );
      await step(
        'Apply deployment and service',
        (capture) =>
          this.kubectl(
            state,
            ['apply', '-f', '-'],
            project,
            JSON.stringify(previewManifest(c, state.id, state.image!)),
            undefined,
            capture
          ),
        'Check Kubernetes permissions, resource quotas and the preview configuration.',
        this.kubectlCommand(state, ['apply', '-f', '-'])
      );
      if (c.exposure.type === 'nodePort') {
        // Handles switching from Ingress to NodePort without leaving an old route.
        await step(
          'Remove previous ingress route',
          (capture) =>
            this.kubectl(
              state,
              ['delete', 'ingress', state.id, '--ignore-not-found'],
              project,
              undefined,
              undefined,
              capture
            ),
          'Check permission to delete the previous ingress.',
          this.kubectlCommand(state, ['delete', 'ingress', state.id, '--ignore-not-found'])
        );
      }
      await step(
        'Wait for deployment rollout',
        (capture) =>
          this.kubectl(
            state,
            ['rollout', 'status', `deployment/${state.id}`, '--timeout=180s'],
            project,
            undefined,
            190_000,
            capture
          ),
        'Inspect Pod events and container logs for image pull, startup or readiness probe failures.',
        this.kubectlCommand(state, [
          'rollout',
          'status',
          `deployment/${state.id}`,
          '--timeout=180s',
        ])
      );
      if (c.exposure.type === 'nodePort') {
        const port = await step(
          'Resolve preview address',
          async (capture) => {
            const service = JSON.parse(
              await this.kubectl(
                state,
                ['get', 'service', state.id, '-o', 'json'],
                project,
                undefined,
                undefined,
                capture
              )
            );
            const port = service.spec?.ports?.[0]?.nodePort;
            if (!Number.isInteger(port) || port < 1 || port > 65535)
              throw new Error('No preview NodePort allocated');
            return port;
          },
          'Check the Service and NodePort allocation.',
          this.kubectlCommand(state, ['get', 'service', state.id, '-o', 'json'])
        );
        state.url = `http://${c.exposure.host}:${port}`;
      } else {
        state.url = `http://${state.id}.${c.exposure.domain}`;
      }
      // Verify the browser-facing route, in addition to the Pod readiness probe.
      await step(
        'Check preview HTTP readiness',
        () => this.verifyUrl(`${state.url}${c.readinessPath}`),
        'Check the readiness path, application listener and external route connectivity.',
        ['GET', `${state.url}${c.readinessPath}`]
      );
      if (c.devbridge) {
        state.url = await step(
          'Start backend bridge',
          () => this.bridge.start(project, state.worktreePath, state.id, c.devbridge!, state.url!),
          'Check devbridge configuration, backend startup and tunnel connectivity.'
        );
        await step(
          'Check bridged preview HTTP readiness',
          () => this.verifyUrl(`${state.url}${c.readinessPath}`),
          'Inspect the backend bridge session and browser-facing readiness route.',
          ['GET', `${state.url}${c.readinessPath}`]
        );
      }
      state.status = 'ready';
    } catch (error) {
      state.status = 'failed';
      state.error = (error as Error).message;
      delete state.url;
      try {
        await step(
          'Clean up failed backend bridge',
          () => this.bridge.stop(project, state.id),
          'Inspect the devbridge session before retrying deployment.'
        );
      } catch (cleanupError) {
        state.error += `; Devbridge cleanup failed: ${(cleanupError as Error).message}`;
      }
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
        await this.step(
          projectPath,
          state,
          'Stop backend bridge',
          () => this.bridge.stop(projectPath, id),
          'Check the devbridge session and cleanup permissions.'
        );
        await this.step(
          projectPath,
          state,
          'Validate cleanup namespace',
          (capture) => this.checkNamespace(state, projectPath, capture),
          'Check cluster access and namespace labels.',
          this.kubectlCommand(state, ['get', 'namespace', state.namespace, '-o', 'json'])
        );
        await this.step(
          projectPath,
          state,
          'Check cleanup ownership',
          (capture) => this.checkOwned(state, projectPath, capture),
          'Inspect resource ownership labels before cleanup.',
          ['deployment', 'service', 'ingress'].flatMap((kind) => [
            ...this.kubectlCommand(state, ['get', kind, id, '--ignore-not-found', '-o', 'json']),
            ';',
          ])
        );
        await this.step(
          projectPath,
          state,
          'Delete preview resources',
          (capture) =>
            this.kubectl(
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
              70_000,
              capture
            ),
          'Inspect Kubernetes permissions and resource finalizers; retry Stop Preview after resolving them.',
          this.kubectlCommand(state, [
            'delete',
            'deployment,service,ingress',
            '-l',
            `${OWNER}=${id}`,
            '--ignore-not-found',
            '--wait=true',
            '--timeout=60s',
          ])
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
