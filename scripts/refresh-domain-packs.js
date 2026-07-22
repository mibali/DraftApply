import fs from 'node:fs';
import {
  buildNextDomainPackSnapshot,
  fetchSourceArtifacts,
  stableStringify,
} from '../shared/domain-packs/refresh.js';

const SOURCES_PATH = new URL('../shared/domain-packs/sources.json', import.meta.url);
const SNAPSHOT_PATH = new URL('../shared/domain-packs/domain-pack.snapshot.json', import.meta.url);
const RAW_DIR = new URL('../shared/domain-packs/raw/', import.meta.url);

function readJson(url) {
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

async function main() {
  const nowIso = new Date().toISOString();
  const sourcesManifest = readJson(SOURCES_PATH);
  const currentSnapshot = readJson(SNAPSHOT_PATH);
  let sourceArtifacts = {};

  if (process.env.DOMAIN_PACK_FETCH_REMOTE === 'true') {
    const maxBytes = Number.parseInt(process.env.DOMAIN_PACK_MAX_REMOTE_BYTES || '5000000', 10);
    const remote = await fetchSourceArtifacts({
      sourcesManifest,
      maxBytes: Number.isFinite(maxBytes) ? maxBytes : 5_000_000,
    });
    sourceArtifacts = remote.artifactsBySource;
    for (const warning of remote.warnings) {
      process.stderr.write(`Domain pack remote warning: ${warning}\n`);
    }
  }

  const { nextSnapshot, changed } = buildNextDomainPackSnapshot({
    currentSnapshot,
    sourcesManifest,
    nowIso,
    rawDirUrl: RAW_DIR,
    sourceArtifacts,
  });

  if (!changed && stableStringify(nextSnapshot) === stableStringify(currentSnapshot)) {
    process.stdout.write('Domain pack snapshot unchanged.\n');
    return;
  }

  fs.writeFileSync(SNAPSHOT_PATH, stableStringify(nextSnapshot));
  process.stdout.write('Domain pack snapshot updated.\n');
}

main().catch(error => {
  process.stderr.write(`Domain pack refresh failed: ${error.message}\n`);
  process.exit(1);
});
