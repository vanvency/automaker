/**
 * Herdr web routes.
 *
 * - GET  /api/herdr/view           - the self-contained herdr terminal page
 * - GET  /api/herdr/status         - control-plane readiness
 * - POST /api/herdr/preview        - PTY for the in-app Agent preview
 * - GET  /api/herdr/assets/:file   - xterm.js assets used by that page
 *
 * The page renders a PTY that the feature deep-link already created, so these
 * routes never spawn anything themselves.
 */

import { createRequire } from 'module';
import { promises as fs } from 'fs';
import path from 'path';
import { Router, type Request, type Response } from 'express';
import { createLogger } from '@automaker/utils';
import { renderHerdrWebView } from './view.js';
import { createHerdrPreviewHandler, createHerdrStatusHandler } from './routes/index.js';
import { createHerdrReattachHandler } from './routes/reattach.js';

const logger = createLogger('HerdrRoutes');

const nodeRequire = createRequire(import.meta.url);

/** xterm.js modules the page loads, mapped to the module path inside the package */
const HERDR_ASSETS: Record<string, { specifier: string; contentType: string }> = {
  'xterm.js': { specifier: '@xterm/xterm/lib/xterm.js', contentType: 'text/javascript' },
  'xterm.css': { specifier: '@xterm/xterm/css/xterm.css', contentType: 'text/css' },
  'addon-fit.js': {
    specifier: '@xterm/addon-fit/lib/addon-fit.js',
    contentType: 'text/javascript',
  },
};

/**
 * Locate an installed server dependency.
 *
 * The packages are hoisted to the workspace root by npm, so resolution starts
 * from this module and falls back to the workspace `node_modules`.
 */
function resolveAssetPath(specifier: string): string {
  try {
    return nodeRequire.resolve(specifier);
  } catch {
    return path.join(process.cwd(), 'node_modules', specifier);
  }
}

function createViewHandler() {
  return (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // The page is same-origin and authenticated by the API middleware; keep it
    // out of any caching layer so it always reflects the current build.
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderHerdrWebView());
  };
}

function createAssetHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const file = typeof req.params.file === 'string' ? req.params.file : '';
    // Object.prototype members must not satisfy the lookup (`.../constructor`).
    const asset = Object.hasOwn(HERDR_ASSETS, file) ? HERDR_ASSETS[file] : undefined;
    if (!asset) {
      res.status(404).json({ success: false, error: `Unknown herdr asset: ${file}` });
      return;
    }

    try {
      const assetPath = resolveAssetPath(asset.specifier);
      const content = await fs.readFile(assetPath, 'utf8');
      res.setHeader('Content-Type', `${asset.contentType}; charset=utf-8`);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(content);
    } catch (error) {
      logger.error(`Failed to serve herdr asset ${file}:`, error);
      res.status(500).json({
        success: false,
        error: `xterm.js is not installed on the server (${asset.specifier})`,
      });
    }
  };
}

export function createHerdrRoutes(): Router {
  const router = Router();
  router.get('/view', createViewHandler());
  // Readiness of the control plane (session + pi integration).
  router.get('/status', createHerdrStatusHandler());
  router.post('/preview', createHerdrPreviewHandler());
  router.post('/reattach', createHerdrReattachHandler());
  router.get('/assets/:file', createAssetHandler());
  return router;
}
