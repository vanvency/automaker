/**
 * POST /api/features/timeline - everything that happened on one card.
 *
 * Pi writes a session file for every run, stamped with `**Feature ID:**` when
 * the prompt was dispatched for a card. So the card's worktree session
 * directory holds both halves of the timeline: the resident sessions that
 * belong to this feature, and the one-shot calls (commit message, title,
 * follow-ups) that ran in the same worktree without a feature stamp.
 */

import type { Request, Response } from 'express';
import { createLogger } from '@automaker/utils';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import {
  listPiSessionFiles,
  readPiSessionFile,
  readSessionFeatureId,
  type PiSessionMessage,
} from '../../../services/pi-session-store.js';
import { resolveFeatureWorkDir } from './opencode-session.js';
import { getErrorMessage, logError } from '../common.js';
import { readFeatureReplies } from '../../../services/feature-reply-history.js';

const logger = createLogger('FeatureTimeline');

export interface FeatureTimelineEntry {
  id: string;
  kind: 'session' | 'one-shot' | 'lifecycle' | 'jira' | 'reply';
  /** ISO timestamp the entry started at */
  at: string;
  endedAt?: string | null;
  developmentAt?: string;
  verificationAt?: string;
  title: string;
  detail?: string;
  model?: string;
  turns?: number;
  status?: 'ok' | 'error';
  filePath?: string;
  imagePaths?: string[];
}

function fileTimestamp(filePath: string): string | null {
  const match = /\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z_/.exec(filePath);
  if (!match) return null;
  const [, date, hour, minute, second] = match;
  return `${date}T${hour}:${minute}:${second}Z`;
}

/** Fields that change the task's requirements rather than its metadata. */
const REQUIREMENT_FIELDS = new Set(['description', 'requirements']);

function excerpt(value: string | undefined, max = 160): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function conversationTimes(messages: PiSessionMessage[], userIndex: number) {
  let developmentAt: string | undefined;
  let verificationAt: string | undefined;
  for (let index = userIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'user') break;
    if (message.role !== 'assistant' || !Number.isFinite(message.timestamp)) continue;
    const date = new Date(message.timestamp!);
    if (!Number.isFinite(date.getTime())) continue;
    const at = date.toISOString();
    developmentAt ??= at;
    // shortcut: recognizes common test commands; record explicit verification phases when available.
    if (
      !verificationAt &&
      message.toolCalls?.some(
        (call) =>
          /^(bash|exec|exec_command|shell)$/i.test(call.name) &&
          typeof call.arguments === 'object' &&
          call.arguments !== null &&
          Object.entries(call.arguments).some(
            ([key, value]) =>
              /^(command|cmd)$/.test(key) &&
              typeof value === 'string' &&
              /\b(?:npm\s+(?:run\s+test[\w:-]*|test)\b|npx\s+(?:vitest|playwright)\b|(?:pnpm|yarn|bun|go|cargo|mvn)\s+test\b|pytest\b|python3?\s+-m\s+unittest\b)/i.test(
                value
              )
          )
      )
    ) {
      verificationAt = at;
    }
  }
  return { ...(developmentAt && { developmentAt }), ...(verificationAt && { verificationAt }) };
}

/**
 * "Jira 描述更新" entries: the monitor records every unacknowledged Jira edit on
 * the card, so a requirement change while the agent works shows up in the same
 * timeline as the runs it affected.
 */
function jiraChangeEntries(feature: {
  jiraChanges?: Array<{ field?: string; before?: string; after?: string; detectedAt?: string }>;
}): FeatureTimelineEntry[] {
  return (feature.jiraChanges ?? [])
    .filter((change) => REQUIREMENT_FIELDS.has(String(change.field ?? '').toLowerCase()))
    .map((change, index) => {
      const before = excerpt(change.before);
      const after = excerpt(change.after);
      return {
        id: `jira:${change.field}:${change.detectedAt ?? index}`,
        kind: 'jira' as const,
        at: change.detectedAt ?? '',
        title: `Jira ${change.field === 'description' ? '描述' : '需求'}更新`,
        detail: [before && `原：${before}`, after && `新：${after}`].filter(Boolean).join(' → '),
      };
    })
    .filter((entry) => entry.at !== '');
}

export function createFeatureTimelineHandler(featureLoader: FeatureLoader) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body as {
        projectPath?: string;
        featureId?: string;
      };
      if (
        typeof projectPath !== 'string' ||
        !projectPath ||
        typeof featureId !== 'string' ||
        !/^[\w-]+$/.test(featureId)
      ) {
        res.status(400).json({ success: false, error: 'projectPath and featureId are required' });
        return;
      }

      const resolved = await resolveFeatureWorkDir(featureLoader, projectPath, featureId);
      if (!resolved) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }
      const { feature, workDir } = resolved;
      const featureKeys = new Set(
        [featureId, feature.jiraKey]
          .filter((key): key is string => typeof key === 'string' && key.length > 0)
          .map((key) => key.toLowerCase())
      );

      const entries: FeatureTimelineEntry[] = [];
      const replies = await readFeatureReplies(projectPath, featureId);
      const replyIds = new Set(replies.map((reply) => reply.id));
      const storedReplyEntries = new Map<string, FeatureTimelineEntry>();
      entries.push(
        ...replies.map((reply) => ({
          id: `reply:${reply.id}`,
          kind: 'reply' as const,
          at: reply.at,
          title: 'Reply',
          detail: reply.text,
          imagePaths: reply.imagePaths,
        }))
      );
      for (const entry of entries) {
        if (entry.kind === 'reply') storedReplyEntries.set(entry.id.slice('reply:'.length), entry);
      }

      entries.push(...jiraChangeEntries(feature));

      if (feature.createdAt) {
        entries.push({
          id: 'lifecycle:created',
          kind: 'lifecycle',
          at: feature.createdAt,
          title: '卡片创建',
        });
      }
      if (feature.startedAt) {
        entries.push({
          id: 'lifecycle:started',
          kind: 'lifecycle',
          at: feature.startedAt,
          title: '开始执行',
        });
      }
      const justFinishedAt =
        typeof feature.justFinishedAt === 'string' ? feature.justFinishedAt : undefined;
      if (justFinishedAt) {
        entries.push({
          id: 'lifecycle:finished',
          kind: 'lifecycle',
          at: justFinishedAt,
          title: `本轮到 ${feature.status}`,
        });
      }

      for (const filePath of listPiSessionFiles(workDir)) {
        const stamp = readSessionFeatureId(filePath)?.toLowerCase();
        if (stamp && !featureKeys.has(stamp)) continue;
        const session = readPiSessionFile(filePath);
        if (!session) continue;

        const isResident =
          (stamp !== undefined && featureKeys.has(stamp)) ||
          (!!feature.providerSessionId && session.id === feature.providerSessionId);
        if (isResident) {
          session.messages.forEach((message, index) => {
            if (message.role !== 'user' || !message.text.trim()) return;
            const replyId = /Automaker reply ID: ([\w-]+)/.exec(message.text)?.[1];
            const times = conversationTimes(session.messages, index);
            if (replyId && storedReplyEntries.has(replyId)) {
              Object.assign(storedReplyEntries.get(replyId)!, times);
            }
            if (replyId && replyIds.has(replyId)) return;
            const followUp = /## Follow-up Instructions\s*\n([\s\S]*?)\n## Task(?:\r?\n|$)/.exec(
              message.text
            )?.[1];
            // Recover historical Reply prompts and direct conversation input,
            // excluding the initial task and generated dispatch scaffolding.
            if (
              followUp === undefined &&
              (index === 0 ||
                /(?:\*\*Feature ID:\*\*|## (?:Feature|Continuing|Continue Implementation|Pipeline))/.test(
                  message.text
                ))
            )
              return;
            const at = message.timestamp ? new Date(message.timestamp) : null;
            if (!at || !Number.isFinite(at.getTime())) return;
            entries.push({
              id: `reply:session:${session.id}:${index}`,
              kind: 'reply',
              at: at.toISOString(),
              title: 'Reply · conversation history',
              detail: followUp?.trim() || message.text,
              ...times,
            });
          });
        }
        const failed = session.messages.some(
          (message) => message.role === 'assistant' && message.isError
        );
        const model = [session.modelProvider, session.modelId].filter(Boolean).join('/');

        entries.push({
          id: `session:${session.id}`,
          kind: isResident ? 'session' : 'one-shot',
          at: session.createdAt ?? fileTimestamp(filePath) ?? feature.createdAt ?? '',
          endedAt: session.updatedAt,
          ...conversationTimes(
            session.messages,
            session.messages.findIndex((m) => m.role === 'user')
          ),
          title: isResident ? `常驻会话${model ? ` · ${model}` : ''}` : '一次性调用',
          detail: session.messages.find((m) => m.role === 'user')?.text,
          model: model || undefined,
          turns: session.userTurnCount,
          status: failed ? 'error' : 'ok',
          filePath,
        });
      }

      entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      res.json({ success: true, workDir, entries });
    } catch (error) {
      logError(error, 'Read feature timeline failed');
      logger.debug(`timeline failed: ${getErrorMessage(error)}`);
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
