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

export class ClientCancelledError extends Error {
  constructor() { super('Client cancelled request'); this.name = 'ClientCancelledError'; this.code = 'client_cancelled'; }
}

export class ProviderAttemptTimeoutError extends Error {
  constructor() {
    super('Provider attempt timed out');
    this.name = 'AbortError';
    this.code = 'provider_attempt_timeout';
    this.status = 408;
  }
}

export function requestSafetyMiddleware({ deadlineMs = 90000 } = {}) {
  return (req, res, next) => {
    const controller = new AbortController();
    const context = {
      requestId: /^[A-Za-z0-9._:-]{1,128}$/.test(req.get('x-request-id') || '')
        ? req.get('x-request-id') : crypto.randomUUID(),
      deadlineAt: Date.now() + deadlineMs,
      providerTrace: [],
      finalProvider: null,
      usage: { tokens: 0, spendMicros: 0, attempts: 0, tokenReports: 0, costReports: 0 },
      signal: controller.signal,
      activeUpstreams: 0,
      upstreamWaiters: [],
    };
    let finished = false;
    res.once?.('finish', () => { finished = true; });
    req.once?.('aborted', () => controller.abort(new ClientCancelledError()));
    res.once?.('close', () => { if (!finished) controller.abort(new ClientCancelledError()); });
    res.setHeader('X-Request-Id', context.requestId);
    storage.run(context, next);
  };
}

export const requestContext = () => storage.getStore();
export const requestSignal = () => requestContext()?.signal;
export function waitForUpstreams(context = requestContext()) {
  if (!context || context.activeUpstreams === 0) return Promise.resolve();
  return new Promise(resolve => context.upstreamWaiters.push(resolve));
}
export const remainingMs = (context = requestContext()) => Math.max(0, (context?.deadlineAt || 0) - Date.now());
export function assertBudget(minimumMs = 1) {
  if (remainingMs() < minimumMs) throw new RequestDeadlineError();
}
export function boundedTimeout(attemptMs) {
  assertBudget();
  return Math.max(1, Math.min(Number(attemptMs) || 60000, remainingMs()));
}

export function attemptSignal(attemptMs) {
  const context = requestContext();
  const budget = remainingMs();
  const requestedTimeout = Math.max(1, Number(attemptMs) || 60000);
  const timeout = boundedTimeout(requestedTimeout); // validate before taking a lease
  const timeoutReason = requestedTimeout >= budget
    ? new RequestDeadlineError()
    : new ProviderAttemptTimeoutError();
  if (context) context.activeUpstreams++;
  const controller = new AbortController();
  const parent = requestSignal();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutReason), timeout);
  let cleaned = false;
  return {
    signal: controller.signal,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
      if (context && context.activeUpstreams > 0 && --context.activeUpstreams === 0) {
        for (const resolve of context.upstreamWaiters.splice(0)) resolve();
      }
    },
  };
}

export function isCircuitFailure(error) {
  if (error instanceof ClientCancelledError || error instanceof RequestDeadlineError) return false;
  if (requestSignal()?.aborted && (requestSignal().reason instanceof ClientCancelledError || requestSignal().reason instanceof RequestDeadlineError)) return false;
  const status = Number(error?.status);
  return !status || status === 408 || status === 429 || status >= 500;
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
