import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNextSnapshot } from '../shared/data-sources/salary/refresh.js';

describe('salary benchmark refresh builder', () => {
  it('is deterministic when no configured raw files exist', () => {
    const currentSnapshot = {
      schemaVersion: 1,
      updatedAt: '2026-05-27',
      generation: { tool: 'scripts/refresh-salary-benchmarks.js', retrievedAt: null, notes: 'x' },
      sources: [{ id: 'bls-oews', name: 'BLS', country: 'US', url: 'x', cadence: 'annual', release: null, retrievedAt: null, sha256: null }],
      benchmarks: [],
    };
    const sourcesManifest = {
      schemaVersion: 1,
      sources: [{ id: 'bls-oews', name: 'BLS', country: 'US', cadence: 'annual', officialLandingUrl: 'x', expectedRawFiles: [] }],
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-refresh-'));
    const rawDirUrl = new URL(`file://${tmp}/`);
    const { nextSnapshot, changed } = buildNextSnapshot({
      currentSnapshot,
      sourcesManifest,
      nowIso: '2026-05-27T12:00:00.000Z',
      rawDirUrl,
    });

    expect(changed).toBe(false);
    expect(nextSnapshot.updatedAt).toBe('2026-05-27');
    expect(nextSnapshot.sources[0].sha256).toBeNull();
  });

  it('updates source checksum and dates when a configured raw file is present', () => {
    const currentSnapshot = {
      schemaVersion: 1,
      updatedAt: '2026-05-01',
      generation: { tool: 'scripts/refresh-salary-benchmarks.js', retrievedAt: null, notes: 'x' },
      sources: [{ id: 'ons-ashe', name: 'ONS', country: 'UK', url: 'x', cadence: 'annual', release: null, retrievedAt: null, sha256: null }],
      benchmarks: [],
    };
    const sourcesManifest = {
      schemaVersion: 1,
      sources: [{ id: 'ons-ashe', name: 'ONS', country: 'UK', cadence: 'annual', officialLandingUrl: 'x', expectedRawFiles: ['ashe.xlsx'] }],
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-refresh-'));
    fs.writeFileSync(path.join(tmpDir, 'ashe.xlsx'), 'fixture');
    const rawDirUrl = new URL(`file://${tmpDir}/`);

    const { nextSnapshot, changed } = buildNextSnapshot({
      currentSnapshot,
      sourcesManifest,
      nowIso: '2026-05-27T12:00:00.000Z',
      rawDirUrl,
    });

    expect(changed).toBe(true);
    expect(nextSnapshot.updatedAt).toBe('2026-05-27');
    expect(nextSnapshot.generation.retrievedAt).toBe('2026-05-27T12:00:00.000Z');
    expect(nextSnapshot.sources[0].retrievedAt).toBe('2026-05-27T12:00:00.000Z');
    expect(nextSnapshot.sources[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

