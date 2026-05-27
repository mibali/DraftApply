/**
 * Local salary benchmark snapshot (official sources only).
 *
 * Source-of-truth data lives in:
 * `shared/data-sources/salary/salary-benchmarks.snapshot.json`
 *
 * This module loads the JSON snapshot in Node.js environments so that the
 * extension/proxy/backend share one deterministic view.
 */

import fs from 'node:fs';

const FALLBACK_SNAPSHOT = {
  schemaVersion: 1,
  updatedAt: null,
  sources: [],
  benchmarks: [],
};

function loadSnapshotFromDisk() {
  if (!process?.versions?.node) return FALLBACK_SNAPSHOT;
  try {
    const url = new URL('./data-sources/salary/salary-benchmarks.snapshot.json', import.meta.url);
    const raw = fs.readFileSync(url, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== 1) return FALLBACK_SNAPSHOT;
    return parsed;
  } catch {
    return FALLBACK_SNAPSHOT;
  }
}

export const SALARY_BENCHMARKS = loadSnapshotFromDisk();
export default SALARY_BENCHMARKS;
