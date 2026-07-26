#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PACKAGE_PATH = join(ROOT, 'package.json');
const MANIFEST_PATH = join(ROOT, 'extension-ready', 'manifest.json');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');
const DIST_DIR = join(ROOT, 'dist');

const args = new Set(process.argv.slice(2));
const explicitTag = [...args].find(arg => arg.startsWith('--tag='))?.slice('--tag='.length);
// GITHUB_REF_NAME is set on every workflow run, not only tag pushes - on an
// ordinary branch push or pull_request run it's a branch name or GitHub's
// synthetic PR merge ref ("13/merge"), never a real release tag. Gating on
// GITHUB_REF_TYPE === 'tag' (only set to that value for an actual tag push)
// keeps this assertion meaningful only when it's genuinely checking a
// release tag, instead of failing every ordinary CI run against main.
const tag = explicitTag || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '') || '';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(message) {
  console.error(`Release validation failed: ${message}`);
  process.exit(1);
}

function assertVersion(value, label) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) {
    fail(`${label} must be a Chrome-compatible dotted numeric version, got "${value}"`);
  }
}

const pkg = readJson(PACKAGE_PATH);
const manifest = readJson(MANIFEST_PATH);
const changelog = existsSync(CHANGELOG_PATH) ? readFileSync(CHANGELOG_PATH, 'utf8') : '';

assertVersion(pkg.version, 'package.json version');
assertVersion(manifest.version, 'extension-ready/manifest.json version');

if (pkg.version !== manifest.version) {
  fail(`package.json version (${pkg.version}) must match extension manifest version (${manifest.version})`);
}

if (tag) {
  const expectedTag = `v${manifest.version}`;
  if (tag !== expectedTag) {
    fail(`release tag must be ${expectedTag}, got ${tag}`);
  }
}

const hasVersionEntry = new RegExp(`^## \\[?${manifest.version.replace(/\./g, '\\.')}\\]?\\b`, 'm').test(changelog);
const hasUnreleasedEntry = /^## \[Unreleased\]/m.test(changelog);
if (!hasVersionEntry && !hasUnreleasedEntry) {
  fail(`CHANGELOG.md must contain either "## [Unreleased]" or a "## ${manifest.version}" release entry`);
}

const zipPath = join(DIST_DIR, `draftapply-chrome-${manifest.version}.zip`);
if (args.has('--require-zip')) {
  if (!existsSync(zipPath)) fail(`expected packaged extension ZIP at ${zipPath}`);
  if (statSync(zipPath).size <= 0) fail(`packaged extension ZIP is empty: ${zipPath}`);
  const checksumPath = `${zipPath}.sha256`;
  if (!existsSync(checksumPath)) fail(`expected SHA-256 checksum at ${checksumPath}`);
  const expected = readFileSync(checksumPath, 'utf8').trim().match(/^([a-f0-9]{64})\s{2}/)?.[1];
  if (!expected) fail(`invalid checksum file: ${checksumPath}`);
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  if (actual !== expected) fail(`checksum does not match packaged extension ZIP: ${zipPath}`);
}

console.log(`Release validation passed for v${manifest.version}`);
