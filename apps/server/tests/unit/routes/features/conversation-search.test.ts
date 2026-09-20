/**
 * Conversation search reads the card's Pi transcripts off disk, so the test
 * builds a fake Pi session root for a project with two worktrees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { searchPiConversations } from '../../../../src/services/pi-session-store.js';
import { createConversationSearchHandler } from '../../../../src/routes/features/routes/conversation-search.js';

const PROJECT_PATH = '/workspace/demo';
const ORIGINAL_HOME = process.env.HOME;

let home: string;

/** Write one JSONL transcript into a Pi session directory */
function writeSession(dirName: string, fileName: string, entries: unknown[], mtime: Date) {
  const dir = path.join(home, '.pi', 'agent', 'sessions', dirName);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  utimesSync(file, mtime, mtime);
  return file;
}

function message(role: string, text: string, timestamp: number) {
  return {
    type: 'message',
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content: [{ type: 'text', text }], timestamp },
  };
}

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'conversation-search-'));
  process.env.HOME = home;

  writeSession(
    '--workspace-demo--',
    '2026-09-19T10-00-00-000Z_01a0b900-1111-7111-8111-111111111111.jsonl',
    [
      {
        type: 'session',
        id: '01a0b900-1111-7111-8111-111111111111',
        timestamp: '2026-09-19T10:00:00.000Z',
        cwd: PROJECT_PATH,
      },
      message('user', '**Feature ID:** card-1\n\nfix the auth bug', 1758276000000),
      message('assistant', 'patched src/auth.ts', 1758276001000),
      message('toolResult', 'ERROR: token expired', 1758276002000),
    ],
    new Date('2026-09-19T10:00:00.000Z')
  );

  writeSession(
    '--workspace-demo-.worktrees-aip-1--',
    '2026-09-18T10-00-00-000Z_01a0b800-2222-7222-8222-222222222222.jsonl',
    [
      {
        type: 'session',
        id: '01a0b800-2222-7222-8222-222222222222',
        timestamp: '2026-09-18T10:00:00.000Z',
        cwd: '/workspace/demo/.worktrees/aip-1',
      },
      message('user', '**Feature ID:** card-2\n\nfirst pass', 1758189600000),
      message('toolResult', 'the auth bug is still there', 1758189601000),
    ],
    new Date('2026-09-18T10:00:00.000Z')
  );

  // A second, older run of the same card: search shows the card once.
  writeSession(
    '--workspace-demo--',
    '2026-09-17T10-00-00-000Z_01a0b700-3333-7333-8333-333333333333.jsonl',
    [
      {
        type: 'session',
        id: '01a0b700-3333-7333-8333-333333333333',
        timestamp: '2026-09-17T10:00:00.000Z',
        cwd: PROJECT_PATH,
      },
      message('user', '**Feature ID:** card-1\n\nretry the auth bug', 1758103200000),
    ],
    new Date('2026-09-17T10:00:00.000Z')
  );
});

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('searchPiConversations', () => {
  it('matches prompts, answers and tool output across the project worktrees', async () => {
    const result = await searchPiConversations(PROJECT_PATH, 'auth bug');

    expect(result.matches).toHaveLength(2);
    expect(result.scannedSessions).toBe(3);
    expect(result.truncated).toBe(false);
    // Newest session first, and the card comes from the dispatch marker.
    expect(result.matches[0]).toMatchObject({
      featureId: 'card-1',
      sessionId: '01a0b900-1111-7111-8111-111111111111',
      cwd: PROJECT_PATH,
      role: 'user',
    });
    expect(result.matches[0]?.snippet).toContain('auth bug');
    // Both runs of the card fold into one row.
    expect(result.matches[0]?.hitCount).toBe(2);
    // The older hit lives in a worktree the card no longer uses.
    expect(result.matches[1]).toMatchObject({ featureId: 'card-2', role: 'toolResult' });
  });

  it('searches tool results and matches case-insensitively', async () => {
    const result = await searchPiConversations(PROJECT_PATH, 'TOKEN EXPIRED');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ featureId: 'card-1', role: 'toolResult' });
    expect(result.matches[0]?.snippet).toBe('ERROR: token expired');
  });

  it('returns nothing for an unknown keyword and stops at the limit', async () => {
    await expect(searchPiConversations(PROJECT_PATH, 'nothing here')).resolves.toMatchObject({
      matches: [],
      truncated: false,
    });

    const limited = await searchPiConversations(PROJECT_PATH, 'auth bug', { limit: 1 });
    expect(limited.matches).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });
});

describe('conversation search route', () => {
  function fakeRequest(body: Record<string, unknown>): Request {
    return { body } as Request;
  }

  function fakeResponse() {
    const recorded: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        recorded.status = code;
        return this;
      },
      json(body: unknown) {
        recorded.body = body;
        return this;
      },
    };
    return { res: res as unknown as Response, recorded };
  }

  it('rejects a missing query', async () => {
    const { res, recorded } = fakeResponse();
    await createConversationSearchHandler()(fakeRequest({ projectPath: PROJECT_PATH }), res);

    expect(recorded.status).toBe(400);
    expect(recorded.body).toMatchObject({ success: false });
  });

  it('returns the matches for a query', async () => {
    const { res, recorded } = fakeResponse();
    await createConversationSearchHandler()(
      fakeRequest({ projectPath: PROJECT_PATH, query: 'auth bug' }),
      res
    );

    expect(recorded.status).toBeUndefined();
    expect(recorded.body).toMatchObject({
      success: true,
      data: { matches: [{ featureId: 'card-1' }, { featureId: 'card-2' }] },
    });
  });
});
