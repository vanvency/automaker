/**
 * GET /pi-status endpoint - Get Pi CLI installation and LiteLLM connectivity status
 */

import type { Request, Response } from 'express';
import { PiProvider } from '../../../providers/pi-provider.js';
import {
  getPiModelsConfigPath,
  resolveLitellmApiKey,
  resolveLitellmBaseUrl,
} from '../../../providers/pi-litellm.js';
import { getErrorMessage, logError } from '../common.js';

const INSTALL_COMMAND = 'npm install -g @earendil-works/pi-coding-agent';
const INIT_MODELS_COMMAND = 'node scripts/init-pi-litellm-models.mjs';

/**
 * Creates handler for GET /api/setup/pi-status
 *
 * Reports whether the `pi` CLI is installed and whether the local LiteLLM
 * gateway (which supplies Pi's model list) is reachable.
 */
export function createPiStatusHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const provider = new PiProvider();
      const status = await provider.detectInstallation();
      const hasApiKey = Boolean(resolveLitellmApiKey());

      res.json({
        success: true,
        installed: status.installed,
        version: status.version || null,
        path: status.path || null,
        auth: {
          // Pi has no login flow here: usable models come from LiteLLM, so
          // "authenticated" means the gateway answered with a model list.
          authenticated: status.authenticated || false,
          method: hasApiKey ? 'litellm_api_key' : 'none',
          hasApiKey,
          hasOAuthToken: status.hasOAuthToken || false,
        },
        litellm: {
          baseUrl: resolveLitellmBaseUrl(),
          hasApiKey,
          modelsConfigPath: getPiModelsConfigPath(),
        },
        recommendation: status.installed
          ? undefined
          : 'Install the Pi coding agent CLI to run Pi models.',
        installCommand: INSTALL_COMMAND,
        loginCommand: INIT_MODELS_COMMAND,
        installCommands: {
          npm: INSTALL_COMMAND,
        },
      });
    } catch (error) {
      logError(error, 'Get Pi status failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
