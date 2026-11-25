import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteOptions, Feature, ProviderMessage } from '@automaker/types';
import { HerdrFeaturePiProvider } from '../../../src/providers/herdr-feature-pi-provider.js';
import type { HerdrTaskService } from '../../../src/services/herdr-task-service.js';
import { DEFAULT_AUTO_MODE_FOLLOW_UP_PROMPT_TEMPLATE } from '@automaker/prompts';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  bootstrap: vi.fn(),
  refresh: vi.fn(),
  shuttingDown: false,
}));
vi.mock('../../../src/lib/shutdown-state.js', () => ({ isShuttingDown: () => mocks.shuttingDown }));
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
    mocks.shuttingDown = false;
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

  it('keeps Pi running at shutdown and reattaches to the saved turn after it completes offline', async () => {
    const saved = { ...feature, status: 'in_progress', executionRunId: 'run-1' };
    persist.mockImplementation(async (fields) => Object.assign(saved, structuredClone(fields)));
    const abortController = new AbortController();
    mocks.read.mockReturnValue(snapshot([]));
    service.prompt.mockImplementation(async () => {
      // The external process accepted the prompt and continues after API shutdown.
      mocks.shuttingDown = true;
      abortController.abort();
      return agent;
    });
    const provider = new HerdrFeaturePiProvider(
      { projectPath: '/project', feature: saved, persist },
      service as unknown as HerdrTaskService
    );
    await expect(async () => {
      for await (const _ of provider.executeQuery({ ...options, abortController })) {
        /* collect */
      }
    }).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(saved.herdrExecution).toMatchObject({
      paneId: 'w1:p1',
      executionRunId: 'run-1',
      startCursor: 0,
    });
    expect(
      persist.mock.invocationCallOrder.find(
        (_, index) => persist.mock.calls[index][0].herdrExecution
      )
    ).toBeLessThan(service.prompt.mock.invocationCallOrder[0]);

    mocks.shuttingDown = false;
    mocks.read.mockReturnValue(
      snapshot([
        { role: 'user', text: '**Feature ID:** task-a\n\nMy reply' },
        { role: 'assistant', text: 'Completed while API was offline' },
      ])
    );
    const reconnected = new HerdrFeaturePiProvider(
      { projectPath: '/project', feature: saved, persist, reattach: true },
      service as unknown as HerdrTaskService
    );
    const events = [];
    for await (const event of reconnected.executeQuery({ ...options, prompt: 'Do not send this' }))
      events.push(event);
    expect(service.prompt).toHaveBeenCalledTimes(1);
    expect(service.restoreConversation).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.subtype).toBe('success');
    expect(JSON.stringify(events)).toContain('Completed while API was offline');
    expect(request).not.toHaveBeenCalled();
  });

  const savedTurn = (): Feature => ({
    ...feature,
    herdrExecution: {
      paneId: 'w1:p1',
      workspaceId: 'w1',
      tabId: 'w1:t1',
      workDir: '/project/wt',
      sessionFile: '/pi/session-a.jsonl',
      sessionId: 'session-a',
      startCursor: 0,
      prompt: '**Feature ID:** task-a\n\nMy reply',
      startedAt: new Date().toISOString(),
      status: 'in_progress',
    },
  });
  it('reattaches to a busy Pi without resubmission and preserves explicit Stop', async () => {
    getAgent.mockResolvedValue({ ...agent, agent_status: 'working' });
    const abortController = new AbortController();
    mocks.read.mockReturnValueOnce(snapshot([])).mockImplementation(() => {
      abortController.abort();
      return snapshot([{ role: 'user', text: '**Feature ID:** task-a\n\nMy reply' }]);
    });
    const provider = new HerdrFeaturePiProvider(
      { projectPath: '/project', feature: savedTurn(), persist, reattach: true },
      service as unknown as HerdrTaskService
    );
    await expect(async () => {
      for await (const _ of provider.executeQuery({ ...options, abortController })) {
        /* collect */
      }
    }).rejects.toThrow();
    expect(service.prompt).not.toHaveBeenCalled();
    expect(service.restoreConversation).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith('agent.send_keys', {
      target: 'w1:p1',
      keys: ['esc'],
    });
    expect(persist).toHaveBeenCalledWith({ herdrExecution: undefined });
  });

  it('does not recreate a lost pane or interrupt another session during recovery', async () => {
    getAgent.mockResolvedValue({ ...agent, agent_session: { value: '/pi/other.jsonl' } });
    const provider = new HerdrFeaturePiProvider(
      { projectPath: '/project', feature: savedTurn(), persist, reattach: true },
      service as unknown as HerdrTaskService
    );
    await expect(async () => {
      for await (const _ of provider.executeQuery(options)) {
        /* collect */
      }
    }).rejects.toThrow('changed sessions');
    expect(service.prompt).not.toHaveBeenCalled();
    expect(service.restoreConversation).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps an uncertain submission for inspection without submitting it again', async () => {
    vi.useFakeTimers();
    try {
      mocks.read.mockReturnValue(snapshot([]));
      const provider = new HerdrFeaturePiProvider(
        { projectPath: '/project', feature: savedTurn(), persist, reattach: true },
        service as unknown as HerdrTaskService
      );
      const outcome = (async () => {
        for await (const _ of provider.executeQuery(options)) {
          /* collect */
        }
      })();
      const assertion = expect(outcome).rejects.toThrow('Reply was not recorded');
      await vi.advanceTimersByTimeAsync(31_000);
      await assertion;
      expect(service.prompt).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalledWith({ herdrExecution: undefined });
    } finally {
      vi.useRealTimers();
    }
  });
});
