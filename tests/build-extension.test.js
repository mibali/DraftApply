import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExtension, OFFICIAL_PROXY_URL, validateProxyUrl } from '../scripts/build-extension.js';

const outputs = [];
function output() {
  const path = mkdtempSync(join(tmpdir(), 'draftapply-build-'));
  outputs.push(path);
  return path;
}
afterEach(() => outputs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('extension build configuration', () => {
  it('builds for a valid custom proxy with matching config and permission', () => {
    const dir = output();
    const sourceManifest = JSON.parse(readFileSync('extension-ready/manifest.json', 'utf8'));
    buildExtension({ proxyUrl: 'https://proxy.example.org/base/', outputDir: dir });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(readFileSync(join(dir, 'build-config.js'), 'utf8')).toContain("https://proxy.example.org/base");
    expect(manifest.host_permissions).toContain('https://proxy.example.org/*');
    expect(manifest.host_permissions).not.toContain('https://draftapply.onrender.com/*');
    expect(manifest.permissions).toEqual(sourceManifest.permissions);
    expect(manifest.content_scripts).toEqual(sourceManifest.content_scripts);
    expect(manifest.host_permissions.filter(p => !p.includes('proxy.example.org')))
      .toEqual(sourceManifest.host_permissions.filter(p => !p.includes('draftapply.onrender.com')));
    expect(JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8'))).toEqual({
      proxyUrl: 'https://proxy.example.org/base', official: false, extensionVersion: sourceManifest.version,
    });
  });

  it('defaults to an official build without changing Store behavior', () => {
    const dir = output();
    const result = buildExtension({ outputDir: dir });
    expect(result.proxyUrl).toBe(OFFICIAL_PROXY_URL);
    expect(result.manifest.host_permissions).toContain(`${OFFICIAL_PROXY_URL}/*`);
    expect(readFileSync(join(dir, 'build-config.js'), 'utf8')).toContain(OFFICIAL_PROXY_URL);
  });

  it.each(['http://example.com', 'ftp://localhost', 'not a URL', 'https://user:pass@example.com'])
    ('rejects invalid proxy URL %s', value => expect(() => validateProxyUrl(value)).toThrow());

  it.each(['http://localhost:8787', 'http://127.0.0.1:3000', 'http://[::1]:8080'])
    ('allows loopback HTTP %s', value => expect(validateProxyUrl(value)).toBe(value));
});
