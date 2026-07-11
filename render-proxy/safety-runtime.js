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
  if (safe.outcome === 'success') context.finalProvider = { provider: safe.provider, model: safe.model, stage: safe.stage };
}

export function safetyMetadata() {
  const context = requestContext();
  return context ? { requestId: context.requestId, providerTrace: context.providerTrace, finalProvider: context.finalProvider } : {};
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
