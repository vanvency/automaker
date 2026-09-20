import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiProvider } from '../../../src/providers/pi-provider.js';
import type { ProviderMessage } from '@automaker/types';

const refreshPiLitellmProvider = vi.fn().mockResolvedValue({
  configPath: '/tmp/pi-models.json',
  modelIds: ['worker', 'deepseek-flash', 'kimi-k3'],
  updated: true,
});

const resolveLitellmApiKey = vi.fn().mockReturnValue('test-master-key');

vi.mock('../../../src/providers/pi-litellm.js', () => ({
  getPiModelsConfigPath: () => '/tmp/pi-models.json',
  refreshPiLitellmProvider: (...args: unknown[]) => refreshPiLitellmProvider(...args),
  resolveLitellmApiKey: () => resolveLitellmApiKey(),
  toPiModelId: (modelId: string) => `pi:litellm/${modelId}`,
}));

describe('pi-provider.ts', () => {
  let provider: PiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    refreshPiLitellmProvider.mockResolvedValue({
      configPath: '/tmp/pi-models.json',
      modelIds: ['worker', 'deepseek-flash', 'kimi-k3'],
      updated: true,
    });
    resolveLitellmApiKey.mockReturnValue('test-master-key');
    provider = new PiProvider();
    // The model list is cached process-wide (ProviderFactory builds a new
    // instance per call), so each test starts from a cold cache.
    provider.clearModelCache();
    delete process.env.AUTOMAKER_PI_NO_PROJECT_TRUST;
  });

  // ==========================================================================
  // Basics
  // ==========================================================================

  it('reports pi as provider and CLI name', () => {
    expect(provider.getName()).toBe('pi');
    expect(provider.getCliName()).toBe('pi');
  });

  it('supports tools and text, but not vision', () => {
    expect(provider.supportsFeature('tools')).toBe(true);
    expect(provider.supportsFeature('text')).toBe(true);
    expect(provider.supportsFeature('vision')).toBe(false);
  });

  // ==========================================================================
  // CLI args
  // ==========================================================================

  describe('buildCliArgs', () => {
    const baseOptions = {
      prompt: 'do the thing',
      model: 'pi:litellm/auto',
      cwd: '/tmp/project',
    };

    it('runs pi non-interactively in JSON mode with the LiteLLM provider', () => {
      const args = provider.buildCliArgs(baseOptions);

      expect(args).toContain('--print');
      expect(args).toContain('--mode');
      expect(args[args.indexOf('--mode') + 1]).toBe('json');
      expect(args[args.indexOf('--provider') + 1]).toBe('litellm');
      expect(args[args.indexOf('--model') + 1]).toBe('auto');
    });

    it('falls back to the LiteLLM provider for bare model ids', () => {
      const args = provider.buildCliArgs({ ...baseOptions, model: 'deepseek-flash' });

      expect(args[args.indexOf('--provider') + 1]).toBe('litellm');
      expect(args[args.indexOf('--model') + 1]).toBe('deepseek-flash');
    });

    it('accepts the stripped provider/model form used by the executor', () => {
      const args = provider.buildCliArgs({ ...baseOptions, model: 'litellm/deepseek-flash' });

      expect(args[args.indexOf('--provider') + 1]).toBe('litellm');
      expect(args[args.indexOf('--model') + 1]).toBe('deepseek-flash');
    });

    it('keeps slash-containing LiteLLM model groups intact', () => {
      const args = provider.buildCliArgs({ ...baseOptions, model: 'litellm/ark/kimi-k3' });

      expect(args[args.indexOf('--model') + 1]).toBe('ark/kimi-k3');
    });

    it('maps reasoning effort onto pi thinking levels', () => {
      const args = provider.buildCliArgs({ ...baseOptions, reasoningEffort: 'xhigh' });
      expect(args[args.indexOf('--thinking') + 1]).toBe('xhigh');

      const offArgs = provider.buildCliArgs({ ...baseOptions, reasoningEffort: 'none' });
      expect(offArgs[offArgs.indexOf('--thinking') + 1]).toBe('off');
    });

    it('maps ultrathink onto the max thinking level', () => {
      const args = provider.buildCliArgs({ ...baseOptions, thinkingLevel: 'ultrathink' });
      expect(args[args.indexOf('--thinking') + 1]).toBe('max');
    });

    it('resumes Pi sessions with --session-id', () => {
      const args = provider.buildCliArgs({ ...baseOptions, sdkSessionId: 'session-123' });
      expect(args[args.indexOf('--session-id') + 1]).toBe('session-123');
    });

    it('maps automaker tool names and disables built-ins for empty tool lists', () => {
      const args = provider.buildCliArgs({
        ...baseOptions,
        tools: ['Read', 'Bash', 'WebSearch'],
      });
      expect(args[args.indexOf('--tools') + 1]).toBe('read,bash');

      const noTools = provider.buildCliArgs({ ...baseOptions, tools: [] });
      expect(noTools).toContain('--no-tools');
    });

    it('honors caller allowlists including empty and unsupported-only lists', () => {
      expect(provider.buildCliArgs({ ...baseOptions, allowedTools: [] })).toContain('--no-tools');
      expect(provider.buildCliArgs({ ...baseOptions, allowedTools: ['UnknownTool'] })).toContain(
        '--no-tools'
      );
      const args = provider.buildCliArgs({
        ...baseOptions,
        allowedTools: ['Read'],
        tools: ['Bash'],
      });
      expect(args[args.indexOf('--tools') + 1]).toBe('read');
    });

    it('excludes mutating tools in read-only mode', () => {
      const args = provider.buildCliArgs({ ...baseOptions, readOnly: true });
      expect(args[args.indexOf('--tools') + 1]).toBe('read,grep,find,ls');
      expect(args[args.indexOf('--exclude-tools') + 1]).toBe('edit,write,bash');
    });

    it('trusts project resources unless disabled by env', () => {
      expect(provider.buildCliArgs(baseOptions)).toContain('--approve');

      process.env.AUTOMAKER_PI_NO_PROJECT_TRUST = 'true';
      expect(provider.buildCliArgs(baseOptions)).not.toContain('--approve');
    });
  });

  // ==========================================================================
  // Model discovery
  // ==========================================================================

  describe('models', () => {
    it('exposes the static LiteLLM fallback list', () => {
      const models = provider.getFallbackModels();

      expect(models.map((model) => model.id)).toEqual(
        expect.arrayContaining([
          'pi:litellm/auto',
          'pi:litellm/worker',
          'pi:litellm/deepseek-flash',
        ])
      );
      expect(models.find((model) => model.id === 'pi:litellm/worker')?.default).toBe(true);
      expect(models.every((model) => model.provider === 'pi')).toBe(true);
      // Pi's own default is 128k; every LiteLLM-backed model is 1M.
      expect(models.every((model) => model.contextWindow === 1_000_000)).toBe(true);
      // ...and 16k output by default, which is raised to 64k.
      expect(models.every((model) => model.maxOutputTokens === 64_000)).toBe(true);
    });

    it('initializes models from the LiteLLM gateway', async () => {
      const models = await provider.refreshModels();

      expect(refreshPiLitellmProvider).toHaveBeenCalled();
      expect(models.map((model) => model.id)).toEqual([
        'pi:litellm/worker',
        'pi:litellm/deepseek-flash',
        'pi:litellm/kimi-k3',
      ]);
      expect(provider.hasCachedModels()).toBe(true);
      expect(models[0].modelString).toBe('litellm/worker');
      expect(models.every((model) => model.contextWindow === 1_000_000)).toBe(true);
      expect(models.every((model) => model.maxOutputTokens === 64_000)).toBe(true);
    });

    it('falls back to the static list when the gateway is unreachable', async () => {
      refreshPiLitellmProvider.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const models = await provider.refreshModels();
      expect(models.map((model) => model.id)).toContain('pi:litellm/worker');
    });

    it('shares the discovered list with other provider instances', async () => {
      await provider.refreshModels();
      refreshPiLitellmProvider.mockClear();

      // ProviderFactory builds a new instance per call, so the cache has to be
      // process-wide or every request re-fetches the gateway.
      const second = new PiProvider();
      expect(second.hasCachedModels()).toBe(true);
      expect(second.getAvailableModels().map((model) => model.id)).toContain('pi:litellm/worker');
      expect(refreshPiLitellmProvider).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event normalization
  // ==========================================================================

  describe('normalizeEvent', () => {
    const sessionHeader = { type: 'session', id: 'session-abc' };

    it('ignores lifecycle noise', () => {
      expect(provider.normalizeEvent(sessionHeader)).toBeNull();
      expect(provider.normalizeEvent({ type: 'agent_start' })).toBeNull();
      expect(provider.normalizeEvent({ type: 'turn_start' })).toBeNull();
      expect(provider.normalizeEvent({ type: 'compaction_end' })).toBeNull();
      expect(provider.normalizeEvent({ type: 'tool_execution_update' })).toBeNull();
    });

    it('streams text deltas with the session id', () => {
      provider.normalizeEvent(sessionHeader);

      const message = provider.normalizeEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
      });

      expect(message?.type).toBe('assistant');
      expect(message?.session_id).toBe('session-abc');
      expect(message?.message?.content[0]).toEqual({ type: 'text', text: 'Hello' });
    });

    it('streams thinking deltas', () => {
      const message = provider.normalizeEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
      });

      expect(message?.message?.content[0]).toEqual({ type: 'thinking', thinking: 'hmm' });
    });

    it('emits tool calls once and pairs them with results', () => {
      const toolCallMessage = provider.normalizeEvent({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          toolCall: { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
        },
      });

      expect(toolCallMessage?.message?.content[0]).toEqual({
        type: 'tool_use',
        name: 'read',
        tool_use_id: 'call-1',
        input: { path: 'a.ts' },
      });

      // The same call reported again at execution time must not duplicate.
      expect(
        provider.normalizeEvent({
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'read',
          args: { path: 'a.ts' },
        })
      ).toBeNull();

      const resultMessage = provider.normalizeEvent({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        result: { content: [{ type: 'text', text: 'file contents' }] },
      });

      expect(resultMessage?.message?.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'file contents',
      });
    });

    it('reports errors from message_end and ends the run as failed', () => {
      const errorMessage = provider.normalizeEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'quota exceeded',
        },
      });

      expect(errorMessage?.type).toBe('error');
      expect(errorMessage?.error).toBe('quota exceeded');

      const result = provider.normalizeEvent({ type: 'agent_end', messages: [] });
      expect(result?.type).toBe('result');
      expect(result?.subtype).toBe('error');
    });

    it('falls back to the authoritative message text when no deltas stream', () => {
      const message = provider.normalizeEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'PONG' }],
          stopReason: 'stop',
        },
      });

      expect(message?.message?.content[0]).toEqual({ type: 'text', text: 'PONG' });
    });

    it('does not repeat text that was already streamed', () => {
      provider.normalizeEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'PONG' },
      });

      expect(
        provider.normalizeEvent({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] },
        })
      ).toBeNull();
    });

    it('emits a successful result with the accumulated text', () => {
      provider.normalizeEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
      });
      provider.normalizeEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'world' },
      });

      const result: ProviderMessage | null = provider.normalizeEvent({
        type: 'agent_end',
        messages: [],
      });

      expect(result?.type).toBe('result');
      expect(result?.subtype).toBe('success');
      expect(result?.result).toBe('Hello world');
    });

    it('surfaces explicit error events', () => {
      const message = provider.normalizeEvent({
        type: 'error',
        error: { message: 'gateway down' },
      });

      expect(message?.type).toBe('error');
      expect(message?.error).toBe('gateway down');
    });

    it('ignores non-object events', () => {
      expect(provider.normalizeEvent(null)).toBeNull();
      expect(provider.normalizeEvent('not-an-event')).toBeNull();
      expect(provider.normalizeEvent(42)).toBeNull();
    });
  });
});
