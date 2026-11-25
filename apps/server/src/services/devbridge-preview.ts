import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as fs from '../lib/secure-fs.js';
import type { PreviewRunner } from './worktree-preview-service.js';
import type { WorktreePreview } from '@automaker/types';

export interface DevbridgePreviewConfig {
  /** Compiled devbridge executable, available on the Automaker server. */
  command: string[];
  /** Relative to the selected worktree, never the shared project checkout. */
  configFile: string;
  /** Go source directory relative to each worktree. */
  sourcePath?: string;
  /** Address the browser uses to reach Automaker's preview listeners. */
  host: string;
  bindHost: string;
  previewPort?: number;
}

interface Session {
  ready: boolean;
  route_id: string;
  proxy_url: string;
  preview_address: string;
  health_path: string;
  apps?: Array<{ name: string; ready: boolean; route_id: string; health_path: string }>;
}

function relativePath(value: unknown, allowDot = false): value is string {
  return (
    typeof value === 'string' &&
    !!value &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes('..') &&
    (allowDot || value !== '.')
  );
}

export function validateDevbridgeConfig(c: DevbridgePreviewConfig): void {
  if (
    !c ||
    !Array.isArray(c.command) ||
    !c.command.length ||
    !c.command.every((v) => typeof v === 'string' && !!v) ||
    !relativePath(c.configFile) ||
    (c.sourcePath !== undefined && !relativePath(c.sourcePath, true)) ||
    typeof c.host !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(c.host) ||
    typeof c.bindHost !== 'string' ||
    !isIP(c.bindHost) ||
    (c.previewPort !== undefined &&
      (!Number.isInteger(c.previewPort) || c.previewPort < 1024 || c.previewPort > 65535))
  ) {
    throw new Error('Invalid preview devbridge configuration; see docs/worktree-previews.md');
  }
}

/** One child and one persistent cleanup record per worktree; no project-wide session. */
export class DevbridgePreview {
  private children = new Map<string, { child: ChildProcess; done: Promise<void> }>();

  constructor(private run: PreviewRunner) {}

  private directory(project: string, id: string) {
    return path.join(project, '.automaker', 'previews', `${id}.devbridge`);
  }

  private progressPath(project: string, id: string) {
    return path.join(this.directory(project, id), 'progress.jsonl');
  }

  async clearLogs(project: string, id: string): Promise<void> {
    await fs.mkdir(this.directory(project, id), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.progressPath(project, id), '', { mode: 0o600 });
    await fs
      .unlink(path.join(this.directory(project, id), 'config-summary.json'))
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
  }

  async configSummary(project: string, id: string): Promise<WorktreePreview['devbridgeConfig']> {
    let raw: string;
    try {
      raw = (await fs.readFile(
        path.join(this.directory(project, id), 'config-summary.json'),
        'utf8'
      )) as string;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Could not read the devbridge configuration snapshot');
    }
    // Validate and project known display fields; never return arbitrary config JSON.
    try {
      const value = JSON.parse(raw);
      const text = (item: unknown): string => {
        if (typeof item !== 'string' || item.length > 500) throw new Error();
        return item;
      };
      const number = (item: unknown): number => {
        if (!Number.isSafeInteger(item) || (item as number) < 0) throw new Error();
        return item as number;
      };
      const list = (items: unknown): string[] => {
        if (!Array.isArray(items) || items.length > 200) throw new Error();
        return items.map(text);
      };
      if (
        !Array.isArray(value.components) ||
        value.components.length > 100 ||
        typeof value.autoReattach !== 'boolean' ||
        !Number.isFinite(Date.parse(value.capturedAt))
      )
        throw new Error();
      return {
        capturedAt: text(value.capturedAt),
        configFile: text(value.configFile),
        sourceRoot: text(value.sourceRoot),
        stripPrefix: text(value.stripPrefix),
        namespace: text(value.namespace),
        gateway: text(value.gateway),
        listen: text(value.listen),
        autoReattach: value.autoReattach,
        maxAttempts: number(value.maxAttempts),
        components: value.components.map((component: Record<string, unknown>) => {
          if (!['changed', 'unchanged', 'unknown'].includes(component.changeStatus as string))
            throw new Error();
          return {
            name: text(component.name),
            configFile: component.configFile === undefined ? '' : text(component.configFile),
            dir: text(component.dir),
            target: text(component.target),
            localPort: number(component.localPort),
            remotePort: number(component.remotePort),
            routes: list(component.routes),
            healthPath: text(component.healthPath),
            buildTool: text(component.buildTool),
            environmentKeys: list(component.environmentKeys),
            changeStatus: component.changeStatus as 'changed' | 'unchanged' | 'unknown',
            changedFiles: number(component.changedFiles),
            baseRef: text(component.baseRef),
          };
        }),
      };
    } catch {
      throw new Error(
        'Invalid devbridge configuration snapshot; redeploy with devbridge 0.3.2 or newer'
      );
    }
  }

  async logs(project: string, id: string): Promise<NonNullable<WorktreePreview['logs']>> {
    try {
      const content = (await fs.readFile(this.progressPath(project, id), 'utf8')) as string;
      return content
        .split('\n')
        .flatMap((line) => {
          try {
            const entry = JSON.parse(line);
            if (
              typeof entry.at !== 'string' ||
              !Number.isFinite(Date.parse(entry.at)) ||
              typeof entry.step !== 'string' ||
              !entry.step.startsWith('Devbridge · ') ||
              entry.step.length > 200 ||
              typeof entry.message !== 'string' ||
              entry.message.length > 300 ||
              !['running', 'succeeded', 'failed'].includes(entry.status)
            )
              return [];
            return [
              { at: entry.at, step: entry.step, status: entry.status, message: entry.message },
            ];
          } catch {
            // The writer may still be appending the final line.
            return [];
          }
        })
        .slice(-500);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async session(project: string, id: string): Promise<Session> {
    return JSON.parse(
      (await fs.readFile(path.join(this.directory(project, id), 'session.json'), 'utf8')) as string
    );
  }

  private async sourceAndConfig(worktree: string, config: DevbridgePreviewConfig) {
    const source = await realpath(path.join(worktree, config.sourcePath ?? '.'));
    const sourceRelative = path.relative(worktree, source);
    if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) {
      throw new Error('Devbridge source must stay inside the selected worktree');
    }
    const configPath = await realpath(path.join(worktree, config.configFile));
    const configRelative = path.relative(worktree, configPath);
    if (configRelative.startsWith('..') || path.isAbsolute(configRelative)) {
      throw new Error('Devbridge configuration must stay inside the selected worktree');
    }
    return { source, configPath };
  }

  /** Read-only shared backend routing check before replacing a working preview. */
  async preflight(project: string, worktree: string, id: string, config: DevbridgePreviewConfig) {
    const { source, configPath } = await this.sourceAndConfig(worktree, config);
    await fs.mkdir(this.directory(project, id), { recursive: true, mode: 0o700 });
    const progressPath = path.join(this.directory(project, id), 'preflight.jsonl');
    await fs.writeFile(progressPath, '', { mode: 0o600 });
    try {
      await this.run(
        [
          ...config.command,
          'preflight',
          '-f',
          configPath,
          '-root',
          source,
          '-progress-file',
          progressPath,
        ],
        project,
        undefined,
        40_000
      );
    } catch (error) {
      let failed: string | undefined;
      try {
        const content = (await fs.readFile(progressPath, 'utf8')) as string;
        failed = content
          .split('\n')
          .reverse()
          .map((line) => {
            try {
              const entry = JSON.parse(line);
              if (entry.status !== 'failed' || typeof entry.step !== 'string') return undefined;
              const step = /^Devbridge · ([a-zA-Z0-9._-]+): verify managed gateway routing$/.exec(
                entry.step
              );
              if (!step) return undefined;
              // Progress is produced by the configured executable. Accept only
              // fixed fields from its structured diagnostic, never arbitrary output.
              const diagnostic =
                typeof entry.message === 'string'
                  ? /\(HTTP ([0-9]{3}); rejection header present: (true|false)\)/.exec(
                      entry.message
                    )
                  : null;
              return diagnostic
                ? `${step[1]}: shared backend returned HTTP ${diagnostic[1]}; rejection header present: ${diagnostic[2]}. Deploy the shared route guard before retrying`
                : entry.step;
            } catch {
              return undefined;
            }
          })
          .find(Boolean);
      } catch {
        // The process error still identifies a failed preflight.
      }
      throw new Error(
        `Devbridge preflight failed: ${failed ?? (error as Error).message}. The existing preview was not changed.`
      );
    }
  }

  async start(
    project: string,
    worktree: string,
    id: string,
    config: DevbridgePreviewConfig,
    frontendUrl: string
  ): Promise<string> {
    const { source, configPath } = await this.sourceAndConfig(worktree, config);
    const directory = this.directory(project, id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // Persist the executable before starting, so cleanup works after config removal/restart.
    await fs.writeFile(
      path.join(directory, 'control.json'),
      JSON.stringify({ command: config.command }),
      { mode: 0o600 }
    );
    await this.run(
      [
        ...config.command,
        'doctor',
        '-f',
        configPath,
        '-root',
        source,
        '-progress-file',
        this.progressPath(project, id),
      ],
      project,
      undefined,
      60_000
    );
    const child = spawn(
      config.command[0],
      [
        ...config.command.slice(1),
        'up',
        '-f',
        configPath,
        '-root',
        source,
        '-state-dir',
        directory,
        '-listen',
        '127.0.0.1:0',
        '-frontend-url',
        frontendUrl,
        '-preview-listen',
        `${isIP(config.bindHost) === 6 ? `[${config.bindHost}]` : config.bindHost}:${config.previewPort ?? 0}`,
        '-managed',
        '-progress-file',
        this.progressPath(project, id),
      ],
      // Remote application output can contain inherited credentials. Never capture or expose it.
      { cwd: project, stdio: ['pipe', 'ignore', 'ignore'] }
    );
    let exited = false;
    const done = new Promise<void>((resolve) => {
      const finish = () => {
        exited = true;
        resolve();
      };
      child.once('error', finish);
      child.once('close', finish);
    });
    child.stdin?.on('error', () => {
      /* Child may exit during startup. */
    });
    this.children.set(id, { child, done });
    try {
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline) {
        if (exited)
          throw new Error('Devbridge exited; check configuration and doctor prerequisites');
        let session: Session | undefined;
        try {
          session = await this.session(project, id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (session?.ready) {
          const port = Number(session.preview_address?.split(':').at(-1));
          // Multi-service devbridge publishes Ready before opening its preview
          // listener. Wait for both fields rather than failing in this window.
          if (!session.preview_address) {
            await delay(250);
            continue;
          }
          if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error('Devbridge did not publish a valid preview listener');
          const url = `http://${config.host}:${port}`;
          await this.check(project, id, url);
          return url;
        }
        await delay(250);
      }
      throw new Error('Devbridge startup timed out');
    } catch (error) {
      await this.stop(project, id);
      throw error;
    }
  }

  async check(project: string, id: string, url: string): Promise<void> {
    const session = await this.session(project, id);
    const apps = session.apps?.length ? session.apps : [session];
    if (
      !session.ready ||
      apps.some((app) => !app.ready || !app.route_id || !app.health_path?.startsWith('/'))
    ) {
      throw new Error('Devbridge session is not ready');
    }
    await Promise.all(
      apps.map(async (app) => {
        const response = await fetch(`${url}${app.health_path}`, {
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        });
        await response.body?.cancel();
        if (!response.ok || response.headers.get('X-Devbridge-Route') !== app.route_id) {
          throw new Error('Preview backend did not match this worktree devbridge session');
        }
      })
    );
  }

  async stop(project: string, id: string): Promise<void> {
    const process = this.children.get(id);
    if (process) {
      process.child.stdin?.end();
      const timer = setTimeout(() => process.child.kill('SIGKILL'), 35_000);
      try {
        await process.done;
      } finally {
        clearTimeout(timer);
        this.children.delete(id);
      }
    }
    const directory = this.directory(project, id);
    let control: { command: string[] };
    try {
      control = JSON.parse(
        (await fs.readFile(path.join(directory, 'control.json'), 'utf8')) as string
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await this.run(
      [
        ...control.command,
        'down',
        '-state-dir',
        directory,
        '-progress-file',
        this.progressPath(project, id),
      ],
      project,
      undefined,
      40_000
    );
  }
}
