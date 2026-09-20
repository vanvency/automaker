import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { syncPiLitellmProvider } from '../../../src/providers/pi-litellm.js';
import { PI_MODEL_CONTEXT_WINDOW, PI_MODEL_MAX_OUTPUT_TOKENS } from '@automaker/types';

describe('pi-litellm models.json sync', () => {
  let tempDir: string;
  let configPath: string;
  const originalKey = process.env.LITELLM_MASTER_KEY;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-litellm-test-'));
    configPath = path.join(tempDir, 'models.json');
    process.env.LITELLM_MASTER_KEY = 'test-key';
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalKey === undefined) {
      delete process.env.LITELLM_MASTER_KEY;
    } else {
      process.env.LITELLM_MASTER_KEY = originalKey;
    }
  });

  it('keeps other providers and adds the routing aliases', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ providers: { anthropic: { name: 'Anthropic' } } })
    );

    const result = syncPiLitellmProvider(['worker'], { configPath });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(written.providers.anthropic).toEqual({ name: 'Anthropic' });
    expect(written.providers.litellm.apiKey).toBe('$LITELLM_MASTER_KEY');
    // Aliases the gateway does not advertise are always present.
    expect(result.modelIds).toEqual(expect.arrayContaining(['auto', 'leader', 'worker']));
    expect(result.updated).toBe(true);
  });

  it('declares the 1M context window and 64k output cap on every model', () => {
    const result = syncPiLitellmProvider(['worker', 'kimi-k3'], { configPath });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const models: Array<{ id: string; contextWindow?: number; maxTokens?: number }> =
      written.providers.litellm.models;

    // Pi falls back to 128k for models that do not declare a context window.
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.contextWindow).toBe(PI_MODEL_CONTEXT_WINDOW);
      expect(model.maxTokens).toBe(PI_MODEL_MAX_OUTPUT_TOKENS);
    }
    expect(PI_MODEL_CONTEXT_WINDOW).toBe(1_000_000);
    expect(PI_MODEL_MAX_OUTPUT_TOKENS).toBe(64_000);
    expect(result.modelIds).toContain('worker');
  });

  it('backs up an unreadable config instead of discarding it', () => {
    fs.writeFileSync(configPath, '{ this is not json');

    syncPiLitellmProvider(['worker'], { configPath });

    const backups = fs.readdirSync(tempDir).filter((name) => name.includes('.invalid-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(tempDir, backups[0]), 'utf8')).toBe('{ this is not json');
    // The new config is valid and keeps the provider usable.
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).providers.litellm.models).toBeDefined();
  });
});
