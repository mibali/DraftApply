import { describe, expect, it } from 'vitest';
import {
  coercePositiveInteger,
  OpenRouterFreeModelCache,
  buildOpenRouterFallbackModelOrder,
  isOpenRouterFreeTextModel,
  scoreOpenRouterModelForDraftApply,
  shouldUseOpenRouterFallback,
} from '../render-proxy/llm-fallback.js';

const freeModel = id => ({
  id,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: '0', completion: '0', request: '0' },
  expiration_date: null,
});

describe('OpenRouter free-model fallback ordering', () => {
  it('falls back to the default model cap when OPENROUTER_MAX_FALLBACK_MODELS is invalid', () => {
    expect(coercePositiveInteger(undefined, 6)).toBe(6);
    expect(coercePositiveInteger('not-a-number', 6)).toBe(6);
    expect(coercePositiveInteger('0', 6)).toBe(6);
    expect(coercePositiveInteger('-3', 6)).toBe(6);
    expect(coercePositiveInteger('4.9', 6)).toBe(4);
  });

  it('keeps the Groq success path on Groq by not falling back without an error', () => {
    expect(shouldUseOpenRouterFallback(null, {
      primary: 'groq',
      hasOpenRouter: true,
    })).toBe(false);
  });

  it('falls back from Groq rate limits, timeouts, and temporary provider failures', () => {
    expect(shouldUseOpenRouterFallback({ status: 429 }, { primary: 'groq', hasOpenRouter: true })).toBe(true);
    expect(shouldUseOpenRouterFallback({ name: 'AbortError' }, { primary: 'groq', hasOpenRouter: true })).toBe(true);
    expect(shouldUseOpenRouterFallback({ status: 503 }, { primary: 'groq', hasOpenRouter: true })).toBe(true);
  });

  it('does not fall back from auth or validation errors', () => {
    expect(shouldUseOpenRouterFallback({ status: 400 }, { primary: 'groq', hasOpenRouter: true })).toBe(false);
    expect(shouldUseOpenRouterFallback({ status: 401 }, { primary: 'groq', hasOpenRouter: true })).toBe(false);
    expect(shouldUseOpenRouterFallback({ status: 403 }, { primary: 'groq', hasOpenRouter: true })).toBe(false);
  });

  it('does not fall back when OpenRouter is unconfigured or fallback is disabled', () => {
    expect(shouldUseOpenRouterFallback({ status: 429 }, { primary: 'groq', hasOpenRouter: false })).toBe(false);
    expect(shouldUseOpenRouterFallback({ status: 429 }, { primary: 'groq', hasOpenRouter: true, allowFallback: false })).toBe(false);
  });

  it('detects free text models from OpenRouter model metadata', () => {
    expect(isOpenRouterFreeTextModel(freeModel('alpha/free:free'))).toBe(true);
    expect(isOpenRouterFreeTextModel({
      ...freeModel('paid/model'),
      pricing: { prompt: '0.000001', completion: '0', request: '0' },
    })).toBe(false);
    expect(isOpenRouterFreeTextModel({
      ...freeModel('image/model:free'),
      architecture: { input_modalities: ['image'], output_modalities: ['image'] },
    })).toBe(false);
    expect(isOpenRouterFreeTextModel(freeModel('google/lyria-3-clip-preview'))).toBe(false);
    expect(isOpenRouterFreeTextModel(freeModel('openai/whisper-large-v3:free'))).toBe(false);
  });

  it('tries preferred free models first when they are available', () => {
    const ordered = buildOpenRouterFallbackModelOrder([
      freeModel('zeta/other:free'),
      freeModel('google/gemma-3-27b-it:free'),
      freeModel('qwen/qwen3-32b:free'),
      freeModel('alpha/other:free'),
    ]);

    expect(ordered.slice(0, 2)).toEqual([
      'qwen/qwen3-32b:free',
      'google/gemma-3-27b-it:free',
    ]);
  });

  it('honors a configured preferred OpenRouter model before the built-in preferred order', () => {
    const ordered = buildOpenRouterFallbackModelOrder([
      freeModel('google/gemma-3-27b-it:free'),
      freeModel('qwen/qwen3-32b:free'),
      freeModel('meta-llama/llama-3.3-70b-instruct'),
    ], [
      'meta-llama/llama-3.3-70b-instruct',
      'qwen/qwen3-32b:free',
      'google/gemma-3-27b-it:free',
    ]);

    expect(ordered.slice(0, 3)).toEqual([
      'meta-llama/llama-3.3-70b-instruct',
      'qwen/qwen3-32b:free',
      'google/gemma-3-27b-it:free',
    ]);
  });

  it('ranks other free models by DraftApply suitability when preferred models are unavailable', () => {
    const ordered = buildOpenRouterFallbackModelOrder([
      freeModel('zeta/story-roleplay:free'),
      { ...freeModel('alpha/qwen-instruct:free'), context_length: 128000, supported_parameters: ['response_format', 'temperature', 'max_tokens'] },
      freeModel('middle/code-coder:free'),
    ]);

    expect(ordered[0]).toBe('alpha/qwen-instruct:free');
  });

  it('keeps ordering deterministic across a large mixed catalogue and removes duplicate ids', () => {
    const catalogue = [];
    for (let i = 99; i >= 0; i -= 1) {
      catalogue.push(freeModel(`vendor/model-${String(i).padStart(3, '0')}:free`));
    }
    catalogue.push(freeModel('vendor/model-010:free'));
    catalogue.push(freeModel('google/gemma-3-27b-it:free'));
    catalogue.push({
      ...freeModel('paid/model'),
      pricing: { prompt: '0.1', completion: '0', request: '0' },
    });

    const ordered = buildOpenRouterFallbackModelOrder(catalogue);

    expect(ordered[0]).toBe('google/gemma-3-27b-it:free');
    expect(ordered.filter(id => id === 'vendor/model-010:free')).toHaveLength(1);
    expect(ordered.slice(1, 6)).toHaveLength(5);
    expect(ordered).not.toContain('paid/model');
  });

  it('penalizes code-only or soon-expiring free models for DraftApply prose workflows', () => {
    const stableInstruction = {
      ...freeModel('vendor/qwen-instruct:free'),
      context_length: 128000,
      supported_parameters: ['response_format', 'temperature', 'max_tokens'],
    };
    const expiringCode = {
      ...freeModel('vendor/code-coder:free'),
      context_length: 128000,
      supported_parameters: ['temperature', 'max_tokens'],
      expiration_date: '2026-07-09T00:00:00Z',
    };

    const now = Date.parse('2026-07-08T12:00:00Z');
    expect(scoreOpenRouterModelForDraftApply(stableInstruction, now))
      .toBeGreaterThan(scoreOpenRouterModelForDraftApply(expiringCode, now));
  });

  it('excludes expired models from fallback order', () => {
    const ordered = buildOpenRouterFallbackModelOrder([
      { ...freeModel('expired/model:free'), expiration_date: '2020-01-01T00:00:00Z' },
      freeModel('active/model:free'),
    ], undefined, Date.parse('2026-05-27T12:00:00Z'));

    expect(ordered).toEqual(['active/model:free']);
  });

  it('fetches the official OpenRouter model catalogue and caches it', async () => {
    let calls = 0;
    const cache = new OpenRouterFreeModelCache({
      apiKey: 'test-key',
      now: () => 1000,
      fetchFn: async (url, options) => {
        calls += 1;
        expect(url).toBe('https://openrouter.ai/api/v1/models');
        expect(options.headers.Authorization).toBe('Bearer test-key');
        return {
          ok: true,
          async json() {
            return { data: [freeModel('alpha/model:free')] };
          },
        };
      },
    });

    await expect(cache.getModels()).resolves.toHaveLength(1);
    await expect(cache.getModels()).resolves.toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('coalesces concurrent catalogue fetches into one OpenRouter request', async () => {
    let calls = 0;
    const cache = new OpenRouterFreeModelCache({
      now: () => 1000,
      fetchFn: async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return {
          ok: true,
          async json() {
            return { data: [freeModel('alpha/model:free')] };
          },
        };
      },
    });

    const results = await Promise.all([
      cache.getModels(),
      cache.getModels(),
      cache.getModels(),
    ]);

    expect(results.map(result => result[0].id)).toEqual([
      'alpha/model:free',
      'alpha/model:free',
      'alpha/model:free',
    ]);
    expect(calls).toBe(1);
  });

  it('serves stale cached models when a catalogue refresh temporarily fails', async () => {
    let now = 1000;
    let calls = 0;
    const cache = new OpenRouterFreeModelCache({
      ttlMs: 10,
      staleTtlMs: 1000,
      now: () => now,
      fetchFn: async () => {
        calls += 1;
        if (calls > 1) {
          return { ok: false, status: 503, async json() { return {}; } };
        }
        return {
          ok: true,
          async json() {
            return { data: [freeModel('cached/model:free')] };
          },
        };
      },
    });

    await expect(cache.getModels()).resolves.toHaveLength(1);
    now = 1020;
    await expect(cache.getModels()).resolves.toEqual([freeModel('cached/model:free')]);
    expect(calls).toBe(2);
  });

  it('fails clearly when the official catalogue response is malformed and no stale cache exists', async () => {
    const cache = new OpenRouterFreeModelCache({
      fetchFn: async () => ({
        ok: true,
        async json() {
          return { unexpected: [] };
        },
      }),
    });

    await expect(cache.getModels()).rejects.toThrow('OpenRouter models response was malformed');
  });
});
