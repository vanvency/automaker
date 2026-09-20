import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  deriveAgentRole,
  readAgentTranscript,
  resolveAgentSessionFile,
  transcriptToText,
} from '../../../src/services/herdr-transcript.js';
import type { HerdrAgentInfo } from '../../../src/services/herdr-client.js';
import type { HerdrControlClient } from '../../../src/services/herdr-client.js';

function makeAgent(overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    name: 'worker-1',
    agent: 'pi',
    agent_status: 'idle',
    pane_id: 'w1:p2',
    tab_id: 'w1:t1',
    workspace_id: 'w1',
    focused: false,
    ...overrides,
  };
}

/** Minimal pi session file: session header, model change, one exchange. */
function writeSessionFile(dir: string, id: string, model: string): string {
  const file = path.join(dir, id + '.jsonl');
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-09-18T00:00:00.000Z',
      cwd: dir,
    }),
    JSON.stringify({ type: 'model_change', id: 'm1', provider: 'litellm', modelId: model }),
    JSON.stringify({
      type: 'message',
      id: 'u1',
      message: { role: 'user', content: [{ type: 'text', text: 'implement X' }] },
    }),
    JSON.stringify({
      type: 'message',
      id: 'a1',
      message: {
        role: 'assistant',
        model,
        content: [
          { type: 'text', text: 'done with X' },
          { type: 'toolCall', id: 't1', name: 'edit', arguments: { file: 'x.ts' } },
        ],
      },
    }),
  ];
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('herdr-transcript', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'herdr-tx-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeClient(overrides: Partial<HerdrControlClient> = {}): HerdrControlClient {
    return {
      readPane: vi.fn().mockResolvedValue({ text: 'RENDERED PANE TEXT', pane_id: 'w1:p2' }),
      ...overrides,
    } as unknown as HerdrControlClient;
  }

  it('derives a role label from the agent name', () => {
    expect(deriveAgentRole('leader')).toBe('leader');
    expect(deriveAgentRole('worker-3')).toBe('worker-3');
    expect(deriveAgentRole(null)).toBe('agent');
  });

  it('uses the session file herdr reports, not a guessed one', () => {
    const file = writeSessionFile(dir, 'abc', 'worker');
    const agent = makeAgent({
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: file },
    });
    expect(resolveAgentSessionFile(agent)).toBe(file);
  });

  it('ignores a reported session file that does not exist', () => {
    const agent = makeAgent({
      agent_session: {
        agent: 'pi',
        kind: 'path',
        source: 'herdr:pi',
        value: path.join(dir, 'missing.jsonl'),
      },
    });
    expect(resolveAgentSessionFile(agent)).toBeNull();
  });

  it('parses a pi session file into messages with tools and model', async () => {
    const file = writeSessionFile(dir, 'sess-1', 'worker');
    const agent = makeAgent({
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: file },
    });
    const transcript = await readAgentTranscript(fakeClient(), agent);

    expect(transcript.source).toBe('pi-session');
    expect(transcript.model).toBe('worker');
    expect(transcript.sessionFile).toBe(file);
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0]).toMatchObject({ role: 'user', text: 'implement X' });
    expect(transcript.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'done with X',
      model: 'worker',
    });
    expect(transcript.messages[1].toolCalls?.[0]).toMatchObject({ name: 'edit' });
  });

  it('keeps leader and worker transcripts separate when they share a worktree', async () => {
    const leaderFile = writeSessionFile(dir, 'leader-sess', 'leader');
    const workerFile = writeSessionFile(dir, 'worker-sess', 'worker');
    const leader = makeAgent({
      name: 'leader',
      pane_id: 'w1:p1',
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: leaderFile },
    });
    const worker = makeAgent({
      name: 'worker-1',
      pane_id: 'w1:p2',
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: workerFile },
    });

    const [a, b] = await Promise.all([
      readAgentTranscript(fakeClient(), leader),
      readAgentTranscript(fakeClient(), worker),
    ]);
    expect(a.model).toBe('leader');
    expect(b.model).toBe('worker');
    expect(a.sessionFile).not.toBe(b.sessionFile);
  });

  it('falls back to pane text when no session file is available', async () => {
    const transcript = await readAgentTranscript(fakeClient(), makeAgent());
    expect(transcript.source).toBe('pane-read');
    expect(transcript.rawOutput).toBe('RENDERED PANE TEXT');
  });

  it('skips the pane fallback when the caller only wants structured data', async () => {
    const client = fakeClient();
    const transcript = await readAgentTranscript(client, makeAgent(), {
      includeRawFallback: false,
    });
    expect(transcript.source).toBe('none');
    expect(client.readPane).not.toHaveBeenCalled();
  });

  it('flattens a structured transcript to text', async () => {
    const file = writeSessionFile(dir, 'sess-2', 'worker');
    const agent = makeAgent({
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: file },
    });
    const text = transcriptToText(await readAgentTranscript(fakeClient(), agent));
    expect(text).toContain('[assistant]\ndone with X');
    expect(text).toContain('tool: edit');
  });

  it('does not lose content appended to the session file', async () => {
    const file = writeSessionFile(dir, 'sess-3', 'worker');
    appendFileSync(
      file,
      JSON.stringify({
        type: 'message',
        id: 'a2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ESSAY-END' }] },
      }) + '\n'
    );
    const agent = makeAgent({
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: file },
    });
    const transcript = await readAgentTranscript(fakeClient(), agent);
    expect(transcriptToText(transcript)).toContain('ESSAY-END');
  });

  it('flattens only the latest assistant reply', async () => {
    const file = writeSessionFile(dir, 'sess-4', 'worker');
    // Simulate a re-dispatched task: two exchanges in one pi session.
    appendFileSync(
      file,
      JSON.stringify({
        type: 'message',
        id: 'u2',
        message: { role: 'user', content: [{ type: 'text', text: 'plan again' }] },
      }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          id: 'a2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'STALE PLAN' }] },
        }) +
        '\n'
    );
    const agent = makeAgent({
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: file },
    });
    const text = transcriptToText(await readAgentTranscript(fakeClient(), agent));
    expect(text).toContain('STALE PLAN');
    expect(text).not.toContain('done with X');
  });
});
