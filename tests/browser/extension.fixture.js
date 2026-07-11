import { test as base, chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from '../../scripts/build-extension.js';

const here = dirname(fileURLToPath(import.meta.url));
const jobHtml = await readFile(join(here, 'fixtures/job.html'));

async function listen(server) {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return server.address().port;
}

export const test = base.extend({
  extension: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'draftapply-browser-'));
    const calls = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/job') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(jobHtml); return; }
      if (req.url === '/api/health') return json(200, { provider: 'browser-mock', apiVersion: 2, capabilities: { streamFinal: true, answerValidation: true } });
      if (req.url === '/api/register') return json(200, { token: 'browser-token', expiresAt: new Date(Date.now() + 86400000).toISOString() });
      if (req.url === '/api/generate') {
        if (req.headers.authorization !== 'Bearer browser-token') return json(401, { error: 'unauthorized' });
        const question = body?.question || '';
        const block = /BLOCK/i.test(question);
        const answer = block ? 'This unsupported claim must not be inserted.' : 'I built deterministic JavaScript tooling at scale.';
        if (!body?.stream) return json(200, { answer, validation: { status: block ? 'block' : 'pass' } });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ draftapplyFinal: { answer, validation: { status: block ? 'block' : 'pass' } } })}\n\n`);
        res.end('data: [DONE]\n\n'); return;
      }
      if (req.url === '/api/cv/upload') return json(200, { text: 'Jane Example\nSenior Engineer\nJavaScript systems experience' });
      if (req.url === '/api/cv/analyze') return json(200, { matchScore: 90, strongMatches: ['JavaScript'], missingSkills: [], domainMatches: [] });
      if (req.url === '/api/cv/tailor') return json(200, { tailoredCv: 'Jane Example\nSenior Software Engineer\nAcme-focused JavaScript systems experience' });
      json(404, { error: 'not found' });
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const extensionDir = join(root, 'extension');
    buildExtension({ proxyUrl: origin, outputDir: extensionDir });
    // A test-only build deliberately grants no production ATS hosts. Its sole
    // host grant and content-script match are the loopback fixture/proxy origin.
    const manifestPath = join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions = [`${origin}/*`];
    manifest.content_scripts[0].matches = [`${origin}/*`];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const context = await chromium.launchPersistentContext(join(root, 'profile'), {
      headless: false,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await use({ context, worker, extensionId, origin, calls, extensionDir });
    await context.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  },
});

export { expect };
