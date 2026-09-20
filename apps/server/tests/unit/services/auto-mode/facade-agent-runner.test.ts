import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies (hoisted)
vi.mock('../../../../src/services/agent-executor.js');
vi.mock('../../../../src/lib/settings-helpers.js');
vi.mock('../../../../src/providers/provider-factory.js');
vi.mock('../../../../src/lib/sdk-options.js');
vi.mock('@automaker/model-resolver', () => ({
  resolveModelString: vi.fn((model, fallback) => model || fallback),
  DEFAULT_MODELS: { claude: 'claude-3-5-sonnet' },
}));

import { AutoModeServiceFacade } from '../../../../src/services/auto-mode/facade.js';
import { AutoModeServiceCompat } from '../../../../src/services/auto-mode/compat.js';
import { AgentExecutor } from '../../../../src/services/agent-executor.js';
import * as settingsHelpers from '../../../../src/lib/settings-helpers.js';
import { ProviderFactory } from '../../../../src/providers/provider-factory.js';
import * as sdkOptions from '../../../../src/lib/sdk-options.js';
import { HerdrFeaturePiProvider } from '../../../../src/providers/herdr-feature-pi-provider.js';

describe('AutoModeServiceFacade Agent Runner', () => {
  let mockAgentExecutor: MockAgentExecutor;
  let mockSettingsService: MockSettingsService;
  let facade: AutoModeServiceFacade;

  // Type definitions for mocks
  interface MockAgentExecutor {
    execute: ReturnType<typeof vi.fn>;
  }
  interface MockSettingsService {
    getGlobalSettings: ReturnType<typeof vi.fn>;
    getCredentials: ReturnType<typeof vi.fn>;
    getProjectSettings: ReturnType<typeof vi.fn>;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up the mock for createAutoModeOptions
    // Note: Using 'as any' because Options type from SDK is complex and we only need
    // the specific fields that are verified in tests (maxTurns, allowedTools, etc.)
    vi.mocked(sdkOptions.createAutoModeOptions).mockReturnValue({
      maxTurns: 123,
      allowedTools: ['tool1'],
      systemPrompt: 'system-prompt',
    } as any);

    mockAgentExecutor = {
      execute: vi.fn().mockResolvedValue(undefined),
    };
    (AgentExecutor as any).mockImplementation(function (this: MockAgentExecutor) {
      return mockAgentExecutor;
    });

    mockSettingsService = {
      getGlobalSettings: vi.fn().mockResolvedValue({}),
      getCredentials: vi.fn().mockResolvedValue({}),
      getProjectSettings: vi.fn().mockResolvedValue({}),
    };

    // Helper to access the private createRunAgentFn via factory creation
    facade = AutoModeServiceFacade.create('/project', {
      events: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()) } as any,
      settingsService: mockSettingsService,
      sharedServices: {
        eventBus: { emitAutoModeEvent: vi.fn() } as any,
        worktreeResolver: { getCurrentBranch: vi.fn().mockResolvedValue('main') } as any,
        concurrencyManager: {
          isRunning: vi.fn().mockReturnValue(false),
          getRunningFeature: vi.fn().mockReturnValue(null),
        } as any,
      } as any,
    });
  });

  it('should resolve provider by providerId and pass to AgentExecutor', async () => {
    // 1. Setup mocks
    const mockProvider = { getName: () => 'mock-provider' };
    (ProviderFactory.getProviderForModel as any).mockReturnValue(mockProvider);

    const mockClaudeProvider = { id: 'zai-1', name: 'Zai' };
    const mockCredentials = { apiKey: 'test-key' };
    (settingsHelpers.resolveProviderContext as any).mockResolvedValue({
      provider: mockClaudeProvider,
      credentials: mockCredentials,
      resolvedModel: undefined,
    });

    const runAgentFn = (facade as any).executionService.runAgentFn;

    // 2. Execute
    await runAgentFn(
      '/workdir',
      'feature-1',
      'prompt',
      new AbortController(),
      '/project',
      [],
      'model-1',
      {
        providerId: 'zai-1',
      }
    );

    // 3. Verify
    expect(settingsHelpers.resolveProviderContext).toHaveBeenCalledWith(
      mockSettingsService,
      'model-1',
      'zai-1',
      '[AutoModeFacade]'
    );

    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeCompatibleProvider: mockClaudeProvider,
        credentials: mockCredentials,
        model: 'model-1', // Original model ID
      }),
      expect.any(Object)
    );
  });

  it('routes Pi feature execution and Reply through the task herdr provider', async () => {
    const backgroundProvider = { getName: () => 'pi', executeQuery: vi.fn() };
    vi.mocked(ProviderFactory.getProviderForModel).mockReturnValue(backgroundProvider as never);
    vi.mocked(settingsHelpers.resolveProviderContext).mockResolvedValue({
      provider: undefined,
      credentials: undefined,
      resolvedModel: undefined,
    } as never);
    const stateManager = (facade as any).featureStateManager;
    vi.spyOn(stateManager, 'loadFeature').mockResolvedValue({
      id: 'feature-1',
      title: 'Task one',
      providerSessionId: 'existing-session',
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t2',
    });
    const persist = vi.spyOn(stateManager, 'updateFeatureFields').mockResolvedValue(undefined);
    await (facade as any).executionService.runAgentFn(
      '/workdir',
      'feature-1',
      'reply',
      new AbortController(),
      '/project',
      [],
      'pi:litellm/worker',
      { sdkSessionId: 'existing-session' }
    );
    const supplied = mockAgentExecutor.execute.mock.calls[0][0];
    expect(supplied.provider).toBeInstanceOf(HerdrFeaturePiProvider);
    expect(supplied.sdkSessionId).toBe('existing-session');
    expect(backgroundProvider.executeQuery).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled(); // Placement is persisted when execution opens the pane.
  });

  it('should fallback to model-based lookup if providerId is not provided', async () => {
    const mockProvider = { getName: () => 'mock-provider' };
    (ProviderFactory.getProviderForModel as any).mockReturnValue(mockProvider);

    const mockClaudeProvider = { id: 'zai-model', name: 'Zai Model' };
    (settingsHelpers.resolveProviderContext as any).mockResolvedValue({
      provider: mockClaudeProvider,
      credentials: { apiKey: 'model-key' },
      resolvedModel: 'resolved-model-1',
    });

    const runAgentFn = (facade as any).executionService.runAgentFn;

    await runAgentFn(
      '/workdir',
      'feature-1',
      'prompt',
      new AbortController(),
      '/project',
      [],
      'model-1',
      {
        // no providerId
      }
    );

    expect(settingsHelpers.resolveProviderContext).toHaveBeenCalledWith(
      mockSettingsService,
      'model-1',
      undefined,
      '[AutoModeFacade]'
    );

    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeCompatibleProvider: mockClaudeProvider,
      }),
      expect.any(Object)
    );
  });

  it('should use resolvedModel from provider config for createAutoModeOptions if it maps to a Claude model', async () => {
    const mockProvider = { getName: () => 'mock-provider' };
    (ProviderFactory.getProviderForModel as any).mockReturnValue(mockProvider);

    const mockClaudeProvider = {
      id: 'zai-1',
      name: 'Zai',
      models: [{ id: 'custom-model-1', mapsToClaudeModel: 'claude-3-opus' }],
    };
    (settingsHelpers.resolveProviderContext as any).mockResolvedValue({
      provider: mockClaudeProvider,
      credentials: { apiKey: 'test-key' },
      resolvedModel: 'claude-3-5-opus',
    });

    const runAgentFn = (facade as any).executionService.runAgentFn;

    await runAgentFn(
      '/workdir',
      'feature-1',
      'prompt',
      new AbortController(),
      '/project',
      [],
      'custom-model-1',
      {
        providerId: 'zai-1',
      }
    );

    // Verify createAutoModeOptions was called with the mapped model
    expect(sdkOptions.createAutoModeOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-3-5-opus',
      })
    );

    // Verify AgentExecutor.execute still gets the original custom model ID
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'custom-model-1',
      }),
      expect.any(Object)
    );
  });

  it('passes the feature conversation sink from the facade options to ExecutionService', () => {
    const sink = {
      startFeatureConversation: vi.fn(),
      updateFeatureConversation: vi.fn(),
      finishFeatureConversation: vi.fn(),
    };

    const wiredFacade = AutoModeServiceFacade.create('/project', {
      events: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()) } as any,
      settingsService: mockSettingsService,
      featureConversations: sink as any,
      sharedServices: {
        eventBus: { emitAutoModeEvent: vi.fn() } as any,
        worktreeResolver: { getCurrentBranch: vi.fn().mockResolvedValue('main') } as any,
        concurrencyManager: {
          isRunning: vi.fn().mockReturnValue(false),
          getRunningFeature: vi.fn().mockReturnValue(null),
        } as any,
      } as any,
    });

    expect((wiredFacade as any).executionService.featureConversations).toBe(sink);
    // Facades created without a sink keep working (no mirroring)
    expect((facade as any).executionService.featureConversations).toBeUndefined();
  });

  it('forwards the feature conversation sink through AutoModeServiceCompat', () => {
    const sink = {
      startFeatureConversation: vi.fn(),
      updateFeatureConversation: vi.fn(),
      finishFeatureConversation: vi.fn(),
    };
    const compat = new AutoModeServiceCompat(
      { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()) } as any,
      mockSettingsService as any,
      {} as any,
      null,
      sink as any
    );

    const created = compat.createFacade('/project');

    expect((created as any).executionService.featureConversations).toBe(sink);
  });
});
