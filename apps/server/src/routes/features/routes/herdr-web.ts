/**
 * POST /herdr-web endpoint - Deep link to the feature's herdr conversation.
 *
 * Each project has one herdr session; inside it a worktree is a space and a task
 * is a tab whose panes run that task's pi agents. This route makes sure that
 * conversation exists (reusing the worktree's space and the task's tab, resuming
 * the pi session the worktree already has on disk, and creating what is missing
 * for tasks that predate herdr), focuses it, attaches a TUI client and returns
 * the page that renders it - so the card opens the task's actual pi conversation
 * instead of an empty shell.
 */

import type { Request, Response } from 'express';
import { createLogger } from '@automaker/utils';
import { FeatureLoader } from '../../../services/feature-loader.js';
import { FeatureStateManager } from '../../../services/feature-state-manager.js';
import { getTerminalService } from '../../../services/terminal-service.js';
import { getHerdrService, isHerdrAvailable } from '../../../services/herdr-service.js';
import { getHerdrTaskService } from '../../../services/herdr-task-service.js';
import { createEventEmitter, type EventEmitter } from '../../../lib/events.js';
import { resolveFeatureWorkDir } from './opencode-session.js';
import { getErrorMessage, logError } from '../common.js';
import type { Feature } from '@automaker/types';

const logger = createLogger('herdr-web');

// Browsing a non-Pi task in Herdr must not replace its provider's native ID.
function sessionField(feature: Feature): 'providerSessionId' | 'herdrPiSessionId' {
  return typeof feature.model === 'string' && feature.model.startsWith('pi:')
    ? 'providerSessionId'
    : 'herdrPiSessionId';
}
function piSession(feature: Feature): string | null {
  const value = feature[sessionField(feature)];
  return typeof value === 'string' ? value : null;
}

/** Strings that tie a card to its pi sessions (the dispatch prompt carries both) */
function taskKeysOf(feature: Feature, fallbackId: string): string[] {
  return [feature.id ?? fallbackId, feature.jiraKey].filter(
    (key): key is string => typeof key === 'string' && key.length > 0
  );
}

/** Persist a card's herdr placement, keeping the write failures non-fatal */
async function persistPlacement(
  featureLoader: FeatureLoader,
  events: EventEmitter | undefined,
  projectPath: string,
  featureId: string,
  fields: Record<string, string | undefined>
): Promise<void> {
  const changed = Object.values(fields).some((value) => value !== undefined);
  if (!changed) return;

  try {
    const stateManager = new FeatureStateManager(
      // FeatureStateManager subscribes on construction, so it needs a real
      // emitter (the server bus, or a throwaway one here).
      events ?? createEventEmitter(),
      featureLoader
    );
    try {
      await stateManager.updateFeatureFields(projectPath, featureId, fields);
    } finally {
      stateManager.destroy();
    }
  } catch (error) {
    logger.warn(
      `Could not persist herdr placement on feature ${featureId}: ${(error as Error).message}`
    );
  }
}

/**
 * Put every card of the worktree into its space.
 *
 * The space is the worktree, so it has to read like the branch: the epic and all
 * of its sub-tasks are tabs, each running that card's pi conversation. Tabs are
 * cheap and are created before the browser opens; the pi agents are started
 * afterwards in the background, because only the clicked card's pane has to be
 * ready right now.
 */
async function expandWorktreeSpace(params: {
  service: ReturnType<typeof getHerdrTaskService>;
  featureLoader: FeatureLoader;
  events?: EventEmitter;
  projectPath: string;
  workspaceId: string;
  workDir: string;
  feature: Feature;
}): Promise<void> {
  const { service, featureLoader, events, projectPath, workspaceId, workDir, feature } = params;
  const branch = feature.branchName ?? null;
  // A branch defines the worktree group; without one, `null === null` would pull
  // in every other branch-less feature of the project.
  if (!branch) return;

  const siblings = (await featureLoader.getAll(projectPath)).filter(
    (candidate) => candidate.id !== feature.id && (candidate.branchName ?? null) === branch
  );
  if (siblings.length === 0) return;

  const targets = siblings.map((candidate) => ({
    taskKeys: taskKeysOf(candidate, candidate.id),
    title: candidate.title || candidate.id,
    tabId: candidate.herdrTabId ?? null,
    providerSessionId: piSession(candidate),
  }));

  const persist = async (results: Awaited<ReturnType<typeof service.restoreSpaceTabs>>) => {
    for (const [index, result] of results.entries()) {
      const sibling = siblings[index];
      if (!sibling) continue;
      const needsWrite =
        sibling.herdrWorkspaceId !== workspaceId ||
        sibling.herdrTabId !== result.tabId ||
        (result.sessionId !== null &&
          result.sessionId !== undefined &&
          piSession(sibling) !== result.sessionId);
      if (!needsWrite) continue;
      await persistPlacement(featureLoader, events, projectPath, sibling.id, {
        herdrWorkspaceId: workspaceId,
        herdrTabId: result.tabId,
        [sessionField(sibling)]: result.sessionId ?? undefined,
      });
    }
  };

  const tabs = await service.restoreSpaceTabs({
    workspaceId,
    workDir,
    targets,
    agents: 'none',
    projectPath,
  });
  await persist(tabs);

  // Fire and forget: starting N pi conversations takes seconds each, and none of
  // them is on the critical path of the page that is about to open.
  void service
    .restoreSpaceTabs({ workspaceId, workDir, targets, agents: 'all', projectPath })
    .then(persist)
    .catch((error) => {
      logger.warn(
        `Could not resume the worktree's task conversations: ${(error as Error).message}`
      );
    });
}

export function createHerdrWebHandler(featureLoader: FeatureLoader, events?: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body as {
        projectPath?: string;
        featureId?: string;
      };
      if (!projectPath || !featureId) {
        res.status(400).json({
          success: false,
          error: 'projectPath and featureId are required',
        });
        return;
      }

      if (!isHerdrAvailable()) {
        res.status(503).json({
          success: false,
          error: 'herdr is not installed on this machine (install herdr or set HERDR_BIN)',
        });
        return;
      }

      const resolved = await resolveFeatureWorkDir(featureLoader, projectPath, featureId);
      if (!resolved) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }

      const taskName = resolved.feature.title || featureId;
      const persistedWorkspaceId = resolved.feature.herdrWorkspaceId ?? null;
      const persistedTabId = resolved.feature.herdrTabId ?? null;
      const persistedSessionId = piSession(resolved.feature);

      // Restore the task's conversation in the project's session. The card
      // promises the task's pi session, so a missing worktree space or task tab is
      // created here and a pane without a live agent gets pi back, resuming the
      // transcript the worktree already has.
      let workspaceId: string | null = persistedWorkspaceId;
      let tabId: string | null = persistedTabId;
      let restored = false;
      try {
        const target = await getHerdrTaskService(projectPath).restoreConversation({
          taskName,
          workDir: resolved.workDir,
          workspaceId: persistedWorkspaceId,
          tabId: persistedTabId,
          providerSessionId: persistedSessionId,
          taskKeys: taskKeysOf(resolved.feature, featureId),
          projectPath,
        });
        workspaceId = target.workspaceId;
        tabId = target.tabId;
        restored = target.createdWorkspace || target.createdTab || target.startedAgent;

        if (
          target.workspaceId !== persistedWorkspaceId ||
          target.tabId !== persistedTabId ||
          (target.sessionId && target.sessionId !== persistedSessionId)
        ) {
          await persistPlacement(featureLoader, events, projectPath, featureId, {
            herdrWorkspaceId: target.workspaceId,
            herdrTabId: target.tabId,
            // Pin the card to the pi conversation this tab is running, so the
            // next open resumes that one and not a sibling task's.
            [sessionField(resolved.feature)]: target.sessionId ?? undefined,
          });
        }
      } catch (error) {
        // Control failed (session unreachable, pane busy, ...). Still open the
        // terminal so the card degrades to the worktree session instead of 500.
        logger.warn(
          `Could not restore the herdr conversation for feature ${featureId}: ${
            (error as Error).message
          }`
        );
      }

      if (workspaceId) {
        try {
          await expandWorktreeSpace({
            service: getHerdrTaskService(projectPath),
            featureLoader,
            events,
            projectPath,
            workspaceId,
            workDir: resolved.workDir,
            feature: resolved.feature,
          });
        } catch (error) {
          logger.warn(
            `Could not list the worktree's tasks in herdr space ${workspaceId}: ${
              (error as Error).message
            }`
          );
        }
      }

      const terminalService = getTerminalService();
      const herdrService = getHerdrService(terminalService);
      // Always the project's session: restore only decides *where inside it* the
      // client lands, so a failed restore still opens the right session.
      const attach = await herdrService.attachWorktreeSession({
        projectPath,
        workDir: resolved.workDir,
      });

      // The page renders the PTY the attach above created, so it only needs the
      // terminal session id plus labels for the header.
      const query = new URLSearchParams({
        session: attach.terminalSessionId,
        name: attach.sessionName,
        title: resolved.feature.title || featureId,
        dir: resolved.workDir,
        projectPath,
        featureId,
      });

      res.json({
        success: true,
        url: `/api/herdr/view?${query.toString()}`,
        sessionName: attach.sessionName,
        terminalSessionId: attach.terminalSessionId,
        workspaceId,
        tabId,
        workDir: resolved.workDir,
        restored,
        reused: attach.reused,
      });
    } catch (error) {
      logError(error, 'Resolve herdr terminal link failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
