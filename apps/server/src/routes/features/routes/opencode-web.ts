/**
 * POST /opencode-web endpoint - Deep link to the feature's opencode web session.
 *
 * Returns the machine-wide opencode server URL for the session that belongs to
 * the feature's worktree so the card can open the running conversation directly.
 */

import type { Request, Response } from 'express';
import { FeatureLoader } from '../../../services/feature-loader.js';
import { findOpenCodeSession, resolveFeatureWorkDir, runCaptured } from './opencode-session.js';
import { getErrorMessage, logError } from '../common.js';

/**
 * Host used in the returned web URL.
 *
 * The OpenCode server is machine-wide while requests reach this API over
 * loopback, so an explicit OPENCODE_WEB_HOST (the LAN address a browser can
 * reach) wins; otherwise fall back to the configured server host or the Host
 * header of the request.
 */
function resolveWebHost(req: Request, serverUrl: URL): string {
  const configured = process.env.OPENCODE_WEB_HOST?.trim();
  if (configured) return configured;

  const serverHost = serverUrl.hostname;
  if (serverHost && !['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(serverHost)) {
    return serverHost;
  }

  return (req.headers.host || '').split(':')[0] || '127.0.0.1';
}

async function fetchSessionSlug(sessionId: string): Promise<string | null> {
  const serverUrl = process.env.OPENCODE_SERVER_URL;
  if (!serverUrl) return null;
  try {
    const headers: Record<string, string> = {};
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (password) {
      const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
    const response = await fetch(
      `${serverUrl.replace(/\/$/, '')}/session/${encodeURIComponent(sessionId)}`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { slug?: string };
    return data.slug ?? null;
  } catch {
    return null;
  }
}

/**
 * Count user turns in an OpenCode session.
 *
 * `opencode export` prefixes its JSON with a human-readable line, so strip it
 * before parsing. A turn is one user message; assistant tool-call bursts are
 * intentionally not counted as conversation rounds.
 *
 * The board fetches this for every card, and each miss spawns an `opencode
 * export` process, so results are cached briefly.
 */
const TURN_COUNT_CACHE_TTL_MS = 60_000;
const turnCountCache = new Map<string, { count: number | null; at: number }>();

/** Memoize a turn count (including "none") so repeated board polls do not re-spawn the CLI. */
function cacheTurnCount(sessionId: string, count: number | null): number | null {
  turnCountCache.set(sessionId, { count, at: Date.now() });
  return count;
}

async function fetchSessionTurnCount(workDir: string, sessionId: string): Promise<number | null> {
  const cached = turnCountCache.get(sessionId);
  if (cached && Date.now() - cached.at < TURN_COUNT_CACHE_TTL_MS) {
    return cached.count;
  }

  try {
    const output = await runCaptured('opencode', ['export', sessionId], workDir, 20000);
    const jsonStart = output.indexOf('{');
    if (jsonStart < 0) return cacheTurnCount(sessionId, null);
    const parsed = JSON.parse(output.slice(jsonStart)) as {
      messages?: Array<{ info?: { role?: string } }>;
    };
    if (!Array.isArray(parsed.messages)) return cacheTurnCount(sessionId, null);
    const userTurns = parsed.messages.filter((message) => message.info?.role === 'user');
    const count = userTurns.length > 0 ? userTurns.length : null;
    return cacheTurnCount(sessionId, count);
  } catch {
    // Turn count is supplemental metadata; the deep link remains usable without it.
    return cacheTurnCount(sessionId, null);
  }
}

/**
 * Memoized "this feature has no OpenCode session yet".
 *
 * Session discovery shells out to `opencode session list`, and the board asks
 * for every card on focus; without the memo an unfinished card re-spawns the CLI
 * on every poll. Deliberately short so a session created by the next run shows
 * up promptly.
 */
const MISSING_SESSION_TTL_MS = 30_000;
const missingSessionCache = new Map<string, number>();

function missingSessionCacheKey(projectPath: string, featureId: string): string {
  return `${projectPath}\u0000${featureId}`;
}

function wasRecentlyMissing(cacheKey: string): boolean {
  const at = missingSessionCache.get(cacheKey);
  if (at === undefined) return false;
  if (Date.now() - at > MISSING_SESSION_TTL_MS) {
    missingSessionCache.delete(cacheKey);
    return false;
  }
  return true;
}

export function createOpenCodeWebHandler(featureLoader: FeatureLoader) {
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

      const resolved = await resolveFeatureWorkDir(featureLoader, projectPath, featureId, {
        rebuild: true,
      });
      if (!resolved) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }

      const featureTitle = resolved.feature.title || featureId;
      const providerSessionId = (resolved.feature as { providerSessionId?: string })
        .providerSessionId;
      const sessionCacheKey = missingSessionCacheKey(projectPath, featureId);

      // The provider-native session id recorded by AgentExecutor is authoritative.
      // Title/time heuristics are only fallbacks for older features.
      const session = providerSessionId
        ? { id: providerSessionId }
        : wasRecentlyMissing(sessionCacheKey)
          ? null
          : await findOpenCodeSession(
              resolved.workDir,
              featureTitle,
              featureId,
              (resolved.feature.startedAt as string | undefined) ??
                (resolved.feature.updatedAt as string | undefined),
              projectPath
            );
      if (!session) {
        if (!providerSessionId) {
          missingSessionCache.set(sessionCacheKey, Date.now());
        }
        res.json({
          success: false,
          error: 'No opencode session found for this worktree yet',
        });
        return;
      }
      missingSessionCache.delete(sessionCacheKey);

      const serverUrl = process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:4096';
      const parsed = new URL(serverUrl);
      const host = resolveWebHost(req, parsed);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const slug = session.slug || (await fetchSessionSlug(session.id));
      const turnCount = await fetchSessionTurnCount(resolved.workDir, session.id);
      const dir = slug || session.id;
      res.json({
        success: true,
        url: `${parsed.protocol}//${host}:${port}/${dir}/session/${session.id}`,
        username: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
        password: process.env.OPENCODE_SERVER_PASSWORD || '',
        sessionId: session.id,
        slug: slug ?? null,
        turnCount,
      });
    } catch (error) {
      logError(error, 'Resolve opencode web link failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
