import fs from 'node:fs';
import crypto from 'node:crypto';

export function stableStringify(value) {
  const seen = new WeakSet();
  const sortKeys = obj => {
    if (!obj || typeof obj !== 'object') return obj;
    if (seen.has(obj)) throw new Error('Cannot stableStringify circular structures');
    seen.add(obj);
    if (Array.isArray(obj)) return obj.map(sortKeys);
    return Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = sortKeys(obj[key]);
      return acc;
    }, {});
  };
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

export function sha256File(pathUrl) {
  const buf = fs.readFileSync(pathUrl);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function buildNextSnapshot({ currentSnapshot, sourcesManifest, nowIso, rawDirUrl }) {
  const currentSources = Array.isArray(currentSnapshot.sources) ? currentSnapshot.sources : [];
  const nextSources = (sourcesManifest.sources || []).map(source => {
    const existing = currentSources.find(s => s?.id === source.id) || {};
    const expectedFiles = Array.isArray(source.expectedRawFiles) ? source.expectedRawFiles : [];

    const fileChecksums = expectedFiles.map(entry => {
      const rel = typeof entry === 'string' ? entry : entry?.path;
      if (!rel) return null;
      const url = new URL(rel, rawDirUrl);
      if (!fs.existsSync(url)) return { path: rel, sha256: null, present: false };
      return { path: rel, sha256: sha256File(url), present: true };
    }).filter(Boolean);

    const combined = fileChecksums.length
      ? crypto.createHash('sha256').update(fileChecksums.map(f => f.sha256 || '').join('|')).digest('hex')
      : null;

    const hasAnyRaw = fileChecksums.some(f => f.present);
    return {
      id: source.id,
      name: source.name,
      country: source.country,
      url: source.officialLandingUrl,
      cadence: source.cadence,
      release: existing.release ?? null,
      retrievedAt: hasAnyRaw ? nowIso : existing.retrievedAt ?? null,
      sha256: combined ?? existing.sha256 ?? null,
    };
  });

  const nextSnapshot = {
    schemaVersion: 1,
    updatedAt: currentSnapshot.updatedAt ?? null,
    generation: {
      tool: 'scripts/refresh-salary-benchmarks.js',
      retrievedAt: null,
      notes: 'No official raw datasets are committed. Download official files into shared/data-sources/salary/raw/ and re-run the refresh script.',
    },
    sources: nextSources,
    benchmarks: Array.isArray(currentSnapshot.benchmarks) ? currentSnapshot.benchmarks : [],
  };

  const sourcesChanged = stableStringify(nextSources) !== stableStringify(currentSources);
  if (sourcesChanged) {
    nextSnapshot.updatedAt = nowIso.slice(0, 10);
    nextSnapshot.generation.retrievedAt = nowIso;
  } else {
    nextSnapshot.generation = currentSnapshot.generation || nextSnapshot.generation;
  }

  return { nextSnapshot, changed: sourcesChanged };
}

