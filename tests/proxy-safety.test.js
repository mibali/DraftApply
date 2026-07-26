import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker, ProviderAttemptTimeoutError, RequestDeadlineError, attemptSignal, boundedTimeout,
  isCircuitFailure, recordProviderTrace, recordProviderUsage, reconciledUsage, requestSafetyMiddleware,
} from '../render-proxy/safety-runtime.js';
import { MemoryAdmissionStore } from '../render-proxy/admission-control.js';

describe('production proxy safety primitives', () => {
  it('bounds every attempt by the absolute request deadline', () => {
    const middleware = requestSafetyMiddleware({ deadlineMs: 20 });
    const req = { get: () => null };
    const res = { setHeader() {} };
    middleware(req, res, () => expect(boundedTimeout(60_000)).toBeLessThanOrEqual(20));
  });

  it('refuses work after the absolute deadline', async () => {
    const middleware = requestSafetyMiddleware({ deadlineMs: 1 });
    await new Promise(resolve => middleware({ get: () => null }, { setHeader() {} }, async () => {
      await new Promise(done => setTimeout(done, 4));
      expect(() => boundedTimeout(100)).toThrow(RequestDeadlineError);
      resolve();
    }));
  });

  it('distinguishes a provider attempt timeout from the absolute deadline', async () => {
    const middleware = requestSafetyMiddleware({ deadlineMs: 100 });
    await new Promise(resolve => middleware({ get: () => null }, { setHeader() {} }, async () => {
      const attempt = attemptSignal(2);
      await new Promise(done => attempt.signal.addEventListener('abort', done, { once: true }));
      expect(attempt.signal.reason).toBeInstanceOf(ProviderAttemptTimeoutError);
      expect(attempt.signal.reason).toMatchObject({ name: 'AbortError', status: 408 });
      attempt.cleanup();
      resolve();
    }));
  });

  it('keeps complete bounded body validation inside the provider fallback boundary', async () => {
    const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../render-proxy/server.js', import.meta.url), 'utf8'));
    expect(source).toMatch(/if \(!stream\) \{[\s\S]{0,1000}readBoundedResponseText\(response, PROVIDER_RESPONSE_MAX_BYTES\)/);
    expect(source).toContain('response.json = async () => body');
    expect(source).toContain('streamed = await consumeOpenAIStream(response.body, PROVIDER_RESPONSE_MAX_BYTES)');
    expect(source).toContain('if (!streamed.complete || !streamed.answer.trim())');
  });

  it('opens and half-opens provider/model circuits', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 10, now: () => now });
    breaker.failure('groq:model'); breaker.failure('groq:model');
    expect(breaker.permit('groq:model')).toBe(false);
    now = 10;
    expect(breaker.state('groq:model').state).toBe('half-open');
    breaker.success('groq:model');
    expect(breaker.state('groq:model').state).toBe('closed');
  });

  it('does not classify deterministic provider 4xx responses as circuit failures', () => {
    expect(isCircuitFailure({ status: 400 })).toBe(false);
    expect(isCircuitFailure({ status: 422 })).toBe(false);
    expect(isCircuitFailure({ status: 408 })).toBe(true);
    expect(isCircuitFailure({ status: 429 })).toBe(true);
    expect(isCircuitFailure({ status: 503 })).toBe(true);
  });

  it('does not classify an exhausted absolute request deadline as a circuit failure', () => {
    expect(isCircuitFailure(new RequestDeadlineError())).toBe(false);
  });

  it('reserves and releases concurrency while retaining quota usage', async () => {
    const store = new MemoryAdmissionStore({ maxConcurrent: 1, maxRequests: 2 });
    const reservation = await store.reserve({ subjectKey: 'install-a', tokens: 10 });
    await expect(store.reserve({ subjectKey: 'install-a', tokens: 1 })).rejects.toMatchObject({ code: 'quota_global_concurrency' });
    await store.release(reservation);
    await expect(store.reserve({ subjectKey: 'install-a', tokens: 1 })).resolves.toEqual(expect.any(String));
    expect(store.used.requests).toBe(2);
  });

  it('rotates memory usage windows without dropping active concurrency', async () => {
    let now = 0;
    const store = new MemoryAdmissionStore({ maxRequests: 1, maxConcurrent: 2, maxConcurrentPerSubject: 2, windowSeconds: 1, now: () => now });
    const first = await store.reserve({ subjectKey: 'a', tokens: 1 });
    now = 1001;
    const second = await store.reserve({ subjectKey: 'a', tokens: 1 });
    expect(store.active.size).toBe(2);
    await store.release(first); await store.release(second);
  });

  it('isolates per-install quotas while enforcing the global cap', async () => {
    const store = new MemoryAdmissionStore({
      maxConcurrent: 2,
      maxConcurrentPerSubject: 1,
      maxRequests: 3,
      maxRequestsPerSubject: 1,
    });
    const first = await store.reserve({ subjectKey: 'install-a', tokens: 1 });
    await expect(store.reserve({ subjectKey: 'install-a', tokens: 1 })).rejects.toMatchObject({ code: 'quota_subject_concurrency' });
    const second = await store.reserve({ subjectKey: 'install-b', tokens: 1 });
    await store.release(first);
    await store.release(second);
  });

  it('allows a legitimate CV tailoring reservation to be retried under default subject limits', async () => {
    const store = new MemoryAdmissionStore();
    const estimatedTailorTokens = 58_368;
    const estimatedTailorSpendMicros = 58_368;
    const first = await store.reserve({
      subjectKey: 'install-a', tokens: estimatedTailorTokens, spendMicros: estimatedTailorSpendMicros,
    });
    await store.release(first);
    const second = await store.reserve({
      subjectKey: 'install-a', tokens: estimatedTailorTokens, spendMicros: estimatedTailorSpendMicros,
    });
    await expect(store.release(second)).resolves.toBeUndefined();
  });

  it('reconciles usage only when every successful provider call reports it', () => {
    const middleware = requestSafetyMiddleware({ deadlineMs: 100 });
    middleware({ get: () => null }, { setHeader() {} }, () => {
      recordProviderUsage({ total_tokens: 120, cost: 0.00004 });
      recordProviderTrace({ provider: 'groq', outcome: 'success' });
      expect(reconciledUsage()).toEqual({ tokens: 120, spendMicros: 40 });
      recordProviderTrace({ provider: 'openrouter', outcome: 'success' });
      expect(reconciledUsage()).toEqual({});
    });
  });
});

describe('quota denial codes name the cap that fired', () => {
  it('distinguishes subject token and spend caps from request caps', async () => {
    const tokenStore = new MemoryAdmissionStore({ maxTokensPerSubject: 100 });
    await expect(tokenStore.reserve({ subjectKey: 'a', tokens: 101 }))
      .rejects.toMatchObject({ code: 'quota_subject_tokens' });
    const spendStore = new MemoryAdmissionStore({ maxSpendMicrosPerSubject: 100 });
    await expect(spendStore.reserve({ subjectKey: 'a', tokens: 1, spendMicros: 101 }))
      .rejects.toMatchObject({ code: 'quota_subject_spend' });
    const reqStore = new MemoryAdmissionStore({ maxRequestsPerSubject: 1, maxConcurrentPerSubject: 2 });
    const first = await reqStore.reserve({ subjectKey: 'a', tokens: 1 });
    await expect(reqStore.reserve({ subjectKey: 'a', tokens: 1 }))
      .rejects.toMatchObject({ code: 'quota_subject_requests' });
    await reqStore.release(first);
  });
});
