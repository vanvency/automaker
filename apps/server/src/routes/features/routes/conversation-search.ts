/**
 * POST /api/features/conversation-search - keyword search across task conversations.
 *
 * Pi keeps every task conversation as a JSONL transcript under
 * `~/.pi/agent/sessions`, so the history outlives the card's herdr tab and even
 * its worktree. Searching those files lets a string from a log (an error, a file
 * path, a JIRA key) be traced back to the card that produced it.
 */

import type { Request, Response } from 'express';
import { createLogger } from '@automaker/utils';
import { searchPiConversations } from '../../../services/pi-session-store.js';
import { getErrorMessage, logError } from '../common.js';

const logger = createLogger('ConversationSearch');

/** Longer than this is a paste, not a search term */
const MAX_QUERY_CHARS = 200;

export function createConversationSearchHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, query, limit } = req.body as {
        projectPath?: string;
        query?: string;
        limit?: number;
      };

      if (!projectPath) {
        res.status(400).json({ success: false, error: 'projectPath is required' });
        return;
      }

      const needle = typeof query === 'string' ? query.trim() : '';
      if (!needle) {
        res.status(400).json({ success: false, error: 'query is required' });
        return;
      }
      if (needle.length > MAX_QUERY_CHARS) {
        res.status(400).json({
          success: false,
          error: `query must be ${MAX_QUERY_CHARS} characters or fewer`,
        });
        return;
      }

      const result = await searchPiConversations(projectPath, needle, {
        limit: typeof limit === 'number' ? limit : undefined,
      });
      logger.debug(
        `Conversation search "${needle}" matched ${result.matches.length} of ${result.scannedSessions} sessions`
      );
      res.json({ success: true, data: result });
    } catch (error) {
      logError(error, 'Conversation search failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
