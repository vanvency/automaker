import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from '../lib/secure-fs.js';
import { createLogger } from '@automaker/utils';
import {
  DEFAULT_JIRA_SYNC_CONFIG,
  type JiraSyncConfig,
  type JiraSyncRun,
  type JiraSyncStatus,
} from '@automaker/types';
import type { SettingsService } from './settings-service.js';

const exec = promisify(execFile);
const logger = createLogger('JiraSync');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const safeString = (s: unknown, max = 2048): s is string =>
  typeof s === 'string' && s.length <= max && !s.includes('\0');

export function validateJiraSyncConfig(input: unknown): JiraSyncConfig {
  const c = input as JiraSyncConfig;
  if (!c || typeof c !== 'object') throw new Error('Jira configuration is required');
  const url = new URL(c.jiraUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Jira URL must be HTTP(S), without credentials or query parameters');
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(c.jiraProject) || !safeString(c.jql, 8000) || !c.jql.trim())
    throw new Error('Jira project and JQL are required');
  for (const key of ['enabled', 'autoStart', 'branchIncludeLabel', 'humanInput'] as const) {
    if (typeof c[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  }
  if (
    !Number.isInteger(c.intervalMinutes) ||
    c.intervalMinutes < 1 ||
    c.intervalMinutes > 1440 ||
    !Number.isInteger(c.maxDispatchPerRun) ||
    c.maxDispatchPerRun < 1 ||
    c.maxDispatchPerRun > 4
  )
    throw new Error('Invalid interval or dispatch limit');
  for (const labels of [c.autoLabels, c.manualLabels]) {
    if (
      !Array.isArray(labels) ||
      labels.length > 50 ||
      !labels.every((s) => safeString(s, 100) && /^[\w-]+$/.test(s))
    )
      throw new Error('Invalid Jira labels');
  }
  if (!c.autoLabels.length && !c.manualLabels.length)
    throw new Error('At least one label is required');
  if (
    c.hierarchyImport !== undefined &&
    (!c.hierarchyImport ||
      !['story', 'task'].includes(c.hierarchyImport.executionUnit) ||
      !['story', 'epic'].includes(c.hierarchyImport.worktreeScope))
  )
    throw new Error('Invalid hierarchy import options');
  if (c.autoLabels.some((label) => c.manualLabels.includes(label)))
    throw new Error('Auto and manual labels must not overlap');
  if (
    !['story', 'task'].includes(c.executionUnit) ||
    !['story', 'epic'].includes(c.worktreeScope) ||
    !['off', 'completion', 'milestones'].includes(c.writeback) ||
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(c.reasoningEffort) ||
    !safeString(c.model, 200) ||
    !c.model
  )
    throw new Error('Invalid execution configuration');
  if (
    !safeString(c.targetBranch, 150) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(c.targetBranch) ||
    c.targetBranch.includes('..') ||
    c.targetBranch.endsWith('/')
  )
    throw new Error('Invalid target branch');
  if (
    !safeString(c.gitlabHost, 250) ||
    (c.gitlabHost && !/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(c.gitlabHost))
  )
    throw new Error('Invalid GitLab host');
  for (const mapping of [c.reviewerOverrides, c.branchPrefixes]) {
    if (
      !mapping ||
      typeof mapping !== 'object' ||
      Array.isArray(mapping) ||
      Object.entries(mapping).length > 200 ||
      !Object.entries(mapping).every(([k, v]) => safeString(k, 100) && safeString(v, 100))
    )
      throw new Error('Invalid mapping');
  }
  if (!Object.values(c.branchPrefixes).every((v) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v)))
    throw new Error('Invalid branch prefix');
  // Explicit allowlist: browser configuration never supplies commands or credential paths.
  return {
    ...(Object.fromEntries(
      Object.keys(DEFAULT_JIRA_SYNC_CONFIG).map((key) => [key, c[key as keyof JiraSyncConfig]])
    ) as unknown as JiraSyncConfig),
    hierarchyImport: c.hierarchyImport ?? {
      executionUnit: c.executionUnit,
      worktreeScope: c.worktreeScope,
    },
  };
}

export function legacyJiraConfig(c: Record<string, any>): JiraSyncConfig {
  return validateJiraSyncConfig({
    ...DEFAULT_JIRA_SYNC_CONFIG,
    enabled: true,
    jiraUrl: c.jiraUrl,
    jiraProject: c.jiraProject,
    jql: c.jql,
    autoLabels: c.jiraLabels?.autoStart ?? (c.jiraLabel ? [c.jiraLabel] : []),
    manualLabels: c.jiraLabels?.manualStart ?? [],
    autoStart: !!c.dispatchEnabled,
    model: c.model,
    reasoningEffort: c.reasoningEffort ?? 'medium',
    executionUnit: c.executionUnit ?? 'story',
    worktreeScope: c.worktreeScope ?? 'story',
    hierarchyImport: c.hierarchyImport ?? {
      executionUnit: c.executionUnit ?? 'story',
      worktreeScope: c.worktreeScope ?? 'story',
    },
    targetBranch: c.targetBranch ?? 'dev',
    branchIncludeLabel: !!c.branchIncludeLabel,
    branchPrefixes: c.branchPrefixes ?? {},
    gitlabHost: c.gitlabHost ?? '',
    reviewerOverrides: c.reviewerOverrides ?? {},
    writeback: c.jiraProgressMode ?? 'off',
    humanInput: !!c.jiraHumanInputEnabled,
  });
}

interface Runtime {
  projectPath: string;
  managed: boolean;
  migrated?: boolean;
  legacyDir?: string;
  nextRunAt?: string;
  runs: JiraSyncRun[];
  /** Server-only paths/commands; never included in HTTP responses. */
  worker?: Record<string, string>;
}

export class JiraSyncService {
  private busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private children = new Set<ReturnType<typeof spawn>>();
  constructor(
    private settings: SettingsService,
    private dataDir: string
  ) {
    this.dataDir = path.resolve(dataDir);
  }
  private id(project: string) {
    return createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 24);
  }
  private dir(project: string) {
    return path.join(this.dataDir, 'jira-sync', this.id(project));
  }
  private async read<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse((await fs.readFile(file, 'utf8')) as string);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw error;
    }
  }
  private async write(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  private runtime(project: string) {
    return this.read<Runtime>(path.join(this.dir(project), 'runtime.json'), {
      projectPath: project,
      managed: false,
      runs: [],
    });
  }
  private saveRuntime(r: Runtime) {
    return this.write(path.join(this.dir(r.projectPath), 'runtime.json'), r);
  }
  private async legacy(project: string) {
    const c = await this.read<Record<string, any> | null>(
      path.join(this.dataDir, 'jira-monitor/config.json'),
      null
    );
    return c && path.resolve(c.projectPath) === path.resolve(project) ? c : null;
  }
  async status(project: string): Promise<JiraSyncStatus> {
    const [settings, runtime, legacy] = await Promise.all([
      this.settings.getProjectSettings(project),
      this.runtime(project),
      this.legacy(project),
    ]);
    const state = await this.read<{
      jobs?: Record<string, { featureId?: string; status?: string; dispatchClaim?: string }>;
    }>(path.join(this.dir(project), 'state.json'), {});
    return {
      config: settings.jiraSync
        ? validateJiraSyncConfig(settings.jiraSync)
        : legacy
          ? legacyJiraConfig(legacy)
          : null,
      runs: runtime.runs.slice(-50).reverse(),
      running: this.busy.has(this.id(project)),
      nextRunAt: runtime.nextRunAt,
      legacyAvailable: !!legacy,
      migrated: !!runtime.migrated,
      jobCount: Object.keys(state.jobs ?? {}).length,
      jobs: Object.entries(state.jobs ?? {}).map(([issueKey, job]) => ({
        issueKey,
        featureId: job.featureId,
        status: job.status ?? 'unknown',
        claimed: !!job.dispatchClaim,
      })),
    };
  }
  async save(project: string, input: unknown) {
    const id = this.id(project);
    if (this.busy.has(id)) throw new Error('Wait for the current Jira operation to finish');
    this.busy.add(id);
    try {
      return await this.saveConfig(project, input);
    } finally {
      this.busy.delete(id);
    }
  }
  private async saveConfig(project: string, input: unknown) {
    const config = validateJiraSyncConfig(input);
    const legacy = await this.legacy(project);
    const runtime = await this.runtime(project);
    if (legacy && !runtime.migrated && config.enabled)
      throw new Error('Migrate the legacy scheduler before enabling this project');
    const old = (await this.settings.getProjectSettings(project)).jiraSync;
    if (old?.jiraUrl && old.jiraUrl !== config.jiraUrl && runtime.migrated)
      throw new Error(
        'Migrated Jira identity cannot be changed; create a separate project integration'
      );
    await this.settings.updateProjectSettings(project, { jiraSync: config });
    runtime.managed = true;
    runtime.nextRunAt = config.enabled
      ? new Date(Date.now() + config.intervalMinutes * 60000).toISOString()
      : undefined;
    runtime.runs.push({
      id: randomUUID(),
      mode: 'config',
      status: 'success',
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: `Configuration saved; changed: ${Object.keys(config)
        .filter(
          (k) =>
            JSON.stringify(old?.[k as keyof JiraSyncConfig]) !==
            JSON.stringify(config[k as keyof JiraSyncConfig])
        )
        .join(', ')}`,
    });
    runtime.runs = runtime.runs.slice(-50);
    await this.saveRuntime(runtime);
    return this.status(project);
  }
  async migrate(project: string) {
    const id = this.id(project);
    if (this.busy.has(id)) throw new Error('Jira operation already running');
    this.busy.add(id);
    try {
      const runtime = await this.runtime(project);
      if (runtime.migrated) return await this.status(project);
      const legacy = await this.legacy(project);
      if (!legacy) throw new Error('No matching legacy Jira configuration');
      const config = legacyJiraConfig(legacy);
      const legacyDir = path.join(this.dataDir, 'jira-monitor');
      // Stop admission first; let an already-running tick complete instead of killing a dispatch.
      await exec('systemctl', ['disable', '--now', 'automaker-jira-monitor.timer'], {
        timeout: 15000,
      });
      const active = await exec(
        'systemctl',
        ['show', 'automaker-jira-monitor.service', '-p', 'ActiveState', '--value'],
        { timeout: 10000 }
      );
      if (['active', 'activating', 'deactivating'].includes(active.stdout.trim())) {
        throw new Error(
          'Legacy timer paused; current tick is finishing. Retry migration after it completes.'
        );
      }
      await this.worker({
        config: legacy,
        mode: 'migration',
        legacyDir,
        statePath: path.join(this.dir(project), 'state.json'),
        lockPath: path.join(legacyDir, 'monitor.lock'),
      });
      const state = await this.read<Record<string, unknown>>(
        path.join(this.dir(project), 'state.json'),
        { jobs: {} }
      );
      runtime.worker = Object.fromEntries(
        ['jiraCommand', 'gitlabTokenFile', 'gitlabApiUrl', 'jiraMonitorUser']
          .filter((key) => typeof legacy[key] === 'string')
          .map((key) => [key, legacy[key]])
      );
      runtime.legacyDir = legacyDir;
      runtime.managed = true;
      runtime.migrated = true;
      runtime.nextRunAt = new Date(Date.now() + config.intervalMinutes * 60000).toISOString();
      runtime.runs.push({
        id: randomUUID(),
        mode: 'migration',
        status: 'success',
        trigger: 'migration',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: `Legacy state preserved (${Object.keys((state.jobs as object) ?? {}).length} jobs); timer disabled`,
      });
      await this.settings.updateProjectSettings(project, { jiraSync: config });
      await this.saveRuntime(runtime);
      await this.write(path.join(legacyDir, 'managed-by-automaker.json'), {
        projectPath: project,
        migratedAt: new Date().toISOString(),
      });
      return this.status(project);
    } finally {
      this.busy.delete(id);
    }
  }
  async startRun(
    project: string,
    mode: 'test' | 'preview' | 'sync',
    draft?: unknown,
    trigger: 'manual' | 'schedule' = 'manual'
  ) {
    if (this.stopping) throw new Error('Server is shutting down');
    const id = this.id(project);
    if (this.busy.has(id)) throw new Error('A Jira sync is already running');
    this.busy.add(id);
    try {
      const runtime = await this.runtime(project);
      const saved = (await this.settings.getProjectSettings(project)).jiraSync;
      const config = validateJiraSyncConfig(draft && mode !== 'sync' ? draft : saved);
      if (trigger === 'schedule' && !config.enabled)
        throw new Error('Scheduled Jira synchronization is paused');
      if (mode === 'sync' && (await this.legacy(project)) && !runtime.migrated)
        throw new Error('Migrate legacy monitoring before synchronization');
      const run: JiraSyncRun = {
        id: randomUUID(),
        mode,
        status: 'running',
        startedAt: new Date().toISOString(),
        trigger,
      };
      runtime.runs.push(run);
      runtime.runs = runtime.runs.slice(-50);
      await this.saveRuntime(runtime);
      void this.execute(project, config, runtime, run);
      return run;
    } catch (error) {
      this.busy.delete(id);
      throw error;
    }
  }
  private async execute(project: string, c: JiraSyncConfig, runtime: Runtime, run: JiraSyncRun) {
    try {
      if (runtime.migrated) {
        const timer = await exec(
          'systemctl',
          ['show', 'automaker-jira-monitor.timer', '-p', 'ActiveState', '--value'],
          { timeout: 10000 }
        );
        if (timer.stdout.trim() === 'active')
          throw new Error(
            'Legacy timer is active; managed sync refused to avoid duplicate dispatch'
          );
      }
      const config = {
        ...runtime.worker,
        ...c,
        jiraCommand:
          runtime.worker?.jiraCommand || process.env.JIRA_CLI_PATH || '/usr/local/bin/jira',
        projectPath: project,
        jiraLabels: { autoStart: c.autoLabels, manualStart: c.manualLabels },
        jiraProgressMode: c.writeback,
        jiraHumanInputEnabled: c.humanInput,
        automakerUrl: `http://127.0.0.1:${process.env.PORT || 3008}`,
        apiKeyFile: path.join(this.dataDir, '.api-key'),
      };
      const result = await this.worker({
        config,
        mode: run.mode,
        runId: run.id,
        statePath: path.join(this.dir(project), 'state.json'),
        lockPath: path.join(runtime.legacyDir ?? this.dir(project), 'monitor.lock'),
      });
      run.status = 'success';
      run.changes = result.changes;
      run.message = result.message;
    } catch (error) {
      run.status = this.stopping ? 'interrupted' : 'failed';
      run.error = (error as Error).message;
    } finally {
      run.finishedAt = new Date().toISOString();
      runtime.nextRunAt = c.enabled
        ? new Date(Date.now() + c.intervalMinutes * 60000).toISOString()
        : undefined;
      try {
        await this.saveRuntime(runtime);
      } catch {
        logger.error('Could not persist Jira sync result');
      }
      this.busy.delete(this.id(project));
    }
  }
  private worker(input: object): Promise<{ changes: JiraSyncRun['changes']; message: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('python3', [path.join(repoRoot, 'scripts/jira-sync-worker.py')], {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      this.children.add(child);
      let output = '';
      const timer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }, 10 * 60000);
      child.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-2_000_000);
      });
      child.stderr.resume(); // CLI output may include credentials; do not publish it.
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
      child.on('error', () => {
        clearTimeout(timer);
        this.children.delete(child);
        reject(new Error('Could not start Jira worker'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        try {
          const result = JSON.parse(output);
          if (code !== 0 || !result.success) throw new Error(result.error || 'Jira worker failed');
          resolve(result);
        } catch (error) {
          reject(
            new Error(
              code === null ? 'Jira worker interrupted or timed out' : (error as Error).message
            )
          );
        }
      });
    });
  }
  start() {
    this.timer = setInterval(
      () => void this.poll().catch(() => logger.warn('Jira scheduler scan failed')),
      15000
    );
    this.timer.unref();
    void this.poll().catch(() => logger.warn('Jira scheduler startup scan failed'));
  }
  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const child of this.children) {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* exited */
        }
      }
    }
  }
  private async poll() {
    if (this.stopping) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(this.dataDir, 'jira-sync'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!/^[a-f0-9]{24}$/.test(entry)) continue;
      const runtime = await this.read<Runtime | null>(
        path.join(this.dataDir, 'jira-sync', entry, 'runtime.json'),
        null
      );
      if (!runtime?.managed || this.busy.has(this.id(runtime.projectPath))) continue;
      for (const run of runtime.runs) {
        if (run.status === 'running') {
          run.status = 'interrupted';
          run.finishedAt = new Date().toISOString();
          run.error =
            'Server restarted; uncertain dispatch claims are preserved and will not be replayed';
          await this.saveRuntime(runtime);
        }
      }
      const config = (await this.settings.getProjectSettings(runtime.projectPath)).jiraSync;
      if (config?.enabled && (!runtime.nextRunAt || Date.parse(runtime.nextRunAt) <= Date.now())) {
        await this.startRun(runtime.projectPath, 'sync', undefined, 'schedule').catch((error) =>
          logger.warn((error as Error).message)
        );
      }
    }
  }
}
