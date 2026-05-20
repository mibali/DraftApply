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
    const groqCalls = route.match(/fetch\('https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions'/g) || [];

    expect(groqCalls).toHaveLength(2);
    expect(route).toContain('buildTailoringPrompt');
    expect(route).toContain('buildTailoredCvAuditPrompt');
    expect(route).not.toContain('buildLLMAnalysisPrompt');
    expect(route).not.toContain('buildSemanticMatchPrompt');
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
