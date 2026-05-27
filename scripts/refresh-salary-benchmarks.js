import fs from 'node:fs';
import { buildNextSnapshot, stableStringify } from '../shared/data-sources/salary/refresh.js';

const SOURCES_PATH = new URL('../shared/data-sources/salary/sources.json', import.meta.url);
const SNAPSHOT_PATH = new URL('../shared/data-sources/salary/salary-benchmarks.snapshot.json', import.meta.url);
const RAW_DIR = new URL('../shared/data-sources/salary/raw/', import.meta.url);

function readJson(url) {
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

function main() {
  const nowIso = new Date().toISOString();
  const sourcesManifest = readJson(SOURCES_PATH);
  const currentSnapshot = readJson(SNAPSHOT_PATH);

  const { nextSnapshot, changed } = buildNextSnapshot({ currentSnapshot, sourcesManifest, nowIso, rawDirUrl: RAW_DIR });
  if (!changed && stableStringify(nextSnapshot) === stableStringify(currentSnapshot)) {
    process.stdout.write('Salary snapshot unchanged.\n');
    return;
  }

  fs.writeFileSync(SNAPSHOT_PATH, stableStringify(nextSnapshot));
  process.stdout.write('Salary snapshot updated.\n');
}

main();
