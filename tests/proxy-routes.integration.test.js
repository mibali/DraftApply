import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const requests = [];
let providerServer;
let proxyServer;
let providerBase;
let proxyBase;
let token;

const cvText = `Jane Example\nPlatform Engineer\n\nWORK EXPERIENCE\nPlatform Engineer | Acme Ltd | 2020-2025\n- Built Python automation for Kubernetes deployments and production diagnostics.\n- Led incident reviews and wrote operational runbooks.\n\nSKILLS\nPython, Kubernetes, production diagnostics`;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function jsonRequest(path, body) {
  const response = await fetch(`${proxyBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
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
      const answer = prompt.includes('RISKY')
        ? 'I have ten years of Redis production experience and hold an AWS certification.'
        : 'At Acme, I built Python automation for Kubernetes deployments and production diagnostics.';
      res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
      if (body.stream) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(0, 30) } }], model: `${provider}-model` })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(30) } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }], model: `${provider}-model` }));
    });
    providerBase = `http://127.0.0.1:${await listen(providerServer)}`;
    Object.assign(process.env, {
      NODE_ENV: 'test', TOKEN_SECRET: 'integration-test-secret',
      GROQ_API_KEY: 'mock-groq', OPENROUTER_API_KEY: 'mock-openrouter',
      GROQ_API_URL: `${providerBase}/groq`, OPENROUTER_API_URL: `${providerBase}/openrouter`,
      OPENROUTER_MODELS_URL: `${providerBase}/models`, OPENROUTER_MODEL: 'mock/free:free',
      REQUIRE_DURABLE_QUOTAS: 'false', REQUEST_DEADLINE_MS: '150',
      CIRCUIT_FAILURE_THRESHOLD: '20', OPENROUTER_MAX_FALLBACK_MODELS: '1',
      RECIPE_PATH: './render-proxy/recipe/index.js',
    });
    const { app } = await import('../render-proxy/server.js');
    proxyServer = http.createServer(app);
    proxyBase = `http://127.0.0.1:${await listen(proxyServer)}`;
    const registration = await fetch(`${proxyBase}/api/register`, { method: 'POST' });
    token = (await registration.json()).token;
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
});
