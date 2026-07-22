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
  it('keeps the production Tailor CV route to one structured generation and audit path', () => {
    const route = getCvTailorRoute(renderProxyServer);
    const llmCalls = route.match(/callChatCompletionWithFallback/g) || [];

    expect(llmCalls).toHaveLength(2);
    expect(route).not.toContain('buildTailoringPrompt');
    expect(route).not.toContain('buildTailoredCvAuditPrompt');
    expect(route).toContain('buildRecruiterReview');
    expect(route).toContain('truthfulnessReport: buildTruthfulnessReport');
    expect(route).toContain('...buildQualityMetadata(completion)');
    expect(route).toContain('allowFallback: OPENROUTER_TAILOR_FALLBACK');
    expect(route).not.toContain('buildLLMAnalysisPrompt');
    expect(route).not.toContain('buildSemanticMatchPrompt');
  });

  it('requires structured generation and fails closed instead of returning a free-text CV', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(renderProxyServer).toContain("const STRUCTURED_CV_GENERATION = !/^false$/i.test(process.env.STRUCTURED_CV_GENERATION || 'true')");
    expect(route).toContain('buildStructuredTailoringPrompt');
    expect(route).toContain('validateStructuredContent');
    expect(route).toContain('renderTailoredCV');
    expect(route).toContain('buildStructuredAuditPrompt');
    expect(route).toContain("const generationMode = 'structured'");
    expect(route).toContain("code: 'structured_cv_generation_required'");
    expect(route).toContain("code: 'structured_cv_output_invalid'");
    expect(route).not.toContain('legacy free-text path');
    expect(route).toContain('structuredCv,');
    expect(route).toContain('generationMode,');
    // JSON mode requested for structured calls; provider guard lives in callProviderChat.
    expect(route).toContain("responseFormat: { type: 'json_object' }");
    expect(renderProxyServer).toContain("responseFormat && provider === 'groq'");
  });

  it('uses OpenRouter only as a retry fallback behind Groq in production', () => {
    expect(renderProxyServer).toContain('const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY');
    expect(renderProxyServer).toContain("const OPENROUTER_TAILOR_FALLBACK = !/^false$/i.test");
    expect(renderProxyServer).toContain("const OPENROUTER_API_URL = providerEndpoint(process.env.OPENROUTER_API_URL, 'https://openrouter.ai/api/v1/chat/completions'");
    expect(renderProxyServer).toContain('url: OPENROUTER_API_URL');
    expect(renderProxyServer).toContain("const primary = GROQ_API_KEY ? 'groq' : 'openrouter'");
    expect(renderProxyServer).toContain('shouldUseOpenRouterFallback(error');
    expect(renderProxyServer).toContain('buildOpenRouterFallbackModelOrder');
    expect(renderProxyServer).toContain('OpenRouterFreeModelCache');
    expect(renderProxyServer).toContain('const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL ||');
    expect(renderProxyServer).toContain('? [OPENROUTER_MODEL, ...PREFERRED_OPENROUTER_FREE_MODELS.filter');
    expect(renderProxyServer).toContain('!order.includes(OPENROUTER_MODEL)');
    expect(renderProxyServer).toContain('OPENROUTER_MAX_FALLBACK_MODELS');
    // Manual fallback is the hardened default so every attempted model is
    // visible in DraftApply's provider trace. Operators may opt into the
    // opaque OpenRouter models-array strategy explicitly.
    expect(renderProxyServer).toContain("const OPENROUTER_USE_MODELS_ARRAY = /^true$/i.test");
    expect(renderProxyServer).toContain('providerPreferences');
    expect(renderProxyServer).toContain('models: orderedModels');
    expect(renderProxyServer).toContain("metadata: true");
    expect(renderProxyServer).toContain("openRouterStrategy: 'models-array'");
    expect(renderProxyServer).toContain("console.warn(`[DraftApply] Groq ${error.status || error.name || 'error'}; falling back to OpenRouter free models.`)");
  });

  it('gives Tailor CV fallback enough time after a Groq timeout instead of spending the exhausted primary budget', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(renderProxyServer).toContain('options.fallbackTimeoutMs || options.timeoutMs || 60000');
    // Per-stage ceilings are additionally clamped by the request-wide
    // absolute deadline, so fallback attempts cannot multiply this budget.
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

  it('keeps the local Tailor CV route to generation + audit per path (structured primary, legacy fallback)', () => {
    const route = getCvTailorRoute(backendServer);
    // Local dev uses generateWithFallback (same as production) so Groq failures
    // don't cause silent hangs when an Ollama or other local provider is available.
    const fallbackCalls = route.match(/await generateWithFallback\(FALLBACK_CHAIN/g) || [];

    // 2 structured + 2 legacy fallback; only one path runs per request.
    expect(fallbackCalls).toHaveLength(4);
    expect(route).toContain('buildStructuredTailoringPrompt');
    expect(route).toContain('validateStructuredContent');
    expect(route).toContain('renderTailoredCV');
    expect(route).toContain('buildTailoringPrompt');
    expect(route).toContain('buildTailoredCvAuditPrompt');
    expect(route).toContain('buildRecruiterReview');
    expect(route).not.toContain('buildLLMAnalysisPrompt');
    expect(route).not.toContain('buildSemanticMatchPrompt');
  });

  it('validates structured audit output before replacing generated content in production', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(route).toContain('tailor.validateStructuredContent');
    expect(route).toContain('if (audited)');
    expect(route).toContain('auditSkipped');
  });

  it('guards audit output with isValidCvOutput on the raw LLM response before replacing the tailored CV in local dev', () => {
    const route = getCvTailorRoute(backendServer);
    expect(route).toContain('tailor.isValidCvOutput(auditedText)');
    expect(route).toContain('auditSkipped');
  });

  it('uses a bounded structured JSON budget for the production audit call', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(route.match(/maxTokens: 2500/g)).toHaveLength(2);
    expect(route).not.toContain('maxTokens: 6500');
  });

  it('rejects a truncated audit response instead of replacing the tailored CV with a cut-off rewrite', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(route).toContain("auditData?.choices?.[0]?.finish_reason !== 'length'");
  });

  it('rejects a truncated primary structured response', () => {
    const route = getCvTailorRoute(renderProxyServer);
    expect(route).toContain("structuredData?.choices?.[0]?.finish_reason === 'length'");
    expect(route).toContain('structuredTruncated\n          ? null');
  });

  it('exposes the deployed commit and process start time in /api/health so deploy state is verifiable', () => {
    expect(renderProxyServer).toContain('process.env.RENDER_GIT_COMMIT');
    expect(renderProxyServer).toContain('startedAt: SERVER_STARTED_AT');
  });

  it('wraps CV parse and prompt build inside the try block in production', () => {
    const route = getCvTailorRoute(renderProxyServer);
    const tryIdx = route.indexOf('try {');
    const parseIdx = route.indexOf('new CVParser()');
    expect(parseIdx).toBeGreaterThan(tryIdx);
  });
});
