import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker, RequestDeadlineError, boundedTimeout, recordProviderTrace,
  recordProviderUsage, reconciledUsage, requestSafetyMiddleware,
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

  it('reserves and releases concurrency while retaining quota usage', async () => {
    const store = new MemoryAdmissionStore({ maxConcurrent: 1, maxRequests: 2 });
    const reservation = await store.reserve({ subjectKey: 'install-a', tokens: 10 });
    await expect(store.reserve({ subjectKey: 'install-a', tokens: 1 })).rejects.toMatchObject({ code: 'quota_exceeded' });
    await store.release(reservation);
    await expect(store.reserve({ subjectKey: 'install-a', tokens: 1 })).resolves.toEqual(expect.any(String));
    expect(store.used.requests).toBe(2);
  });

  it('isolates per-install quotas while enforcing the global cap', async () => {
    const store = new MemoryAdmissionStore({
      maxConcurrent: 2,
      maxConcurrentPerSubject: 1,
      maxRequests: 3,
      maxRequestsPerSubject: 1,
    });
    const first = await store.reserve({ subjectKey: 'install-a', tokens: 1 });
    await expect(store.reserve({ subjectKey: 'install-a', tokens: 1 })).rejects.toMatchObject({ code: 'quota_exceeded' });
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
