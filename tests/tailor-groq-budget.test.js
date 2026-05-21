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
    expect(route).toContain('allowFallback: OPENROUTER_TAILOR_FALLBACK');
    expect(route).not.toContain('buildLLMAnalysisPrompt');
    expect(route).not.toContain('buildSemanticMatchPrompt');
  });

  it('uses OpenRouter only as a retry fallback behind Groq in production', () => {
    expect(renderProxyServer).toContain('const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY');
    expect(renderProxyServer).toContain("const OPENROUTER_TAILOR_FALLBACK = !/^false$/i.test");
    expect(renderProxyServer).toContain("url: 'https://openrouter.ai/api/v1/chat/completions'");
    expect(renderProxyServer).toContain("const primary = GROQ_API_KEY ? 'groq' : 'openrouter'");
    expect(renderProxyServer).toContain('const canFallback = options.allowFallback !== false');
    expect(renderProxyServer).toContain("console.warn(`[DraftApply] Groq ${error.status || error.name || 'error'}; falling back to OpenRouter.`)");
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
    const providerCalls = route.match(/await generate\(PROVIDER_NAME, PROVIDER_CONFIG/g) || [];

    expect(providerCalls).toHaveLength(2);
    expect(route).toContain('buildTailoringPrompt');
    expect(route).toContain('buildTailoredCvAuditPrompt');
    expect(route).not.toContain('buildLLMAnalysisPrompt');
    expect(route).not.toContain('buildSemanticMatchPrompt');
  });
});
