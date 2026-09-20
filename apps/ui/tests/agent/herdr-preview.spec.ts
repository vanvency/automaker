/**
 * Herdr Agent Preview E2E Test
 *
 * The sidebar's Agent entry used to open the in-app chat runner. It now renders
 * the herdr workspace preview for the current project/worktree, so the happy
 * path is: project selected → sidebar entry reads "Herdr" → the preview attaches.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  createTempDirPath,
  cleanupTempDir,
  setupRealProject,
  waitForNetworkIdle,
  navigateToAgent,
  authenticateForTests,
} from '../utils';

const TEST_TEMP_DIR = createTempDirPath('agent-herdr-preview-test');

test.describe('Agent sidebar entry', () => {
  let projectPath: string;
  const projectName = `test-project-${Date.now()}`;

  test.beforeAll(async () => {
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }

    projectPath = path.join(TEST_TEMP_DIR, projectName);
    fs.mkdirSync(projectPath, { recursive: true });

    fs.writeFileSync(
      path.join(projectPath, 'package.json'),
      JSON.stringify({ name: projectName, version: '1.0.0' }, null, 2)
    );

    const automakerDir = path.join(projectPath, '.automaker');
    fs.mkdirSync(automakerDir, { recursive: true });
    fs.mkdirSync(path.join(automakerDir, 'features'), { recursive: true });
    fs.mkdirSync(path.join(automakerDir, 'context'), { recursive: true });
    fs.mkdirSync(path.join(automakerDir, 'sessions'), { recursive: true });

    fs.writeFileSync(
      path.join(automakerDir, 'categories.json'),
      JSON.stringify({ categories: [] }, null, 2)
    );

    fs.writeFileSync(
      path.join(automakerDir, 'app_spec.txt'),
      `# ${projectName}\n\nA test project for e2e testing.`
    );
  });

  test.afterAll(async () => {
    cleanupTempDir(TEST_TEMP_DIR);
  });

  test('opens the herdr preview from the sidebar Agent entry', async ({ page }) => {
    // Ensure desktop viewport so the sidebar is expanded.
    await page.setViewportSize({ width: 1280, height: 720 });

    await setupRealProject(page, projectPath, projectName, { setAsCurrent: true });

    await authenticateForTests(page);
    await page.goto('/');
    await waitForNetworkIdle(page);

    // The Agent entry is the herdr preview, not the old chat runner.
    await expect(page.locator('[data-testid="nav-agent"]')).toContainText('Agent');

    // The bottom "Running Agents" entry was removed with the chat runner.
    await expect(page.locator('[data-testid="running-agents-link"]')).toHaveCount(0);

    await navigateToAgent(page);

    // Preview shell (header + embedded terminal, or the unavailable state).
    await expect(page.locator('[data-testid="herdr-agent-preview"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole('heading', { name: `Agent · ${projectName}` })).toBeVisible();
    await expect(page.locator('[data-testid="herdr-preview-retry"]')).toBeVisible();
  });
});
