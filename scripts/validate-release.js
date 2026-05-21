#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PACKAGE_PATH = join(ROOT, 'package.json');
const MANIFEST_PATH = join(ROOT, 'extension-ready', 'manifest.json');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');
const DIST_DIR = join(ROOT, 'dist');

const args = new Set(process.argv.slice(2));
const explicitTag = [...args].find(arg => arg.startsWith('--tag='))?.slice('--tag='.length);
const tag = explicitTag || process.env.GITHUB_REF_NAME || '';

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
}

console.log(`Release validation passed for v${manifest.version}`);
