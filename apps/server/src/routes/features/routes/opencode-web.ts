/**
 * POST /opencode-web endpoint - Deep link to the feature's opencode web session.
 *
 * Returns the machine-wide opencode server URL for the session that belongs to
 * the feature's worktree so the card can open the running conversation directly.
 */

import type { Request, Response } from 'express';
import { FeatureLoader } from '../../../services/feature-loader.js';
import { findOpenCodeSession, resolveFeatureWorkDir } from './opencode-session.js';
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

      const resolved = await resolveFeatureWorkDir(featureLoader, projectPath, featureId);
      if (!resolved) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }

      const preferredTitle =
        ((resolved.feature as { jiraKey?: string }).jiraKey ?? featureId) || undefined;
      const session = await findOpenCodeSession(resolved.workDir, preferredTitle);
      if (!session) {
        res.json({
          success: false,
          error: 'No opencode session found for this worktree yet',
        });
        return;
      }

      const serverUrl = process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:4096';
      const parsed = new URL(serverUrl);
      const host = resolveWebHost(req, parsed);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const slug = session.slug || (await fetchSessionSlug(session.id));
      const dir = slug || session.id;
      res.json({
        success: true,
        url: `${parsed.protocol}//${host}:${port}/${dir}/session/${session.id}`,
        username: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
        password: process.env.OPENCODE_SERVER_PASSWORD || '',
        sessionId: session.id,
        slug: slug ?? null,
      });
    } catch (error) {
      logError(error, 'Resolve opencode web link failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
