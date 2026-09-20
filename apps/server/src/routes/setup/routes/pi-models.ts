/**
 * Pi models API routes
 *
 * Provides endpoints for:
 * - GET /api/setup/pi/models - Get available models (cached or refreshed)
 * - POST /api/setup/pi/models/refresh - Re-read the LiteLLM model list and sync
 *   it into Pi's models.json
 * - POST /api/setup/pi/cache/clear - Drop the in-memory model cache
 */

import type { Request, Response } from 'express';
import { PiProvider } from '../../../providers/pi-provider.js';
import { getPiModelsConfigPath, resolveLitellmBaseUrl } from '../../../providers/pi-litellm.js';
import { getErrorMessage, logError } from '../common.js';
import type { ModelDefinition } from '@automaker/types';

// Singleton provider instance so the model cache is shared across requests
let providerInstance: PiProvider | null = null;

function getProvider(): PiProvider {
  if (!providerInstance) {
    providerInstance = new PiProvider();
  }
  return providerInstance;
}

interface ModelsResponse {
  success: boolean;
  models?: ModelDefinition[];
  count?: number;
  cached?: boolean;
  source?: {
    baseUrl: string;
    modelsConfigPath: string;
  };
  error?: string;
}

/**
 * Creates handler for GET /api/setup/pi/models
 *
 * Query params:
 * - refresh=true: force a LiteLLM fetch before responding
 */
export function createGetPiModelsHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const forceRefresh = req.query.refresh === 'true';

      let models: ModelDefinition[];
      let cached = true;

      if (forceRefresh) {
        models = await provider.refreshModels();
        cached = false;
      } else {
        models = provider.getAvailableModels();
        if (!provider.hasCachedModels()) {
          models = await provider.refreshModels();
          cached = false;
        }
      }

      const response: ModelsResponse = {
        success: true,
        models,
        count: models.length,
        cached,
        source: {
          baseUrl: resolveLitellmBaseUrl(),
          modelsConfigPath: getPiModelsConfigPath(),
        },
      };

      res.json(response);
    } catch (error) {
      logError(error, 'Get Pi models failed');
      const response: ModelsResponse = { success: false, error: getErrorMessage(error) };
      res.status(500).json(response);
    }
  };
}

/**
 * Creates handler for POST /api/setup/pi/models/refresh
 */
export function createRefreshPiModelsHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      provider.clearModelCache();
      const models = await provider.refreshModels();

      const response: ModelsResponse = {
        success: true,
        models,
        count: models.length,
        cached: false,
        source: {
          baseUrl: resolveLitellmBaseUrl(),
          modelsConfigPath: getPiModelsConfigPath(),
        },
      };

      res.json(response);
    } catch (error) {
      logError(error, 'Refresh Pi models failed');
      const response: ModelsResponse = { success: false, error: getErrorMessage(error) };
      res.status(500).json(response);
    }
  };
}

/**
 * Creates handler for POST /api/setup/pi/cache/clear
 */
export function createClearPiCacheHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      getProvider().clearModelCache();
      res.json({ success: true });
    } catch (error) {
      logError(error, 'Clear Pi model cache failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
