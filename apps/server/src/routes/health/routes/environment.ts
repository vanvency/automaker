/**
 * GET /environment endpoint - Environment information including containerization status
 *
 * This endpoint is unauthenticated so the UI can check it on startup
 * before login to determine if sandbox risk warnings should be shown.
 */

import type { Request, Response } from 'express';
import type { SettingsService } from '../../../services/settings-service.js';

export interface EnvironmentResponse {
  isContainerized: boolean;
  skipSandboxWarning?: boolean;
}

/**
 * Create handler factory for GET /api/health/environment
 *
 * The persisted user preference is authoritative. The environment variable is a
 * deployment-level override that can additionally suppress the warning, but it
 * must never re-enable a warning the user explicitly dismissed.
 */
export function createEnvironmentHandler(settingsService: SettingsService) {
  return async (_req: Request, res: Response): Promise<void> => {
    let userSkipped = false;
    try {
      const settings = await settingsService.getGlobalSettings();
      userSkipped = settings.skipSandboxWarning === true;
    } catch (error) {
      console.error('Failed to read sandbox warning preference:', error);
    }

    res.json({
      isContainerized: process.env.IS_CONTAINERIZED === 'true',
      skipSandboxWarning: userSkipped || process.env.AUTOMAKER_SKIP_SANDBOX_WARNING === 'true',
    } satisfies EnvironmentResponse);
  };
}
