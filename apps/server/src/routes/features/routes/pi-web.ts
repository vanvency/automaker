/**
 * POST /pi-web endpoint - Deep link to the feature's Pi conversation page.
 *
 * Prefers the standalone Pi Web UI (https://github.com/agegr/pi-web), which
 * reads the same `~/.pi` sessions and supports `/?session=<id>` deep links.
 * When that server is not running we fall back to Automaker's built-in viewer
 * at `/api/pi-web/view`, which is always available.
 */

import type { Request, Response } from 'express';
import { FeatureLoader } from '../../../services/feature-loader.js';
import { findPiSession, resolvePiSessionModel } from '../../../services/pi-session-store.js';
import { resolveFeatureWorkDir } from './opencode-session.js';
import { getErrorMessage, logError } from '../common.js';

/** Where the standalone Pi Web UI listens by default */
const DEFAULT_PI_WEB_URL = 'http://127.0.0.1:30141';

/** How long a reachability probe result is trusted */
const PI_WEB_PROBE_TTL_MS = 5000;

/** Basic-auth username pi-web expects when a password is configured */
const PI_WEB_USERNAME = 'pi';

let cachedProbe: { url: string; reachable: boolean; at: number } | null = null;

/**
 * Resolve the base URL of the standalone Pi Web server.
 */
export function resolvePiWebBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_WEB_URL?.trim();
  return (configured || DEFAULT_PI_WEB_URL).replace(/\/+$/, '');
}

/**
 * Check whether the Pi Web server is reachable (results are cached briefly so
 * opening several cards does not hammer it).
 */
export async function isPiWebReachable(
  baseUrl: string = resolvePiWebBaseUrl(),
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (
    cachedProbe &&
    cachedProbe.url === baseUrl &&
    Date.now() - cachedProbe.at < PI_WEB_PROBE_TTL_MS
  ) {
    return cachedProbe.reachable;
  }

  let reachable = false;
  try {
    const response = await fetchImpl(`${baseUrl}/api/sessions`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    });
    reachable = response.status < 500;
  } catch {
    reachable = false;
  }

  cachedProbe = { url: baseUrl, reachable, at: Date.now() };
  return reachable;
}

export interface PiWebTargetOptions {
  /** Which UI serves the conversation */
  backend: 'pi-web' | 'builtin';
  sessionId: string;
  workDir: string;
  projectPath: string;
  title: string;
  model?: { provider: string; modelId: string } | null;
  /** Protocol/host the browser used to reach Automaker */
  protocol: string;
  host: string;
  /** Base URL of the standalone Pi Web server */
  piWebUrl: string;
  /** Hostname override for the browser-facing Pi Web URL */
  piWebHost?: string;
}

/**
 * Build the deep link the card should open.
 *
 * - `pi-web`: `<pi-web>/?session=<id>` (pi-web reads the same session files)
 * - `builtin`: Automaker's own viewer, scoped by workdir + session
 */
export function buildPiWebTarget(options: PiWebTargetOptions): {
  url: string;
  path?: string;
} {
  const modelQuery = options.model
    ? `&model=${encodeURIComponent(`${options.model.provider}/${options.model.modelId}`)}`
    : '';

  if (options.backend === 'pi-web') {
    const base = new URL(options.piWebUrl);
    if (options.piWebHost) {
      base.host = options.piWebHost;
    }
    // pi-web only honours ?session= when ?cwd= is absent.
    base.search = `?session=${encodeURIComponent(options.sessionId)}`;
    return { url: base.toString() };
  }

  const query = new URLSearchParams({
    workDir: options.workDir,
    sessionId: options.sessionId,
    projectPath: options.projectPath,
    title: options.title,
  });
  const path = `/api/pi-web/view?${query.toString()}${modelQuery}`;
  return {
    path,
    url: `${options.protocol}://${options.host}${path}`,
  };
}

/**
 * Host used in the returned URL. Mirrors the OpenCode web link: an explicit
 * PI_WEB_HOST wins, otherwise the request's own host is used (the page is
 * served by this same server, so that always works).
 */
function resolveWebHost(req: Request): string {
  const configured = process.env.PI_WEB_HOST?.trim();
  if (configured) return configured;
  return req.headers.host || `127.0.0.1:${process.env.PORT || 3001}`;
}

function resolveProtocol(req: Request): string {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.protocol || 'http';
}

export function createPiWebHandler(featureLoader: FeatureLoader) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body as {
        projectPath: string;
        featureId: string;
      };
      if (!projectPath || !featureId) {
        res.status(400).json({
          success: false,
          error: 'projectPath and featureId are required',
        });
        return;
      }

      const resolved = await resolveFeatureWorkDir(featureLoader, projectPath, featureId);
      if (!resolved) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }

      const providerSessionId = (resolved.feature as { providerSessionId?: string })
        .providerSessionId;
      const session = findPiSession(resolved.workDir, providerSessionId);

      if (!session) {
        res.json({
          success: false,
          error: 'No Pi session found for this worktree yet',
        });
        return;
      }

      const model = resolvePiSessionModel(session);
      const piWebUrl = resolvePiWebBaseUrl();
      const usePiWeb = await isPiWebReachable(piWebUrl);
      const target = buildPiWebTarget({
        backend: usePiWeb ? 'pi-web' : 'builtin',
        sessionId: session.id,
        workDir: resolved.workDir,
        projectPath,
        title: resolved.feature.title || featureId,
        model,
        protocol: resolveProtocol(req),
        host: resolveWebHost(req),
        piWebUrl,
        piWebHost: process.env.PI_WEB_HOST?.trim() || undefined,
      });

      res.json({
        success: true,
        // 'pi-web' = standalone Pi Web UI, 'builtin' = Automaker's own viewer
        backend: usePiWeb ? 'pi-web' : 'builtin',
        url: target.url,
        path: target.path ?? null,
        username: usePiWeb ? PI_WEB_USERNAME : undefined,
        password: usePiWeb ? process.env.PI_WEB_PASSWORD || '' : undefined,
        sessionId: session.id,
        turnCount: session.userTurnCount,
        model: model ? `${model.provider}/${model.modelId}` : null,
      });
    } catch (error) {
      logError(error, 'Resolve Pi web link failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
