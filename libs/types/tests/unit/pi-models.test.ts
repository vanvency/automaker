import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PI_MODEL,
  PI_MODELS,
  PI_LITELLM_DEFAULT_BASE_URL,
  createPiModelId,
  getAllPiModelIds,
  getPiModelLabel,
  isPiModelId,
  isPiModel,
  parsePiModelId,
  resolvePiModelId,
  getModelProvider,
  addProviderPrefix,
  stripProviderPrefix,
} from '@automaker/types';

describe('pi-models.ts', () => {
  describe('createPiModelId', () => {
    it('should build a canonical LiteLLM model ID', () => {
      expect(createPiModelId('auto')).toBe('pi:litellm/auto');
    });

    it('should not double-prefix an already namespaced model', () => {
      expect(createPiModelId('litellm/kimi-k3')).toBe('pi:litellm/kimi-k3');
    });

    it('should support other upstream providers', () => {
      expect(createPiModelId('gpt-5', 'openai')).toBe('pi:openai/gpt-5');
    });
  });

  describe('parsePiModelId', () => {
    it('should split provider and model', () => {
      expect(parsePiModelId('pi:litellm/deepseek-flash')).toEqual({
        upstreamProvider: 'litellm',
        model: 'deepseek-flash',
        legacy: false,
      });
    });

    it('should keep nested model names intact', () => {
      expect(parsePiModelId('pi:litellm/ark/kimi-k3')).toEqual({
        upstreamProvider: 'litellm',
        model: 'ark/kimi-k3',
        legacy: false,
      });

      // The pre-rename dash form still parses (and is flagged as legacy)
      expect(parsePiModelId('pi-litellm/worker')).toEqual({
        upstreamProvider: 'litellm',
        model: 'worker',
        legacy: true,
      });
    });

    it('should reject non-pi and malformed IDs', () => {
      expect(parsePiModelId('opencode-litellm/auto')).toBeNull();
      expect(parsePiModelId('pi-litellm')).toBeNull();
      expect(parsePiModelId('pi-')).toBeNull();
      expect(parsePiModelId(undefined)).toBeNull();
    });
  });

  describe('isPiModelId / isPiModel', () => {
    it('should accept canonical IDs', () => {
      expect(isPiModelId('pi:litellm/auto')).toBe(true);
      expect(isPiModel('pi:litellm/auto')).toBe(true);
    });

    it('should not hijack bare aliases or other providers', () => {
      expect(isPiModel('auto')).toBe(false);
      expect(isPiModel('opencode-litellm/auto')).toBe(false);
      expect(isPiModel('claude-opus')).toBe(false);
      expect(isPiModel(undefined)).toBe(false);
    });
  });

  describe('static model list', () => {
    it('should expose the LiteLLM auto alias as the default', () => {
      expect(DEFAULT_PI_MODEL).toBe('pi:litellm/worker');
      expect(getAllPiModelIds()).toContain(DEFAULT_PI_MODEL);
    });

    it('should use the local gateway as the default base URL', () => {
      expect(PI_LITELLM_DEFAULT_BASE_URL).toBe('http://127.0.0.1:4000/v1');
    });

    it('should label known models and fall back to the bare name', () => {
      expect(getPiModelLabel('pi:litellm/kimi-k3')).toBe('Kimi K3');
      expect(getPiModelLabel('pi:litellm/unknown-model')).toBe('unknown-model');
    });

    it('should resolve aliases to canonical IDs', () => {
      // Legacy "auto" selections point at the leader chain now.
      expect(resolvePiModelId('auto')).toBe('pi:litellm/auto');
      expect(resolvePiModelId('leader')).toBe('pi:litellm/leader');
      expect(resolvePiModelId('pi:litellm/glm-5.3')).toBe('pi:litellm/glm-5.3');
    });

    it('should give every model a unique id', () => {
      const ids = PI_MODELS.map((config) => config.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('provider routing', () => {
    it('should route pi- models to the pi provider, not opencode', () => {
      expect(getModelProvider('pi:litellm/auto')).toBe('pi');
      expect(getModelProvider('pi:litellm/ark/kimi-k3')).toBe('pi');
      expect(getModelProvider('opencode-litellm/auto')).toBe('opencode');
    });

    it('should add and strip the pi prefix', () => {
      expect(addProviderPrefix('litellm/auto', 'pi')).toBe('pi:litellm/auto');
      expect(addProviderPrefix('pi:litellm/auto', 'pi')).toBe('pi:litellm/auto');
      expect(stripProviderPrefix('pi:litellm/auto')).toBe('litellm/auto');
    });
  });
});
