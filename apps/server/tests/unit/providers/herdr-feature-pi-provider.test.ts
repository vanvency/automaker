import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteOptions, Feature, ProviderMessage } from '@automaker/types';
import { HerdrFeaturePiProvider } from '../../../src/providers/herdr-feature-pi-provider.js';
import type { HerdrTaskService } from '../../../src/services/herdr-task-service.js';
import { DEFAULT_AUTO_MODE_FOLLOW_UP_PROMPT_TEMPLATE } from '@automaker/prompts';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  bootstrap: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../../../src/services/pi-session-store.js', () => ({ readPiSessionFile: mocks.read }));
vi.mock('../../../src/services/herdr-bootstrap.js', () => ({ bootstrapHerdr: mocks.bootstrap }));
vi.mock('../../../src/providers/pi-litellm.js', () => ({ resolveLitellmApiKey: () => undefined }));
vi.mock('../../../src/providers/pi-provider.js', () => ({
  PiProvider: class {
    refreshModels = mocks.refresh;
    buildCliArgs() {
      return [
        '--print',
        '--mode',
        'json',
        '--provider',
        'litellm',
        '--model',
        'worker',
        '--thinking',
        'high',
      ];
    }
  },
}));

describe('Pi feature execution through herdr', () => {
  const feature = { id: 'task-a', title: 'Task A', providerSessionId: 'session-a' } as Feature;
  const options: ExecuteOptions = {
    model: 'litellm/worker',
    cwd: '/project/wt',
    prompt: 'My reply',
  };
  let persist: ReturnType<typeof vi.fn>;
  let service: {
    restoreConversation: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    getClient: ReturnType<typeof vi.fn>;
  };
  let request: ReturnType<typeof vi.fn>;
  let getAgent: ReturnType<typeof vi.fn>;
  const agent = {
    agent: 'pi',
    agent_status: 'idle',
    pane_id: 'w1:p1',
    agent_session: { value: '/pi/session-a.jsonl' },
  };
  const snapshot = (messages: unknown[]) => ({ id: 'session-a', messages });

  beforeEach(() => {
    mocks.bootstrap.mockResolvedValue({ available: true, piIntegrationReady: true, problems: [] });
    mocks.refresh.mockResolvedValue([]);
    persist = vi.fn().mockResolvedValue(undefined);
    request = vi.fn().mockResolvedValue({});
    getAgent = vi.fn().mockResolvedValue(agent);
    service = {
      restoreConversation: vi.fn().mockResolvedValue({
        paneId: 'w1:p1',
        workspaceId: 'w1',
        tabId: 'w1:t1',
        sessionId: 'session-a',
      }),
      prompt: vi.fn().mockResolvedValue(agent),
      getClient: vi.fn(() => ({ getAgent, request })),
    };
  });

  async function run(overrides: Partial<ExecuteOptions> = {}) {
    const provider = new HerdrFeaturePiProvider(
      { projectPath: '/project', feature, persist },
      service as unknown as HerdrTaskService
    );
    const messages: ProviderMessage[] = [];
    for await (const message of provider.executeQuery({ ...options, ...overrides }))
      messages.push(message);
    return messages;
  }

  it('records Reply in the card pane and streams only its new output with the same session ID', async () => {
    const old = [{ role: 'assistant', text: 'old answer' }];
    mocks.read.mockReturnValueOnce(snapshot(old)).mockReturnValue(
      snapshot([
        ...old,
        { role: 'user', text: '**Feature ID:** task-a\n\nMy reply' },
        {
          role: 'assistant',
          text: 'working',
          toolCalls: [{ id: 't1', name: 'read', arguments: { path: '/file' } }],
        },
        { role: 'toolResult', text: 'file contents' },
        { role: 'assistant', text: 'new answer' },
      ])
    );
    const messages = await run();
    expect(service.prompt).toHaveBeenCalledExactlyOnceWith(
      'w1:p1',
      '**Feature ID:** task-a\n\nMy reply'
    );
    expect(service.restoreConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: 'session-a',
        executionArgs: ['--provider', 'litellm', '--model', 'worker', '--thinking', 'high'],
      })
    );
    expect(persist).toHaveBeenCalledWith({
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      providerSessionId: 'session-a',
    });
    expect(JSON.stringify(messages)).not.toContain('old answer');
    expect(messages[0].message?.content).toContainEqual({
      type: 'tool_use',
      name: 'read',
      input: { path: '/file' },
    });
    expect(messages.at(-1)).toEqual({
      type: 'result',
      subtype: 'success',
      session_id: 'session-a',
    });
  });

  it('does not submit a Reply to a busy pane or launch a hidden fallback', async () => {
    getAgent.mockResolvedValue({ ...agent, agent_status: 'working' });
    await expect(run()).rejects.toThrow('busy');
    expect(service.prompt).not.toHaveBeenCalled();
  });

  it.each(['\n', '\r\n'])(
    'recognizes the real Reply template after Pi trims its trailing newline (%j)',
    async (newline) => {
      const prompt = DEFAULT_AUTO_MODE_FOLLOW_UP_PROMPT_TEMPLATE.replace(
        '{{featurePrompt}}',
        '## Feature Implementation Task\n\n**Feature ID:** task-a\n'
      )
        .replace('{{previousContext}}', '')
        .replace('{{followUpInstructions}}', 'review下目前的改动，完成剩余未完成任务')
        .replaceAll('\n', newline);
      expect(prompt.endsWith(newline)).toBe(true);
      const recordedText = `**Feature ID:** task-a\n\n${prompt}`.replace(/\r\n/g, '\n').trim();
      mocks.read.mockReturnValueOnce(snapshot([])).mockReturnValue(
        snapshot([
          { role: 'user', text: recordedText },
          {
            role: 'assistant',
            text: '',
            toolCalls: [{ id: 't1', name: 'bash', arguments: { command: 'git status' } }],
          },
          { role: 'toolResult', text: 'clean' },
          { role: 'assistant', text: 'Review completed' },
        ])
      );
      const events = await run({ prompt });
      expect(service.prompt).toHaveBeenCalledExactlyOnceWith('w1:p1', recordedText);
      expect(events[0].message?.content).toContainEqual({
        type: 'tool_use',
        name: 'bash',
        input: { command: 'git status' },
      });
      expect(events.at(-1)?.subtype).toBe('success');
      expect(request).not.toHaveBeenCalledWith('agent.send_keys', expect.anything());
    }
  );

  it('does not accept a different reply merely because it contains this reply', async () => {
    const abortController = new AbortController();
    mocks.read.mockReturnValueOnce(snapshot([])).mockImplementation(() => {
      abortController.abort();
      return snapshot([
        { role: 'user', text: '**Feature ID:** task-a\n\nMy reply with unrelated instructions' },
        { role: 'assistant', text: 'Unrelated answer' },
      ]);
    });
    await expect(run({ abortController })).rejects.toThrow();
  });

  it('propagates assistant errors and interrupts this pane only', async () => {
    mocks.read.mockReturnValueOnce(snapshot([])).mockReturnValue(
      snapshot([
        { role: 'user', text: '**Feature ID:** task-a\n\nMy reply' },
        { role: 'assistant', text: '', isError: true, errorMessage: 'Upstream unavailable' },
      ])
    );
    await expect(run()).rejects.toThrow('Upstream unavailable');
    expect(request).toHaveBeenCalledWith('agent.send_keys', { target: 'w1:p1', keys: ['esc'] });
  });

  it('aborts an accepted Reply without closing unrelated panes', async () => {
    const abortController = new AbortController();
    mocks.read.mockReturnValue(snapshot([]));
    service.prompt.mockImplementation(async () => {
      abortController.abort();
      return agent;
    });
    await expect(run({ abortController })).rejects.toThrow();
    expect(request).toHaveBeenCalledWith('agent.send_keys', { target: 'w1:p1', keys: ['esc'] });
  });

  it('fails explicitly when herdr is unavailable', async () => {
    mocks.bootstrap.mockResolvedValue({
      available: false,
      piIntegrationReady: false,
      problems: ['No herdr'],
    });
    await expect(run()).rejects.toThrow('No herdr');
    expect(service.prompt).not.toHaveBeenCalled();
  });
});
