#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { buildExtension, OFFICIAL_PROXY_URL, validateProxyUrl } from './build-extension.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const EXT_DIR = join(ROOT, 'extension-ready');
const DIST_DIR = join(ROOT, 'dist');
const STAGE_DIR = join(DIST_DIR, 'chrome-release');
const MANIFEST_PATH = join(EXT_DIR, 'manifest.json');

const args = new Set(process.argv.slice(2));
const shouldUpload = args.has('--upload') || args.has('--publish');
const shouldPublish = args.has('--publish');
const skipTests = args.has('--skip-tests');
const allowDirty = args.has('--allow-dirty');
const allowCustomProxyUpload = args.has('--allow-custom-proxy-upload');
const proxyUrl = [...args].find(arg => arg.startsWith('--proxy-url='))?.slice('--proxy-url='.length)
  || OFFICIAL_PROXY_URL;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : process.env,
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

function releaseFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? releaseFiles(root, path) : [relative(root, path)];
    })
    .filter(file => !/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|.*~|\.swp)$/i.test(file))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function zipExtension(version, extensionDir) {
  mkdirSync(DIST_DIR, { recursive: true });
  const zipName = `draftapply-chrome-${version}.zip`;
  const zipPath = join(DIST_DIR, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);

  const files = releaseFiles(extensionDir)
    .filter(file => !/\.(?:pem|crx)$/i.test(file));
  if (files.length === 0) throw new Error('Release staging directory contains no files');

  // Normalize copied-file timestamps and archive entries so the same source
  // produces the same bytes regardless of checkout time or host filesystem.
  const epoch = new Date(Number(process.env.SOURCE_DATE_EPOCH || 946684800) * 1000);
  if (Number.isNaN(epoch.getTime())) throw new Error('SOURCE_DATE_EPOCH must be Unix seconds');
  for (const file of files) utimesSync(join(extensionDir, file), epoch, epoch);
  run('zip', ['-X', '-q', zipPath, ...files], { cwd: extensionDir, env: { TZ: 'UTC' } });

  const size = statSync(zipPath).size;
  if (size <= 0) throw new Error('Created ZIP is empty');
  const checksum = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  const checksumPath = `${zipPath}.sha256`;
  writeFileSync(checksumPath, `${checksum}  ${zipName}\n`);
  return { zipPath, zipName, checksum, checksumPath, size };
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

  const resolvedProxyUrl = validateProxyUrl(proxyUrl);
  if (shouldUpload && resolvedProxyUrl !== OFFICIAL_PROXY_URL && !allowCustomProxyUpload) {
    throw new Error('Refusing to upload or publish a custom-proxy build. Pass --allow-custom-proxy-upload only after verifying the target Web Store listing.');
  }

  if (!skipTests) run('npm', ['test']);
  buildExtension({ proxyUrl: resolvedProxyUrl, outputDir: STAGE_DIR });
  for (const file of ['background.js', 'build-config.js', 'popup.js', 'content.js', 'page-extractor.js', 'cv-export.js', 'stats.js']) {
    run('node', ['--check', join(STAGE_DIR, file)]);
  }

  const { zipPath, zipName, checksum, checksumPath, size } = zipExtension(manifest.version, STAGE_DIR);
  console.log(`\nPackaged ${zipName} (${Math.round(size / 1024)} KB)`);
  console.log(`SHA-256 ${checksum}`);
  console.log(`Checksum file: ${checksumPath}`);

  const allReleases = readdirSync(DIST_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => ({ name: f, mtime: statSync(join(DIST_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  console.log('\nAll builds in dist/ (newest → oldest):');
  for (const r of allReleases) {
    const marker = r.name === zipName ? '  ← this build' : '';
    console.log(`  ${r.name}${marker}`);
  }

  if (!shouldUpload) {
    console.log(`\nDry run complete. ZIP ready at:\n  ${zipPath}`);
    console.log('\nNext steps:');
    console.log('  npm run release:chrome:upload   — upload to Web Store (draft)');
    console.log('  npm run release:chrome:publish  — upload + submit for review');
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
