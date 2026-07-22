import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage();

export class RequestDeadlineError extends Error {
  constructor() {
    super('Request deadline exceeded');
    this.name = 'RequestDeadlineError';
    this.code = 'request_deadline_exceeded';
  }
}

export function requestSafetyMiddleware({ deadlineMs = 90000 } = {}) {
  return (req, res, next) => {
    const context = {
      requestId: req.get('x-request-id')?.slice(0, 128) || crypto.randomUUID(),
      deadlineAt: Date.now() + deadlineMs,
      providerTrace: [],
      finalProvider: null,
      usage: { tokens: 0, spendMicros: 0, attempts: 0, tokenReports: 0, costReports: 0 },
    };
    res.setHeader('X-Request-Id', context.requestId);
    storage.run(context, next);
  };
}

export const requestContext = () => storage.getStore();
export const remainingMs = (context = requestContext()) => Math.max(0, (context?.deadlineAt || 0) - Date.now());
export function assertBudget(minimumMs = 1) {
  if (remainingMs() < minimumMs) throw new RequestDeadlineError();
}
export function boundedTimeout(attemptMs) {
  assertBudget();
  return Math.max(1, Math.min(Number(attemptMs) || 60000, remainingMs()));
}

export function recordProviderTrace(entry) {
  const context = requestContext();
  if (!context) return;
  const safe = {
    stage: String(entry.stage || 'generation'),
    provider: String(entry.provider || 'unknown'),
    model: entry.model ? String(entry.model) : undefined,
    attempt: Number(entry.attempt || 1),
    outcome: String(entry.outcome || 'unknown'),
    status: entry.status == null ? undefined : Number(entry.status),
    elapsedMs: Math.max(0, Number(entry.elapsedMs || 0)),
  };
  context.providerTrace.push(safe);
  if (['success', 'error', 'timeout'].includes(safe.outcome)) context.usage.attempts++;
  if (safe.outcome === 'success') {
    context.finalProvider = { provider: safe.provider, model: safe.model, stage: safe.stage };
  }
}

export function recordProviderUsage(usage = {}) {
  const context = requestContext();
  if (!context || !usage || typeof usage !== 'object') return;
  const tokens = Number(usage.total_tokens ?? usage.totalTokens);
  const costDollars = Number(usage.cost ?? usage.total_cost);
  if (Number.isFinite(tokens) && tokens >= 0) {
    context.usage.tokens += Math.ceil(tokens);
    context.usage.tokenReports++;
  }
  if (Number.isFinite(costDollars) && costDollars >= 0) {
    context.usage.spendMicros += Math.ceil(costDollars * 1_000_000);
    context.usage.costReports++;
  }
}

export function reconciledUsage() {
  const usage = requestContext()?.usage;
  if (!usage || usage.attempts === 0) return {};
  return {
    ...(usage.tokenReports >= usage.attempts ? { tokens: usage.tokens } : {}),
    ...(usage.costReports >= usage.attempts ? { spendMicros: usage.spendMicros } : {}),
  };
}

export function safetyMetadata() {
  const context = requestContext();
  return context ? {
    requestId: context.requestId,
    providerTrace: context.providerTrace,
    finalProvider: context.finalProvider,
    usage: {
      calls: context.usage.attempts,
      tokens: context.usage.tokens,
      spendMicros: context.usage.spendMicros,
      complete: context.usage.tokenReports >= context.usage.attempts,
    },
  } : {};
}

export function telemetry(event) {
  const context = requestContext();
  const allowed = ['stage', 'route', 'provider', 'model', 'outcome', 'latency', 'tokens', 'cost'];
  const safe = { event: 'proxy_safety', requestId: context?.requestId };
  for (const key of allowed) if (event[key] != null) safe[key] = event[key];
  console.info(JSON.stringify(safe));
}

export class CircuitBreaker {
  constructor({ store = new Map(), failureThreshold = 3, openMs = 30000, now = Date.now } = {}) {
    this.store = store; this.failureThreshold = failureThreshold; this.openMs = openMs; this.now = now;
  }
  state(key) {
    const value = this.store.get(key) || { failures: 0, state: 'closed' };
    if (value.state === 'open' && this.now() >= value.retryAt) return { ...value, state: 'half-open' };
    return value;
  }
  permit(key) { return this.state(key).state !== 'open'; }
  success(key) { this.store.set(key, { failures: 0, state: 'closed' }); }
  failure(key) {
    const old = this.state(key); const failures = old.failures + 1;
    this.store.set(key, failures >= this.failureThreshold || old.state === 'half-open'
      ? { failures, state: 'open', retryAt: this.now() + this.openMs }
      : { failures, state: 'closed' });
  }
}

export class RedisCircuitBreaker {
  constructor(client, { keyPrefix = 'draftapply:circuit', failureThreshold = 3, openMs = 30000, halfOpenLeaseMs = 95000 } = {}) {
    this.client = client;
    this.keyPrefix = keyPrefix;
    this.failureThreshold = failureThreshold;
    this.openMs = openMs;
    this.halfOpenLeaseMs = halfOpenLeaseMs;
  }
  key(value) {
    const digest = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
    return `${this.keyPrefix}:${digest}`;
  }
  async permit(value) {
    const lua = `local state=redis.call('HGET',KEYS[1],'state'); if not state or state=='closed' then return 1 end; if state=='half-open' then return 0 end; local retryAt=tonumber(redis.call('HGET',KEYS[1],'retryAt') or '0'); if retryAt<=tonumber(ARGV[1]) then redis.call('HSET',KEYS[1],'state','half-open'); redis.call('PEXPIRE',KEYS[1],ARGV[2]); return 1 end; return 0`;
    return Boolean(await this.client.eval(lua, {
      keys: [this.key(value)],
      arguments: [String(Date.now()), String(this.halfOpenLeaseMs)],
    }));
  }
  async success(value) {
    await this.client.del(this.key(value));
  }
  async failure(value) {
    const lua = `local state=redis.call('HGET',KEYS[1],'state') or 'closed'; local failures=tonumber(redis.call('HGET',KEYS[1],'failures') or '0')+1; if state=='half-open' or failures>=tonumber(ARGV[1]) then redis.call('HSET',KEYS[1],'state','open','failures',failures,'retryAt',tonumber(ARGV[2])+tonumber(ARGV[3])); redis.call('PEXPIRE',KEYS[1],math.max(tonumber(ARGV[3])*2,tonumber(ARGV[4]))) else redis.call('HSET',KEYS[1],'state','closed','failures',failures); redis.call('PEXPIRE',KEYS[1],math.max(tonumber(ARGV[3])*2,tonumber(ARGV[4]))) end; return failures`;
    await this.client.eval(lua, {
      keys: [this.key(value)],
      arguments: [String(this.failureThreshold), String(Date.now()), String(this.openMs), String(this.halfOpenLeaseMs)],
    });
  }
}
