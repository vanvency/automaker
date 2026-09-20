/**
 * Pi web conversation routes.
 *
 * Pi ships no web UI, so Automaker hosts a small page that renders a feature's
 * Pi session and lets the user continue the conversation:
 *
 * - GET  /api/pi-web/view     - the self-contained HTML page
 * - GET  /api/pi-web/session  - parsed transcript for a worktree/session
 * - POST /api/pi-web/send     - run a follow-up turn through the Pi provider
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '@automaker/utils';
import { createPiModelId, type ThinkingLevel } from '@automaker/types';
import { PiProvider } from '../../providers/pi-provider.js';
import {
  findPiSession,
  resolvePiSessionModel,
  type PiSessionInfo,
} from '../../services/pi-session-store.js';
import { validateWorkingDirectory } from '../../lib/sdk-options.js';
import { renderPiWebView } from './view.js';

const logger = createLogger('PiWebRoutes');

/** Cap how much transcript one request can return */
const MAX_MESSAGES = 500;

/**
 * Reject a directory outside `ALLOWED_ROOT_DIRECTORY`.
 *
 * The Pi agent runs with write/bash tools in `workDir`, so an unvalidated value
 * from the request would bypass the same boundary every other execution route
 * enforces.
 *
 * @returns The rejection reason, or null when the directory is allowed
 */
export function disallowedWorkDirError(workDir: string): string | null {
  try {
    validateWorkingDirectory(workDir);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Working directory is not allowed';
  }
}

/**
 * Map Pi thinking levels back onto Automaker's thinking levels so a follow-up
 * turn keeps the session's reasoning setting.
 */
function toThinkingLevel(piLevel: string | undefined): ThinkingLevel | undefined {
  switch (piLevel) {
    case 'off':
      return 'none';
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'ultrathink';
    default:
      return undefined;
  }
}

function serializeSession(session: PiSessionInfo) {
  return {
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    modelProvider: session.modelProvider,
    modelId: session.modelId,
    thinkingLevel: session.thinkingLevel,
    userTurnCount: session.userTurnCount,
    messages: session.messages.slice(-MAX_MESSAGES),
  };
}

/**
 * GET /api/pi-web/view - serve the conversation page.
 */
function createViewHandler() {
  return (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // The page is same-origin and authenticated by the API middleware; keep it
    // out of any caching layer so it always reflects the current build.
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderPiWebView());
  };
}

/**
 * GET /api/pi-web/session?workDir=...&sessionId=...
 */
export function createSessionHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const workDir = typeof req.query.workDir === 'string' ? req.query.workDir : '';
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;

      if (!workDir) {
        res.status(400).json({ success: false, error: 'workDir is required' });
        return;
      }

      const invalidWorkDir = disallowedWorkDirError(workDir);
      if (invalidWorkDir) {
        res.status(400).json({ success: false, error: invalidWorkDir });
        return;
      }

      const session = findPiSession(workDir, sessionId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'No Pi session found for this worktree yet',
        });
        return;
      }

      res.json({ success: true, session: serializeSession(session) });
    } catch (error) {
      logger.error('Failed to load Pi session:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load Pi session',
      });
    }
  };
}

/**
 * POST /api/pi-web/send
 */
export function createSendHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { workDir, projectPath, sessionId, model, message } = (req.body ?? {}) as {
      workDir?: string;
      projectPath?: string;
      sessionId?: string;
      model?: string;
      message?: string;
    };

    if (!workDir || !message) {
      res.status(400).json({ success: false, error: 'workDir and message are required' });
      return;
    }

    const invalidWorkDir = disallowedWorkDirError(workDir);
    if (invalidWorkDir) {
      res.status(400).json({ success: false, error: invalidWorkDir });
      return;
    }
    if (projectPath) {
      const invalidProjectPath = disallowedWorkDirError(projectPath);
      if (invalidProjectPath) {
        res.status(400).json({ success: false, error: invalidProjectPath });
        return;
      }
    }

    try {
      const session = findPiSession(workDir, sessionId);
      const resolvedModel = resolvePiSessionModel(session);

      // Prefer the model baked into the session, then an explicit override.
      let provider = resolvedModel?.provider ?? 'litellm';
      let modelId = resolvedModel?.modelId ?? '';

      if (model) {
        const slash = model.indexOf('/');
        if (slash > 0) {
          provider = model.slice(0, slash);
          modelId = model.slice(slash + 1);
        } else {
          modelId = model;
        }
      }

      if (!modelId) {
        res.status(400).json({
          success: false,
          error: 'No model found for this Pi session; open the session through Automaker first',
        });
        return;
      }

      const piProvider = new PiProvider();
      const abortController = new AbortController();
      // Abort only when the client actually disconnects (the request stream
      // closes right after the body is read, which is not a disconnect).
      res.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      let reply = '';
      let errorMessage: string | undefined;
      let newSessionId: string | undefined = session?.id ?? sessionId;

      for await (const providerMessage of piProvider.executeQuery({
        prompt: message,
        model: createPiModelId(modelId, provider),
        cwd: workDir,
        sdkSessionId: session?.id ?? sessionId,
        thinkingLevel: toThinkingLevel(session?.thinkingLevel),
        abortController,
      })) {
        if (providerMessage.session_id) {
          newSessionId = providerMessage.session_id;
        }

        if (providerMessage.type === 'assistant' && providerMessage.message) {
          for (const block of providerMessage.message.content) {
            if (block.type === 'text' && block.text) {
              reply += block.text;
            }
          }
        } else if (providerMessage.type === 'error') {
          errorMessage = providerMessage.error || 'Pi run failed';
        } else if (providerMessage.type === 'result' && providerMessage.subtype === 'error') {
          errorMessage = providerMessage.error || errorMessage || 'Pi run failed';
        } else if (providerMessage.type === 'result' && providerMessage.result && !reply) {
          reply = providerMessage.result;
        }
      }

      if (errorMessage && !reply) {
        res.json({
          success: false,
          error: errorMessage,
          sessionId: newSessionId,
          projectPath,
        });
        return;
      }

      res.json({
        success: true,
        reply,
        sessionId: newSessionId,
        provider,
        model: modelId,
      });
    } catch (error) {
      logger.error('Failed to send Pi message:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send Pi message',
      });
    }
  };
}

export function createPiWebRoutes(): Router {
  const router = Router();
  router.get('/view', createViewHandler());
  router.get('/session', createSessionHandler());
  router.post('/send', createSendHandler());
  return router;
}
