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
      if (req.url === '/iframe-job') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Iframe job</title><script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Platform Engineer',
          hiringOrganization: { '@type': 'Organization', name: 'Parent Systems' },
          description: 'PARENT STRUCTURED CONTEXT: Build deterministic JavaScript browser systems with reliable automation and careful testing across embedded application forms. Own resilient extension workflows, collaborate with product engineers, diagnose difficult race conditions, and improve end-to-end quality for applicants on modern hiring platforms.',
        })}</script><h1>Platform Engineer</h1>
          <section class="job-description">Build deterministic JavaScript browser systems with reliable automation and careful testing across embedded application forms and production job sites. You will own resilient extension workflows, collaborate with product engineers, diagnose difficult race conditions, and improve end-to-end quality for applicants using modern hiring platforms.</section>
          <iframe id="application-frame" src="/iframe-form"></iframe>`); return;
      }
      if (req.url === '/two-iframe-job') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Two iframe job</title><script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Platform Engineer',
          hiringOrganization: { '@type': 'Organization', name: 'Parent Systems' },
          description: 'PARENT STRUCTURED CONTEXT: This authoritative parent posting requires reliable browser automation and race-free embedded forms. Own resilient extension workflows, collaborate with product engineers, diagnose difficult race conditions, and improve end-to-end quality for applicants on modern hiring platforms.',
        })}</script><iframe id="frame-a" src="/iframe-form-a"></iframe><iframe id="frame-b" src="/iframe-form-b"></iframe>`); return;
      }
      if (req.url?.startsWith('/iframe-form?') || req.url === '/iframe-form') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><label for="a">SLOW CANCEL: Field A</label><textarea id="a"></textarea>
          <label for="b">Field B</label><textarea id="b"></textarea>`); return;
      }
      if (req.url === '/iframe-form-a' || req.url === '/iframe-form-b') {
        const suffix = req.url.endsWith('-a') ? 'A' : 'B';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><p>Generic application form 12345</p><label for="answer">OVERLAP ${suffix}</label><textarea id="answer"></textarea>`); return;
      }
      if (req.url === '/generic-job') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Application</title><label for="application-answer">Why this role?</label><textarea id="application-answer"></textarea>'); return;
      }
      if (req.url === '/api/health') return json(200, { provider: 'browser-mock', apiVersion: 2, capabilities: { streamFinal: true, answerValidation: true } });
      if (req.url === '/api/register') return json(200, { token: 'browser-token', expiresAt: new Date(Date.now() + 86400000).toISOString() });
      if (req.url === '/api/generate') {
        if (req.headers.authorization !== 'Bearer browser-token') return json(401, { error: 'unauthorized' });
        const question = body?.question || '';
        if (/RATE LIMIT/i.test(question)) {
          res.setHeader('retry-after', '30');
          return json(429, { error: 'rate limited', code: 'rate_limited' });
        }
        if (/INVALID RESPONSE/i.test(question)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{');
          return;
        }
        const block = /BLOCK/i.test(question);
        const review = /REVIEW|MISSING VALIDATION/i.test(question);
        const answer = /OVERLAP A/i.test(question) ? 'Answer for iframe A.'
          : /OVERLAP B/i.test(question) ? 'Answer for iframe B.'
          : /EMAIL/i.test(question)
          ? 'jane@example.com'
          : block ? 'This unsupported claim must not be inserted.' : 'I built deterministic JavaScript tooling at scale.';
        if (!body?.stream) {
          // Keep the in-flight state observable so the browser test can prove
          // insertion remains disabled until the atomic result arrives. Special
          // cases exercise MV3 worker lifetime and explicit cancellation.
          const delayMs = /SLOW WORKER/i.test(question) ? 35000
            : /SLOW CANCEL/i.test(question) ? 5000
              : /OVERLAP A/i.test(question) ? 500 : 50;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          return json(200, {
            answer,
            ...(/MISSING VALIDATION/i.test(question) ? {} : { validation: { status: block ? 'block' : review ? 'review' : 'pass' } }),
          });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // Keep the in-flight state observable so the smoke test can verify
        // insertion remains disabled before the validated final event arrives.
        await new Promise(resolve => setTimeout(resolve, 50));
        res.write(`data: ${JSON.stringify({ draftapplyFinal: { answer, validation: { status: block ? 'block' : 'pass' } } })}\n\n`);
        res.end('data: [DONE]\n\n'); return;
      }
      if (req.url === '/api/cv/upload') return json(200, { text: 'Jane Example\nSenior Engineer\nJavaScript systems experience' });
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
