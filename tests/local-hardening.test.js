import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_PROVIDER,
  buildFallbackChain,
  generateWithFallback,
  resolveProvider,
} from '../backend/llm-providers.js';

describe('local app provider hardening', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses Ollama as the single default source of truth', () => {
    expect(DEFAULT_PROVIDER).toBe('ollama');
    expect(resolveProvider({})).toBe('ollama');
    expect(buildFallbackChain({ GROQ_API_KEY: 'secret' }).map(p => p.name)).toEqual(['ollama']);
  });

  it('requires explicit cloud fallback consent', () => {
    expect(buildFallbackChain({ LLM_PROVIDER: 'ollama', LLM_FALLBACK_PROVIDERS: 'groq', GROQ_API_KEY: 'x' })
      .map(p => p.name)).toEqual(['ollama']);
    expect(buildFallbackChain({ LLM_PROVIDER: 'ollama', LLM_FALLBACK_PROVIDERS: 'groq', ALLOW_CLOUD_FALLBACK: 'true', GROQ_API_KEY: 'x' })
      .map(p => p.name)).toEqual(['ollama', 'groq']);
  });

  it('aborts each provider attempt and respects the absolute deadline', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })));
    const chain = [
      { name: 'ollama', config: { baseUrl: 'http://localhost', model: 'x' } },
      { name: 'ollama', config: { baseUrl: 'http://localhost', model: 'x' } },
    ];
    await expect(generateWithFallback(chain, [], { attemptTimeoutMs: 10, requestTimeoutMs: 15 }))
      .rejects.toThrow('No configured provider completed');
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('frontend secret and endpoint contracts', () => {
  it('uses session storage, clears legacy keys, confirms remote endpoints, and suppresses BYOK forwarding', async () => {
    const source = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
    expect(source).toContain('sessionStorage.setItem(LLM_SETTINGS_KEY');
    expect(source).toContain('localStorage.removeItem(LLM_SETTINGS_KEY)');
    expect(source).toContain('window.confirm(`Use remote API endpoint');
    expect(source).toContain('function buildApiJsonBody(payload, llmSettings)');
    expect(source).toContain('llmConfig && isTrustedApiEndpoint() ? { llmConfig }');
    expect(source).toContain('body: buildApiJsonBody({ text: rawDescription }, this.llmSettings)');
  });

  it('fails closed for non-loopback server binding', async () => {
    const source = await readFile(new URL('../backend/server.js', import.meta.url), 'utf8');
    expect(source).toContain("process.env.ALLOW_UNSAFE_REMOTE_BIND !== 'true'");
    expect(source).toContain('Refusing non-loopback HOST');
  });
});
