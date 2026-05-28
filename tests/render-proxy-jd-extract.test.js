import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const renderProxyServer = fs.readFileSync(new URL('../render-proxy/server.js', import.meta.url), 'utf8');
const backgroundJs = fs.readFileSync(new URL('../extension-ready/background.js', import.meta.url), 'utf8');

function getRoute(source, marker) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextRoute = source.indexOf('\napp.', start + marker.length);
  return source.slice(start, nextRoute === -1 ? undefined : nextRoute);
}

describe('Render proxy JD extraction route', () => {
  it('implements the production endpoint called by the extension', () => {
    expect(backgroundJs).toContain("fetch(`${proxyUrl}/api/jd/extract`");

    const route = getRoute(renderProxyServer, "app.post('/api/jd/extract'");
    expect(route).toContain('authRequired');
    expect(route).toContain('generateLimiter');
    expect(route).toContain('callChatCompletionWithFallback');
    expect(route).toContain('text must be at least 100 characters');
    expect(route).toContain('Job posting is too large');
    expect(route).toContain('Remove completely:');
    expect(route).toContain('res.json({ extractedText, provider: completion.provider, fallbackFrom: completion.fallbackFrom || undefined })');
  });

  it('keeps profile URL fields deterministic even with compound labels', () => {
    expect(renderProxyServer).toContain('/^linkedin(?:\\s*(?:url|link|profile|page))*$/i');
    expect(renderProxyServer).toContain('/^github(?:\\s*(?:url|link|profile|page))*$/i');
    expect(renderProxyServer).toContain('normalizeExtractedUrl');
    expect(renderProxyServer).toContain('link\\s+(?:to\\s+)?(?:your\\s+)?');
  });
});
