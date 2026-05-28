import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const renderProxyServer = fs.readFileSync(new URL('../render-proxy/server.js', import.meta.url), 'utf8');
const backendServer = fs.readFileSync(new URL('../backend/server.js', import.meta.url), 'utf8');

function getCvTailorRoute(source) {
  const marker = "app.post('/api/cv/tailor'";
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextRoute = source.indexOf('\napp.', start + marker.length);
  return source.slice(start, nextRoute === -1 ? undefined : nextRoute);
}

describe('Tailor CV Groq budget', () => {
  it('keeps the production Tailor CV route to the main generation call plus audit', () => {
    const route = getCvTailorRoute(renderProxyServer);
    const llmCalls = route.match(/callChatCompletionWithFallback/g) || [];

    expect(llmCalls).toHaveLength(2);
    expect(route).toContain('buildTailoringPrompt');
    expect(route).toContain('buildTailoredCvAuditPrompt');
    expect(route).toContain('buildRecruiterReview');
    expect(route).toContain('allowFallback: OPENROUTER_TAILOR_FALLBACK');
    expect(route).not.toContain('buildLLMAnalysisPrompt');
    expect(route).not.toContain('buildSemanticMatchPrompt');
  });

  it('uses OpenRouter only as a retry fallback behind Groq in production', () => {
    expect(renderProxyServer).toContain('const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY');
    expect(renderProxyServer).toContain("const OPENROUTER_TAILOR_FALLBACK = !/^false$/i.test");
    expect(renderProxyServer).toContain("url: 'https://openrouter.ai/api/v1/chat/completions'");
    expect(renderProxyServer).toContain("const primary = GROQ_API_KEY ? 'groq' : 'openrouter'");
    expect(renderProxyServer).toContain('shouldUseOpenRouterFallback(error');
    expect(renderProxyServer).toContain('buildOpenRouterFallbackModelOrder');
    expect(renderProxyServer).toContain('OpenRouterFreeModelCache');
    expect(renderProxyServer).toContain('const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL ||');
    expect(renderProxyServer).toContain('? [OPENROUTER_MODEL, ...PREFERRED_OPENROUTER_FREE_MODELS.filter');
    expect(renderProxyServer).toContain('OPENROUTER_MAX_FALLBACK_MODELS');
    expect(renderProxyServer).toContain("console.warn(`[DraftApply] Groq ${error.status || error.name || 'error'}; falling back to OpenRouter free models.`)");
  });

  it('gives Tailor CV fallback enough time after a Groq timeout instead of spending the exhausted primary budget', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(renderProxyServer).toContain('options.fallbackTimeoutMs || options.timeoutMs || 60000');
    // Primary + audit must fit inside the 150 s SW background timeout with headroom.
    // 50 s primary + 30 s audit = 80 s max LLM time, well inside the limit.
    expect(route).toContain('timeoutMs: 50000');
    expect(route).toContain('fallbackTimeoutMs: 50000');
    expect(route).toContain('maxFallbackModels: 2');
  });

  it('explains when Tailor CV fallback is disabled after Groq provider failure', () => {
    expect(renderProxyServer).toContain('function llmErrorResponse');
    expect(renderProxyServer).toContain('function formatRetryAfter');
    expect(renderProxyServer).toContain('function retryAfterMsFromHeaders');
    expect(renderProxyServer).toContain('retryAfterMsFromProviderDetail');
    expect(renderProxyServer).toContain('OpenRouter fallback is disabled for Tailor CV to protect CV quality');
    expect(renderProxyServer).toContain('Try again in ${retryAfter}');
    expect(renderProxyServer).toContain('llmErrorResponse(e, { allowFallback: OPENROUTER_TAILOR_FALLBACK })');
  });

  it('keeps the local Tailor CV route to the main generation call plus audit', () => {
    const route = getCvTailorRoute(backendServer);
    // Local dev uses generateWithFallback (same as production) so Groq failures
    // don't cause silent hangs when an Ollama or other local provider is available.
    const fallbackCalls = route.match(/await generateWithFallback\(FALLBACK_CHAIN/g) || [];

    expect(fallbackCalls).toHaveLength(2);
    expect(route).toContain('buildTailoringPrompt');
    expect(route).toContain('buildTailoredCvAuditPrompt');
    expect(route).toContain('buildRecruiterReview');
    expect(route).not.toContain('buildLLMAnalysisPrompt');
    expect(route).not.toContain('buildSemanticMatchPrompt');
  });

  it('guards audit output with isValidCvOutput on the raw LLM response before replacing the tailored CV in production', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(route).toContain('tailor.isValidCvOutput(auditedText)');
    expect(route).toContain('auditSkipped');
  });

  it('guards audit output with isValidCvOutput on the raw LLM response before replacing the tailored CV in local dev', () => {
    const route = getCvTailorRoute(backendServer);
    expect(route).toContain('tailor.isValidCvOutput(auditedText)');
    expect(route).toContain('auditSkipped');
  });

  it('uses 4500 max tokens for the audit call in production', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(route).toContain('maxTokens: 4500');
    expect(route).not.toContain('maxTokens: 3500');
  });

  it('wraps CV parse and prompt build inside the try block in production', () => {
    const route = getCvTailorRoute(renderProxyServer);
    const tryIdx = route.indexOf('try {');
    const parseIdx = route.indexOf('new CVParser()');
    expect(parseIdx).toBeGreaterThan(tryIdx);
  });
});
