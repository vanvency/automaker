/**
 * Health check routes
 *
 * NOTE: Only the basic health check (/) and environment check are unauthenticated.
 * The /detailed endpoint requires authentication.
 */

import { Router } from 'express';
import type { SettingsService } from '../../services/settings-service.js';
import { createIndexHandler } from './routes/index.js';
import { createEnvironmentHandler } from './routes/environment.js';

/**
 * Create unauthenticated health routes (basic check only)
 * Used by load balancers and container orchestration
 */
export function createHealthRoutes(settingsService: SettingsService): Router {
  const router = Router();

  // Basic health check - no sensitive info
  router.get('/', createIndexHandler());

  // Environment info including containerization status
  // This is unauthenticated so the UI can check on startup
  router.get('/environment', createEnvironmentHandler(settingsService));

  return router;
}

// Re-export detailed handler for use in authenticated routes
export { createDetailedHandler } from './routes/detailed.js';
