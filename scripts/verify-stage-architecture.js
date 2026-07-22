import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Auto-discovers files instead of a hand-maintained list - a hardcoded list
// silently stops protecting new files the moment someone forgets to add
// them (this happened: shared/domain-packs/domain-classifier.js shipped
// without ever being added here). Walking the real source directories means
// a syntax error in any new file is always caught by `npm run test:static`.
const SOURCE_DIRS = [
  { dir: 'render-proxy', extensions: ['.js'] },
  { dir: 'shared', extensions: ['.js'] },
  { dir: 'scripts', extensions: ['.js'] },
  { dir: 'extension-ready', extensions: ['.js'] },
  { dir: 'tests', extensions: ['.js'] },
];
const SKIP_DIR_NAMES = new Set(['node_modules']);

function walk(dir, extensions) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results.push(...walk(fullPath, extensions));
    } else if (extensions.some(ext => entry.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = SOURCE_DIRS.flatMap(({ dir, extensions }) => walk(dir, extensions)).sort();

let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed = true;
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`Verified syntax for ${files.length} architecture files.`);
}
