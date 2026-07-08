import { spawnSync } from 'node:child_process';

const files = [
  'render-proxy/server.js',
  'render-proxy/model-router.js',
  'render-proxy/recipe/index.js',
  'shared/agent-workflows.js',
  'shared/evidence-retrieval.js',
  'shared/evidence-retrieval-eval-fixtures.js',
  'scripts/eval-evidence-retrieval.js',
  'extension-ready/background.js',
  'extension-ready/content.js',
  'extension-ready/popup.js',
  'extension-ready/cv-export.js',
  'tests/agent-workflows.test.js',
  'tests/evidence-retrieval.test.js',
  'tests/model-router.test.js',
  'tests/render-proxy-agent-architecture.test.js',
  'tests/extension-critical-ui.test.js',
];

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
