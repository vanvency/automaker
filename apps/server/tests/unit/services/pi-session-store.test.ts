import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  encodePiProjectDir,
  findPiSessionForFeature,
  readPiSessionFile,
  readSessionFeatureId,
  resolvePiSessionModel,
} from '../../../src/services/pi-session-store.js';

describe('pi-session-store.ts', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pi-session-store-'));
    file = path.join(dir, '2026-09-15T07-52-09-307Z_01a0a40d-495a-7729-bb6c-413fd6b94d14.jsonl');

    const lines = [
      {
        type: 'session',
        version: 3,
        id: '01a0a40d-495a-7729-bb6c-413fd6b94d14',
        timestamp: '2026-09-15T07:52:09.307Z',
        cwd: '/workspace/automaker',
      },
      { type: 'model_change', id: 'm1', parentId: null, provider: 'litellm', modelId: 'auto' },
      { type: 'thinking_level_change', id: 't1', parentId: 'm1', thinkingLevel: 'off' },
      {
        type: 'message',
        id: 'u1',
        parentId: 't1',
        message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }], timestamp: 1 },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me look' },
            { type: 'text', text: 'done' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
          ],
          model: 'auto',
          stopReason: 'stop',
          timestamp: 2,
        },
      },
      {
        type: 'message',
        id: 'r1',
        parentId: 'a1',
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
        },
      },
      {
        type: 'message',
        id: 'u2',
        parentId: 'r1',
        message: { role: 'user', content: [{ type: 'text', text: 'and again' }], timestamp: 3 },
      },
    ];

    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('encodes the project directory the way Pi names it', () => {
    expect(encodePiProjectDir('/workspace/automaker')).toBe('--workspace-automaker--');
    expect(encodePiProjectDir('/workspace')).toBe('--workspace--');
  });

  it('parses session metadata and messages', () => {
    const session = readPiSessionFile(file);

    expect(session).not.toBeNull();
    expect(session?.id).toBe('01a0a40d-495a-7729-bb6c-413fd6b94d14');
    expect(session?.cwd).toBe('/workspace/automaker');
    expect(session?.modelProvider).toBe('litellm');
    expect(session?.modelId).toBe('auto');
    expect(session?.thinkingLevel).toBe('off');
    expect(session?.userTurnCount).toBe(2);
    expect(session?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'user',
    ]);
  });

  it('keeps assistant text, reasoning and tool calls', () => {
    const assistant = readPiSessionFile(file)?.messages[1];

    expect(assistant?.text).toBe('done');
    expect(assistant?.thinking).toBe('let me look');
    expect(assistant?.toolCalls).toEqual([
      { id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
    ]);
    expect(assistant?.isError).toBe(false);
  });

  it('flattens tool results to text', () => {
    const toolResult = readPiSessionFile(file)?.messages[2];
    expect(toolResult?.role).toBe('toolResult');
    expect(toolResult?.text).toBe('file contents');
  });

  it('resolves the model for follow-up turns', () => {
    const session = readPiSessionFile(file);
    expect(resolvePiSessionModel(session)).toEqual({ provider: 'litellm', modelId: 'auto' });
  });

  it('returns null for files without a session header', () => {
    const empty = path.join(dir, 'empty.jsonl');
    writeFileSync(empty, '{"type":"message","message":{"role":"user","content":"hi"}}\n');
    expect(readPiSessionFile(empty)).toBeNull();
  });

  it('returns null for missing files', () => {
    expect(readPiSessionFile(path.join(dir, 'nope.jsonl'))).toBeNull();
  });

  describe('dispatch markers', () => {
    let home: string;
    let originalHome: string | undefined;

    /** Write a minimal pi session file whose prompt carries the given markers */
    function writeSession(name: string, id: string, markers: string[]): string {
      const projectDir = path.join(home, '.pi', 'agent', 'sessions', encodePiProjectDir('/wt'));
      mkdirSync(projectDir, { recursive: true });
      const target = path.join(projectDir, name);
      const lines = [
        { type: 'session', version: 3, id, timestamp: '2026-09-18T00:00:00.000Z', cwd: '/wt' },
        {
          type: 'message',
          id: 'u1',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: markers.map((marker) => `**Feature ID:** ${marker}`).join('\n\n'),
              },
            ],
          },
        },
      ];
      writeFileSync(target, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
      return target;
    }

    beforeEach(() => {
      home = mkdtempSync(path.join(tmpdir(), 'pi-sessions-home-'));
      originalHome = process.env.HOME;
      process.env.HOME = home;
    });

    afterEach(() => {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    });

    it('reads the feature a session was dispatched for, not a quoted parent', () => {
      const file = writeSession('child.jsonl', 'child-id', ['aip-1-child-1', 'jira-parent-9']);
      expect(readSessionFeatureId(file)).toBe('aip-1-child-1');
    });

    it('returns null for sessions without a dispatch marker', () => {
      const file = writeSession('manual.jsonl', 'manual-id', []);
      expect(readSessionFeatureId(file)).toBeNull();
    });

    it('matches only the session dispatched for that card', () => {
      writeSession('2026-09-17T00-00-00-000Z_child.jsonl', 'child-id', [
        'aip-1-child-1',
        'jira-parent-9',
      ]);
      writeSession('2026-09-18T00-00-00-000Z_parent.jsonl', 'parent-id', ['jira-parent-9']);

      expect(findPiSessionForFeature('/wt', ['jira-parent-9'])?.id).toBe('parent-id');
      expect(findPiSessionForFeature('/wt', ['aip-1-child-1'])?.id).toBe('child-id');
      expect(findPiSessionForFeature('/wt', ['aip-1-other'])).toBeNull();
    });
  });
});
