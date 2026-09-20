#!/usr/bin/env node

/**
 * Sync the local LiteLLM gateway's models into the OpenCode CLI config.
 *
 * OpenCode only knows the models declared under `provider.litellm.models` in
 * `~/.config/opencode/opencode.jsonc`, so `opencode:litellm/worker` fails
 * unless `worker` (and friends) are listed there. This script merges the
 * gateway's `/v1/models` response into that file, keeping every other provider
 * and every existing model entry untouched.
 *
 * Usage:
 *   node scripts/init-opencode-litellm-models.mjs [--dry-run] [--config <path>]
 *
 * Environment:
 *   AUTOMAKER_LITELLM_BASE_URL  Gateway base URL (default http://127.0.0.1:4000/v1)
 *   LITELLM_MASTER_KEY          Gateway key (falls back to /etc/litellm/litellm.env)
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DEFAULT_CONFIG = join(homedir(), '.config', 'opencode', 'opencode.jsonc');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4000/v1';
const LITELLM_ENV_FILE = '/etc/litellm/litellm.env';
const API_KEY_ENV = 'LITELLM_MASTER_KEY';
const PROVIDER_ID = 'litellm';

// Aliases the gateway routes but does not always advertise in /v1/models.
const ALIAS_MODELS = ['auto', 'leader', 'worker'];

const KNOWN_LABELS = {
  auto: 'Auto (LiteLLM)',
  leader: 'Leader (LiteLLM)',
  worker: 'Worker (LiteLLM)',
  'kimi-k3': 'Kimi K3',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-flash': 'DeepSeek Flash',
  'glm-5.3': 'GLM 5.3',
  'glm-5.3-flash': 'GLM 5.3 Flash',
};

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--config') options.configPath = argv[++i];
    else if (arg === '--base-url') options.baseUrl = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function normalizeBaseUrl(value) {
  const trimmed = (value || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function resolveApiKey() {
  if (process.env[API_KEY_ENV]) return process.env[API_KEY_ENV];
  try {
    const line = readFileSync(LITELLM_ENV_FILE, 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${API_KEY_ENV}=`));
    if (line) return line.slice(line.indexOf('=') + 1).trim();
  } catch {
    // fall through
  }
  return undefined;
}

async function fetchModelIds(baseUrl, apiKey) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`GET ${baseUrl}/models failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const ids = (payload.data ?? [])
    .map((entry) => entry?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  const configPath = options.configPath ?? process.env.OPENCODE_CONFIG ?? DEFAULT_CONFIG;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.AUTOMAKER_LITELLM_BASE_URL);
  const apiKey = resolveApiKey();

  const gatewayModels = await fetchModelIds(baseUrl, apiKey);
  const modelIds = [...ALIAS_MODELS.filter((id) => !gatewayModels.includes(id)), ...gatewayModels];
  if (modelIds.length === 0) {
    throw new Error('Gateway returned no models; refusing to rewrite the OpenCode config');
  }

  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const providers = config.provider ?? {};
  const existing = providers[PROVIDER_ID] ?? {};
  const existingModels = existing.models ?? {};
  const baseURL = (existing.options ?? {}).baseURL ?? baseUrl;
  const key = (existing.options ?? {}).apiKey ?? `$${API_KEY_ENV}`;

  const models = { ...existingModels };
  for (const id of modelIds) {
    models[id] = { name: KNOWN_LABELS[id] ?? id, ...(existingModels[id] ?? {}) };
  }

  const next = {
    ...config,
    provider: {
      ...providers,
      [PROVIDER_ID]: {
        ...existing,
        npm: existing.npm ?? '@ai-sdk/openai-compatible',
        name: existing.name ?? 'LiteLLM (local)',
        options: { ...(existing.options ?? {}), baseURL, apiKey: key },
        models,
      },
    },
  };

  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const previous = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

  console.log(`[opencode-litellm] ${configPath}`);
  console.log(`[opencode-litellm] ${modelIds.length} models: ${modelIds.join(', ')}`);

  if (previous === serialized) {
    console.log('[opencode-litellm] already up to date');
    return;
  }
  if (options.dryRun) {
    console.log('[opencode-litellm] dry run - file not modified');
    return;
  }

  if (previous) {
    const backup = `${configPath}.bak`;
    copyFileSync(configPath, backup);
    console.log(`[opencode-litellm] backup: ${backup}`);
  }
  writeFileSync(configPath, serialized, { encoding: 'utf8', mode: 0o600 });
  console.log('[opencode-litellm] written');
}

main().catch((error) => {
  console.error(`[opencode-litellm] Failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
