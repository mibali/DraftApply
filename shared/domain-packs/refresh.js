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

function checksumsForSource(source, rawDirUrl) {
  const expectedFiles = Array.isArray(source.expectedRawFiles) ? source.expectedRawFiles : [];
  return expectedFiles.map(entry => {
    const rel = typeof entry === 'string' ? entry : entry?.path;
    if (!rel) return null;
    const url = new URL(rel, rawDirUrl);
    if (!fs.existsSync(url)) return { path: rel, sha256: null, present: false };
    return { path: rel, sha256: sha256File(url), present: true };
  }).filter(Boolean);
}

function checksumsFromArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.map(artifact => {
    if (!artifact?.path || !artifact?.sha256) return null;
    return {
      path: artifact.path,
      sha256: artifact.sha256,
      present: true,
      etag: artifact.etag ?? null,
      lastModified: artifact.lastModified ?? null,
    };
  }).filter(Boolean);
}

function combinedChecksum(fileChecksums) {
  if (!fileChecksums.length) return null;
  return crypto
    .createHash('sha256')
    .update(fileChecksums.map(file => `${file.path}:${file.sha256 || ''}`).join('|'))
    .digest('hex');
}

export function buildNextDomainPackSnapshot({ currentSnapshot, sourcesManifest, nowIso, rawDirUrl, sourceArtifacts = {} }) {
  const currentSources = Array.isArray(currentSnapshot.sources) ? currentSnapshot.sources : [];
  const nextSources = (sourcesManifest.sources || []).map(source => {
    const existing = currentSources.find(item => item?.id === source.id) || {};
    const fileChecksums = [
      ...checksumsForSource(source, rawDirUrl),
      ...checksumsFromArtifacts(sourceArtifacts[source.id]),
    ];
    const hasAnyRaw = fileChecksums.some(file => file.present);

    return {
      id: source.id,
      name: source.name,
      region: source.region,
      url: source.officialLandingUrl,
      cadence: source.cadence,
      license: source.license,
      attribution: source.attribution,
      retrievedAt: hasAnyRaw ? nowIso : existing.retrievedAt ?? null,
      sha256: combinedChecksum(fileChecksums) ?? existing.sha256 ?? null,
    };
  });

  const nextSnapshot = {
    schemaVersion: 1,
    updatedAt: currentSnapshot.updatedAt ?? null,
    generation: {
      tool: 'scripts/refresh-domain-packs.js',
      retrievedAt: null,
      notes: 'Seed snapshot is intentionally compact. Official raw datasets are not committed by default; add source files under shared/domain-packs/raw/ and re-run the refresh script.',
    },
    sources: nextSources,
    domainProfiles: Array.isArray(currentSnapshot.domainProfiles) ? currentSnapshot.domainProfiles : [],
    credentialRules: Array.isArray(currentSnapshot.credentialRules) ? currentSnapshot.credentialRules : [],
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

export async function fetchSourceArtifacts({
  sourcesManifest,
  fetchImpl = globalThis.fetch,
  maxBytes = 5_000_000,
  timeoutMs = 15_000,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Remote domain pack refresh requires a fetch implementation.');
  }

  const artifactsBySource = {};
  const warnings = [];
  for (const source of sourcesManifest.sources || []) {
    const entries = Array.isArray(source.expectedRawFiles) && source.expectedRawFiles.length
      ? source.expectedRawFiles
      : [{ path: 'source-monitor.html', downloadUrl: source.monitorUrl || source.officialLandingUrl }];

    for (const entry of entries) {
      const path = typeof entry === 'string' ? entry : entry?.path;
      const downloadUrl = typeof entry === 'string' ? null : entry?.downloadUrl;
      if (!path || !downloadUrl) continue;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(downloadUrl, {
          headers: {
            'user-agent': 'DraftApply domain-pack refresh (+https://github.com/mibali/DraftApply)',
            accept: '*/*',
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          warnings.push(`${source.id}: ${downloadUrl} returned HTTP ${response.status}`);
          continue;
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) {
          warnings.push(`${source.id}: ${downloadUrl} exceeded ${maxBytes} byte monitor limit`);
          continue;
        }

        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        artifactsBySource[source.id] = artifactsBySource[source.id] || [];
        artifactsBySource[source.id].push({
          path,
          sha256,
          etag: response.headers?.get?.('etag') ?? null,
          lastModified: response.headers?.get?.('last-modified') ?? null,
        });
      } catch (error) {
        const reason = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message;
        warnings.push(`${source.id}: ${downloadUrl} failed: ${reason}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  return { artifactsBySource, warnings };
}

function pushIf(errors, condition, message) {
  if (condition) errors.push(message);
}

function hasDuplicateIds(items) {
  const seen = new Set();
  return items.some(item => {
    if (!item?.id) return false;
    if (seen.has(item.id)) return true;
    seen.add(item.id);
    return false;
  });
}

export function validateDomainPackSnapshot(snapshot, sourcesManifest) {
  const errors = [];
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const profiles = Array.isArray(snapshot.domainProfiles) ? snapshot.domainProfiles : [];
  const rules = Array.isArray(snapshot.credentialRules) ? snapshot.credentialRules : [];
  const manifestSources = Array.isArray(sourcesManifest.sources) ? sourcesManifest.sources : [];

  pushIf(errors, snapshot.schemaVersion !== 1, 'Domain pack snapshot schemaVersion must be 1.');
  pushIf(errors, sourcesManifest.schemaVersion !== 1, 'Domain pack source manifest schemaVersion must be 1.');
  pushIf(errors, !Array.isArray(snapshot.sources), 'Domain pack snapshot must include sources[].');
  pushIf(errors, !Array.isArray(snapshot.domainProfiles), 'Domain pack snapshot must include domainProfiles[].');
  pushIf(errors, !Array.isArray(snapshot.credentialRules), 'Domain pack snapshot must include credentialRules[].');
  pushIf(errors, hasDuplicateIds(sources), 'Domain pack sources must not contain duplicate ids.');
  pushIf(errors, hasDuplicateIds(profiles), 'Domain profiles must not contain duplicate ids.');
  pushIf(errors, hasDuplicateIds(rules), 'Credential rules must not contain duplicate ids.');

  const sourceIds = new Set(sources.map(source => source?.id).filter(Boolean));
  for (const source of manifestSources) {
    pushIf(errors, !sourceIds.has(source.id), `Domain source ${source.id} is missing from the snapshot.`);
    pushIf(errors, !source.officialLandingUrl, `Domain source ${source.id} must define officialLandingUrl.`);
    pushIf(errors, !source.license, `Domain source ${source.id} must define license.`);
    pushIf(errors, !source.attribution, `Domain source ${source.id} must define attribution.`);
    pushIf(errors, !source.cadence, `Domain source ${source.id} must define cadence.`);
  }

  for (const source of sources) {
    pushIf(errors, !source.id, 'Every domain source needs an id.');
    pushIf(errors, !source.name, `Domain source ${source.id || '(unknown)'} needs a name.`);
    pushIf(errors, !source.url, `Domain source ${source.id || '(unknown)'} needs a URL.`);
    pushIf(errors, !source.license, `Domain source ${source.id || '(unknown)'} needs a license.`);
    pushIf(errors, !source.attribution, `Domain source ${source.id || '(unknown)'} needs attribution.`);
  }

  for (const profile of profiles) {
    pushIf(errors, !profile.id, 'Every domain profile needs an id.');
    pushIf(errors, !profile.label, `Domain profile ${profile.id || '(unknown)'} needs a label.`);
    pushIf(errors, !profile.riskLevel, `Domain profile ${profile.id || '(unknown)'} needs riskLevel.`);
    pushIf(errors, !profile.evidenceStrictness, `Domain profile ${profile.id || '(unknown)'} needs evidenceStrictness.`);
    pushIf(errors, !Array.isArray(profile.keywords), `Domain profile ${profile.id || '(unknown)'} needs keywords[].`);
    pushIf(errors, !Array.isArray(profile.credentialKeywords), `Domain profile ${profile.id || '(unknown)'} needs credentialKeywords[].`);
    pushIf(errors, !Array.isArray(profile.confirmationPrompts), `Domain profile ${profile.id || '(unknown)'} needs confirmationPrompts[].`);
  }

  const validSeverities = new Set(['block', 'confirm', 'warn', 'info']);
  for (const rule of rules) {
    pushIf(errors, !rule.id, 'Every credential rule needs an id.');
    pushIf(errors, !validSeverities.has(rule.severity), `Credential rule ${rule.id || '(unknown)'} has an invalid severity.`);
    pushIf(errors, !rule.description, `Credential rule ${rule.id || '(unknown)'} needs a description.`);
    pushIf(errors, !Array.isArray(rule.appliesToRiskLevels), `Credential rule ${rule.id || '(unknown)'} needs appliesToRiskLevels[].`);
  }

  pushIf(errors, profiles.length < 8, 'Domain pack should include the core eight gap-closing profiles.');
  pushIf(errors, rules.length < 4, 'Domain pack should include baseline credential/truthfulness rules.');

  return { ok: errors.length === 0, errors };
}
