#!/usr/bin/env node

/**
 * Initialize the `pi` coding agent's model list from the local LiteLLM gateway.
 *
 * Pi discovers custom providers through `~/.pi/agent/models.json`. This script
 * fetches the gateway's OpenAI-compatible `/v1/models` response and writes (or
 * refreshes) the `litellm` provider block, leaving any other providers intact.
 *
 * Usage:
 *   node scripts/init-pi-litellm-models.mjs [--dry-run] [--stdout]
 *   node scripts/init-pi-litellm-models.mjs --base-url http://127.0.0.1:4000/v1 --api-key sk-...
 *
 * Environment:
 *   AUTOMAKER_LITELLM_BASE_URL  Gateway base URL      (default http://127.0.0.1:4000/v1)
 *   LITELLM_MASTER_KEY          Gateway master key    (falls back to /etc/litellm/litellm.env)
 *   PI_MODELS_CONFIG            Target models.json    (default ~/.pi/agent/models.json)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4000/v1';
const LITELLM_ENV_FILE = '/etc/litellm/litellm.env';
const PROVIDER_ID = 'litellm';
const API_KEY_ENV = 'LITELLM_MASTER_KEY';

// Every gateway model is served with a 1M-token context window. Pi falls back
// to 128k for a model that does not declare one, so each entry states it.
const CONTEXT_WINDOW = 1000000;

// Pi's default max output is 16k; the gateway models can return more.
const MAX_OUTPUT_TOKENS = 64000;

// LiteLLM routes these alias groups but does not advertise every one of them in
// /v1/models. Pi matches model patterns against the list below, so an alias has
// to be present or the pattern fuzzy-matches an unrelated id ("auto" ->
// "ark/auto", which the upstream rejects).
const ALIAS_MODELS = ['auto', 'leader', 'worker'];

function parseArgs(argv) {
  const options = { dryRun: false, stdout: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--stdout') options.stdout = true;
    else if (arg === '--base-url') options.baseUrl = argv[++i];
    else if (arg === '--api-key') options.apiKey = argv[++i];
    else if (arg === '--config') options.configPath = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function normalizeBaseUrl(value) {
  const trimmed = (value || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function readLitellmEnvFile() {
  try {
    if (!existsSync(LITELLM_ENV_FILE)) return {};
    const values = {};
    for (const rawLine of readFileSync(LITELLM_ENV_FILE, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key && value) values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function resolveApiKey(options) {
  if (options.apiKey) return options.apiKey;
  if (process.env[API_KEY_ENV]) return process.env[API_KEY_ENV];
  if (process.env.LITELLM_API_KEY) return process.env.LITELLM_API_KEY;

  const fromFile = readLitellmEnvFile()[API_KEY_ENV];
  if (fromFile) return fromFile;

  // Reuse the key OpenCode already has configured for the same gateway.
  for (const candidate of [
    join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
    join(homedir(), '.config', 'opencode', 'opencode.json'),
  ]) {
    try {
      if (!existsSync(candidate)) continue;
      const match = readFileSync(candidate, 'utf8').match(
        /"baseURL"\s*:\s*"([^"]+)"[\s\S]{0,400}?"apiKey"\s*:\s*"([^"]+)"/
      );
      if (match?.[2]) return match[2];
    } catch {
      // ignore and keep looking
    }
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

function readConfig(configPath) {
  try {
    if (!existsSync(configPath)) return {};
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const KNOWN_LABELS = {
  auto: 'Auto (LiteLLM)',
  'kimi-k3': 'Kimi K3',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-flash': 'DeepSeek Flash',
  'glm-5.3': 'GLM 5.3',
  'glm-5.3-flash': 'GLM 5.3 Flash',
};

function buildConfig(existing, baseUrl, modelIds) {
  const effectiveModelIds = [...ALIAS_MODELS.filter((id) => !modelIds.includes(id)), ...modelIds];
  return {
    ...existing,
    providers: {
      ...(existing.providers ?? {}),
      [PROVIDER_ID]: {
        name: 'LiteLLM (local)',
        baseUrl,
        api: 'openai-completions',
        apiKey: `$${API_KEY_ENV}`,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        // Unknown labels stay undefined so JSON.stringify drops the key.
        models: effectiveModelIds.map((id) => ({
          id,
          name: KNOWN_LABELS[id],
          contextWindow: CONTEXT_WINDOW,
          maxTokens: MAX_OUTPUT_TOKENS,
        })),
      },
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.AUTOMAKER_LITELLM_BASE_URL);
  const apiKey = resolveApiKey(options);
  const configPath =
    options.configPath ??
    process.env.PI_MODELS_CONFIG ??
    join(homedir(), '.pi', 'agent', 'models.json');

  console.log(`[pi-litellm] Gateway: ${baseUrl} (apiKey: ${apiKey ? 'resolved' : 'missing'})`);

  const modelIds = await fetchModelIds(baseUrl, apiKey);
  if (modelIds.length === 0) {
    throw new Error('Gateway returned no models; refusing to overwrite the Pi config');
  }

  const config = buildConfig(readConfig(configPath), baseUrl, modelIds);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  if (options.stdout) {
    process.stdout.write(serialized);
    return;
  }

  console.log(`[pi-litellm] ${modelIds.length} models: ${modelIds.join(', ')}`);

  if (options.dryRun) {
    console.log(`[pi-litellm] Dry run - ${configPath} not modified`);
    return;
  }

  const previous = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  if (previous === serialized) {
    console.log(`[pi-litellm] ${configPath} already up to date`);
    return;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, serialized, { encoding: 'utf8', mode: 0o600 });
  console.log(`[pi-litellm] Wrote ${configPath}`);
}

main().catch((error) => {
  console.error(`[pi-litellm] Failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
