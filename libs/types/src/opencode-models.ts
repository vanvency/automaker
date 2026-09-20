/**
 * OpenCode Model IDs
 * Models available via OpenCode CLI (opencode models command)
 *
 * All OpenCode model IDs use the `agent:model` form with an `opencode:` prefix,
 * e.g. `opencode:litellm/auto` (agent = opencode CLI, model = litellm/auto).
 * The legacy dash form (`opencode-litellm/auto`) and slash form
 * (`opencode/big-pickle`) are still parsed and migrated.
 */
export type OpencodeModelId =
  // OpenCode Free Tier Models
  | 'opencode:big-pickle'
  | 'opencode:glm-5-free'
  | 'opencode:gpt-5-nano'
  | 'opencode:kimi-k2.5-free'
  | 'opencode:minimax-m2.5-free'
  // Local LiteLLM gateway (OpenCode provider id 'litellm')
  | 'opencode:litellm/auto';

/** Canonical OpenCode prefix (`agent:model`) */
export const OPENCODE_MODEL_PREFIX = 'opencode:';

/** Legacy dash prefix, kept for parsing/migration only */
export const LEGACY_OPENCODE_MODEL_PREFIX = 'opencode-';

/**
 * Legacy OpenCode model IDs (with slash format) for migration support
 * Includes both current and previously-available models for backward compatibility.
 */
export type LegacyOpencodeModelId =
  | 'opencode/big-pickle'
  | 'opencode/glm-5-free'
  | 'opencode/gpt-5-nano'
  | 'opencode/kimi-k2.5-free'
  | 'opencode/minimax-m2.5-free'
  // Retired models (kept for migration from older settings)
  | 'opencode/glm-4.7-free'
  | 'opencode/grok-code'
  | 'opencode/minimax-m2.1-free';

/**
 * Provider type for OpenCode models
 */
export type OpencodeProvider = 'opencode';

/**
 * Friendly aliases mapped to full model IDs
 */
export const OPENCODE_MODEL_MAP: Record<string, OpencodeModelId> = {
  // OpenCode free tier aliases
  'big-pickle': 'opencode:big-pickle',
  pickle: 'opencode:big-pickle',
  'glm-free': 'opencode:glm-5-free',
  'glm-5': 'opencode:glm-5-free',
  'gpt-nano': 'opencode:gpt-5-nano',
  nano: 'opencode:gpt-5-nano',
  'kimi-free': 'opencode:kimi-k2.5-free',
  kimi: 'opencode:kimi-k2.5-free',
  minimax: 'opencode:minimax-m2.5-free',
} as const;

/**
 * Map from legacy slash-format model IDs to canonical prefixed IDs.
 * Retired models are mapped to their closest replacement.
 */
export const LEGACY_OPENCODE_MODEL_MAP: Record<LegacyOpencodeModelId, OpencodeModelId> = {
  // Current models
  'opencode/big-pickle': 'opencode:big-pickle',
  'opencode/glm-5-free': 'opencode:glm-5-free',
  'opencode/gpt-5-nano': 'opencode:gpt-5-nano',
  'opencode/kimi-k2.5-free': 'opencode:kimi-k2.5-free',
  'opencode/minimax-m2.5-free': 'opencode:minimax-m2.5-free',
  // Retired models → mapped to replacements
  'opencode/glm-4.7-free': 'opencode:glm-5-free',
  'opencode/grok-code': 'opencode:big-pickle', // grok-code retired, fallback to default
  'opencode/minimax-m2.1-free': 'opencode:minimax-m2.5-free',
};

/**
 * Map from retired canonical (dash-format) model IDs to their replacements.
 * Used to migrate settings that reference models no longer available.
 */
export const RETIRED_OPENCODE_MODEL_MAP: Record<string, OpencodeModelId> = {
  'opencode-glm-4.7-free': 'opencode:glm-5-free',
  'opencode-grok-code': 'opencode:big-pickle',
  'opencode-minimax-m2.1-free': 'opencode:minimax-m2.5-free',
};

/**
 * Map from the pre-rename dash-format canonical IDs (`opencode-litellm/auto`,
 * `opencode-big-pickle`, ...) to the current `agent:model` form.
 */
export const LEGACY_OPENCODE_DASH_MODEL_MAP: Record<string, OpencodeModelId> = {
  'opencode-litellm/auto': 'opencode:litellm/auto',
  'opencode-big-pickle': 'opencode:big-pickle',
  'opencode-glm-5-free': 'opencode:glm-5-free',
  'opencode-gpt-5-nano': 'opencode:gpt-5-nano',
  'opencode-kimi-k2.5-free': 'opencode:kimi-k2.5-free',
  'opencode-minimax-m2.5-free': 'opencode:minimax-m2.5-free',
};

/**
 * OpenCode model metadata
 */
export interface OpencodeModelConfig {
  id: OpencodeModelId;
  label: string;
  description: string;
  supportsVision: boolean;
  provider: OpencodeProvider;
  tier: 'free' | 'standard' | 'premium';
}

/**
 * Complete list of OpenCode model configurations
 * All IDs use 'opencode-' prefix for consistent provider routing.
 */
export const OPENCODE_MODELS: OpencodeModelConfig[] = [
  // Local LiteLLM gateway (see /etc/litellm/config.yaml). Listed first so the
  // pickers fall back to it, but DEFAULT_OPENCODE_MODEL stays the free tier:
  // change both if dispatched work should default to the gateway.
  {
    id: 'opencode:litellm/auto',
    label: 'Auto',
    description: 'LiteLLM gateway: Kimi K3, falls back to DeepSeek Flash',
    supportsVision: false,
    provider: 'opencode',
    tier: 'standard',
  },
  // OpenCode Free Tier Models
  {
    id: 'opencode:big-pickle',
    label: 'Big Pickle',
    description: 'OpenCode free tier model - great for general coding',
    supportsVision: false,
    provider: 'opencode',
    tier: 'free',
  },
  {
    id: 'opencode:glm-5-free',
    label: 'GLM 5 Free',
    description: 'OpenCode free tier GLM model',
    supportsVision: false,
    provider: 'opencode',
    tier: 'free',
  },
  {
    id: 'opencode:gpt-5-nano',
    label: 'GPT-5 Nano',
    description: 'OpenCode free tier nano model - fast and lightweight',
    supportsVision: false,
    provider: 'opencode',
    tier: 'free',
  },
  {
    id: 'opencode:kimi-k2.5-free',
    label: 'Kimi K2.5 Free',
    description: 'OpenCode free tier Kimi model for coding',
    supportsVision: false,
    provider: 'opencode',
    tier: 'free',
  },
  {
    id: 'opencode:minimax-m2.5-free',
    label: 'MiniMax M2.5 Free',
    description: 'OpenCode free tier MiniMax model',
    supportsVision: false,
    provider: 'opencode',
    tier: 'free',
  },
];

/**
 * Complete model configuration map indexed by model ID
 */
export const OPENCODE_MODEL_CONFIG_MAP: Record<OpencodeModelId, OpencodeModelConfig> =
  OPENCODE_MODELS.reduce(
    (acc, config) => {
      acc[config.id] = config;
      return acc;
    },
    {} as Record<OpencodeModelId, OpencodeModelConfig>
  );

/**
 * Default OpenCode model - OpenCode free tier
 */
export const DEFAULT_OPENCODE_MODEL: OpencodeModelId = 'opencode:big-pickle';

/**
 * Helper: Get display name for model
 */
export function getOpencodeModelLabel(modelId: OpencodeModelId): string {
  return OPENCODE_MODEL_CONFIG_MAP[modelId]?.label ?? modelId;
}

/**
 * Helper: Get all OpenCode model IDs
 */
export function getAllOpencodeModelIds(): OpencodeModelId[] {
  return OPENCODE_MODELS.map((config) => config.id);
}

/**
 * Helper: Check if OpenCode model supports vision
 */
export function opencodeModelSupportsVision(modelId: OpencodeModelId): boolean {
  return OPENCODE_MODEL_CONFIG_MAP[modelId]?.supportsVision ?? false;
}

/**
 * Helper: Get the provider for a model
 */
export function getOpencodeModelProvider(modelId: OpencodeModelId): OpencodeProvider {
  return OPENCODE_MODEL_CONFIG_MAP[modelId]?.provider ?? 'opencode';
}

/**
 * Helper: Resolve an alias or partial model ID to a full model ID.
 * Also handles retired model IDs by mapping them to their replacements.
 */
export function resolveOpencodeModelId(input: string): OpencodeModelId | undefined {
  // Check if it's already a valid model ID
  if (OPENCODE_MODEL_CONFIG_MAP[input as OpencodeModelId]) {
    return input as OpencodeModelId;
  }

  // Pre-rename dash form (opencode-litellm/auto -> opencode:litellm/auto)
  if (input in LEGACY_OPENCODE_DASH_MODEL_MAP) {
    return LEGACY_OPENCODE_DASH_MODEL_MAP[input];
  }

  // Check retired model map (handles old canonical IDs like 'opencode-grok-code')
  if (input in RETIRED_OPENCODE_MODEL_MAP) {
    return RETIRED_OPENCODE_MODEL_MAP[input];
  }

  // Check alias map
  const normalized = input.toLowerCase();
  return OPENCODE_MODEL_MAP[normalized];
}

/**
 * Helper: Check if a string is a valid OpenCode model ID
 */
export function isOpencodeModelId(value: string): value is OpencodeModelId {
  return value in OPENCODE_MODEL_CONFIG_MAP;
}

/**
 * Helper: Get models filtered by provider
 */
export function getOpencodeModelsByProvider(provider: OpencodeProvider): OpencodeModelConfig[] {
  return OPENCODE_MODELS.filter((config) => config.provider === provider);
}

/**
 * Helper: Get models filtered by tier
 */
export function getOpencodeModelsByTier(
  tier: 'free' | 'standard' | 'premium'
): OpencodeModelConfig[] {
  return OPENCODE_MODELS.filter((config) => config.tier === tier);
}

/**
 * Helper: Get free tier models
 */
export function getOpencodeFreeModels(): OpencodeModelConfig[] {
  return getOpencodeModelsByTier('free');
}
