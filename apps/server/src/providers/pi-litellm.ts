/**
 * LiteLLM bridge for the Pi provider
 *
 * Pi learns about non-native providers through `~/.pi/agent/models.json`. The
 * local LiteLLM gateway already knows which models exist, so this module:
 *
 * 1. Resolves the gateway base URL / API key (env vars, then the local
 *    `/etc/litellm/litellm.env` file that the gateway itself uses).
 * 2. Fetches the model list from the OpenAI-compatible `/v1/models` endpoint.
 * 3. Writes a `litellm` provider block into Pi's `models.json`, preserving any
 *    other providers the user configured.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PI_MODEL_CONTEXT_WINDOW,
  PI_MODEL_MAX_OUTPUT_TOKENS,
  PI_LITELLM_API_KEY_ENV,
  PI_LITELLM_BASE_URL_ENV,
  PI_LITELLM_DEFAULT_BASE_URL,
  PI_LITELLM_PROVIDER_ID,
  PI_MODELS,
  createPiModelId,
} from '@automaker/types';
import { createLogger } from '@automaker/utils';

const litellmLogger = createLogger('PiLitellm');

/** Fallback location of the LiteLLM gateway credentials on this host */
const LITELLM_ENV_FILE = '/etc/litellm/litellm.env';

/** Timeout for gateway requests */
const LITELLM_REQUEST_TIMEOUT_MS = 5000;

/**
 * LiteLLM alias/model groups that must always be present in Pi's model list.
 *
 * The gateway routes these groups (auto -> leader -> provider fallbacks) but it
 * does not advertise every alias in `/v1/models`. Without an exact entry Pi
 * fuzzy-matches the pattern against the closest id it knows - e.g. "auto"
 * matched the unrelated "ark/auto" group, which the upstream rejects.
 */
export const PI_LITELLM_ALIAS_MODELS = ['auto', 'leader', 'worker'] as const;

/**
 * Pi's per-user agent directory.
 */
export function getPiAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}

/**
 * Path to Pi's custom model/provider configuration.
 */
export function getPiModelsConfigPath(): string {
  return path.join(getPiAgentDir(), 'models.json');
}

/**
 * Resolve the LiteLLM gateway base URL.
 *
 * Order: AUTOMAKER_LITELLM_BASE_URL > LITELLM_BASE_URL > built-in default.
 */
export function resolveLitellmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[PI_LITELLM_BASE_URL_ENV] || env.LITELLM_BASE_URL;
  if (!configured) {
    return PI_LITELLM_DEFAULT_BASE_URL;
  }
  // Accept both "http://host:port" and "http://host:port/v1"
  const trimmed = configured.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * Read key/value pairs from the LiteLLM systemd env file.
 */
function readLitellmEnvFile(): Record<string, string> {
  try {
    if (!fs.existsSync(LITELLM_ENV_FILE)) {
      return {};
    }

    const values: Record<string, string> = {};
    for (const rawLine of fs.readFileSync(LITELLM_ENV_FILE, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const separator = line.indexOf('=');
      if (separator <= 0) continue;

      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key && value) {
        values[key] = value;
      }
    }
    return values;
  } catch (error) {
    litellmLogger.debug(`Could not read ${LITELLM_ENV_FILE}: ${error}`);
    return {};
  }
}

/**
 * Resolve the LiteLLM master key.
 *
 * Order: process env > LiteLLM env file > OpenCode's local provider config
 * (the gateway is already registered there on this machine).
 */
export function resolveLitellmApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[PI_LITELLM_API_KEY_ENV] || env.LITELLM_API_KEY;
  if (fromEnv) return fromEnv;

  const fromFile = readLitellmEnvFile()[PI_LITELLM_API_KEY_ENV];
  if (fromFile) return fromFile;

  // Last resort: reuse the key OpenCode was configured with.
  try {
    for (const candidate of [
      path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
      path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    ]) {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, 'utf8');
      const match = content.match(
        /"baseURL"\s*:\s*"([^"]+)"[\s\S]{0,400}?"apiKey"\s*:\s*"([^"]+)"/
      );
      if (match?.[2]) {
        return match[2];
      }
    }
  } catch (error) {
    litellmLogger.debug(`Could not read OpenCode provider config: ${error}`);
  }

  return undefined;
}

export interface FetchLitellmModelsOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch model IDs from the LiteLLM gateway's OpenAI-compatible `/models` endpoint.
 */
export async function fetchLitellmModelIds(
  options: FetchLitellmModelsOptions = {}
): Promise<string[]> {
  const baseUrl = (options.baseUrl ?? resolveLitellmBaseUrl()).replace(/\/+$/, '');
  const apiKey = options.apiKey ?? resolveLitellmApiKey();
  const fetchImpl = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? LITELLM_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`LiteLLM /models returned ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (payload.data ?? [])
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return Array.from(new Set(ids)).sort();
}

/** Shape of the subset of Pi's models.json that we manage */
interface PiModelsConfig {
  providers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Read Pi's models.json, returning an empty config when it is missing/invalid.
 */
export function readPiModelsConfig(configPath = getPiModelsConfigPath()): PiModelsConfig {
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PiModelsConfig;
    }
    litellmLogger.debug(`Ignoring non-object Pi models config at ${configPath}`);
    return {};
  } catch (error) {
    litellmLogger.debug(`Could not parse Pi models config at ${configPath}: ${error}`);
    return {};
  }
}

/**
 * Whether the config file exists but cannot be read back as a JSON object.
 *
 * Such a file is never overwritten in place: it may hold hand-written providers
 * that a syntax error only temporarily hides, so it is moved aside first.
 */
function piModelsConfigIsUnreadable(configPath: string): boolean {
  try {
    if (!fs.existsSync(configPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    return !(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

export interface SyncPiLitellmResult {
  /** Path of the written models.json */
  configPath: string;
  /** Model IDs registered with Pi (bare LiteLLM names) */
  modelIds: string[];
  /** Whether the config file changed */
  updated: boolean;
}

/**
 * Register/refresh the LiteLLM provider in Pi's models.json.
 *
 * The model list always comes from the gateway itself, so a model added to
 * `/etc/litellm/config.yaml` shows up in Pi after a refresh.
 */
export function syncPiLitellmProvider(
  modelIds: string[],
  options: { configPath?: string; apiKey?: string } = {}
): SyncPiLitellmResult {
  const configPath = options.configPath ?? getPiModelsConfigPath();
  const apiKey = options.apiKey ?? resolveLitellmApiKey();
  const baseUrl = resolveLitellmBaseUrl();

  const knownLabels = new Map(PI_MODELS.map((config) => [config.model, config.label]));

  // Keep the routing aliases first and guaranteed: Pi matches model patterns
  // against this list, so an entry has to exist even when the gateway's
  // /v1/models response omits the alias.
  const aliasModels = PI_LITELLM_ALIAS_MODELS.filter((id) => !modelIds.includes(id));
  const effectiveModelIds = [...aliasModels, ...modelIds];

  const providerConfig = {
    name: 'LiteLLM (local)',
    baseUrl,
    api: 'openai-completions',
    // The key is injected into the Pi subprocess env by PiProvider; on disk we
    // only keep the env reference so the secret stays out of the config file.
    apiKey: `$${PI_LITELLM_API_KEY_ENV}`,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    // An unknown label stays undefined so JSON.stringify drops the key.
    // Pi defaults an undeclared context window/output cap to 128k/16k, so both
    // are always stated.
    models: effectiveModelIds.map((id) => ({
      id,
      name: knownLabels.get(id),
      contextWindow: PI_MODEL_CONTEXT_WINDOW,
      maxTokens: PI_MODEL_MAX_OUTPUT_TOKENS,
    })),
  };

  const existing = readPiModelsConfig(configPath);

  const next: PiModelsConfig = {
    ...existing,
    providers: {
      ...(existing.providers ?? {}),
      [PI_LITELLM_PROVIDER_ID]: providerConfig,
    },
  };

  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const updated = previous !== serialized;

  if (updated) {
    if (piModelsConfigIsUnreadable(configPath)) {
      const backupPath = `${configPath}.invalid-${Date.now()}`;
      try {
        fs.renameSync(configPath, backupPath);
        litellmLogger.warn(
          `Pi models config at ${configPath} was unreadable; kept a copy at ${backupPath}`
        );
      } catch (error) {
        litellmLogger.warn(`Could not back up the unreadable Pi models config: ${error}`);
      }
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, serialized, { encoding: 'utf8', mode: 0o600 });
    litellmLogger.debug(
      `Wrote ${effectiveModelIds.length} LiteLLM models to ${configPath} (apiKey: ${
        apiKey ? 'resolved' : 'unresolved'
      })`
    );
  }

  return { configPath, modelIds: effectiveModelIds, updated };
}

/**
 * Fetch the gateway model list and write it into Pi's models.json.
 */
export async function refreshPiLitellmProvider(
  options: FetchLitellmModelsOptions & { configPath?: string } = {}
): Promise<SyncPiLitellmResult> {
  const modelIds = await fetchLitellmModelIds(options);
  const effectiveModelIds =
    modelIds.length > 0 ? modelIds : PI_MODELS.map((config) => config.model);
  return syncPiLitellmProvider(effectiveModelIds, {
    configPath: options.configPath,
    apiKey: options.apiKey,
  });
}

/**
 * Build the canonical Pi model ID for a LiteLLM model name.
 */
export function toPiModelId(litellmModelId: string): string {
  return createPiModelId(litellmModelId, PI_LITELLM_PROVIDER_ID);
}
