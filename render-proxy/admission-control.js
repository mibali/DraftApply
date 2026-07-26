import crypto from 'crypto';
import { requestContext, waitForUpstreams } from './safety-runtime.js';

export class AdmissionDeniedError extends Error { constructor(reason = 'quota_exceeded') { super(reason); this.code = reason; } }

export function redisClientOptions(url, {
  pingIntervalMs = 60_000,
  connectTimeoutMs = 10_000,
  reconnectMaxMs = 10_000,
  random = Math.random,
} = {}) {
  return {
    url,
    // Managed Redis providers can close otherwise healthy idle TLS sockets.
    // An application-level PING is more portable than relying only on TCP
    // keepalive and lets node-redis detect a dead connection promptly.
    pingInterval: pingIntervalMs,
    // Quota enforcement must fail closed while Redis reconnects. Do not retain
    // an unbounded queue of stale admission requests in process memory.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: connectTimeoutMs,
      keepAlive: 5_000,
      reconnectStrategy: retries => {
        const backoff = Math.min(250 * (2 ** Math.min(retries, 6)), reconnectMaxMs);
        const jitter = Math.floor(Math.max(0, Math.min(1, random())) * 250);
        return Math.min(backoff + jitter, reconnectMaxMs);
      },
    },
  };
}

export async function connectRedisAtStartup(client, timeoutMs = 30_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis startup connection timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([client.connect(), timeout]);
  } catch (error) {
    if (client.isOpen) await client.disconnect().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class MemoryAdmissionStore {
  constructor({
    maxConcurrent = 8, maxRequests = 1000, maxTokens = 20_000_000, maxSpendMicros = 100_000_000,
    maxConcurrentPerSubject = 1, maxRequestsPerSubject = 100, maxTokensPerSubject = 5_000_000,
    maxSpendMicrosPerSubject = 5_000_000, windowSeconds = 86400, leaseSeconds = 120, now = Date.now,
  } = {}) {
    this.limits = {
      maxConcurrent, maxRequests, maxTokens, maxSpendMicros,
      maxConcurrentPerSubject, maxRequestsPerSubject, maxTokensPerSubject, maxSpendMicrosPerSubject,
      windowSeconds, leaseSeconds,
    };
    this.active = new Map();
    this.used = { requests: 0, tokens: 0, spendMicros: 0 };
    this.subjects = new Map();
    this.now = now;
    this.windowStartedAt = now();
  }
  rotateWindow() {
    if (this.now() - this.windowStartedAt < this.limits.windowSeconds * 1000) return;
    this.windowStartedAt = this.now();
    this.used = { requests: 0, tokens: 0, spendMicros: 0 };
    for (const [key, subject] of this.subjects) this.subjects.set(key, {
      concurrent: subject.concurrent, requests: 0, tokens: 0, spendMicros: 0,
    });
  }
  async reserve({ subjectKey = 'anonymous', tokens = 0, spendMicros = 0 }) {
    this.rotateWindow();
    const subject = this.subjects.get(subjectKey) || { concurrent: 0, requests: 0, tokens: 0, spendMicros: 0 };
    // Distinct denial codes: "quota_exceeded" alone made a token/spend cap
    // denial indistinguishable from a request-count denial in production.
    if (this.active.size >= this.limits.maxConcurrent) throw new AdmissionDeniedError('quota_global_concurrency');
    if (this.used.requests + 1 > this.limits.maxRequests) throw new AdmissionDeniedError('quota_global_requests');
    if (this.used.tokens + tokens > this.limits.maxTokens) throw new AdmissionDeniedError('quota_global_tokens');
    if (this.used.spendMicros + spendMicros > this.limits.maxSpendMicros) throw new AdmissionDeniedError('quota_global_spend');
    if (subject.concurrent >= this.limits.maxConcurrentPerSubject) throw new AdmissionDeniedError('quota_subject_concurrency');
    if (subject.requests + 1 > this.limits.maxRequestsPerSubject) throw new AdmissionDeniedError('quota_subject_requests');
    if (subject.tokens + tokens > this.limits.maxTokensPerSubject) throw new AdmissionDeniedError('quota_subject_tokens');
    if (subject.spendMicros + spendMicros > this.limits.maxSpendMicrosPerSubject) throw new AdmissionDeniedError('quota_subject_spend');
    const id = crypto.randomUUID();
    this.active.set(id, { subjectKey, tokens, spendMicros });
    this.used.requests++; this.used.tokens += tokens; this.used.spendMicros += spendMicros;
    this.subjects.set(subjectKey, {
      concurrent: subject.concurrent + 1,
      requests: subject.requests + 1,
      tokens: subject.tokens + tokens,
      spendMicros: subject.spendMicros + spendMicros,
    });
    return id;
  }
  async reconcile(id, actual = {}) {
    const held = this.active.get(id); if (!held) return;
    const tokenDelta = (actual.tokens ?? held.tokens) - held.tokens;
    const spendDelta = (actual.spendMicros ?? held.spendMicros) - held.spendMicros;
    this.used.tokens += tokenDelta;
    this.used.spendMicros += spendDelta;
    const subject = this.subjects.get(held.subjectKey);
    if (subject) this.subjects.set(held.subjectKey, {
      ...subject,
      concurrent: Math.max(0, subject.concurrent - 1),
      tokens: subject.tokens + tokenDelta,
      spendMicros: subject.spendMicros + spendDelta,
    });
    this.active.delete(id);
  }
  async release(id) { return this.reconcile(id); }
}

// Atomic reservation and release. Counters use a caller-selected Redis key so
// all instances share the same deployment quota window.
export class RedisAdmissionStore {
  constructor(client, {
    key = 'draftapply:quota', maxConcurrent = 100, maxRequests = 10000,
    maxTokens = 20_000_000, maxSpendMicros = 1_000_000_000,
    maxConcurrentPerSubject = 1, maxRequestsPerSubject = 100,
    maxTokensPerSubject = 5_000_000, maxSpendMicrosPerSubject = 5_000_000,
    windowSeconds = 86400, leaseSeconds = 120,
  } = {}) {
    this.client = client;
    Object.assign(this, {
      key, maxConcurrent, maxRequests, maxTokens, maxSpendMicros,
      maxConcurrentPerSubject, maxRequestsPerSubject, maxTokensPerSubject,
      maxSpendMicrosPerSubject, windowSeconds, leaseSeconds,
    });
  }
  async reserve({ subjectKey = 'anonymous', tokens = 0, spendMicros = 0 }) {
    const id = crypto.randomUUID();
    const bucket = Math.floor(Date.now() / (this.windowSeconds * 1000));
    const globalKey = `${this.key}:window:${bucket}`;
    const subjectRedisKey = `${globalKey}:subject:${subjectKey}`;
    const holdsKey = `${this.key}:holds`;
    const expiriesKey = `${this.key}:hold-expiries`;
    const now = Date.now();
    const lua = `local expired=redis.call('ZRANGEBYSCORE',KEYS[4],'-inf',ARGV[13]); for _,hold in ipairs(expired) do local raw=redis.call('HGET',KEYS[3],hold); if raw then local ok,info=pcall(cjson.decode,raw); if not ok then info={subject=raw,global=string.match(raw,'^(.*):subject:')} end; local gc=tonumber(redis.call('HGET',info.global,'concurrent') or '0'); if gc>0 then redis.call('HINCRBY',info.global,'concurrent',-1) end; local sc=tonumber(redis.call('HGET',info.subject,'concurrent') or '0'); if sc>0 then redis.call('HINCRBY',info.subject,'concurrent',-1) end; redis.call('HDEL',KEYS[3],hold) end; redis.call('ZREM',KEYS[4],hold) end; local gc=tonumber(redis.call('HGET',KEYS[1],'concurrent') or '0'); local gr=tonumber(redis.call('HGET',KEYS[1],'requests') or '0'); local gt=tonumber(redis.call('HGET',KEYS[1],'tokens') or '0'); local gs=tonumber(redis.call('HGET',KEYS[1],'spend') or '0'); local sc=tonumber(redis.call('HGET',KEYS[2],'concurrent') or '0'); local sr=tonumber(redis.call('HGET',KEYS[2],'requests') or '0'); local st=tonumber(redis.call('HGET',KEYS[2],'tokens') or '0'); local ss=tonumber(redis.call('HGET',KEYS[2],'spend') or '0'); if gc>=tonumber(ARGV[3]) then return 'quota_global_concurrency' end; if gr+1>tonumber(ARGV[4]) then return 'quota_global_requests' end; if gt+tonumber(ARGV[1])>tonumber(ARGV[5]) then return 'quota_global_tokens' end; if gs+tonumber(ARGV[2])>tonumber(ARGV[6]) then return 'quota_global_spend' end; if sc>=tonumber(ARGV[7]) then return 'quota_subject_concurrency' end; if sr+1>tonumber(ARGV[8]) then return 'quota_subject_requests' end; if st+tonumber(ARGV[1])>tonumber(ARGV[9]) then return 'quota_subject_tokens' end; if ss+tonumber(ARGV[2])>tonumber(ARGV[10]) then return 'quota_subject_spend' end; for _,k in ipairs({KEYS[1],KEYS[2]}) do redis.call('HINCRBY',k,'concurrent',1); redis.call('HINCRBY',k,'requests',1); redis.call('HINCRBY',k,'tokens',ARGV[1]); redis.call('HINCRBY',k,'spend',ARGV[2]); redis.call('EXPIRE',k,ARGV[12]) end; redis.call('HSET',KEYS[3],ARGV[11],cjson.encode({subject=KEYS[2],global=KEYS[1],tokens=tonumber(ARGV[1]),spend=tonumber(ARGV[2])})); redis.call('ZADD',KEYS[4],ARGV[14],ARGV[11]); return 1`;
    const ok = await this.client.eval(lua, { keys: [globalKey, subjectRedisKey, holdsKey, expiriesKey], arguments: [String(tokens), String(spendMicros), String(this.maxConcurrent), String(this.maxRequests), String(this.maxTokens), String(this.maxSpendMicros), String(this.maxConcurrentPerSubject), String(this.maxRequestsPerSubject), String(this.maxTokensPerSubject), String(this.maxSpendMicrosPerSubject), id, String(this.windowSeconds * 2), String(now), String(now + this.leaseSeconds * 1000)] });
    if (ok !== 1) throw new AdmissionDeniedError(typeof ok === 'string' ? ok : 'quota_exceeded'); return id;
  }
  async release(id) {
    const holdsKey = `${this.key}:holds`;
    const expiriesKey = `${this.key}:hold-expiries`;
    const lua = `local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then redis.call('ZREM',KEYS[2],ARGV[1]); return 0 end; local ok,info=pcall(cjson.decode,raw); if not ok then info={subject=raw,global=string.match(raw,'^(.*):subject:')} end; redis.call('HDEL',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]); for _,k in ipairs({info.global,info.subject}) do local c=tonumber(redis.call('HGET',k,'concurrent') or '0'); if c>0 then redis.call('HINCRBY',k,'concurrent',-1) end end; return 1`;
    await this.client.eval(lua, { keys: [holdsKey, expiriesKey], arguments: [id] });
  }
  async reconcile(id, actual = {}) {
    const holdsKey = `${this.key}:holds`;
    const expiriesKey = `${this.key}:hold-expiries`;
    const hasActual = Number.isFinite(actual.tokens) || Number.isFinite(actual.spendMicros);
    if (!hasActual) return this.release(id);
    const lua = `local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then redis.call('ZREM',KEYS[2],ARGV[1]); return 0 end; local ok,info=pcall(cjson.decode,raw); if not ok then info={subject=raw,global=string.match(raw,'^(.*):subject:'),legacy=true} end; for _,k in ipairs({info.global,info.subject}) do if not info.legacy then local actualTokens=tonumber(ARGV[2]); if actualTokens<0 then actualTokens=tonumber(info.tokens) end; local actualSpend=tonumber(ARGV[3]); if actualSpend<0 then actualSpend=tonumber(info.spend) end; redis.call('HINCRBY',k,'tokens',actualTokens-tonumber(info.tokens)); redis.call('HINCRBY',k,'spend',actualSpend-tonumber(info.spend)) end; local c=tonumber(redis.call('HGET',k,'concurrent') or '0'); if c>0 then redis.call('HINCRBY',k,'concurrent',-1) end end; redis.call('HDEL',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1`;
    await this.client.eval(lua, {
      keys: [holdsKey, expiriesKey],
      arguments: [
        id,
        String(Number.isFinite(actual.tokens) ? Math.max(0, actual.tokens) : -1),
        String(Number.isFinite(actual.spendMicros) ? Math.max(0, actual.spendMicros) : -1),
      ],
    });
  }
}

export function admissionMiddleware(store, estimate = req => {
  const inputTokens = Math.ceil(JSON.stringify(req.body || {}).length / 3);
  // Charge a conservative worst-case reservation for every provider stage and
  // retry. We intentionally over-reserve rather than let fallback or audit
  // calls bypass token/spend caps when a provider omits usage metadata.
  const { inputMultiplier, outputReserve } = req.path === '/api/cv/tailor'
    ? { inputMultiplier: 8, outputReserve: 30_000 }
    : req.path === '/api/cv/analyze'
      ? { inputMultiplier: 5, outputReserve: 15_000 }
      : { inputMultiplier: 4, outputReserve: 12_000 };
  const tokens = inputTokens * inputMultiplier
    + Math.max(outputReserve, Math.max(0, Number(req.body?.maxTokens) || 0));
  const microsPerThousandTokens = Math.max(0, Number(process.env.ESTIMATED_COST_MICROS_PER_1K_TOKENS) || 1000);
  const identity = req.installToken?.jti || req.ip || 'anonymous';
  const subjectKey = crypto.createHash('sha256').update(String(identity)).digest('hex').slice(0, 32);
  return { subjectKey, tokens, spendMicros: Math.ceil(tokens * microsPerThousandTokens / 1000) };
}, actualUsage = () => ({})) {
  return async (req, res, next) => {
    let id;
    try { id = await store.reserve(estimate(req)); } catch (error) {
      const denied = error instanceof AdmissionDeniedError;
      if (denied) console.warn(`[admission] denied ${req.path}: ${error.code}`);
      return res.status(denied ? 429 : 503).json({
        error: denied ? 'Request quota exceeded' : 'Quota service unavailable',
        code: denied ? error.code : 'quota_store_unavailable',
      });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      // A transient Redis outage after the response must not become an
      // unhandled rejection that terminates Node. Keep the conservative
      // reservation; its lease is reclaimed by the next successful reserve.
      void store.reconcile(id, actualUsage(req)).catch(() => {});
    };
    req.admissionReservation = { id };
    // Release only after the handler finishes normally, or after request-scoped
    // cancellation has propagated to upstream fetches and their promises have
    // unwound. Route handlers call this in finally; finish is a safe fallback
    // for deterministic responses that start no upstream work.
    req.releaseAdmission = release;
    res.once('finish', release);
    const context = requestContext();
    res.once('close', () => { void waitForUpstreams(context).then(release); });
    next();
  };
}
