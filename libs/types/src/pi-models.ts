/**
 * Pi model IDs
 *
 * Pi (the `pi` coding agent CLI) is wired to the local LiteLLM gateway, so its
 * canonical model IDs are `agent:provider/model`, e.g. `pi:litellm/auto`.
 *
 * The legacy dash form (`pi:litellm/auto`) is still parsed and migrated so that
 * settings written before the rename keep working.
 *
 * The static list below mirrors the LiteLLM `model_list` entries that matter for
 * coding work. It doubles as the fallback whenever the gateway is unreachable;
 * the live list is discovered from LiteLLM's OpenAI-compatible `/v1/models`.
 */

/** Canonical prefix used to route model IDs to the Pi provider (`agent:model`) */
export const PI_MODEL_PREFIX = 'pi:';

/** Legacy dash prefix, kept for parsing/migration only */
export const LEGACY_PI_MODEL_PREFIX = 'pi-';

/** LiteLLM provider id used inside Pi (`--provider litellm`) */
export const PI_LITELLM_PROVIDER_ID = 'litellm';

/**
 * Context window declared for every Pi model.
 *
 * The LiteLLM gateway serves all of its model groups with a 1M-token context
 * window. Pi's own default for a custom provider model that does not declare
 * one is 128k, so this has to be written into `~/.pi/agent/models.json`
 * explicitly - otherwise the CLI compacts and reports context usage against
 * 128k even though the model can take 1M.
 */
export const PI_MODEL_CONTEXT_WINDOW = 1_000_000;

/**
 * Max output tokens requested for every Pi model.
 *
 * Pi's own default for a custom provider model is 16k. The gateway models can
 * return much more, and Pi clamps the request to what is left of the context
 * window anyway, so a generous value is safe for every model.
 */
export const PI_MODEL_MAX_OUTPUT_TOKENS = 64_000;

/** Default LiteLLM gateway base URL (OpenAI-compatible `/v1` path included) */
export const PI_LITELLM_DEFAULT_BASE_URL = 'http://127.0.0.1:4000/v1';

/** Environment variable that overrides the LiteLLM base URL */
export const PI_LITELLM_BASE_URL_ENV = 'AUTOMAKER_LITELLM_BASE_URL';

/** Environment variable that overrides the LiteLLM API key */
export const PI_LITELLM_API_KEY_ENV = 'LITELLM_MASTER_KEY';

/**
 * Pi model identifier, always prefixed so the provider factory can route it.
 * Example: `pi:litellm/auto`
 */
export type PiModelId = `pi:${string}/${string}` | `pi-${string}/${string}`;

/** Provider identifier for Pi models */
export type PiProvider = 'pi';

/**
 * Pi model metadata
 */
export interface PiModelConfig {
  /** Canonical model ID (e.g. "pi:litellm/auto") */
  id: PiModelId;
  /** Upstream provider inside Pi (e.g. "litellm") */
  upstreamProvider: string;
  /** Model name passed to the upstream provider (e.g. "auto") */
  model: string;
  /** Display label for the UI */
  label: string;
  /** Description shown in model pickers */
  description: string;
  /** Whether the model accepts image input */
  supportsVision: boolean;
  /** Rough cost/capability tier (matches ModelDefinition) */
  tier: 'basic' | 'standard' | 'premium';
}

/**
 * Static Pi model list.
 *
 * Keep this in sync with `/etc/litellm/config.yaml`; entries beyond this list are
 * still discovered dynamically from the gateway.
 */
export const PI_MODELS: PiModelConfig[] = [
  {
    id: 'pi:litellm/auto',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'auto',
    label: 'Auto (LiteLLM)',
    description: 'LiteLLM auto route - general purpose work with automatic failover',
    supportsVision: false,
    tier: 'standard',
  },
  {
    id: 'pi:litellm/leader',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'leader',
    label: 'Leader (LiteLLM)',
    description: 'LiteLLM leader chain - planning and coordination',
    supportsVision: false,
    tier: 'standard',
  },
  {
    id: 'pi:litellm/worker',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'worker',
    label: 'Worker (LiteLLM)',
    description: 'LiteLLM worker chain - implements the actual coding work',
    supportsVision: false,
    tier: 'standard',
  },
  {
    id: 'pi:litellm/deepseek-flash',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'deepseek-flash',
    label: 'DeepSeek Flash',
    description: 'LiteLLM gateway: DeepSeek Flash (fast)',
    supportsVision: false,
    tier: 'standard',
  },
  {
    id: 'pi:litellm/deepseek-v4-pro',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'LiteLLM gateway: DeepSeek V4 Pro',
    supportsVision: false,
    tier: 'standard',
  },
  {
    id: 'pi:litellm/kimi-k3',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'kimi-k3',
    label: 'Kimi K3',
    description: 'LiteLLM gateway: Kimi K3',
    supportsVision: false,
    tier: 'standard',
  },
  {
    id: 'pi:litellm/minimax-m3',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'minimax-m3',
    label: 'MiniMax M3',
    description: 'LiteLLM gateway: MiniMax M3',
    supportsVision: false,
    tier: 'standard',
  },
  {
    id: 'pi:litellm/glm-5.3',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'glm-5.3',
    label: 'GLM 5.3',
    description: 'LiteLLM gateway: GLM 5.3',
    supportsVision: false,
    tier: 'standard',
  },
  {
    id: 'pi:litellm/glm-5.3-flash',
    upstreamProvider: PI_LITELLM_PROVIDER_ID,
    model: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    description: 'LiteLLM gateway: GLM 5.3 Flash (fast)',
    supportsVision: false,
    tier: 'standard',
  },
];

/**
 * Default Pi model - the LiteLLM "worker" chain, which is the group that
 * implements coding tasks (leader plans, auto covers general calls).
 */
export const DEFAULT_PI_MODEL: PiModelId = 'pi:litellm/worker';

/** Friendly aliases mapped to full canonical model IDs */
export const PI_MODEL_MAP: Record<string, PiModelId> = {
  auto: 'pi:litellm/auto',
  'pi-auto': 'pi:litellm/auto',
  'litellm/auto': 'pi:litellm/auto',
  leader: 'pi:litellm/leader',
  worker: 'pi:litellm/worker',
  kimi: 'pi:litellm/kimi-k3',
  'kimi-k3': 'pi:litellm/kimi-k3',
  'deepseek-pro': 'pi:litellm/deepseek-v4-pro',
  'deepseek-flash': 'pi:litellm/deepseek-flash',
  minimax: 'pi:litellm/minimax-m3',
  'glm-5.3': 'pi:litellm/glm-5.3',
  'glm-5.3-flash': 'pi:litellm/glm-5.3-flash',
} as const;

/**
 * Build a canonical Pi model ID from an upstream provider and model name.
 */
export function createPiModelId(
  model: string,
  upstreamProvider: string = PI_LITELLM_PROVIDER_ID
): PiModelId {
  const normalizedModel = model.startsWith(`${upstreamProvider}/`)
    ? model.slice(upstreamProvider.length + 1)
    : model;
  return `${PI_MODEL_PREFIX}${upstreamProvider}/${normalizedModel}` as PiModelId;
}

/**
 * Split a canonical Pi model ID into its upstream provider and model name.
 *
 * @example
 * parsePiModelId('pi:litellm/auto')
 */
export function parsePiModelId(
  modelId: string | undefined | null
): { upstreamProvider: string; model: string; legacy: boolean } | null {
  if (!modelId) {
    return null;
  }

  // Canonical `pi:` form wins; the dash form is accepted for data written
  // before the rename and normalized by the migration helpers.
  const legacy = modelId.startsWith(LEGACY_PI_MODEL_PREFIX);
  const prefix = legacy ? LEGACY_PI_MODEL_PREFIX : PI_MODEL_PREFIX;
  if (!legacy && !modelId.startsWith(prefix)) {
    return null;
  }

  const withoutPrefix = modelId.slice(prefix.length);
  const slashIndex = withoutPrefix.indexOf('/');
  if (slashIndex <= 0 || slashIndex === withoutPrefix.length - 1) {
    return null;
  }

  return {
    upstreamProvider: withoutPrefix.slice(0, slashIndex),
    model: withoutPrefix.slice(slashIndex + 1),
    legacy,
  };
}

/**
 * Check whether a string is a canonical Pi model ID.
 */
export function isPiModelId(value: string | undefined | null): boolean {
  return parsePiModelId(value) !== null;
}

/**
 * Get all statically configured Pi model IDs.
 */
export function getAllPiModelIds(): PiModelId[] {
  return PI_MODELS.map((config) => config.id);
}

/**
 * Get the display label for a Pi model ID.
 */
export function getPiModelLabel(modelId: string): string {
  const known = PI_MODELS.find((config) => config.id === modelId);
  if (known) {
    return known.label;
  }

  const parsed = parsePiModelId(modelId);
  return parsed ? parsed.model : modelId;
}

/**
 * Resolve an alias or partial model ID to a canonical Pi model ID.
 */
export function resolvePiModelId(input: string): PiModelId | undefined {
  if (isPiModelId(input)) {
    return input as PiModelId;
  }
  return PI_MODEL_MAP[input.toLowerCase()];
}
