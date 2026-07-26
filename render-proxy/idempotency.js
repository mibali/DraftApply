import crypto from 'node:crypto';
import { remainingMs, requestContext, requestSignal, waitForUpstreams } from './safety-runtime.js';

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const ownership = () => ({ ownerId: crypto.randomUUID(), generation: crypto.randomUUID() });
const cancelled = signal => signal?.aborted;

export class MemoryIdempotencyStore {
  constructor({ ttlMs = 15 * 60_000, maxEntries = 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.entries = new Map(); this.now = now;
  }
  async begin(key, payloadHash) {
    const now = this.now();
    for (const [k, v] of this.entries) if (v.expires <= now) { this.entries.delete(k); v.resolve?.(null); }
    const old = this.entries.get(key);
    if (old) return old.payloadHash === payloadHash ? { state: old.result ? 'done' : 'pending', entry: old } : { state: 'conflict' };
    if (this.entries.size >= this.maxEntries) { const oldest = this.entries.keys().next().value; this.entries.get(oldest)?.resolve?.(null); this.entries.delete(oldest); }
    const entry = { payloadHash, expires: now + this.ttlMs, ...ownership() };
    entry.promise = new Promise(resolve => { entry.resolve = resolve; });
    this.entries.set(key, entry); return { state: 'owner', entry };
  }
  async complete(key, ownerId, generation, result) {
    const e = this.entries.get(key);
    if (!e || e.ownerId !== ownerId || e.generation !== generation) return false;
    e.result = result; e.resolve(result); return true;
  }
  async abandon(key, ownerId, generation) {
    const e = this.entries.get(key);
    if (!e || e.ownerId !== ownerId || e.generation !== generation) return false;
    this.entries.delete(key); e.resolve(null); return true;
  }
  async wait(entry, { signal, deadlineAt = Infinity } = {}) {
    if (entry.result) return entry.result;
    if (cancelled(signal)) throw signal.reason;
    const timeoutMs = Math.max(1, Math.min(entry.expires, deadlineAt) - this.now());
    let timer, abort;
    try {
      return await Promise.race([entry.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Idempotent wait expired')), timeoutMs);
        abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true });
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}

export class RedisIdempotencyStore {
  constructor(client, { ttlMs = 15 * 60_000, pollMs = 50, now = Date.now } = {}) { this.client = client; this.ttlMs = ttlMs; this.pollMs = pollMs; this.now = now; }
  key(key) { return `draftapply:idempotency:${key}`; }
  async begin(key, payloadHash) {
    const redisKey = this.key(key); const owner = ownership();
    const value = { payloadHash, state: 'pending', ...owner };
    const created = await this.client.set(redisKey, JSON.stringify(value), { NX: true, PX: this.ttlMs });
    if (created) return { state: 'owner', entry: { redisKey, ...value } };
    const raw = await this.client.get(redisKey); if (!raw) return this.begin(key, payloadHash);
    const old = JSON.parse(raw);
    if (old.payloadHash !== payloadHash) return { state: 'conflict' };
    return { state: old.state === 'done' ? 'done' : 'pending', entry: { redisKey, ...old } };
  }
  async _cas(entry, action, result) {
    const lua = `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local old=cjson.decode(raw); if old.ownerId~=ARGV[1] or old.generation~=ARGV[2] then return 0 end; if ARGV[3]=='abandon' then redis.call('DEL',KEYS[1]); return 1 end; old.state='done'; old.result=cjson.decode(ARGV[4]); redis.call('SET',KEYS[1],cjson.encode(old),'PX',ARGV[5]); return 1`;
    return Boolean(await this.client.eval(lua, { keys: [entry.redisKey], arguments: [entry.ownerId, entry.generation, action, JSON.stringify(result || {}), String(this.ttlMs)] }));
  }
  complete(key, ownerId, generation, result) { return this._cas({ redisKey: this.key(key), ownerId, generation }, 'complete', result); }
  abandon(key, ownerId, generation) { return this._cas({ redisKey: this.key(key), ownerId, generation }, 'abandon'); }
  async wait(entry, { signal, deadlineAt = Infinity } = {}) {
    const deadline = Math.min(this.now() + this.ttlMs, deadlineAt);
    while (this.now() < deadline) {
      if (cancelled(signal)) throw signal.reason;
      const raw = await this.client.get(entry.redisKey);
      if (!raw) return null;
      const value = JSON.parse(raw); if (value.state === 'done') return value.result;
      await new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, Math.min(this.pollMs, Math.max(1, deadline - this.now())));
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Idempotent wait expired');
  }
}

export function idempotencyMiddleware(store, { logger = console } = {}) {
  return async (req, res, next) => {
    const raw = req.get('Idempotency-Key'); if (!raw) return next();
    if (!KEY_RE.test(raw)) return res.status(400).json({ error: 'Invalid Idempotency-Key', code: 'invalid_idempotency_key' });
    const scope = digest(`${req.installToken?.jti || 'anonymous'}:${req.path}:${raw}`);
    let begun;
    try { begun = await store.begin(scope, digest(stable(req.body || {}))); }
    catch { return res.status(503).json({ error: 'Idempotency service unavailable', code: 'idempotency_unavailable' }); }
    if (begun.state === 'conflict') return res.status(409).json({ error: 'Idempotency-Key was already used with a different payload', code: 'idempotency_conflict' });
    if (begun.state !== 'owner') {
      try {
        const replay = await store.wait(begun.entry, { signal: requestSignal(), deadlineAt: Date.now() + remainingMs() });
        if (!replay) return res.status(409).json({ error: 'Original request did not complete', code: 'idempotent_request_abandoned' });
        res.set('Idempotency-Replayed', 'true'); for (const [name, value] of Object.entries(replay.headers || {})) if (value) res.set(name, value);
        return res.status(replay.status).send(Buffer.from(replay.body, 'base64'));
      } catch (error) { if (!res.headersSent && !requestSignal()?.aborted) return res.status(504).json({ error: 'Idempotent wait expired', code: 'idempotent_wait_expired' }); return; }
    }
    const { ownerId, generation } = begun.entry; const chunks = []; const write = res.write.bind(res); const end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
    const complete = async () => {
      try {
        if (res.statusCode >= 400 || res.locals?.idempotencyFailed || requestSignal()?.aborted) return await store.abandon(scope, ownerId, generation);
        return await store.complete(scope, ownerId, generation, { status: res.statusCode, headers: { 'content-type': res.getHeader('content-type') }, body: Buffer.concat(chunks).toString('base64') });
      } catch (error) { logger.error?.('[idempotency] completion failed', { name: error?.name }); }
    };
    res.once('finish', () => { void complete(); });
    const context = requestContext(); res.once('close', () => { if (!res.writableFinished) void waitForUpstreams(context).then(complete).catch(error => logger.error?.('[idempotency] abandon failed', { name: error?.name })); });
    next();
  };
}
