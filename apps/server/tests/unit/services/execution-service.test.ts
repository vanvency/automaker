import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import type { Feature } from '@automaker/types';

/**
 * Helper to normalize paths for cross-platform test compatibility.
 */
const normalizePath = (p: string): string => path.resolve(p);
import {
  ExecutionService,
  type RunAgentFn,
  type ExecutePipelineFn,
  type UpdateFeatureStatusFn,
  type LoadFeatureFn,
  type GetPlanningPromptPrefixFn,
  type SaveFeatureSummaryFn,
  type RecordLearningsFn,
  type ContextExistsFn,
  type ResumeFeatureFn,
  type TrackFailureFn,
  type SignalPauseFn,
  type RecordSuccessFn,
} from '../../../src/services/execution-service.js';
import type { TypedEventBus } from '../../../src/services/typed-event-bus.js';
import type {
  ConcurrencyManager,
  RunningFeature,
} from '../../../src/services/concurrency-manager.js';
import type { WorktreeResolver } from '../../../src/services/worktree-resolver.js';
import type { SettingsService } from '../../../src/services/settings-service.js';
import { pipelineService } from '../../../src/services/pipeline-service.js';
import { ProviderFactory } from '../../../src/providers/provider-factory.js';
import * as secureFs from '../../../src/lib/secure-fs.js';
import { getFeatureDir } from '@automaker/platform';
import {
  getPromptCustomization,
  getAutoLoadClaudeMdSetting,
  getUseClaudeCodeSystemPromptSetting,
  filterClaudeMdFromContext,
} from '../../../src/lib/settings-helpers.js';
import { extractSummary } from '../../../src/services/spec-parser.js';
import { resolveModelString } from '@automaker/model-resolver';
import { collectAcceptanceEvidence } from '../../../src/services/acceptance-evidence-service.js';

vi.mock('../../../src/services/acceptance-evidence-service.js', () => ({
  collectAcceptanceEvidence: vi.fn().mockResolvedValue(null),
}));

// Mock pipelineService
vi.mock('../../../src/services/pipeline-service.js', () => ({
  pipelineService: {
    getPipelineConfig: vi.fn(),
    isPipelineStatus: vi.fn(),
    getStepIdFromStatus: vi.fn(),
  },
}));

// Mock secureFs
vi.mock('../../../src/lib/secure-fs.js', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
}));

// Mock settings helpers
vi.mock('../../../src/lib/settings-helpers.js', () => ({
  getPromptCustomization: vi.fn().mockResolvedValue({
    taskExecution: {
      implementationInstructions: 'test instructions',
      playwrightVerificationInstructions: 'test playwright',
      continuationAfterApprovalTemplate:
        '{{userFeedback}}\n\nApproved plan:\n{{approvedPlan}}\n\nProceed.',
    },
  }),
  getAutoLoadClaudeMdSetting: vi.fn().mockResolvedValue(true),
  getUseClaudeCodeSystemPromptSetting: vi.fn().mockResolvedValue(true),
  filterClaudeMdFromContext: vi.fn().mockReturnValue('context prompt'),
}));

// Mock sdk-options
vi.mock('../../../src/lib/sdk-options.js', () => ({
  validateWorkingDirectory: vi.fn(),
}));

// Mock platform
vi.mock('@automaker/platform', () => ({
  getFeatureDir: vi
    .fn()
    .mockImplementation(
      (projectPath: string, featureId: string) => `${projectPath}/.automaker/features/${featureId}`
    ),
}));

// Mock model-resolver
vi.mock('@automaker/model-resolver', () => ({
  resolveModelString: vi.fn().mockReturnValue('claude-sonnet-4'),
  DEFAULT_MODELS: { claude: 'claude-sonnet-4' },
}));

// Mock provider-factory
vi.mock('../../../src/providers/provider-factory.js', () => ({
  ProviderFactory: {
    getProviderNameForModel: vi.fn().mockReturnValue('anthropic'),
  },
}));

// Mock spec-parser
vi.mock('../../../src/services/spec-parser.js', () => ({
  extractSummary: vi.fn().mockReturnValue('Test summary'),
}));

// Mock @automaker/utils
vi.mock('@automaker/utils', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  classifyError: vi.fn((error: unknown) => {
    const err = error as Error | null;
    if (err?.name === 'AbortError' || err?.message?.includes('abort')) {
      return { isAbort: true, type: 'abort', message: 'Aborted' };
    }
    return { isAbort: false, type: 'unknown', message: err?.message || 'Unknown error' };
  }),
  loadContextFiles: vi.fn(),
  recordMemoryUsage: vi.fn().mockResolvedValue(undefined),
}));

describe('execution-service.ts', () => {
  // Mock dependencies
  let mockEventBus: TypedEventBus;
  let mockConcurrencyManager: ConcurrencyManager;
  let mockWorktreeResolver: WorktreeResolver;
  let mockSettingsService: SettingsService | null;

  // Callback mocks
  let mockRunAgentFn: RunAgentFn;
  let mockExecutePipelineFn: ExecutePipelineFn;
  let mockUpdateFeatureStatusFn: UpdateFeatureStatusFn;
  let mockLoadFeatureFn: LoadFeatureFn;
  let mockGetPlanningPromptPrefixFn: GetPlanningPromptPrefixFn;
  let mockSaveFeatureSummaryFn: SaveFeatureSummaryFn;
  let mockRecordLearningsFn: RecordLearningsFn;
  let mockContextExistsFn: ContextExistsFn;
  let mockResumeFeatureFn: ResumeFeatureFn;
  let mockTrackFailureFn: TrackFailureFn;
  let mockSignalPauseFn: SignalPauseFn;
  let mockRecordSuccessFn: RecordSuccessFn;
  let mockSaveExecutionStateFn: vi.Mock;
  let mockLoadContextFilesFn: vi.Mock;

  let service: ExecutionService;

  // Test data
  const testFeature: Feature = {
    id: 'feature-1',
    title: 'Test Feature',
    category: 'test',
    description: 'Test description',
    status: 'backlog',
    branchName: 'feature/test-1',
  };

  const createRunningFeature = (featureId: string): RunningFeature => ({
    featureId,
    projectPath: '/test/project',
    worktreePath: null,
    branchName: null,
    abortController: new AbortController(),
    isAutoMode: false,
    startTime: Date.now(),
    leaseCount: 1,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockEventBus = {
      emitAutoModeEvent: vi.fn(),
    } as unknown as TypedEventBus;

    mockConcurrencyManager = {
      acquire: vi.fn().mockImplementation(({ featureId, isAutoMode }) => ({
        ...createRunningFeature(featureId),
        isAutoMode: isAutoMode ?? false,
      })),
      release: vi.fn(),
      getRunningFeature: vi.fn(),
      isRunning: vi.fn(),
    } as unknown as ConcurrencyManager;

    mockWorktreeResolver = {
      findWorktreeForBranch: vi.fn().mockResolvedValue('/test/worktree'),
    } as unknown as WorktreeResolver;

    mockSettingsService = null;

    mockRunAgentFn = vi.fn().mockResolvedValue(undefined);
    mockExecutePipelineFn = vi.fn().mockResolvedValue(undefined);
    mockUpdateFeatureStatusFn = vi.fn().mockResolvedValue(undefined);
    mockLoadFeatureFn = vi.fn().mockResolvedValue(testFeature);
    mockGetPlanningPromptPrefixFn = vi.fn().mockResolvedValue('');
    mockSaveFeatureSummaryFn = vi.fn().mockResolvedValue(undefined);
    mockRecordLearningsFn = vi.fn().mockResolvedValue(undefined);
    mockContextExistsFn = vi.fn().mockResolvedValue(false);
    mockResumeFeatureFn = vi.fn().mockResolvedValue(undefined);
    mockTrackFailureFn = vi.fn().mockReturnValue(false);
    mockSignalPauseFn = vi.fn();
    mockRecordSuccessFn = vi.fn();
    mockSaveExecutionStateFn = vi.fn().mockResolvedValue(undefined);
    mockLoadContextFilesFn = vi.fn().mockResolvedValue({
      formattedPrompt: 'test context',
      memoryFiles: [],
    });

    // Default mocks for secureFs
    // Include tool usage markers to simulate meaningful agent output.
    // The execution service checks for '🔧 Tool:' markers and minimum
    // output length to determine if the agent did real work.
    vi.mocked(secureFs.readFile).mockResolvedValue(
      'Starting implementation...\n\n🔧 Tool: Read\nInput: {"file_path": "/src/index.ts"}\n\n' +
        '🔧 Tool: Edit\nInput: {"file_path": "/src/index.ts", "old_string": "foo", "new_string": "bar"}\n\n' +
        'Implementation complete. Updated the code as requested.'
    );
    vi.mocked(secureFs.access).mockResolvedValue(undefined);

    // Re-setup platform mocks
    vi.mocked(getFeatureDir).mockImplementation(
      (projectPath: string, featureId: string) => `${projectPath}/.automaker/features/${featureId}`
    );

    // Default pipeline config (no steps)
    vi.mocked(pipelineService.getPipelineConfig).mockResolvedValue({ version: 1, steps: [] });

    // Re-setup settings helpers mocks (vi.clearAllMocks clears implementations)
    vi.mocked(getPromptCustomization).mockResolvedValue({
      taskExecution: {
        implementationInstructions: 'test instructions',
        playwrightVerificationInstructions: 'test playwright',
        continuationAfterApprovalTemplate:
          '{{userFeedback}}\n\nApproved plan:\n{{approvedPlan}}\n\nProceed.',
      },
    } as Awaited<ReturnType<typeof getPromptCustomization>>);
    vi.mocked(getAutoLoadClaudeMdSetting).mockResolvedValue(true);
    vi.mocked(getUseClaudeCodeSystemPromptSetting).mockResolvedValue(true);
    vi.mocked(filterClaudeMdFromContext).mockReturnValue('context prompt');

    // Re-setup spec-parser mock
    vi.mocked(extractSummary).mockReturnValue('Test summary');

    // Re-setup model-resolver mock
    vi.mocked(resolveModelString).mockReturnValue('claude-sonnet-4');

    service = new ExecutionService(
      mockEventBus,
      mockConcurrencyManager,
      mockWorktreeResolver,
      mockSettingsService,
      mockRunAgentFn,
      mockExecutePipelineFn,
      mockUpdateFeatureStatusFn,
      mockLoadFeatureFn,
      mockGetPlanningPromptPrefixFn,
      mockSaveFeatureSummaryFn,
      mockRecordLearningsFn,
      mockContextExistsFn,
      mockResumeFeatureFn,
      mockTrackFailureFn,
      mockSignalPauseFn,
      mockRecordSuccessFn,
      mockSaveExecutionStateFn,
      mockLoadContextFilesFn,
      undefined as never
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates service with all dependencies', () => {
      expect(service).toBeInstanceOf(ExecutionService);
    });

    it('accepts null settingsService', () => {
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        null,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );
      expect(svc).toBeInstanceOf(ExecutionService);
    });
  });

  describe('AgentSession mirroring', () => {
    const createSink = () => ({
      startFeatureConversation: vi.fn().mockResolvedValue({ sessionId: 'feature-feature-1' }),
      updateFeatureConversation: vi.fn().mockResolvedValue(undefined),
      finishFeatureConversation: vi.fn().mockResolvedValue(undefined),
    });

    const serviceWithSink = (sink: ReturnType<typeof createSink>) =>
      new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never,
        sink
      );

    it('publishes a running feature as an AgentSession and syncs the transcript', async () => {
      const sink = createSink();
      const svc = serviceWithSink(sink);
      vi.mocked(ProviderFactory.getProviderNameForModel).mockReturnValue('anthropic');

      await svc.executeFeature('/test/project', 'feature-1');

      expect(sink.startFeatureConversation).toHaveBeenCalledTimes(1);
      expect(sink.startFeatureConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          featureId: 'feature-1',
          name: 'Test Feature',
          projectPath: '/test/project',
          workingDirectory: path.resolve('/test/project'),
          model: 'claude-sonnet-4',
          provider: 'anthropic',
        })
      );
      // The transcript is flushed when the run ends
      expect(sink.updateFeatureConversation).toHaveBeenCalledWith(
        'feature-1',
        expect.stringContaining('🔧 Tool: Edit')
      );
      expect(sink.finishFeatureConversation).toHaveBeenCalledWith('feature-1', undefined);
    });

    it('passes the run abort controller so the session can stop the feature', async () => {
      const sink = createSink();
      const svc = serviceWithSink(sink);
      const abortController = new AbortController();
      vi.mocked(mockConcurrencyManager.acquire).mockImplementation(({ featureId }) => ({
        ...createRunningFeature(featureId),
        abortController,
      }));

      await svc.executeFeature('/test/project', 'feature-1');

      expect(sink.startFeatureConversation).toHaveBeenCalledWith(
        expect.objectContaining({ abortController })
      );
    });

    it('reports a failed run on the mirrored conversation', async () => {
      const sink = createSink();
      mockRunAgentFn = vi.fn().mockRejectedValue(new Error('provider exploded'));
      const failingSvc = serviceWithSink(sink);

      await failingSvc.executeFeature('/test/project', 'feature-1');

      expect(sink.finishFeatureConversation).toHaveBeenCalledWith('feature-1', {
        error: 'provider exploded',
      });
    });

    it('does nothing when no conversation sink is configured', async () => {
      await expect(service.executeFeature('/test/project', 'feature-1')).resolves.toBeUndefined();
    });
  });

  describe('buildFeaturePrompt', () => {
    const taskPrompts = {
      implementationInstructions: 'impl instructions',
      playwrightVerificationInstructions: 'playwright instructions',
    };

    it('includes feature title and description', () => {
      const prompt = service.buildFeaturePrompt(testFeature, taskPrompts);
      expect(prompt).toContain('**Feature ID:** feature-1');
      expect(prompt).toContain('Test description');
    });

    it('includes specification when present', () => {
      const featureWithSpec: Feature = {
        ...testFeature,
        spec: 'Detailed specification here',
      };
      const prompt = service.buildFeaturePrompt(featureWithSpec, taskPrompts);
      expect(prompt).toContain('**Specification:**');
      expect(prompt).toContain('Detailed specification here');
    });

    it('includes acceptance criteria from task prompts', () => {
      const prompt = service.buildFeaturePrompt(testFeature, taskPrompts);
      expect(prompt).toContain('impl instructions');
    });

    it('adds playwright instructions when skipTests is false', () => {
      const featureWithTests: Feature = { ...testFeature, skipTests: false };
      const prompt = service.buildFeaturePrompt(featureWithTests, taskPrompts);
      expect(prompt).toContain('playwright instructions');
    });

    it('omits playwright instructions when skipTests is true', () => {
      const featureWithoutTests: Feature = { ...testFeature, skipTests: true };
      const prompt = service.buildFeaturePrompt(featureWithoutTests, taskPrompts);
      expect(prompt).not.toContain('playwright instructions');
    });

    it('includes images note when imagePaths present', () => {
      const featureWithImages: Feature = {
        ...testFeature,
        imagePaths: ['/path/to/image.png', { path: '/path/to/image2.jpg', mimeType: 'image/jpeg' }],
      };
      const prompt = service.buildFeaturePrompt(featureWithImages, taskPrompts);
      expect(prompt).toContain('Context Images Attached:');
      expect(prompt).toContain('2 image(s)');
    });

    it('extracts title from first line of description', () => {
      const featureWithLongDesc: Feature = {
        ...testFeature,
        description: 'First line title\nRest of description',
      };
      const prompt = service.buildFeaturePrompt(featureWithLongDesc, taskPrompts);
      expect(prompt).toContain('**Title:** First line title');
    });

    it('truncates long titles to 60 characters', () => {
      const longDescription = 'A'.repeat(100);
      const featureWithLongTitle: Feature = {
        ...testFeature,
        description: longDescription,
      };
      const prompt = service.buildFeaturePrompt(featureWithLongTitle, taskPrompts);
      expect(prompt).toContain('**Title:** ' + 'A'.repeat(57) + '...');
    });
  });

  describe('executeFeature', () => {
    it('throws if feature not found', async () => {
      mockLoadFeatureFn = vi.fn().mockResolvedValue(null);
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'nonexistent');

      // Error event should be emitted
      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_error',
        expect.objectContaining({ featureId: 'nonexistent' })
      );
    });

    it('acquires running feature slot', async () => {
      await service.executeFeature('/test/project', 'feature-1');

      expect(mockConcurrencyManager.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          featureId: 'feature-1',
          projectPath: '/test/project',
        })
      );
    });

    it('updates status to in_progress before starting', async () => {
      await service.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'in_progress'
      );
    });

    it('emits feature_start event after status update', async () => {
      await service.executeFeature('/test/project', 'feature-1');

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_feature_start',
        expect.objectContaining({
          featureId: 'feature-1',
          projectPath: '/test/project',
        })
      );

      // Verify order: status update happens before event
      const statusCallIndex = mockUpdateFeatureStatusFn.mock.invocationCallOrder[0];
      const eventCallIndex = mockEventBus.emitAutoModeEvent.mock.invocationCallOrder[0];
      expect(statusCallIndex).toBeLessThan(eventCallIndex);
    });

    it('runs agent with correct prompt', async () => {
      await service.executeFeature('/test/project', 'feature-1');

      expect(mockRunAgentFn).toHaveBeenCalled();
      const callArgs = mockRunAgentFn.mock.calls[0];
      expect(callArgs[0]).toMatch(/test.*project/); // workDir contains project
      expect(callArgs[1]).toBe('feature-1');
      expect(callArgs[2]).toContain('Feature Task');
      expect(callArgs[3]).toBeInstanceOf(AbortController);
      expect(callArgs[4]).toBe('/test/project');
      // Model (index 6) should be resolved
      expect(callArgs[6]).toBe('claude-sonnet-4');
    });

    it('passes providerId to runAgentFn when present on feature', async () => {
      const featureWithProvider: Feature = {
        ...testFeature,
        providerId: 'zai-provider-1',
      };
      vi.mocked(mockLoadFeatureFn).mockResolvedValue(featureWithProvider);

      await service.executeFeature('/test/project', 'feature-1');

      expect(mockRunAgentFn).toHaveBeenCalled();
      const callArgs = mockRunAgentFn.mock.calls[0];
      const options = callArgs[7];
      expect(options.providerId).toBe('zai-provider-1');
    });

    it('executes pipeline after agent completes', async () => {
      const pipelineSteps = [{ id: 'step-1', name: 'Step 1', order: 1, instructions: 'Do step 1' }];
      vi.mocked(pipelineService.getPipelineConfig).mockResolvedValue({
        version: 1,
        steps: pipelineSteps as any,
      });

      await service.executeFeature('/test/project', 'feature-1');

      // Agent runs first
      expect(mockRunAgentFn).toHaveBeenCalled();
      // Then pipeline executes
      expect(mockExecutePipelineFn).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: '/test/project',
          featureId: 'feature-1',
          steps: pipelineSteps,
        })
      );
    });

    it('updates status to verified on completion', async () => {
      await service.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
    });

    it('updates status to waiting_approval when skipTests is true', async () => {
      mockLoadFeatureFn = vi.fn().mockResolvedValue({ ...testFeature, skipTests: true });
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
    });

    it('records success on completion', async () => {
      await service.executeFeature('/test/project', 'feature-1');

      expect(mockRecordSuccessFn).toHaveBeenCalled();
    });

    it('releases running feature in finally block', async () => {
      await service.executeFeature('/test/project', 'feature-1');

      expect(mockConcurrencyManager.release).toHaveBeenCalledWith('feature-1', undefined);
    });

    it('redirects to resumeFeature when context exists', async () => {
      mockContextExistsFn = vi.fn().mockResolvedValue(true);
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1', true);

      expect(mockResumeFeatureFn).toHaveBeenCalledWith('/test/project', 'feature-1', true, true);
      // Should not run agent
      expect(mockRunAgentFn).not.toHaveBeenCalled();
    });

    it('emits feature_complete event on success when isAutoMode is true', async () => {
      await service.executeFeature('/test/project', 'feature-1', false, true);

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_feature_complete',
        expect.objectContaining({
          featureId: 'feature-1',
          passes: true,
        })
      );
    });

    it('does not emit feature_complete event on success when isAutoMode is false', async () => {
      await service.executeFeature('/test/project', 'feature-1', false, false);

      const completeCalls = vi
        .mocked(mockEventBus.emitAutoModeEvent)
        .mock.calls.filter((call) => call[0] === 'auto_mode_feature_complete');
      expect(completeCalls.length).toBe(0);
    });
  });

  describe('executeFeature - approved plan handling', () => {
    it('builds continuation prompt for approved plan', async () => {
      const featureWithApprovedPlan: Feature = {
        ...testFeature,
        planSpec: { status: 'approved', content: 'The approved plan content' },
      };
      mockLoadFeatureFn = vi.fn().mockResolvedValue(featureWithApprovedPlan);

      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      // Agent should be called with continuation prompt
      expect(mockRunAgentFn).toHaveBeenCalled();
      const callArgs = mockRunAgentFn.mock.calls[0];
      expect(callArgs[1]).toBe('feature-1');
      expect(callArgs[2]).toContain('The approved plan content');
    });

    it('recursively calls executeFeature with continuation', async () => {
      const featureWithApprovedPlan: Feature = {
        ...testFeature,
        planSpec: { status: 'approved', content: 'Plan' },
      };
      mockLoadFeatureFn = vi.fn().mockResolvedValue(featureWithApprovedPlan);

      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      // acquire should be called twice - once for initial, once for recursive
      expect(mockConcurrencyManager.acquire).toHaveBeenCalledTimes(2);
      // Second call should have allowReuse: true
      expect(mockConcurrencyManager.acquire).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowReuse: true })
      );
    });

    it('skips contextExists check when continuation prompt provided', async () => {
      // Feature has context AND approved plan, but continuation prompt is provided
      const featureWithApprovedPlan: Feature = {
        ...testFeature,
        planSpec: { status: 'approved', content: 'Plan' },
      };
      mockLoadFeatureFn = vi.fn().mockResolvedValue(featureWithApprovedPlan);
      mockContextExistsFn = vi.fn().mockResolvedValue(true);

      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      // resumeFeature should NOT be called even though context exists
      // because we're going through approved plan flow
      expect(mockResumeFeatureFn).not.toHaveBeenCalled();
    });
  });

  describe('executeFeature - incomplete task retry', () => {
    const createServiceWithMocks = () => {
      return new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );
    };

    it('does not re-run agent when feature has no tasks', async () => {
      // Feature with no planSpec/tasks - should complete normally with 1 agent call
      mockLoadFeatureFn = vi.fn().mockResolvedValue(testFeature);
      const svc = createServiceWithMocks();

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockRunAgentFn).toHaveBeenCalledTimes(1);
    });

    it('does not re-run agent when all tasks are completed', async () => {
      const featureWithCompletedTasks: Feature = {
        ...testFeature,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'completed', description: 'Second task' },
          ],
          tasksCompleted: 2,
        },
      };
      mockLoadFeatureFn = vi.fn().mockResolvedValue(featureWithCompletedTasks);
      const svc = createServiceWithMocks();

      await svc.executeFeature('/test/project', 'feature-1');

      // Only the initial agent call + the approved-plan recursive call
      // The approved plan triggers recursive executeFeature, so runAgentFn is called once in the inner call
      expect(mockRunAgentFn).toHaveBeenCalledTimes(1);
    });

    it('re-runs agent when there are pending tasks after initial execution', async () => {
      const featureWithPendingTasks: Feature = {
        ...testFeature,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'pending', description: 'Second task' },
            { id: 'T003', title: 'Task 3', status: 'pending', description: 'Third task' },
          ],
          tasksCompleted: 1,
        },
      };

      // After first agent run, loadFeature returns feature with pending tasks
      // After second agent run, loadFeature returns feature with all tasks completed
      const featureAllDone: Feature = {
        ...testFeature,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'completed', description: 'Second task' },
            { id: 'T003', title: 'Task 3', status: 'completed', description: 'Third task' },
          ],
          tasksCompleted: 3,
        },
      };

      let loadCallCount = 0;
      mockLoadFeatureFn = vi.fn().mockImplementation(() => {
        loadCallCount++;
        // First call: initial feature load at the top of executeFeature
        // Second call: after first agent run (check for incomplete tasks) - has pending tasks
        // Third call: after second agent run (check for incomplete tasks) - all done
        if (loadCallCount <= 2) return featureWithPendingTasks;
        return featureAllDone;
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, false, undefined, {
        continuationPrompt: 'Continue',
        _calledInternally: true,
      });

      // Should have called runAgentFn twice: initial + one retry
      expect(mockRunAgentFn).toHaveBeenCalledTimes(2);

      // The retry call should contain continuation prompt about incomplete tasks
      const retryCallArgs = mockRunAgentFn.mock.calls[1];
      expect(retryCallArgs[2]).toContain('Continue Implementation - Incomplete Tasks');
      expect(retryCallArgs[2]).toContain('T002');
      expect(retryCallArgs[2]).toContain('T003');

      // Should have emitted a progress event about retrying
      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_progress',
        expect.objectContaining({
          featureId: 'feature-1',
          content: expect.stringContaining('Re-running to complete tasks'),
        })
      );
    });

    it('respects maximum retry attempts', async () => {
      const featureAlwaysPending: Feature = {
        ...testFeature,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'pending', description: 'Second task' },
          ],
          tasksCompleted: 1,
        },
      };

      // Always return feature with pending tasks (agent never completes T002)
      mockLoadFeatureFn = vi.fn().mockResolvedValue(featureAlwaysPending);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, false, undefined, {
        continuationPrompt: 'Continue',
        _calledInternally: true,
      });

      // Initial run + 3 retry attempts = 4 total
      expect(mockRunAgentFn).toHaveBeenCalledTimes(4);

      // Should still set final status even with incomplete tasks
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
    });

    it('stops retrying when abort signal is triggered', async () => {
      const featureWithPendingTasks: Feature = {
        ...testFeature,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'pending', description: 'Second task' },
          ],
          tasksCompleted: 1,
        },
      };

      mockLoadFeatureFn = vi.fn().mockResolvedValue(featureWithPendingTasks);

      // Simulate abort after first agent run
      let runCount = 0;
      const capturedAbortController = { current: null as AbortController | null };
      mockRunAgentFn = vi.fn().mockImplementation((_wd, _fid, _prompt, abortCtrl) => {
        capturedAbortController.current = abortCtrl;
        runCount++;
        if (runCount >= 1) {
          // Abort after first run
          abortCtrl.abort();
        }
        return Promise.resolve();
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, false, undefined, {
        continuationPrompt: 'Continue',
        _calledInternally: true,
      });

      // Should only have the initial run, then abort prevents retries
      expect(mockRunAgentFn).toHaveBeenCalledTimes(1);
    });

    it('re-runs agent for in_progress tasks (not just pending)', async () => {
      const featureWithInProgressTask: Feature = {
        ...testFeature,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'in_progress', description: 'Second task' },
          ],
          tasksCompleted: 1,
          currentTaskId: 'T002',
        },
      };

      const featureAllDone: Feature = {
        ...testFeature,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'completed', description: 'Second task' },
          ],
          tasksCompleted: 2,
        },
      };

      let loadCallCount = 0;
      mockLoadFeatureFn = vi.fn().mockImplementation(() => {
        loadCallCount++;
        if (loadCallCount <= 2) return featureWithInProgressTask;
        return featureAllDone;
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, false, undefined, {
        continuationPrompt: 'Continue',
        _calledInternally: true,
      });

      // Should have retried for the in_progress task
      expect(mockRunAgentFn).toHaveBeenCalledTimes(2);

      // The retry prompt should mention the in_progress task
      const retryCallArgs = mockRunAgentFn.mock.calls[1];
      expect(retryCallArgs[2]).toContain('T002');
      expect(retryCallArgs[2]).toContain('in_progress');
    });

    it('uses planningMode skip and no plan approval for retry runs', async () => {
      const featureWithPendingTasks: Feature = {
        ...testFeature,
        planningMode: 'full',
        requirePlanApproval: true,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'pending', description: 'Second task' },
          ],
          tasksCompleted: 1,
        },
      };

      const featureAllDone: Feature = {
        ...testFeature,
        planSpec: {
          status: 'approved',
          content: 'Plan',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'completed', description: 'First task' },
            { id: 'T002', title: 'Task 2', status: 'completed', description: 'Second task' },
          ],
          tasksCompleted: 2,
        },
      };

      let loadCallCount = 0;
      mockLoadFeatureFn = vi.fn().mockImplementation(() => {
        loadCallCount++;
        if (loadCallCount <= 2) return featureWithPendingTasks;
        return featureAllDone;
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, false, undefined, {
        continuationPrompt: 'Continue',
        _calledInternally: true,
      });

      // The retry agent call should use planningMode: 'skip' and requirePlanApproval: false
      const retryCallArgs = mockRunAgentFn.mock.calls[1];
      const retryOptions = retryCallArgs[7]; // options object
      expect(retryOptions.planningMode).toBe('skip');
      expect(retryOptions.requirePlanApproval).toBe(false);
    });
  });

  describe('executeFeature - error handling', () => {
    it('classifies and emits error event', async () => {
      const testError = new Error('Test error');
      mockRunAgentFn = vi.fn().mockRejectedValue(testError);
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_error',
        expect.objectContaining({
          featureId: 'feature-1',
          error: 'Test error',
        })
      );
    });

    it('updates status to backlog on error', async () => {
      const testError = new Error('Test error');
      mockRunAgentFn = vi.fn().mockRejectedValue(testError);
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('tracks failure and checks pause', async () => {
      const testError = new Error('Rate limit error');
      mockRunAgentFn = vi.fn().mockRejectedValue(testError);
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockTrackFailureFn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Rate limit error',
        })
      );
    });

    it('signals pause when threshold reached', async () => {
      const testError = new Error('Quota exceeded');
      mockRunAgentFn = vi.fn().mockRejectedValue(testError);
      mockTrackFailureFn = vi.fn().mockReturnValue(true); // threshold reached

      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockSignalPauseFn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Quota exceeded',
        })
      );
    });

    it('handles abort signal without error event (emits feature_complete when isAutoMode=true)', async () => {
      const abortError = new Error('abort');
      abortError.name = 'AbortError';
      mockRunAgentFn = vi.fn().mockRejectedValue(abortError);

      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1', false, true);

      // Should emit feature_complete with stopped by user
      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_feature_complete',
        expect.objectContaining({
          featureId: 'feature-1',
          passes: false,
          message: 'Feature stopped by user',
        })
      );

      // Should NOT emit error event
      const errorCalls = vi
        .mocked(mockEventBus.emitAutoModeEvent)
        .mock.calls.filter((call) => call[0] === 'auto_mode_error');
      expect(errorCalls.length).toBe(0);
    });

    it('handles abort signal without emitting feature_complete when isAutoMode=false', async () => {
      const abortError = new Error('abort');
      abortError.name = 'AbortError';
      mockRunAgentFn = vi.fn().mockRejectedValue(abortError);

      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1', false, false);

      // Should NOT emit feature_complete when isAutoMode is false
      const completeCalls = vi
        .mocked(mockEventBus.emitAutoModeEvent)
        .mock.calls.filter((call) => call[0] === 'auto_mode_feature_complete');
      expect(completeCalls.length).toBe(0);

      // Should NOT emit error event (abort is not an error)
      const errorCalls = vi
        .mocked(mockEventBus.emitAutoModeEvent)
        .mock.calls.filter((call) => call[0] === 'auto_mode_error');
      expect(errorCalls.length).toBe(0);
    });

    it('releases running feature even on error', async () => {
      const testError = new Error('Test error');
      mockRunAgentFn = vi.fn().mockRejectedValue(testError);
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockConcurrencyManager.release).toHaveBeenCalledWith('feature-1', undefined);
    });
  });

  describe('stopFeature', () => {
    it('returns false if feature not running', async () => {
      vi.mocked(mockConcurrencyManager.getRunningFeature).mockReturnValue(undefined);

      const result = await service.stopFeature('feature-1');

      expect(result).toBe(false);
    });

    it('aborts running feature', async () => {
      const runningFeature = createRunningFeature('feature-1');
      const abortSpy = vi.spyOn(runningFeature.abortController, 'abort');
      vi.mocked(mockConcurrencyManager.getRunningFeature).mockReturnValue(runningFeature);

      const result = await service.stopFeature('feature-1');

      expect(result).toBe(true);
      expect(abortSpy).toHaveBeenCalled();
    });

    it('releases running feature with force', async () => {
      const runningFeature = createRunningFeature('feature-1');
      vi.mocked(mockConcurrencyManager.getRunningFeature).mockReturnValue(runningFeature);

      await service.stopFeature('feature-1');

      expect(mockConcurrencyManager.release).toHaveBeenCalledWith('feature-1', { force: true });
    });

    it('immediately updates feature status to interrupted before subprocess terminates', async () => {
      const runningFeature = createRunningFeature('feature-1');
      vi.mocked(mockConcurrencyManager.getRunningFeature).mockReturnValue(runningFeature);

      await service.stopFeature('feature-1');

      // Should update to 'interrupted' immediately so the UI reflects the stop
      // without waiting for the CLI subprocess to fully terminate
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'interrupted'
      );
    });

    it('still aborts and releases even if status update fails', async () => {
      const runningFeature = createRunningFeature('feature-1');
      const abortSpy = vi.spyOn(runningFeature.abortController, 'abort');
      vi.mocked(mockConcurrencyManager.getRunningFeature).mockReturnValue(runningFeature);
      vi.mocked(mockUpdateFeatureStatusFn).mockRejectedValueOnce(new Error('disk error'));

      const result = await service.stopFeature('feature-1');

      expect(result).toBe(true);
      expect(abortSpy).toHaveBeenCalled();
      expect(mockConcurrencyManager.release).toHaveBeenCalledWith('feature-1', { force: true });
    });
  });

  describe('worktree resolution', () => {
    it('uses worktree when useWorktrees is true and branch exists', async () => {
      await service.executeFeature('/test/project', 'feature-1', true);

      expect(mockWorktreeResolver.findWorktreeForBranch).toHaveBeenCalledWith(
        '/test/project',
        'feature/test-1'
      );
    });

    it('emits error and does not execute agent when worktree is not found in worktree mode', async () => {
      vi.mocked(mockWorktreeResolver.findWorktreeForBranch).mockResolvedValue(null);

      await service.executeFeature('/test/project', 'feature-1', true);

      expect(mockRunAgentFn).not.toHaveBeenCalled();
      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_error',
        expect.objectContaining({
          featureId: 'feature-1',
          error: 'Worktree enabled but no worktree found for feature branch "feature/test-1".',
        })
      );
    });

    it('skips worktree resolution when useWorktrees is false', async () => {
      await service.executeFeature('/test/project', 'feature-1', false);

      expect(mockWorktreeResolver.findWorktreeForBranch).not.toHaveBeenCalled();
    });
  });

  describe('auto-mode integration', () => {
    it('saves execution state when isAutoMode is true', async () => {
      await service.executeFeature('/test/project', 'feature-1', false, true);

      expect(mockSaveExecutionStateFn).toHaveBeenCalledWith('/test/project');
    });

    it('saves execution state after completion in auto-mode', async () => {
      await service.executeFeature('/test/project', 'feature-1', false, true);

      // Should be called twice: once at start, once at end
      expect(mockSaveExecutionStateFn).toHaveBeenCalledTimes(2);
    });

    it('saves execution state for manual starts so they resume after restart', async () => {
      await service.executeFeature('/test/project', 'feature-1', false, false);

      // Start and completion must both be persisted so a server restart can
      // recover a manually started feature instead of resetting it to backlog.
      expect(mockSaveExecutionStateFn).toHaveBeenCalledTimes(2);
      expect(mockSaveExecutionStateFn).toHaveBeenCalledWith('/test/project');
    });
  });

  describe('planning mode', () => {
    it('calls getPlanningPromptPrefix for features', async () => {
      await service.executeFeature('/test/project', 'feature-1');

      expect(mockGetPlanningPromptPrefixFn).toHaveBeenCalledWith(testFeature);
    });

    it('emits planning_started event when planning mode is not skip', async () => {
      const featureWithPlanning: Feature = {
        ...testFeature,
        planningMode: 'lite',
      };
      mockLoadFeatureFn = vi.fn().mockResolvedValue(featureWithPlanning);
      const svc = new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'planning_started',
        expect.objectContaining({
          featureId: 'feature-1',
          mode: 'lite',
        })
      );
    });
  });

  describe('summary extraction', () => {
    it('extracts and saves summary from agent output', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('Agent output with summary');

      await service.executeFeature('/test/project', 'feature-1');

      expect(mockSaveFeatureSummaryFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'Test summary'
      );
    });

    it('records learnings from agent output', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('Agent output');

      await service.executeFeature('/test/project', 'feature-1');

      expect(mockRecordLearningsFn).toHaveBeenCalledWith(
        '/test/project',
        testFeature,
        'Agent output'
      );
    });

    it('handles missing agent output gracefully', async () => {
      vi.mocked(secureFs.readFile).mockRejectedValue(new Error('ENOENT'));

      // Should not throw (isAutoMode=true so event is emitted)
      await service.executeFeature('/test/project', 'feature-1', false, true);

      // The turn ends, but missing implementation output is a failure
      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_feature_complete',
        expect.objectContaining({ passes: false })
      );
    });

    // Helper to create ExecutionService with a custom loadFeatureFn that returns
    // different features on first load (initial) vs subsequent loads (after completion)
    const createServiceWithCustomLoad = (completedFeature: Feature): ExecutionService => {
      let loadCallCount = 0;
      mockLoadFeatureFn = vi.fn().mockImplementation(() => {
        loadCallCount++;
        return loadCallCount === 1 ? testFeature : completedFeature;
      });

      return new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        undefined as never
      );
    };

    it('does not overwrite accumulated summary when feature already has one', async () => {
      const featureWithAccumulatedSummary: Feature = {
        ...testFeature,
        summary:
          '### Implementation\n\nFirst step output\n\n---\n\n### Code Review\n\nReview findings',
      };

      const svc = createServiceWithCustomLoad(featureWithAccumulatedSummary);
      await svc.executeFeature('/test/project', 'feature-1');

      // saveFeatureSummaryFn should NOT be called because feature already has a summary
      // This prevents overwriting accumulated pipeline summaries with just the last step's output
      expect(mockSaveFeatureSummaryFn).not.toHaveBeenCalled();
    });

    it('saves summary when feature has no existing summary', async () => {
      const featureWithoutSummary: Feature = {
        ...testFeature,
        summary: undefined,
      };

      vi.mocked(secureFs.readFile).mockResolvedValue(
        '🔧 Tool: Edit\nInput: {"file_path": "/src/index.ts"}\n\n<summary>New summary</summary>'
      );

      const svc = createServiceWithCustomLoad(featureWithoutSummary);
      await svc.executeFeature('/test/project', 'feature-1');

      // Should save the extracted summary since feature has none
      expect(mockSaveFeatureSummaryFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'Test summary'
      );
    });

    it('does not overwrite summary when feature has empty string summary (treats as no summary)', async () => {
      // Empty string is falsy, so it should be treated as "no summary" and a new one should be saved
      const featureWithEmptySummary: Feature = {
        ...testFeature,
        summary: '',
      };

      vi.mocked(secureFs.readFile).mockResolvedValue(
        '🔧 Tool: Edit\nInput: {"file_path": "/src/index.ts"}\n\n<summary>New summary</summary>'
      );

      const svc = createServiceWithCustomLoad(featureWithEmptySummary);
      await svc.executeFeature('/test/project', 'feature-1');

      // Empty string is falsy, so it should save a new summary
      expect(mockSaveFeatureSummaryFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'Test summary'
      );
    });

    it('preserves accumulated summary when feature is transitioned from pipeline to verified', async () => {
      // This is the key scenario: feature went through pipeline steps, accumulated a summary,
      // then status changed to 'verified' - we should NOT overwrite the accumulated summary
      const featureWithAccumulatedSummary: Feature = {
        ...testFeature,
        status: 'verified',
        summary:
          '### Implementation\n\nCreated auth module\n\n---\n\n### Code Review\n\nApproved\n\n---\n\n### Testing\n\nAll tests pass',
      };

      vi.mocked(secureFs.readFile).mockResolvedValue('Agent output with summary');

      const svc = createServiceWithCustomLoad(featureWithAccumulatedSummary);
      await svc.executeFeature('/test/project', 'feature-1');

      // The accumulated summary should be preserved
      expect(mockSaveFeatureSummaryFn).not.toHaveBeenCalled();
    });
  });

  describe('executeFeature - agent output validation', () => {
    it('replaces old blockers with the actual runtime failure before moving back to backlog', async () => {
      const updateFeatureFields = vi.fn().mockResolvedValue(undefined);
      mockRunAgentFn.mockRejectedValueOnce(new Error('429: No deployments available'));
      const svc = createServiceWithMocks({ updateFeatureFields });
      await svc.executeFeature('/test/project', 'feature-1');
      expect(updateFeatureFields).toHaveBeenCalledWith('/test/project', 'feature-1', {
        error: undefined,
        executionNotice: undefined,
        completionSource: undefined,
      });
      expect(updateFeatureFields).toHaveBeenCalledWith('/test/project', 'feature-1', {
        error: expect.stringContaining('429'),
        executionNotice: expect.objectContaining({
          source: 'execution',
          kind: 'error',
          message: expect.stringContaining('429'),
        }),
      });
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('keeps a text-only Reply in review instead of treating it as failed implementation', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue(
        'Please confirm which deployment you want me to validate.'
      );
      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, false, undefined, {
        continuationPrompt: 'Explain the remaining work',
      });
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
      expect(mockUpdateFeatureStatusFn).not.toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('refreshes delivery blockers from the receipt instead of keeping old errors', async () => {
      const updateFeatureFields = vi.fn().mockResolvedValue(undefined);
      vi.mocked(secureFs.readFile).mockImplementation(async (file: unknown) =>
        String(file).endsWith('jira/feature-1/jira-result.json')
          ? JSON.stringify({
              outcome: 'mr_created',
              blockers: ['Needs real environment acceptance'],
            })
          : makeAgentOutput(5)
      );
      await createServiceWithMocks({ updateFeatureFields }).executeFeature(
        '/test/project',
        'feature-1'
      );
      expect(updateFeatureFields).toHaveBeenCalledWith('/test/project', 'feature-1', {
        error: undefined,
        executionNotice: expect.objectContaining({ source: 'delivery', kind: 'review' }),
      });
    });

    it('imports current visual evidence and leaves the task for human approval', async () => {
      const evidence = {
        status: 'passed',
        summary: 'Verified on k3s',
        screenshots: [],
        checks: [],
        verifiedAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
      } as const;
      vi.mocked(collectAcceptanceEvidence).mockResolvedValueOnce(evidence as never);
      vi.mocked(secureFs.readFile).mockResolvedValue(makeAgentOutput(5));
      const updateFeatureFields = vi.fn().mockResolvedValue(undefined);
      const svc = createServiceWithMocks({ updateFeatureFields });
      await svc.executeFeature('/test/project', 'feature-1');
      expect(collectAcceptanceEvidence).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        expect.any(String),
        expect.any(Number)
      );
      expect(updateFeatureFields).toHaveBeenCalledWith('/test/project', 'feature-1', {
        acceptanceEvidence: evidence,
      });
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
      expect(mockUpdateFeatureStatusFn).not.toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
    });

    it('surfaces malformed evidence instead of marking the task verified', async () => {
      vi.mocked(collectAcceptanceEvidence).mockRejectedValueOnce(
        new Error('Screenshot escapes directory')
      );
      vi.mocked(secureFs.readFile).mockResolvedValue(makeAgentOutput(5));
      const updateFeatureFields = vi.fn().mockResolvedValue(undefined);
      const svc = createServiceWithMocks({ updateFeatureFields });
      await svc.executeFeature('/test/project', 'feature-1');
      expect(updateFeatureFields).toHaveBeenCalledWith('/test/project', 'feature-1', {
        error: expect.stringContaining('Screenshot escapes directory'),
      });
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
    });

    // Helper to generate realistic agent output with tool markers
    const makeAgentOutput = (toolCount: number, extraText = ''): string => {
      let output = 'Starting implementation...\n\n';
      for (let i = 0; i < toolCount; i++) {
        output += `🔧 Tool: Edit\nInput: {"file_path": "/src/file${i}.ts", "old_string": "old${i}", "new_string": "new${i}"}\n\n`;
      }
      output += `Implementation complete. ${extraText}`;
      return output;
    };

    const createServiceWithMocks = (featureStateManager?: {
      updateFeatureFields: (
        projectPath: string,
        featureId: string,
        fields: Partial<Feature>
      ) => Promise<void>;
    }) => {
      return new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        featureStateManager
      );
    };

    it('sets verified when agent output has tool usage and sufficient length', async () => {
      const output = makeAgentOutput(3, 'Updated authentication module with new login flow.');
      vi.mocked(secureFs.readFile).mockResolvedValue(output);

      await service.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
    });

    it('sets waiting_approval when jira receipt outcome is blocked despite meaningful output', async () => {
      const output = makeAgentOutput(
        5,
        'Investigation completed and delivery receipt was written.'
      );
      vi.mocked(secureFs.readFile).mockImplementation(async (readPath: unknown) => {
        if (String(readPath).endsWith('jira/feature-1/jira-result.json')) {
          return JSON.stringify({ outcome: 'blocked', blockers: ['Product decision pending'] });
        }
        return output;
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
    });

    it('accepts completed development without requiring MRs', async () => {
      vi.mocked(secureFs.readFile).mockImplementation(async (readPath: unknown) =>
        String(readPath).endsWith('jira/feature-1/jira-result.json')
          ? JSON.stringify({ outcome: 'development_complete', blockers: [], mergeRequests: [] })
          : makeAgentOutput(5)
      );
      await createServiceWithMocks().executeFeature('/test/project', 'feature-1');
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
      expect(mockRunAgentFn.mock.calls[0][2]).toContain('no MR is required');
    });

    it('persists changed projects and MRs from a delivery receipt', async () => {
      const output = makeAgentOutput(5, 'Implementation delivered with MRs.');
      const updateFeatureFields = vi.fn().mockResolvedValue(undefined);
      vi.mocked(secureFs.readFile).mockImplementation(async (readPath: unknown) => {
        if (String(readPath).endsWith('jira/feature-1/jira-result.json')) {
          return JSON.stringify({
            outcome: 'mr_created',
            changedProjects: [
              {
                name: 'backend/sophon-mind',
                mrUrl: 'https://gitblue.example.com/group/sophon-mind/-/merge_requests/12',
              },
            ],
            mergeRequests: ['https://gitblue.example.com/group/sophon-mind/-/merge_requests/12'],
          });
        }
        return output;
      });

      const svc = createServiceWithMocks({ updateFeatureFields });
      await svc.executeFeature('/test/project', 'feature-1');

      expect(updateFeatureFields).toHaveBeenCalledWith('/test/project', 'feature-1', {
        changedProjects: [
          {
            name: 'backend/sophon-mind',
            mrUrl: 'https://gitblue.example.com/group/sophon-mind/-/merge_requests/12',
          },
        ],
        mergeRequests: ['https://gitblue.example.com/group/sophon-mind/-/merge_requests/12'],
      });
    });

    it('sets waiting_approval when jira receipt has blockers despite tests and MRs', async () => {
      const output = makeAgentOutput(5, 'Partial implementation delivered behind MRs.');
      vi.mocked(secureFs.readFile).mockImplementation(async (readPath: unknown) => {
        if (String(readPath).endsWith('jira/feature-1/jira-result.json')) {
          return JSON.stringify({
            outcome: 'mr_created',
            blockers: ['', 'Epic §4B remains unimplemented'],
          });
        }
        return output;
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
    });

    it('sets waiting_approval when jira receipt outcome is needs_input', async () => {
      const output = makeAgentOutput(3, 'Work stopped for a product decision.');
      vi.mocked(secureFs.readFile).mockImplementation(async (readPath: unknown) => {
        if (String(readPath).endsWith('jira/feature-1/jira-result.json')) {
          return JSON.stringify({ outcome: 'needs_input', questions: [] });
        }
        return output;
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
    });

    it('sets backlog when agent output is empty', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('');

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('sets backlog when agent output has no tool usage markers', async () => {
      // Long output but no tool markers - agent printed text but didn't use tools
      const longOutputNoTools = 'I analyzed the codebase and found several issues. '.repeat(20);
      vi.mocked(secureFs.readFile).mockResolvedValue(longOutputNoTools);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('sets backlog when agent output has tool markers but is too short', async () => {
      // Has a tool marker but total output is under 200 chars
      const shortWithTool = '🔧 Tool: Read\nInput: {"file_path": "/src/index.ts"}\nDone.';
      expect(shortWithTool.trim().length).toBeLessThan(200);

      vi.mocked(secureFs.readFile).mockResolvedValue(shortWithTool);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('sets backlog when agent output file is missing (ENOENT)', async () => {
      vi.mocked(secureFs.readFile).mockRejectedValue(new Error('ENOENT'));

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('sets backlog when agent output is only whitespace', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('   \n\n\t  \n  ');

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('sets verified when output is exactly at the 200 char threshold with tool usage', async () => {
      // Create output that's exactly 200 chars trimmed with tool markers
      const toolMarker = '🔧 Tool: Edit\nInput: {"file_path": "/src/index.ts"}\n';
      const padding = 'x'.repeat(200 - toolMarker.length);
      const output = toolMarker + padding;
      expect(output.trim().length).toBeGreaterThanOrEqual(200);

      vi.mocked(secureFs.readFile).mockResolvedValue(output);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
    });

    it('sets backlog when output is 199 chars with tool usage (below threshold)', async () => {
      const toolMarker = '🔧 Tool: Read\n';
      const padding = 'x'.repeat(199 - toolMarker.length);
      const output = toolMarker + padding;
      expect(output.trim().length).toBe(199);

      vi.mocked(secureFs.readFile).mockResolvedValue(output);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('skipTests always takes priority over output validation', async () => {
      // Meaningful output with tool usage - would normally be 'verified'
      const output = makeAgentOutput(5, 'All changes applied successfully.');
      vi.mocked(secureFs.readFile).mockResolvedValue(output);

      mockLoadFeatureFn = vi.fn().mockResolvedValue({ ...testFeature, skipTests: true });
      const svc = createServiceWithMocks();

      await svc.executeFeature('/test/project', 'feature-1');

      // skipTests=true always means waiting_approval regardless of output quality
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
    });

    it('skipTests with empty output still results in waiting_approval', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('');

      mockLoadFeatureFn = vi.fn().mockResolvedValue({ ...testFeature, skipTests: true });
      const svc = createServiceWithMocks();

      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'waiting_approval'
      );
    });

    it('records a failure instead of success when output validation fails', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('');

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // The feature goes back to backlog, so the auto-mode failure counter must
      // advance: recording success here would let the loop retry forever.
      expect(mockRecordSuccessFn).not.toHaveBeenCalled();
      expect(mockTrackFailureFn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'insufficient_output' })
      );
    });

    it('pauses auto mode when insufficient output reaches the failure threshold', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('');
      mockTrackFailureFn = vi.fn().mockReturnValue(true);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockSignalPauseFn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'insufficient_output' })
      );
    });

    it('still extracts summary when output has content but no tool markers', async () => {
      const outputNoTools = 'A '.repeat(150); // > 200 chars but no tool markers
      vi.mocked(secureFs.readFile).mockResolvedValue(outputNoTools);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // Summary extraction still runs even though status is waiting_approval
      expect(extractSummary).toHaveBeenCalledWith(outputNoTools);
      expect(mockSaveFeatureSummaryFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'Test summary'
      );
    });

    it('emits failed completion when output validation rejects the run', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('');

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, true);

      // Insufficient output must not trigger success hooks or suppress error notifications.
      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_feature_complete',
        expect.objectContaining({ passes: false })
      );
    });

    it('handles realistic Cursor CLI output that exits quickly', async () => {
      // Simulates a Cursor CLI that prints a brief message and exits
      const cursorQuickExit = 'Task received. Processing...\nResult: completed successfully.';
      expect(cursorQuickExit.includes('🔧 Tool:')).toBe(false);

      vi.mocked(secureFs.readFile).mockResolvedValue(cursorQuickExit);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // No tool usage = waiting_approval
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('handles realistic Claude SDK output with multiple tool uses', async () => {
      // Simulates a Claude SDK agent that does real work
      const claudeOutput =
        "I'll implement the requested feature.\n\n" +
        '🔧 Tool: Read\nInput: {"file_path": "/src/components/App.tsx"}\n\n' +
        'I can see the existing component structure. Let me modify it.\n\n' +
        '🔧 Tool: Edit\nInput: {"file_path": "/src/components/App.tsx", "old_string": "const App = () => {", "new_string": "const App: React.FC = () => {"}\n\n' +
        '🔧 Tool: Write\nInput: {"file_path": "/src/components/NewFeature.tsx"}\n\n' +
        "I've created the new component and updated the existing one. The feature is now implemented with proper TypeScript types.";

      vi.mocked(secureFs.readFile).mockResolvedValue(claudeOutput);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // Real work = verified
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
    });

    it('reads agent output from the correct path with utf-8 encoding', async () => {
      const output = makeAgentOutput(2, 'Done with changes.');
      vi.mocked(secureFs.readFile).mockResolvedValue(output);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // Verify readFile was called with the correct path derived from getFeatureDir
      expect(secureFs.readFile).toHaveBeenCalledWith(
        '/test/project/.automaker/features/feature-1/agent-output.md',
        'utf-8'
      );
    });

    it('completion message includes auto-verified when status is verified', async () => {
      const output = makeAgentOutput(3, 'All changes applied.');
      vi.mocked(secureFs.readFile).mockResolvedValue(output);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, true);

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'auto_mode_feature_complete',
        expect.objectContaining({
          message: expect.stringContaining('auto-verified'),
        })
      );
    });

    it('completion message does NOT include auto-verified when status is waiting_approval', async () => {
      // Empty output → waiting_approval
      vi.mocked(secureFs.readFile).mockResolvedValue('');

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1', false, true);

      const completeCall = vi
        .mocked(mockEventBus.emitAutoModeEvent)
        .mock.calls.find((call) => call[0] === 'auto_mode_feature_complete');
      expect(completeCall).toBeDefined();
      expect((completeCall![1] as { message: string }).message).not.toContain('auto-verified');
    });

    it('uses same agentOutput for both status determination and summary extraction', async () => {
      // Specific output that is long enough with tool markers (verified path)
      // AND has content for summary extraction
      const specificOutput =
        '🔧 Tool: Read\nReading file...\n🔧 Tool: Edit\nEditing file...\n' +
        'The implementation is complete. Here is a detailed description of what was done. '.repeat(
          3
        );
      vi.mocked(secureFs.readFile).mockResolvedValue(specificOutput);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // Status should be verified (has tools + long enough)
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
      // extractSummary should receive the exact same output
      expect(extractSummary).toHaveBeenCalledWith(specificOutput);
      // recordLearnings should also receive the same output
      expect(mockRecordLearningsFn).toHaveBeenCalledWith(
        '/test/project',
        testFeature,
        specificOutput
      );
    });

    it('does not call recordMemoryUsage when output is empty and memoryFiles is empty', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('');
      const { recordMemoryUsage } = await import('@automaker/utils');

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // With empty output and empty memoryFiles, recordMemoryUsage should not be called
      expect(recordMemoryUsage).not.toHaveBeenCalled();
    });

    it('handles output with special unicode characters correctly', async () => {
      // Output with various unicode but includes tool markers
      const unicodeOutput =
        '🔧 Tool: Read\n' +
        '🔧 Tool: Edit\n' +
        'Añadiendo función de búsqueda con caracteres especiales: ñ, ü, ö, é, 日本語テスト. ' +
        'Die Änderungen wurden erfolgreich implementiert. '.repeat(3);
      vi.mocked(secureFs.readFile).mockResolvedValue(unicodeOutput);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // Should still detect tool markers and sufficient length
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
    });

    it('treats output with only newlines and spaces around tool marker as insufficient', async () => {
      // Has tool marker but surrounded by whitespace, total trimmed < 200
      const sparseOutput = '\n\n  🔧 Tool: Read  \n\n';
      expect(sparseOutput.trim().length).toBeLessThan(200);

      vi.mocked(secureFs.readFile).mockResolvedValue(sparseOutput);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('detects tool marker substring correctly (partial match like "🔧 Tools:" does not count)', async () => {
      // Output with a similar but not exact marker - "🔧 Tools:" instead of "🔧 Tool:"
      const wrongMarker = '🔧 Tools: Read\n🔧 Tools: Edit\n' + 'Implementation done. '.repeat(20);
      expect(wrongMarker.includes('🔧 Tool:')).toBe(false);

      vi.mocked(secureFs.readFile).mockResolvedValue(wrongMarker);

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // "🔧 Tools:" is not the same as "🔧 Tool:" - should be waiting_approval
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'backlog'
      );
    });

    it('pipeline merge_conflict status short-circuits before output validation', async () => {
      // Set up pipeline that results in merge_conflict
      vi.mocked(pipelineService.getPipelineConfig).mockResolvedValue({
        version: 1,
        steps: [{ id: 'step-1', name: 'Step 1', order: 1, instructions: 'Do step 1' }] as any,
      });

      // After pipeline, loadFeature returns merge_conflict status
      let loadCallCount = 0;
      mockLoadFeatureFn = vi.fn().mockImplementation(() => {
        loadCallCount++;
        if (loadCallCount === 1) return testFeature; // initial load
        // All subsequent loads (task check + pipeline refresh) return merge_conflict
        return { ...testFeature, status: 'merge_conflict' };
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // Should NOT have called updateFeatureStatusFn with 'verified' or 'waiting_approval'
      // because pipeline merge_conflict short-circuits the method
      const statusCalls = vi
        .mocked(mockUpdateFeatureStatusFn)
        .mock.calls.filter((call) => call[2] === 'verified' || call[2] === 'waiting_approval');
      // The only non-in_progress status call should be absent since merge_conflict returns early
      expect(statusCalls.length).toBe(0);
    });

    it('sets waiting_approval instead of backlog when error occurs after pipeline completes', async () => {
      // Set up pipeline with steps
      vi.mocked(pipelineService.getPipelineConfig).mockResolvedValue({
        version: 1,
        steps: [{ id: 'step-1', name: 'Step 1', order: 1, instructions: 'Do step 1' }] as any,
      });

      // Pipeline succeeds, but reading agent output throws after pipeline completes
      mockExecutePipelineFn = vi.fn().mockResolvedValue(undefined);
      // Simulate an error after pipeline completes by making loadFeature throw
      // on the post-pipeline refresh call
      let loadCallCount = 0;
      mockLoadFeatureFn = vi.fn().mockImplementation(() => {
        loadCallCount++;
        if (loadCallCount === 1) return testFeature; // initial load
        // Second call is the task-retry check, third is the pipeline refresh
        if (loadCallCount <= 2) return testFeature;
        throw new Error('Unexpected post-pipeline error');
      });

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // Should set to waiting_approval, NOT backlog, since pipeline completed
      const backlogCalls = vi
        .mocked(mockUpdateFeatureStatusFn)
        .mock.calls.filter((call) => call[2] === 'backlog');
      expect(backlogCalls.length).toBe(0);

      const waitingCalls = vi
        .mocked(mockUpdateFeatureStatusFn)
        .mock.calls.filter((call) => call[2] === 'waiting_approval');
      expect(waitingCalls.length).toBeGreaterThan(0);
    });

    it('still sets backlog when error occurs before pipeline completes', async () => {
      // Set up pipeline with steps
      vi.mocked(pipelineService.getPipelineConfig).mockResolvedValue({
        version: 1,
        steps: [{ id: 'step-1', name: 'Step 1', order: 1, instructions: 'Do step 1' }] as any,
      });

      // Pipeline itself throws (e.g., agent error during pipeline step)
      mockExecutePipelineFn = vi.fn().mockRejectedValue(new Error('Agent execution failed'));

      const svc = createServiceWithMocks();
      await svc.executeFeature('/test/project', 'feature-1');

      // Should still set to backlog since pipeline did NOT complete
      const backlogCalls = vi
        .mocked(mockUpdateFeatureStatusFn)
        .mock.calls.filter((call) => call[2] === 'backlog');
      expect(backlogCalls.length).toBe(1);
    });
  });

  describe('executeFeature - provider conversation continuity', () => {
    const createServiceForSession = (
      feature: Feature,
      featureStateManager?: {
        updateFeatureFields: (
          projectPath: string,
          featureId: string,
          fields: Partial<Feature>
        ) => Promise<void>;
      }
    ): ExecutionService => {
      mockLoadFeatureFn = vi.fn().mockResolvedValue(feature);
      return new ExecutionService(
        mockEventBus,
        mockConcurrencyManager,
        mockWorktreeResolver,
        mockSettingsService,
        mockRunAgentFn,
        mockExecutePipelineFn,
        mockUpdateFeatureStatusFn,
        mockLoadFeatureFn,
        mockGetPlanningPromptPrefixFn,
        mockSaveFeatureSummaryFn,
        mockRecordLearningsFn,
        mockContextExistsFn,
        mockResumeFeatureFn,
        mockTrackFailureFn,
        mockSignalPauseFn,
        mockRecordSuccessFn,
        mockSaveExecutionStateFn,
        mockLoadContextFilesFn,
        featureStateManager
      );
    };

    it('ignores old Jira receipts and tells the agent which run ID to report', async () => {
      const feature = {
        ...testFeature,
        jiraIssueId: '10001',
        jiraDispatchRunId: 'current-run',
      } as Feature;
      const updateFeatureFields = vi.fn().mockResolvedValue(undefined);
      vi.mocked(secureFs.readFile).mockImplementation(async (file: unknown) =>
        String(file).endsWith('jira-result.json')
          ? JSON.stringify({
              runId: 'previous-run',
              outcome: 'blocked',
              blockers: ['stale blocker'],
            })
          : '🔧 Tool: read\n' + 'Implemented and tested. '.repeat(30)
      );
      await createServiceForSession(feature, { updateFeatureFields }).executeFeature(
        '/test/project',
        'feature-1'
      );
      expect(updateFeatureFields).toHaveBeenCalledWith('/test/project', 'feature-1', {
        executionRunId: 'current-run',
        jiraDispatchRunId: undefined,
      });
      expect(mockRunAgentFn.mock.calls[0][2]).toContain('Execution run ID: current-run');
      expect(mockUpdateFeatureStatusFn).toHaveBeenCalledWith(
        '/test/project',
        'feature-1',
        'verified'
      );
      expect(updateFeatureFields.mock.calls.some((call) => call[2].error === 'stale blocker')).toBe(
        false
      );
    });

    it('overrides stale import permission with the current no-auto-decomposition policy', async () => {
      const feature = {
        ...testFeature,
        description: 'Historical import: decomposition explicitly authorized',
        jiraDelivery: {
          rule: 'parent-with-jira-subtasks',
          issueKey: 'AIP-1',
          subtaskKeys: [],
          branch: 'story/aip-1',
          worktree: '/worktree',
          requiresDecision: true,
        },
      } as Feature;
      await createServiceForSession(feature).executeFeature('/test/project', 'feature-1');
      const prompt = mockRunAgentFn.mock.calls[0][2];
      expect(prompt).toContain('Absence of Jira subtasks is not authorization to split');
      expect(prompt).toContain('supersedes historical import instructions');
    });

    it('resumes the feature provider session instead of starting a clean one', async () => {
      const feature = {
        ...testFeature,
        providerSessionId: 'ses_existing_conversation',
      } as Feature;

      const svc = createServiceForSession(feature);
      await svc.executeFeature('/test/project', 'feature-1');

      const runOptions = vi.mocked(mockRunAgentFn).mock.calls[0]?.[7];
      expect(runOptions?.sdkSessionId).toBe('ses_existing_conversation');
    });

    it('starts without a session id when the feature has none yet', async () => {
      const svc = createServiceForSession(testFeature);
      await svc.executeFeature('/test/project', 'feature-1');

      const runOptions = vi.mocked(mockRunAgentFn).mock.calls[0]?.[7];
      expect(runOptions?.sdkSessionId).toBeUndefined();
    });

    it('clears a stale provider session so the next run can start fresh', async () => {
      const feature = {
        ...testFeature,
        providerSessionId: 'ses_gone',
      } as Feature;
      const updateFeatureFields = vi.fn().mockResolvedValue(undefined);
      mockRunAgentFn = vi.fn().mockRejectedValue(new Error('Session not found: ses_gone'));

      const svc = createServiceForSession(feature, { updateFeatureFields });
      await svc.executeFeature('/test/project', 'feature-1');

      expect(updateFeatureFields).toHaveBeenCalledWith('/test/project', 'feature-1', {
        providerSessionId: undefined,
      });
    });

    it('sends the full task description on the first turn', async () => {
      const feature = {
        ...testFeature,
        description: 'FIRST-TURN-DESCRIPTION-BODY',
      } as Feature;

      const svc = createServiceForSession(feature);
      await svc.executeFeature('/test/project', 'feature-1');

      const prompt = vi.mocked(mockRunAgentFn).mock.calls[0]?.[2] as string;
      expect(prompt).toContain('FIRST-TURN-DESCRIPTION-BODY');
    });

    it('sends only a short anchor when the conversation already exists', async () => {
      const feature = {
        ...testFeature,
        description: 'DUPLICATED-DESCRIPTION-BODY',
        providerSessionId: 'ses_existing_conversation',
      } as Feature;

      const svc = createServiceForSession(feature);
      await svc.executeFeature('/test/project', 'feature-1');

      const prompt = vi.mocked(mockRunAgentFn).mock.calls[0]?.[2] as string;
      // The session already holds the description and instructions.
      expect(prompt).not.toContain('DUPLICATED-DESCRIPTION-BODY');
      // The anchor and the machine-parsed summary contract must still be present.
      expect(prompt).toContain('**Feature ID:** feature-1');
      expect(prompt).toContain('<summary>');
    });
  });
});
