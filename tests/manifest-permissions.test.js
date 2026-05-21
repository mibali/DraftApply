import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension-ready/manifest.json', import.meta.url), 'utf8'));

describe('Chrome extension manifest permissions', () => {
  it('does not request blanket all-URL host permissions', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).toContain('scripting');
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.host_permissions).toContain('https://draftapply.onrender.com/*');
    expect(manifest.host_permissions).toContain('https://*.greenhouse.io/*');
    expect(manifest.host_permissions).toContain('https://*.lever.co/*');
    expect(manifest.host_permissions).toContain('https://*.myworkdayjobs.com/*');
  });

  it('keeps web-accessible icon resources narrower than all URLs', () => {
    const resources = manifest.web_accessible_resources || [];
    expect(resources.length).toBeGreaterThan(0);
    for (const entry of resources) {
      expect(entry.matches || []).not.toContain('<all_urls>');
    }
  });
});
