import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { RedisAdmissionStore } from '../render-proxy/admission-control.js';
import { RedisCircuitBreaker } from '../render-proxy/safety-runtime.js';

const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = redisAvailable ? describe.sequential : describe.skip;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

suite('Redis-backed proxy safety', () => {
  let process;
  let client;

  beforeAll(async () => {
    const port = await freePort();
    process = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    client = createClient({ url: `redis://127.0.0.1:${port}`, socket: { reconnectStrategy: false } });
    let lastError;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await client.connect();
        return;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    if (client?.isOpen) await client.quit();
    process?.kill('SIGTERM');
  });

  it('atomically reconciles reserved tokens and spend while retaining request counts', async () => {
    const key = `test:quota:${Date.now()}`;
    const store = new RedisAdmissionStore(client, { key, maxConcurrentPerSubject: 2 });
    const id = await store.reserve({ subjectKey: 'install-a', tokens: 1000, spendMicros: 500 });
    await store.reconcile(id, { tokens: 125, spendMicros: 40 });
    const bucket = Math.floor(Date.now() / (store.windowSeconds * 1000));
    const global = await client.hGetAll(`${key}:window:${bucket}`);
    expect(global).toMatchObject({ requests: '1', tokens: '125', spend: '40', concurrent: '0' });
  });

  it('purges an expired lease so a crashed worker cannot hold concurrency forever', async () => {
    const store = new RedisAdmissionStore(client, {
      key: `test:lease:${Date.now()}`,
      maxConcurrent: 1,
      maxConcurrentPerSubject: 1,
      maxRequestsPerSubject: 10,
      leaseSeconds: 0.03,
    });
    await store.reserve({ subjectKey: 'install-a', tokens: 1 });
    await new Promise(resolve => setTimeout(resolve, 45));
    await expect(store.reserve({ subjectKey: 'install-b', tokens: 1 })).resolves.toEqual(expect.any(String));
  });

  it('releases holds written by the previous Redis value format during rolling deploys', async () => {
    const key = `test:legacy-hold:${Date.now()}`;
    const store = new RedisAdmissionStore(client, { key });
    const bucket = Math.floor(Date.now() / (store.windowSeconds * 1000));
    const globalKey = `${key}:window:${bucket}`;
    const subjectKey = `${globalKey}:subject:install-a`;
    const holdId = 'legacy-hold';
    await client.hSet(globalKey, { concurrent: '1' });
    await client.hSet(subjectKey, { concurrent: '1' });
    await client.hSet(`${key}:holds`, holdId, subjectKey);
    await client.zAdd(`${key}:hold-expiries`, { score: Date.now() + 10_000, value: holdId });

    await store.release(holdId);

    expect(await client.hGet(globalKey, 'concurrent')).toBe('0');
    expect(await client.hGet(subjectKey, 'concurrent')).toBe('0');
    expect(await client.hExists(`${key}:holds`, holdId)).toBe(false);
  });

  it('shares circuit state across proxy instances and permits only one half-open probe', async () => {
    const options = { keyPrefix: `test:circuit:${Date.now()}`, failureThreshold: 2, openMs: 25 };
    const first = new RedisCircuitBreaker(client, options);
    const second = new RedisCircuitBreaker(client, options);
    await first.failure('groq:model');
    await second.failure('groq:model');
    expect(await first.permit('groq:model')).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await first.permit('groq:model')).toBe(true);
    expect(await second.permit('groq:model')).toBe(false);
    await first.success('groq:model');
    expect(await second.permit('groq:model')).toBe(true);
  });
});
