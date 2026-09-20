/**
 * Herdr transcript helpers.
 *
 * herdr panes run agents on the terminal's alternate screen, which means pane
 * scrollback is NOT a reliable transcript: rows that leave the alt screen never
 * reach herdr's host scrollback, so `pane read --lines N` silently truncates a
 * long answer.
 *
 * Pi solves this for us: every interactive pi run appends a structured JSONL
 * session file and herdr reports that exact path as
 * `agent_session.value` (source `herdr:pi`, kind `path`). This module turns
 * those files into transcripts, with a pane-read fallback for agents that do
 * not expose a session file.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import {
  readPiSessionFile,
  type PiSessionInfo,
  type PiSessionMessage,
} from './pi-session-store.js';
import type { HerdrAgentInfo, HerdrControlClient } from './herdr-client.js';

/** One agent's transcript in a task workspace */
export interface HerdrAgentTranscript {
  /** herdr agent name, when herdr still reports one */
  name: string | null;
  paneId: string;
  /** `leader`, `worker-1`, ... derived from the agent's role */
  role: string;
  model: string | null;
  status: HerdrAgentInfo['agent_status'];
  /** Absolute path of the pi session JSONL backing this transcript */
  sessionFile: string | null;
  /** Messages in order; empty when only raw terminal text was available */
  messages: PiSessionMessage[];
  /** Raw terminal text, used when no session file is available */
  rawOutput?: string;
  /** Where the transcript came from */
  source: 'pi-session' | 'pane-read' | 'none';
  updatedAt: string | null;
}

/** Derive a readable role name from a herdr agent name */
export function deriveAgentRole(agentName: string | null | undefined): string {
  if (!agentName) return 'agent';
  return agentName;
}

/**
 * Resolve the JSONL session file for an agent.
 *
 * Prefers herdr's reported `agent_session.value` (authoritative - it is the file
 * pi itself opened), and falls back to nothing: guessing by mtime would attach
 * the wrong transcript when several pi processes share a worktree, which is
 * exactly the norm here (one leader + N workers).
 */
export function resolveAgentSessionFile(agent: HerdrAgentInfo): string | null {
  const reported = agent.agent_session?.value;
  if (!reported) return null;
  if (!existsSync(reported)) return null;
  return reported;
}

/**
 * Read one agent's transcript.
 *
 * `includeRawFallback` reads the pane when no session file exists; callers that
 * only want structured data can turn it off.
 */
export async function readAgentTranscript(
  client: HerdrControlClient,
  agent: HerdrAgentInfo,
  options: { rawLines?: number; includeRawFallback?: boolean } = {}
): Promise<HerdrAgentTranscript> {
  const sessionFile = resolveAgentSessionFile(agent);
  const base = {
    name: agent.name ?? null,
    paneId: agent.pane_id,
    role: deriveAgentRole(agent.name),
    status: agent.agent_status,
  };

  if (sessionFile) {
    const session: PiSessionInfo | null = readPiSessionFile(sessionFile);
    if (session) {
      return {
        ...base,
        model: session.modelId ?? null,
        sessionFile,
        messages: session.messages,
        source: 'pi-session',
        updatedAt: session.updatedAt,
      };
    }
  }

  if (options.includeRawFallback === false) {
    return {
      ...base,
      model: null,
      sessionFile: null,
      messages: [],
      source: 'none',
      updatedAt: null,
    };
  }

  // No structured session: fall back to the pane's rendered text. This is
  // lossy for long output (alt screen), so it is clearly marked as such.
  try {
    const read = await client.readPane(agent.pane_id, {
      source: 'recent_unwrapped',
      lines: options.rawLines ?? 400,
    });
    return {
      ...base,
      model: null,
      sessionFile: null,
      messages: [],
      rawOutput: read.text ?? '',
      source: 'pane-read',
      updatedAt: null,
    };
  } catch {
    return {
      ...base,
      model: null,
      sessionFile: null,
      messages: [],
      source: 'none',
      updatedAt: null,
    };
  }
}

/** Whether a pi session file has grown since the given timestamp */
export function sessionFileChangedSince(filePath: string, since: Date): boolean {
  try {
    return statSync(filePath).mtimeMs > since.getTime();
  } catch {
    return false;
  }
}

/** Flatten a transcript into plain text, used for status output and summaries */
export function transcriptToText(transcript: HerdrAgentTranscript): string {
  if (transcript.source === 'pi-session') {
    // Only the latest assistant reply is the agent's current answer; earlier
    // turns in the same pi session would otherwise be replayed (for example an
    // old plan with stale file paths when the task is re-dispatched).
    const lastAnswer = [...transcript.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    const messages = lastAnswer ? [lastAnswer] : transcript.messages;
    return messages
      .map((message) => {
        const header = `[${message.role}]`;
        const body = message.text || message.thinking || '';
        const tools = (message.toolCalls ?? []).map((call) => `  tool: ${call.name}`).join('\n');
        return [header, body, tools].filter(Boolean).join('\n');
      })
      .join('\n\n');
  }
  return transcript.rawOutput ?? '';
}

/** Read the raw first line of a session file (used to identify it cheaply) */
export function readSessionHeaderId(filePath: string): string | null {
  try {
    const firstLine = readFileSync(filePath, 'utf8').split('\n', 1)[0];
    const parsed = JSON.parse(firstLine) as { type?: string; id?: string };
    return parsed.type === 'session' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}
