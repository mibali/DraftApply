import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const requests = [];
let providerServer;
let proxyServer;
let providerBase;
let proxyBase;
let token;
let malformedStructuredResponses = false;

const cvText = `Jane Example\nPlatform Engineer\n\nWORK EXPERIENCE\nPlatform Engineer | Acme Ltd | 2020-2025\n- Built Python automation for Kubernetes deployments and production diagnostics.\n- Led incident reviews and wrote operational runbooks.\n\nSKILLS\nPython, Kubernetes, production diagnostics`;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function jsonRequest(path, body, authToken = token) {
  const response = await fetch(`${proxyBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function registerToken() {
  const response = await fetch(`${proxyBase}/api/register`, { method: 'POST' });
  return (await response.json()).token;
}

describe.sequential('Render proxy real HTTP routes', () => {
  beforeAll(async () => {
    providerServer = http.createServer(async (req, res) => {
      if (req.url === '/models') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'mock/free:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] }));
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const provider = req.url.startsWith('/groq') ? 'groq' : 'openrouter';
      requests.push({ provider, body });
      const prompt = body.messages?.map(message => message.content).join('\n') || '';
      if (provider === 'groq' && prompt.includes('FALLBACK')) {
        res.statusCode = 503;
        return res.end('{"error":"busy"}');
      }
      if (provider === 'groq' && prompt.includes('DEADLINE')) {
        return setTimeout(() => { res.statusCode = 503; res.end('{"error":"late"}'); }, 300);
      }
      if (provider === 'groq' && prompt.includes('MALFORMED_BODY')) {
        res.setHeader('content-type', 'application/json');
        return res.end('{');
      }
      const structuredCvRequest = prompt.includes('professional CV tailoring engine') || prompt.includes('structured CV');
      const roleIds = [...prompt.matchAll(/\b(role_\d+)\b/g)].map(match => match[1]);
      const sourceIds = [...prompt.matchAll(/\[(experience:\d+:responsibility:\d+)/g)].map(match => match[1]);
      const answer = prompt.includes('RISKY')
        ? 'I have ten years of Redis production experience and hold an AWS certification.'
        : 'At Acme, I built Python automation for Kubernetes deployments and production diagnostics.';
      res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
      if (body.stream) {
        if (provider === 'groq' && prompt.includes('STREAM_FAILURE')) return res.end('data: [DONE]\n\n');
        if (provider === 'groq' && prompt.includes('TRUNCATED_STREAM')) {
          return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
        }
        if (provider === 'groq' && prompt.includes('MALFORMED_STREAM')) return res.end('data: {\n\ndata: [DONE]\n\n');
        if (provider === 'groq' && prompt.includes('INVALID_STREAM_CONTENT')) {
          return res.end('data: {"choices":[{"delta":{"content":{"unexpected":true}}}]}\n\ndata: [DONE]\n\n');
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(0, 30) } }], model: `${provider}-model` })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(30) } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      if (provider === 'groq' && prompt.includes('EMPTY_JSON')) return res.end('{}');
      if (provider === 'groq' && prompt.includes('LARGE_RESPONSE')) {
        return res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(3000) } }] }));
      }
      const content = structuredCvRequest
        ? malformedStructuredResponses
          ? 'not-json'
          : JSON.stringify({
              summary: { text: 'Platform Engineer', sourceIds: ['summary:0'] },
              competencies: [],
              roles: [...new Set(roleIds)].map((id, index) => ({
                id, focus: null,
                bullets: [{ text: index === 0 ? 'Built Python automation for Kubernetes deployments and production diagnostics.' : 'Led incident reviews and wrote operational runbooks.', sourceIds: [sourceIds[index] || sourceIds[0]] }],
              })),
            })
        : answer;
      res.end(JSON.stringify({ choices: [{ message: { content } }], model: `${provider}-model`, usage: { total_tokens: 321, cost: 0.0001 } }));
    });
    providerBase = `http://127.0.0.1:${await listen(providerServer)}`;
    Object.assign(process.env, {
      NODE_ENV: 'test', TOKEN_SECRET: 'integration-test-secret',
      GROQ_API_KEY: 'mock-groq', OPENROUTER_API_KEY: 'mock-openrouter',
      GROQ_API_URL: `${providerBase}/groq`, OPENROUTER_API_URL: `${providerBase}/openrouter`,
      OPENROUTER_MODELS_URL: `${providerBase}/models`, OPENROUTER_MODEL: 'mock/free:free',
      REQUIRE_DURABLE_QUOTAS: 'false', REQUEST_DEADLINE_MS: '150',
      PROVIDER_RESPONSE_MAX_BYTES: '2048', PROVIDER_ERROR_MAX_BYTES: '256',
      CIRCUIT_FAILURE_THRESHOLD: '20', OPENROUTER_MAX_FALLBACK_MODELS: '1',
      RECIPE_PATH: './render-proxy/recipe/index.js',
    });
    const { app } = await import('../render-proxy/server.js');
    proxyServer = http.createServer(app);
    proxyBase = `http://127.0.0.1:${await listen(proxyServer)}`;
    token = await registerToken();
  });

  afterAll(async () => {
    await Promise.all([providerServer, proxyServer].map(server => new Promise(resolve => server?.close(resolve))));
  });

  it('rejects raw legacy prompts before contacting a provider', async () => {
    const before = requests.length;
    const { response, body } = await jsonRequest('/api/generate', { systemPrompt: 'long system prompt', userPrompt: 'long user prompt' });
    expect(response.status).toBe(400);
    expect(body.code).toBe('legacy_raw_prompts_disabled');
    expect(requests).toHaveLength(before);
  });

  it('uses only the system/user prompt protocol and returns validation and trace', async () => {
    const { response, body } = await jsonRequest('/api/generate', { question: 'Why are you suitable?', cvText, skipEvaluation: true });
    expect(response.status).toBe(200);
    expect(body.validation.status).toBe('pass');
    expect(body.finalProvider.provider).toBe('groq');
    expect(body.providerTrace.map(entry => entry.provider)).toEqual(['groq']);
    const sent = requests.at(-1).body;
    expect(sent.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(sent).not.toHaveProperty('systemPrompt');
    expect(sent).not.toHaveProperty('userPrompt');
  });

  it('buffers provider streaming deltas and emits only meta, final, then DONE', async () => {
    const response = await fetch(`${proxyBase}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ question: 'STREAM: Why suitable?', cvText, stream: true, skipEvaluation: true }) });
    const text = await response.text();
    const data = text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    expect(data).toHaveLength(3);
    expect(JSON.parse(data[0])).toHaveProperty('draftapplyMeta');
    expect(JSON.parse(data[1])).toHaveProperty('draftapplyFinal');
    expect(data[2]).toBe('[DONE]');
    expect(text).not.toContain('"delta"');
  });

  it('falls back when a provider returns malformed successful JSON', async () => {
    const events = [];
    const info = vi.spyOn(console, 'info').mockImplementation(value => events.push(JSON.parse(value)));
    try {
      const failureToken = await registerToken();
      const { response, body } = await jsonRequest('/api/generate', { question: 'MALFORMED_BODY: Why suitable?', cvText, skipEvaluation: true }, failureToken);
      expect(response.status).toBe(200);
      expect(body.finalProvider.provider).toBe('openrouter');
    } finally {
      info.mockRestore();
    }
    expect(events).toContainEqual(expect.objectContaining({ event: 'proxy_safety', provider: 'groq', outcome: 'error' }));
  });

  it.each([
    ['STREAM_FAILURE', 'an empty stream'],
    ['TRUNCATED_STREAM', 'a truncated stream'],
    ['MALFORMED_STREAM', 'a malformed stream'],
    ['INVALID_STREAM_CONTENT', 'schema-invalid stream content'],
  ])('falls back when Groq returns %s (%s)', async (marker) => {
    const events = [];
    const info = vi.spyOn(console, 'info').mockImplementation(value => events.push(JSON.parse(value)));
    try {
      const failureToken = await registerToken();
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${failureToken}` };
      const body = JSON.stringify({ question: `${marker}: Why suitable?`, cvText, stream: true, skipEvaluation: true });
      const response = await fetch(`${proxyBase}/api/generate`, { method: 'POST', headers, body });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('"provider":"openrouter"');
      expect(text).toContain('data: [DONE]');
    } finally {
      info.mockRestore();
    }
    expect(events).toContainEqual(expect.objectContaining({ event: 'proxy_safety', provider: 'groq', outcome: 'error' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'proxy_safety', provider: 'openrouter', outcome: 'success' }));
  });

  it.each([
    ['EMPTY_JSON', 'schema-empty JSON'],
    ['LARGE_RESPONSE', 'an oversized response'],
  ])('falls back when Groq returns %s (%s)', async (marker) => {
    const failureToken = await registerToken();
    const { response, body } = await jsonRequest('/api/generate', { question: `${marker}: Why suitable?`, cvText, skipEvaluation: true }, failureToken);
    expect(response.status).toBe(200);
    expect(body.finalProvider.provider).toBe('openrouter');
    expect(body.fallbackFrom).toBe('groq');
  });

  it('falls back with privacy controls, ordered trace, and final attribution', async () => {
    const { response, body } = await jsonRequest('/api/generate', { question: 'FALLBACK: Why suitable?', cvText, skipEvaluation: true });
    expect(response.status).toBe(200);
    expect(body.finalProvider.provider).toBe('openrouter');
    expect(body.fallbackFrom).toBe('groq');
    expect(body.providerTrace.map(({ provider, outcome }) => [provider, outcome])).toEqual([['groq', 'error'], ['openrouter', 'success']]);
    const sent = requests.at(-1).body;
    expect(sent.provider).toMatchObject({ data_collection: 'deny', zdr: true });
  });

  it('does not attempt fallback after the absolute deadline is exhausted', async () => {
    const beforeFallbacks = requests.filter(request => request.provider === 'openrouter').length;
    const { response, body } = await jsonRequest('/api/generate', { question: 'DEADLINE: Why suitable?', cvText, skipEvaluation: true });
    expect(response.status).toBe(504);
    expect(body.code).toBe('request_deadline_exceeded');
    expect(requests.filter(request => request.provider === 'openrouter')).toHaveLength(beforeFallbacks);
  });

  it('releases admission after errors and blocks unsupported high-risk claims', async () => {
    const success = await jsonRequest('/api/generate', { question: 'RISKY: Do you have Redis experience?', cvText, skipEvaluation: true });
    expect(success.response.status).toBe(200);
    expect(success.body.validation.status).toBe('block');
    const next = await jsonRequest('/api/generate', { question: 'Why are you suitable after error?', cvText, skipEvaluation: true });
    expect(next.response.status).toBe(200);
  });

  it('returns only citation-validated structured CV output and attributes the accepted audit', async () => {
    const { response, body } = await jsonRequest('/api/cv/tailor', {
      cvText,
      jobTitle: 'Platform Engineer',
      company: 'Example Co',
      jobDescription: 'We need a platform engineer with Kubernetes, Python automation, incident response, and production diagnostics experience.',
    });
    expect(response.status).toBe(200);
    expect(body.generationMode).toBe('structured');
    expect(body.structuredCv.content.roles[0].bulletEvidence[0].sourceIds[0]).toMatch(/^experience:/);
    expect(body.provider).toBe('groq');
    expect(body.tailoredCvText).toContain('PROFESSIONAL EXPERIENCE');
  });

  it('fails closed when structured CV output is malformed', async () => {
    const before = requests.length;
    malformedStructuredResponses = true;
    const { response, body } = await jsonRequest('/api/cv/tailor', {
        cvText,
        jobTitle: 'Platform Engineer',
        company: 'Example Co',
        jobDescription: 'Platform role requiring Kubernetes automation, incident response, and reliable production diagnostics.',
      })
      .finally(() => { malformedStructuredResponses = false; });
    expect(response.status).toBe(502);
    expect(body.code).toBe('structured_cv_output_invalid');
    expect(requests.slice(before).filter(request => request.body.max_tokens === 6000)).toHaveLength(0);
  });
});
