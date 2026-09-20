/**
 * Herdr bootstrap - startup self-check and readiness gate.
 *
 * Herdr control has three prerequisites that are easy to get wrong silently:
 *
 * 1. the `herdr` binary exists,
 * 2. the `pi` agent integration is installed - without it herdr uses screen
 *    heuristics, which misreport a working pi as idle.
 * 3. the project's session is running - sessions are per project (named after the
 *    project directory) and started on demand, so this is only checked when the
 *    caller supplies a project.
 *
 * This module checks all three and reports a structured status so the API and
 * the UI can explain what is missing instead of failing at run time.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { createLogger } from '@automaker/utils';
import {
  FALLBACK_HERDR_SESSION_NAME,
  buildProjectSessionName,
  resolveHerdrExecutable,
} from './herdr-client.js';
import { getHerdrTaskService } from './herdr-task-service.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('HerdrBootstrap');

export interface HerdrBootstrapStatus {
  /** herdr is installed and answerable */
  available: boolean;
  /** Version reported by `herdr --version`, when resolvable */
  version: string | null;
  /** Resolved binary path */
  binaryPath: string | null;
  /** Session inspected: the project's session, when a project was supplied */
  sessionName: string;
  /** Socket path of that session */
  socketPath: string | null;
  /** The session server is running (or was started) */
  sessionRunning: boolean;
  /** The pi integration is installed */
  piIntegrationReady: boolean;
  /** Human-readable problems, empty when everything is ready */
  problems: string[];
}

let cachedBootstrap: { status: HerdrBootstrapStatus; at: number; key: string } | null = null;
/** Re-run the checks at most this often */
const BOOTSTRAP_CACHE_MS = 60_000;

/** Read `herdr --version` output, tolerating older formats */
export async function readHerdrVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], { timeout: 10_000 });
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : stdout.trim() || null;
  } catch (error) {
    logger.debug(`Could not read herdr version: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Check the pi integration, and - when a project is given - that the project's
 * herdr session is up.
 *
 * `installMissingIntegration` is opt-in because installing writes to the user's
 * home directory; call it from an explicit bootstrap path, not from a read-only
 * status check.
 */
export async function bootstrapHerdr(
  options: { installMissingIntegration?: boolean; projectPath?: string } = {}
): Promise<HerdrBootstrapStatus> {
  const problems: string[] = [];
  const binaryPath = resolveHerdrExecutable();

  if (!binaryPath) {
    return {
      available: false,
      version: null,
      binaryPath: null,
      sessionName: FALLBACK_HERDR_SESSION_NAME,
      socketPath: null,
      sessionRunning: false,
      piIntegrationReady: false,
      problems: ['herdr is not installed (install herdr or set HERDR_BIN)'],
    };
  }

  const version = await readHerdrVersion(binaryPath);

  // The integration is a local hook file, so it can be checked - and installed -
  // without a running session.
  let piIntegrationReady = piIntegrationFileExists();
  if (!piIntegrationReady && options.installMissingIntegration) {
    piIntegrationReady = await installPiIntegration(binaryPath);
  }
  if (!piIntegrationReady) {
    problems.push(
      'The herdr pi integration is not installed - agent status may be wrong. Run: herdr integration install pi'
    );
  }

  let sessionName = FALLBACK_HERDR_SESSION_NAME;
  let socketPath: string | null = null;
  let sessionRunning = false;
  if (options.projectPath) {
    sessionName = buildProjectSessionName(options.projectPath);
    const client = getHerdrTaskService(options.projectPath).getClient();
    socketPath = client.getSocketPath();
    try {
      const result = await client.ensureSession();
      sessionRunning = true;
      logger.info(
        result.started
          ? `herdr session '${sessionName}' started at ${socketPath}`
          : `herdr session '${sessionName}' already running at ${socketPath}`
      );
    } catch (error) {
      problems.push(`Could not start the herdr session: ${(error as Error).message}`);
    }
  }

  const status: HerdrBootstrapStatus = {
    available: piIntegrationReady && (options.projectPath ? sessionRunning : true),
    version,
    binaryPath,
    sessionName,
    socketPath: sessionRunning ? socketPath : null,
    sessionRunning,
    piIntegrationReady,
    problems,
  };
  cachedBootstrap = { status, at: Date.now(), key: options.projectPath ?? '' };
  return status;
}

/**
 * Install the pi integration through the herdr CLI.
 *
 * The hook is a file under `~/.pi`, so this works without a running session.
 */
async function installPiIntegration(binaryPath: string): Promise<boolean> {
  try {
    await execFileAsync(binaryPath, ['integration', 'install', 'pi'], { timeout: 30_000 });
    const ready = piIntegrationFileExists();
    if (ready) logger.info('Installed the herdr pi integration');
    return ready;
  } catch (error) {
    logger.warn(`Could not install the herdr pi integration: ${(error as Error).message}`);
    return false;
  }
}

/** Path herdr writes the pi lifecycle hook to */
function piIntegrationFileExists(): boolean {
  const home = process.env.HOME || '';
  if (!home) return false;
  return existsSync(`${home}/.pi/agent/extensions/herdr-agent-state.ts`);
}

/** Last bootstrap result for a project, if any */
export function getCachedHerdrStatus(projectPath?: string): HerdrBootstrapStatus | null {
  if (cachedBootstrap && cachedBootstrap.key === (projectPath ?? '')) {
    return cachedBootstrap.status;
  }
  return null;
}

/** Cached status if it is still fresh, otherwise re-run the bootstrap */
export async function getHerdrStatus(projectPath?: string): Promise<HerdrBootstrapStatus> {
  if (
    cachedBootstrap &&
    cachedBootstrap.key === (projectPath ?? '') &&
    Date.now() - cachedBootstrap.at < BOOTSTRAP_CACHE_MS
  ) {
    return cachedBootstrap.status;
  }
  return bootstrapHerdr({ projectPath });
}

/** Reset the bootstrap cache (used by tests) */
export function resetHerdrBootstrapCache(): void {
  cachedBootstrap = null;
}
