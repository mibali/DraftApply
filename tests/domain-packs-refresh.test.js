import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildNextDomainPackSnapshot,
  fetchSourceArtifacts,
  validateDomainPackSnapshot,
} from '../shared/domain-packs/refresh.js';

describe('domain pack refresh builder', () => {
  it('is deterministic when no configured raw files exist', () => {
    const currentSnapshot = {
      schemaVersion: 1,
      updatedAt: '2026-07-08',
      generation: { tool: 'scripts/refresh-domain-packs.js', retrievedAt: null, notes: 'x' },
      sources: [{
        id: 'onet',
        name: 'O*NET',
        region: 'US',
        url: 'https://www.onetcenter.org/database.html',
        cadence: 'quarterly',
        license: 'CC BY 4.0',
        attribution: 'O*NET Resource Center',
        retrievedAt: null,
        sha256: null,
      }],
      domainProfiles: [],
      credentialRules: [],
    };
    const sourcesManifest = {
      schemaVersion: 1,
      sources: [{
        id: 'onet',
        name: 'O*NET',
        region: 'US',
        cadence: 'quarterly',
        officialLandingUrl: 'https://www.onetcenter.org/database.html',
        license: 'CC BY 4.0',
        attribution: 'O*NET Resource Center',
        expectedRawFiles: [],
      }],
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-refresh-'));
    const rawDirUrl = new URL(`file://${tmp}/`);
    const { nextSnapshot, changed } = buildNextDomainPackSnapshot({
      currentSnapshot,
      sourcesManifest,
      nowIso: '2026-07-08T12:00:00.000Z',
      rawDirUrl,
    });

    expect(changed).toBe(false);
    expect(nextSnapshot.updatedAt).toBe('2026-07-08');
    expect(nextSnapshot.sources[0].sha256).toBeNull();
    expect(nextSnapshot.sources[0].license).toBe('CC BY 4.0');
  });

  it('updates source checksum and dates when a configured raw file is present', () => {
    const currentSnapshot = {
      schemaVersion: 1,
      updatedAt: '2026-07-01',
      generation: { tool: 'scripts/refresh-domain-packs.js', retrievedAt: null, notes: 'x' },
      sources: [{
        id: 'esco',
        name: 'ESCO',
        region: 'EU',
        url: 'https://esco.ec.europa.eu/en/use-esco/download',
        cadence: 'quarterly',
        license: 'EC reuse notice',
        attribution: 'European Commission ESCO',
        retrievedAt: null,
        sha256: null,
      }],
      domainProfiles: [],
      credentialRules: [],
    };
    const sourcesManifest = {
      schemaVersion: 1,
      sources: [{
        id: 'esco',
        name: 'ESCO',
        region: 'EU',
        cadence: 'quarterly',
        officialLandingUrl: 'https://esco.ec.europa.eu/en/use-esco/download',
        license: 'EC reuse notice',
        attribution: 'European Commission ESCO',
        expectedRawFiles: ['esco.csv'],
      }],
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-refresh-'));
    fs.writeFileSync(path.join(tmpDir, 'esco.csv'), 'fixture');
    const rawDirUrl = new URL(`file://${tmpDir}/`);

    const { nextSnapshot, changed } = buildNextDomainPackSnapshot({
      currentSnapshot,
      sourcesManifest,
      nowIso: '2026-07-08T12:00:00.000Z',
      rawDirUrl,
    });

    expect(changed).toBe(true);
    expect(nextSnapshot.updatedAt).toBe('2026-07-08');
    expect(nextSnapshot.generation.retrievedAt).toBe('2026-07-08T12:00:00.000Z');
    expect(nextSnapshot.sources[0].retrievedAt).toBe('2026-07-08T12:00:00.000Z');
    expect(nextSnapshot.sources[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('can collect remote monitor checksums without writing raw files', async () => {
    const sourcesManifest = {
      schemaVersion: 1,
      sources: [{
        id: 'nist-nice',
        name: 'NIST NICE Framework',
        region: 'US',
        officialLandingUrl: 'https://www.nist.gov/itl/applied-cybersecurity/nice/nice-framework-resource-center',
        license: 'Public domain / NIST terms',
        attribution: 'NIST NICE Framework Resource Center',
        cadence: 'quarterly',
        expectedRawFiles: [],
      }],
    };
    const headers = new Map([
      ['etag', '"abc"'],
      ['last-modified', 'Wed, 08 Jul 2026 12:00:00 GMT'],
    ]);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: key => headers.get(key) },
      arrayBuffer: async () => new TextEncoder().encode('official page marker').buffer,
    });

    const { artifactsBySource, warnings } = await fetchSourceArtifacts({ sourcesManifest, fetchImpl });

    expect(warnings).toEqual([]);
    expect(artifactsBySource['nist-nice'][0].path).toBe('source-monitor.html');
    expect(artifactsBySource['nist-nice'][0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifactsBySource['nist-nice'][0].etag).toBe('"abc"');
  });
});

describe('domain pack snapshot validation', () => {
  it('requires complete source, profile, and rule metadata', () => {
    const sourcesManifest = {
      schemaVersion: 1,
      sources: [{
        id: 'onet',
        name: 'O*NET',
        region: 'US',
        cadence: 'quarterly',
        officialLandingUrl: 'https://www.onetcenter.org/database.html',
        license: 'CC BY 4.0',
        attribution: 'O*NET Resource Center',
        expectedRawFiles: [],
      }],
    };
    const snapshot = {
      schemaVersion: 1,
      updatedAt: '2026-07-08',
      sources: [{
        id: 'onet',
        name: 'O*NET',
        region: 'US',
        url: 'https://www.onetcenter.org/database.html',
        cadence: 'quarterly',
        license: 'CC BY 4.0',
        attribution: 'O*NET Resource Center',
        retrievedAt: null,
        sha256: null,
      }],
      domainProfiles: Array.from({ length: 8 }, (_, index) => ({
        id: `profile-${index}`,
        label: `Profile ${index}`,
        riskLevel: 'specialized',
        evidenceStrictness: 'high',
        keywords: ['keyword'],
        credentialKeywords: [],
        confirmationPrompts: ['Confirm credential.'],
      })),
      credentialRules: Array.from({ length: 4 }, (_, index) => ({
        id: `rule-${index}`,
        severity: index === 0 ? 'block' : 'confirm',
        description: `Rule ${index}`,
        appliesToRiskLevels: ['regulated'],
      })),
    };

    const result = validateDomainPackSnapshot(snapshot, sourcesManifest);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects missing attribution and baseline profiles', () => {
    const result = validateDomainPackSnapshot({
      schemaVersion: 1,
      sources: [{ id: 'onet', name: 'O*NET', url: 'https://example.com', license: 'CC BY 4.0' }],
      domainProfiles: [],
      credentialRules: [],
    }, {
      schemaVersion: 1,
      sources: [{
        id: 'onet',
        officialLandingUrl: 'https://example.com',
        license: 'CC BY 4.0',
        cadence: 'quarterly',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Domain source onet needs attribution.');
    expect(result.errors).toContain('Domain pack should include the core eight gap-closing profiles.');
  });
});
