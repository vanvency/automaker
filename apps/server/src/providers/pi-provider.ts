/**
 * Pi Provider - Executes queries using the `pi` coding agent CLI
 *
 * Pi is an npm-distributed coding agent (https://github.com/earendil-works/pi-mono)
 * that exposes read/bash/edit/write tools plus session management.
 *
 * This provider wires Pi to the local LiteLLM gateway:
 * - Models are discovered from LiteLLM's OpenAI-compatible `/v1/models`
 *   endpoint and exposed as canonical `pi:litellm/<model>` IDs.
 * - `~/.pi/agent/models.json` is (re)generated so the CLI itself knows about the
 *   gateway, and the LiteLLM master key is injected into the subprocess env.
 * - Responses are read from Pi's `--mode json` JSONL event stream.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CliProvider, type CliSpawnConfig } from './cli-provider.js';
import {
  getPiModelsConfigPath,
  refreshPiLitellmProvider,
  resolveLitellmApiKey,
  toPiModelId,
} from './pi-litellm.js';
import type {
  ProviderConfig,
  ExecuteOptions,
  ProviderMessage,
  ModelDefinition,
  InstallationStatus,
  ContentBlock,
} from '@automaker/types';
import {
  PI_MODEL_CONTEXT_WINDOW,
  PI_MODEL_MAX_OUTPUT_TOKENS,
  PI_LITELLM_API_KEY_ENV,
  PI_LITELLM_PROVIDER_ID,
  PI_MODELS,
  parsePiModelId,
} from '@automaker/types';
import type { SubprocessOptions } from '@automaker/platform';
import { createLogger } from '@automaker/utils';

const execFileAsync = promisify(execFile);
const piLogger = createLogger('PiProvider');

/** Cache duration for the LiteLLM model list (5 minutes) */
const MODEL_CACHE_DURATION_MS = 5 * 60 * 1000;

/** Marker env var that disables project-file trust for Pi runs */
const PI_NO_PROJECT_TRUST_ENV = 'AUTOMAKER_PI_NO_PROJECT_TRUST';

// =============================================================================
// Pi JSON event types (see pi docs/json.md)
// =============================================================================

interface PiTextContent {
  type: 'text';
  text: string;
}

interface PiThinkingContent {
  type: 'thinking';
  thinking: string;
}

interface PiToolCallContent {
  type: 'toolCall';
  id?: string;
  name?: string;
  arguments?: unknown;
}

type PiMessageContent = PiTextContent | PiThinkingContent | PiToolCallContent | { type: string };

interface PiMessage {
  role?: string;
  content?: PiMessageContent[] | string;
  stopReason?: string;
  errorMessage?: string;
}

interface PiAssistantMessageEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
  id?: string;
  toolName?: string;
  toolCall?: PiToolCallContent;
  reason?: string;
  error?: PiMessage;
}

interface PiRawEvent {
  type: string;
  id?: string;
  sessionId?: string;
  message?: PiMessage;
  messages?: PiMessage[];
  assistantMessageEvent?: PiAssistantMessageEvent;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  error?: unknown;
}

// =============================================================================
// Helpers
// =============================================================================

/** Tool names automaker passes around -> Pi built-in tool names */
const PI_TOOL_NAME_MAP: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  shell: 'bash',
  glob: 'glob',
  grep: 'grep',
};

/**
 * Map automaker/Claude-style tool names onto Pi tool names.
 */
function mapToolNames(tools: string[]): string[] {
  const mapped = tools
    .map((tool) => PI_TOOL_NAME_MAP[tool.trim().toLowerCase()])
    .filter((tool): tool is string => Boolean(tool));
  return Array.from(new Set(mapped));
}

/**
 * Map automaker reasoning/thinking settings onto Pi's `--thinking` levels.
 */
function mapThinkingLevel(options: ExecuteOptions): string | undefined {
  if (options.reasoningEffort) {
    return options.reasoningEffort === 'none' ? 'off' : options.reasoningEffort;
  }

  switch (options.thinkingLevel) {
    case 'none':
      return 'off';
    case 'low':
    case 'medium':
    case 'high':
      return options.thinkingLevel;
    case 'ultrathink':
      return 'max';
    default:
      // 'adaptive' (and unset) lets Pi decide per model.
      return undefined;
  }
}

/**
 * Render any tool result payload as text for the UI.
 */
function stringifyToolResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;

  if (typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) =>
          block &&
          typeof block === 'object' &&
          typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : ''
        )
        .join('');
      if (text) return text;
    }
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Extract a human-readable error message from Pi's error payloads.
 */
function extractErrorMessage(error: unknown): string {
  if (!error) return 'Pi agent failed';
  if (typeof error === 'string') return error;

  if (typeof error === 'object') {
    const candidate = error as { errorMessage?: unknown; message?: unknown; error?: unknown };
    if (typeof candidate.errorMessage === 'string') return candidate.errorMessage;
    if (typeof candidate.message === 'string') return candidate.message;
    if (candidate.error) return extractErrorMessage(candidate.error);
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Extract assistant text from a Pi message (used for authoritative fallbacks).
 */
function extractTextFromMessage(message: PiMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  return message.content
    .filter((block): block is PiTextContent => block.type === 'text' && 'text' in block)
    .map((block) => block.text)
    .join('');
}

/**
 * Extract the final assistant text from an `agent_end` event.
 */
function extractTextFromMessages(messages: PiMessage[] | undefined): string {
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'assistant') {
      const text = extractTextFromMessage(message);
      if (text) return text;
    }
  }
  return '';
}

// =============================================================================
// Provider Implementation
// =============================================================================

/**
 * Shared LiteLLM model list.
 *
 * `ProviderFactory` builds a new provider instance per call, so an instance-level
 * cache never survived the next request: every `/api/models/available` and every
 * provider-status poll re-fetched the gateway (up to the 5s request timeout) and
 * re-wrote `models.json`. The list is process-wide instead, and only a config
 * change (base URL/API key) needs `clearModelCache()` to take effect early.
 */
let sharedModels: ModelDefinition[] | null = null;
let sharedModelsExpiry = 0;
/** In-flight refresh, shared so concurrent callers make one gateway request */
let sharedRefreshPromise: Promise<ModelDefinition[]> | null = null;

function resetSharedModelCache(): void {
  sharedModels = null;
  sharedModelsExpiry = 0;
}

/**
 * PiProvider - integrates the `pi` coding agent CLI as an AI provider
 */
export class PiProvider extends CliProvider {
  /** Session id captured from the `session` event, attached to every message */
  private currentSessionId: string | undefined;

  /** Whether the current assistant message streamed text deltas */
  private sawTextDelta = false;

  /** Accumulated assistant text for the final result message */
  private accumulatedText = '';

  /** Tool call ids already emitted as tool_use blocks */
  private emittedToolCalls = new Set<string>();

  /** Set when the run reports an error, so agent_end can report failure */
  private runFailed = false;

  /** Last error message reported during the run */
  private lastError: string | undefined;

  constructor(config: ProviderConfig = {}) {
    super(config);
  }

  // ==========================================================================
  // CliProvider abstract method implementations
  // ==========================================================================

  getName(): string {
    return 'pi';
  }

  getCliName(): string {
    return 'pi';
  }

  getSpawnConfig(): CliSpawnConfig {
    const home = os.homedir();
    return {
      windowsStrategy: 'npx',
      npxPackage: '@earendil-works/pi-coding-agent@latest',
      commonPaths: {
        linux: [
          path.join(home, '.local/bin/pi'),
          path.join(home, '.npm-global/bin/pi'),
          '/usr/local/bin/pi',
          '/usr/bin/pi',
        ],
        darwin: [
          path.join(home, '.local/bin/pi'),
          path.join(home, '.npm-global/bin/pi'),
          '/usr/local/bin/pi',
          '/opt/homebrew/bin/pi',
        ],
        win32: [
          path.join(home, 'AppData', 'Roaming', 'npm', 'pi.cmd'),
          path.join(process.env.APPDATA || '', 'npm', 'pi.cmd'),
        ],
      },
    };
  }

  /**
   * Build CLI args for a non-interactive Pi run with JSONL output.
   */
  buildCliArgs(options: ExecuteOptions): string[] {
    const args = ['--print', '--mode', 'json'];

    // Canonical IDs look like "pi:litellm/auto"; Pi takes provider + bare model.
    const parsed = parsePiModelId(options.model) ?? parsePiModelId(options.originalModel);
    const upstreamProvider = parsed?.upstreamProvider ?? PI_LITELLM_PROVIDER_ID;

    // Upstream code strips the "pi-" prefix before building execute options, so
    // accept both "auto" and "litellm/auto". Model groups that contain a slash
    // (e.g. "ark/kimi-k3") are passed through untouched.
    let model = parsed?.model ?? options.model;
    if (!parsed && model.startsWith(`${upstreamProvider}/`)) {
      model = model.slice(upstreamProvider.length + 1);
    }

    args.push('--provider', upstreamProvider, '--model', model);

    const thinking = mapThinkingLevel(options);
    if (thinking) {
      args.push('--thinking', thinking);
    }

    if (options.sdkSessionId) {
      args.push('--session-id', options.sdkSessionId);
    }

    // Callers use allowedTools for summaries/read-only queries; an empty list
    // is an explicit denial, not permission to use the default toolset.
    const allowedTools = options.allowedTools ?? options.tools;
    if (allowedTools !== undefined) {
      const tools = mapToolNames(allowedTools);
      if (tools.length) args.push('--tools', tools.join(','));
      else args.push('--no-tools');
    }
    if (options.readOnly) {
      if (allowedTools === undefined) args.push('--tools', 'read,grep,find,ls');
      args.push('--exclude-tools', 'edit,write,bash');
    }

    // Non-interactive runs never show the project trust prompt. Automaker
    // operates on the user's own project, so trust project resources by default.
    if (process.env[PI_NO_PROJECT_TRUST_ENV] !== 'true') {
      args.push('--approve');
    }

    return args;
  }

  /**
   * Pass the prompt via stdin (Pi merges piped stdin into the initial prompt)
   * and inject the LiteLLM key that models.json references by env var.
   */
  protected buildSubprocessOptions(options: ExecuteOptions, cliArgs: string[]): SubprocessOptions {
    const subprocessOptions = super.buildSubprocessOptions(options, cliArgs);

    subprocessOptions.stdinData =
      typeof options.prompt === 'string'
        ? options.prompt
        : options.prompt
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text)
            .join('\n');

    const apiKey = resolveLitellmApiKey();
    if (apiKey) {
      subprocessOptions.env = {
        ...(subprocessOptions.env ?? {}),
        [PI_LITELLM_API_KEY_ENV]: apiKey,
      };
    }

    return subprocessOptions;
  }

  /**
   * Make sure Pi knows about the LiteLLM gateway before spawning it.
   */
  async *executeQuery(options: ExecuteOptions): AsyncGenerator<ProviderMessage> {
    try {
      await this.refreshModels();
    } catch (error) {
      piLogger.debug(`Skipping Pi model sync before run: ${error}`);
    }

    yield* super.executeQuery(options);
  }

  /**
   * Normalize a single Pi JSON event into ProviderMessage form.
   */
  normalizeEvent(event: unknown): ProviderMessage | null {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const piEvent = event as PiRawEvent;

    switch (piEvent.type) {
      case 'session': {
        const sessionId =
          typeof piEvent.id === 'string'
            ? piEvent.id
            : typeof piEvent.sessionId === 'string'
              ? piEvent.sessionId
              : undefined;
        if (sessionId) {
          this.currentSessionId = sessionId;
        }
        this.resetRunState();
        return null;
      }

      case 'message_start': {
        if (piEvent.message?.role === 'assistant') {
          this.sawTextDelta = false;
        }
        return null;
      }

      case 'message_update':
        return this.normalizeAssistantMessageEvent(piEvent.assistantMessageEvent);

      case 'tool_execution_start': {
        return this.emitToolUse(piEvent.toolCallId, piEvent.toolName, piEvent.args);
      }

      case 'tool_execution_end': {
        const content: ContentBlock[] = [
          {
            type: 'tool_result',
            tool_use_id: piEvent.toolCallId,
            content: stringifyToolResult(piEvent.result),
          },
        ];

        return {
          type: 'assistant',
          session_id: this.currentSessionId,
          message: { role: 'assistant', content },
        };
      }

      case 'message_end':
        return this.handleMessageEnd(piEvent.message);

      case 'agent_end': {
        const result = this.accumulatedText || extractTextFromMessages(piEvent.messages);
        if (this.runFailed) {
          return {
            type: 'result',
            subtype: 'error',
            session_id: this.currentSessionId,
            error: this.lastError || 'Pi agent failed',
            result,
          };
        }

        return {
          type: 'result',
          subtype: 'success',
          session_id: this.currentSessionId,
          result,
        };
      }

      case 'error': {
        const message = extractErrorMessage(piEvent.error);
        this.runFailed = true;
        this.lastError = message;
        return {
          type: 'error',
          session_id: this.currentSessionId,
          error: message,
        };
      }

      default:
        // turn_start/turn_end/compaction_*/queue_update/tool_execution_update and
        // any future event types are informational for now.
        return null;
    }
  }

  /**
   * Translate Pi's assistant streaming events (delta-only) into content blocks.
   */
  private normalizeAssistantMessageEvent(
    event: PiAssistantMessageEvent | undefined
  ): ProviderMessage | null {
    if (!event || typeof event.type !== 'string') {
      return null;
    }

    switch (event.type) {
      case 'text_delta': {
        if (!event.delta) return null;
        this.sawTextDelta = true;
        this.accumulatedText += event.delta;
        return this.assistantMessage([{ type: 'text', text: event.delta }]);
      }

      case 'thinking_delta': {
        if (!event.delta) return null;
        return this.assistantMessage([{ type: 'thinking', thinking: event.delta }]);
      }

      case 'toolcall_end': {
        const toolCall = event.toolCall;
        if (!toolCall?.id) return null;
        return this.emitToolUse(toolCall.id, toolCall.name, toolCall.arguments);
      }

      case 'error': {
        const message = extractErrorMessage(event.error);
        this.runFailed = true;
        this.lastError = message;
        return { type: 'error', session_id: this.currentSessionId, error: message };
      }

      default:
        // text_start/text_end/thinking_start/thinking_end/toolcall_start/
        // toolcall_delta/start/done carry no additional information we need.
        return null;
    }
  }

  /**
   * Emit the authoritative message_end payload: surface errors and fall back to
   * the full text when the provider did not stream deltas.
   */
  private handleMessageEnd(message: PiMessage | undefined): ProviderMessage | null {
    if (!message || message.role !== 'assistant') {
      return null;
    }

    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      const error = message.errorMessage || `Pi run stopped: ${message.stopReason}`;
      this.runFailed = true;
      this.lastError = error;
      return { type: 'error', session_id: this.currentSessionId, error };
    }

    if (!this.sawTextDelta) {
      const text = extractTextFromMessage(message);
      if (text) {
        this.accumulatedText += text;
        return this.assistantMessage([{ type: 'text', text }]);
      }
    }

    return null;
  }

  /**
   * Emit a tool_use block at most once per tool call id.
   */
  private emitToolUse(
    toolCallId: string | undefined,
    toolName: string | undefined,
    input: unknown
  ): ProviderMessage | null {
    const id = toolCallId || `pi-tool-${this.emittedToolCalls.size + 1}`;
    if (this.emittedToolCalls.has(id)) {
      return null;
    }
    this.emittedToolCalls.add(id);

    return this.assistantMessage([
      {
        type: 'tool_use',
        name: toolName || 'unknown',
        tool_use_id: id,
        input,
      },
    ]);
  }

  private assistantMessage(content: ContentBlock[]): ProviderMessage {
    return {
      type: 'assistant',
      session_id: this.currentSessionId,
      message: { role: 'assistant', content },
    };
  }

  /**
   * Reset per-run streaming state (called on each new session header).
   */
  private resetRunState(): void {
    this.sawTextDelta = false;
    this.accumulatedText = '';
    this.emittedToolCalls.clear();
    this.runFailed = false;
    this.lastError = undefined;
  }

  // ==========================================================================
  // Model discovery (LiteLLM-backed)
  // ==========================================================================

  /**
   * Synchronous model list accessor.
   *
   * Returns the cached LiteLLM list when available and kicks off a background
   * refresh otherwise, falling back to the static LiteLLM model set.
   */
  getAvailableModels(): ModelDefinition[] {
    if (sharedModels && Date.now() < sharedModelsExpiry) {
      return sharedModels;
    }

    if (sharedModels) {
      this.refreshModels().catch((error) => {
        piLogger.debug(`Background Pi model refresh failed: ${error}`);
      });
      return sharedModels;
    }

    this.refreshModels().catch((error) => {
      piLogger.debug(`Initial Pi model refresh failed: ${error}`);
    });

    return this.getFallbackModels();
  }

  /**
   * Static fallback list matching /etc/litellm/config.yaml.
   */
  getFallbackModels(): ModelDefinition[] {
    return PI_MODELS.map((config) => this.toModelDefinition(config.model));
  }

  /**
   * Refresh models from LiteLLM and sync Pi's models.json.
   */
  async refreshModels(): Promise<ModelDefinition[]> {
    if (sharedRefreshPromise) {
      return sharedRefreshPromise;
    }

    sharedRefreshPromise = this.doRefreshModels();
    try {
      return await sharedRefreshPromise;
    } finally {
      sharedRefreshPromise = null;
    }
  }

  private async doRefreshModels(): Promise<ModelDefinition[]> {
    try {
      const syncResult = await refreshPiLitellmProvider();
      const models = syncResult.modelIds.map((modelId) => this.toModelDefinition(modelId));
      if (models.length > 0) {
        sharedModels = models;
        sharedModelsExpiry = Date.now() + MODEL_CACHE_DURATION_MS;
        piLogger.debug(
          `Loaded ${models.length} Pi models from LiteLLM (${getPiModelsConfigPath()}${
            syncResult.updated ? ', updated' : ', unchanged'
          })`
        );
      }
      return sharedModels ?? this.getFallbackModels();
    } catch (error) {
      piLogger.debug(`LiteLLM model discovery failed: ${error}`);
      return sharedModels ?? this.getFallbackModels();
    }
  }

  private toModelDefinition(litellmModelId: string): ModelDefinition {
    const known = PI_MODELS.find((config) => config.model === litellmModelId);
    return {
      id: toPiModelId(litellmModelId),
      name: known?.label ?? litellmModelId,
      modelString: `${PI_LITELLM_PROVIDER_ID}/${litellmModelId}`,
      provider: 'pi',
      description: known?.description ?? `LiteLLM gateway model: ${litellmModelId}`,
      contextWindow: PI_MODEL_CONTEXT_WINDOW,
      maxOutputTokens: PI_MODEL_MAX_OUTPUT_TOKENS,
      supportsTools: true,
      supportsVision: known?.supportsVision ?? false,
      tier: known?.tier ?? 'standard',
      default: litellmModelId === 'worker',
    };
  }

  /** Clear the shared model cache, forcing a refresh on the next access. */
  clearModelCache(): void {
    resetSharedModelCache();
  }

  hasCachedModels(): boolean {
    return sharedModels !== null && sharedModels.length > 0;
  }

  // ==========================================================================
  // Feature support / installation
  // ==========================================================================

  supportsFeature(feature: string): boolean {
    return ['tools', 'text'].includes(feature);
  }

  /**
   * Pi is usable when the CLI is installed and the LiteLLM gateway can serve
   * models (the gateway is the only backend configured here).
   */
  async checkAuth(): Promise<{ authenticated: boolean; hasApiKey: boolean }> {
    const hasApiKey = Boolean(resolveLitellmApiKey());

    try {
      const models = await this.refreshModels();
      return { authenticated: models.length > 0, hasApiKey };
    } catch {
      return { authenticated: false, hasApiKey };
    }
  }

  private async getVersion(): Promise<string | undefined> {
    try {
      const command = this.detectedStrategy === 'npx' ? 'npx' : this.cliPath;
      if (!command) return undefined;

      const args =
        this.detectedStrategy === 'npx'
          ? ['@earendil-works/pi-coding-agent@latest', '--version']
          : ['--version'];

      const { stdout } = await execFileAsync(command, args, {
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true,
      });
      return stdout.trim().split('\n')[0] || undefined;
    } catch {
      return undefined;
    }
  }

  async detectInstallation(): Promise<InstallationStatus> {
    this.ensureCliDetected();

    const installed = await this.isInstalled();
    const version = installed ? await this.getVersion() : undefined;
    const auth = installed
      ? await this.checkAuth()
      : { authenticated: false, hasApiKey: Boolean(resolveLitellmApiKey()) };

    return {
      installed,
      path: this.cliPath || undefined,
      version,
      method: this.detectedStrategy === 'npx' ? 'npm' : 'cli',
      authenticated: auth.authenticated,
      hasApiKey: auth.hasApiKey,
      hasOAuthToken: fs.existsSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json')),
    };
  }
}
