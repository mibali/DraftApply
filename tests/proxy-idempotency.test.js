import { describe, expect, it } from 'vitest';
import { MemoryIdempotencyStore, RedisIdempotencyStore } from '../render-proxy/idempotency.js';

describe('proxy idempotency store', () => {
  it('joins duplicate in-flight work and replays its terminal result', async () => {
    const store = new MemoryIdempotencyStore();
    const first = await store.begin('install:key', 'payload-a');
    const duplicate = await store.begin('install:key', 'payload-a');
    expect(first.state).toBe('owner');
    expect(duplicate.state).toBe('pending');
    const waiting = store.wait(duplicate.entry);
    const result = { status: 200, body: 'answer' };
    await store.complete('install:key', first.entry.ownerId, first.entry.generation, result);
    await expect(waiting).resolves.toEqual(result);
    expect((await store.begin('install:key', 'payload-a')).state).toBe('done');
  });

  it('rejects stale owners and allows a conditional abandon', async () => {
    const store = new MemoryIdempotencyStore();
    const first = await store.begin('install:key', 'payload-a');
    await expect(store.complete('install:key', 'stale', first.entry.generation, { status: 200 })).resolves.toBe(false);
    expect((await store.begin('install:key', 'payload-a')).state).toBe('pending');
    await expect(store.abandon('install:key', first.entry.ownerId, first.entry.generation)).resolves.toBe(true);
    expect((await store.begin('install:key', 'payload-a')).state).toBe('owner');
  });

  it('rejects key reuse with a conflicting payload and bounds memory', async () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 1 });
    await store.begin('one', 'payload-a');
    expect((await store.begin('one', 'payload-b')).state).toBe('conflict');
    await store.begin('two', 'payload-b');
    expect(store.entries.size).toBe(1);
  });

  it('removes each Redis polling abort listener after its timer resolves', async () => {
    let polls = 0;
    const client = {
      async get() {
        polls++;
        return JSON.stringify(polls < 5 ? { state: 'pending' } : { state: 'done', result: { status: 200 } });
      },
    };
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener() { added++; },
      removeEventListener() { removed++; },
    };
    const store = new RedisIdempotencyStore(client, { pollMs: 1 });
    await expect(store.wait({ redisKey: 'test' }, { signal })).resolves.toEqual({ status: 200 });
    expect(added).toBe(4);
    expect(removed).toBe(added);
  });
});
