import fs from 'node:fs';
import { validateDomainPackSnapshot } from '../shared/domain-packs/refresh.js';

const SOURCES_PATH = new URL('../shared/domain-packs/sources.json', import.meta.url);
const SNAPSHOT_PATH = new URL('../shared/domain-packs/domain-pack.snapshot.json', import.meta.url);

function readJson(url) {
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

function main() {
  const sourcesManifest = readJson(SOURCES_PATH);
  const snapshot = readJson(SNAPSHOT_PATH);
  const result = validateDomainPackSnapshot(snapshot, sourcesManifest);

  if (!result.ok) {
    process.stderr.write(`Domain pack validation failed:\n${result.errors.map(error => `- ${error}`).join('\n')}\n`);
    process.exit(1);
  }

  process.stdout.write('Domain pack snapshot is valid.\n');
}

main();
