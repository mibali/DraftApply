#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const EXT_DIR = join(ROOT, 'extension-ready');
const DIST_DIR = join(ROOT, 'dist');
const MANIFEST_PATH = join(EXT_DIR, 'manifest.json');

const args = new Set(process.argv.slice(2));
const shouldUpload = args.has('--upload') || args.has('--publish');
const shouldPublish = args.has('--publish');
const skipTests = args.has('--skip-tests');
const allowDirty = args.has('--allow-dirty');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const details = result.stderr || result.stdout || `${command} exited with ${result.status}`;
    throw new Error(details.trim());
  }
  return result.stdout?.trim() || '';
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validateManifest(manifest) {
  const required = ['manifest_version', 'name', 'version', 'permissions', 'background', 'action'];
  for (const key of required) {
    if (!(key in manifest)) throw new Error(`manifest.json is missing required field: ${key}`);
  }
  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected manifest_version 3, got ${manifest.manifest_version}`);
  }
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) {
    throw new Error(`manifest version must be Chrome-compatible numeric dotted format, got "${manifest.version}"`);
  }
}

function ensureCleanGit() {
  const status = run('git', ['status', '--porcelain', '--untracked-files=all'], { capture: true });
  const relevant = status
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => {
      const file = line.replace(/^.. /, '');
      return file.startsWith('extension-ready/')
        || file === 'package.json'
        || file === 'package-lock.json'
        || file.startsWith('scripts/')
        || file.startsWith('.github/workflows/');
    });

  if (relevant.length > 0) {
    throw new Error(`Release files have uncommitted changes. Commit or stash before releasing.\n${relevant.join('\n')}`);
  }
}

function zipExtension(version) {
  mkdirSync(DIST_DIR, { recursive: true });
  const zipName = `draftapply-chrome-${version}.zip`;
  const zipPath = join(DIST_DIR, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);

  run('zip', [
    '-r',
    zipPath,
    '.',
    '-x',
    '*.DS_Store',
    '__MACOSX/*',
    '*.pem',
    '*.crx',
  ], { cwd: EXT_DIR });

  const size = statSync(zipPath).size;
  if (size <= 0) throw new Error('Created ZIP is empty');
  return { zipPath, zipName, size };
}

async function getAccessToken() {
  const clientId = requireEnv('CHROME_CLIENT_ID');
  const clientSecret = requireEnv('CHROME_CLIENT_SECRET');
  const refreshToken = requireEnv('CHROME_REFRESH_TOKEN');

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Could not refresh Chrome Web Store token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function uploadPackage(zipPath, token) {
  const publisherId = requireEnv('CHROME_PUBLISHER_ID');
  const extensionId = requireEnv('CHROME_EXTENSION_ID');
  const url = `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisherId}/items/${extensionId}:upload`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: createReadStream(zipPath),
    duplex: 'half',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Chrome Web Store upload failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function publishPackage(token) {
  const publisherId = requireEnv('CHROME_PUBLISHER_ID');
  const extensionId = requireEnv('CHROME_EXTENSION_ID');
  const url = `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}:publish`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Chrome Web Store publish failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  if (!existsSync(MANIFEST_PATH)) throw new Error(`Missing manifest: ${MANIFEST_PATH}`);

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  validateManifest(manifest);

  if (allowDirty) {
    console.warn('Skipping release-file cleanliness check because --allow-dirty was provided.');
  } else {
    ensureCleanGit();
  }

  if (!skipTests) run('npm', ['test']);
  run('node', ['--check', join(EXT_DIR, 'background.js')]);
  run('node', ['--check', join(EXT_DIR, 'popup.js')]);
  run('node', ['--check', join(EXT_DIR, 'content.js')]);
  run('node', ['--check', join(EXT_DIR, 'page-extractor.js')]);
  run('node', ['--check', join(EXT_DIR, 'cv-export.js')]);
  run('node', ['--check', join(EXT_DIR, 'stats.js')]);

  const { zipPath, zipName, size } = zipExtension(manifest.version);
  console.log(`Packaged ${basename(zipName)} (${Math.round(size / 1024)} KB)`);

  if (!shouldUpload) {
    console.log(`Dry run complete. ZIP ready at ${zipPath}`);
    console.log('To upload: npm run release:chrome:upload');
    console.log('To upload and submit for review: npm run release:chrome:publish');
    return;
  }

  const token = await getAccessToken();
  const uploadResult = await uploadPackage(zipPath, token);
  console.log('Upload complete:', JSON.stringify(uploadResult));

  if (shouldPublish) {
    const publishResult = await publishPackage(token);
    console.log('Publish submitted:', JSON.stringify(publishResult));
  } else {
    console.log('Package uploaded but not submitted. Run with --publish to submit for review.');
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
