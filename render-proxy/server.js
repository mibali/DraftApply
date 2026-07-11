import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createClient } from 'redis';
import {
  admissionMiddleware, connectRedisAtStartup, MemoryAdmissionStore, RedisAdmissionStore, redisClientOptions,
} from './admission-control.js';
import {
  CircuitBreaker, RedisCircuitBreaker, RequestDeadlineError, assertBudget, boundedTimeout,
  recordProviderTrace, recordProviderUsage, reconciledUsage, remainingMs,
  requestSafetyMiddleware, safetyMetadata, telemetry,
} from './safety-runtime.js';
import { CVParser } from '../shared/cv-parser.js';
import { JDParser } from '../shared/jd-parser.js';
import { CVTailor } from '../shared/cv-tailor.js';
import { evaluateAnswer, buildRegenerationFeedback } from '../shared/answer-evaluator.js';
import { buildGroundingContext, validateApplicationAnswer } from '../shared/grounding-harness.js';
import {
  rebuildTailoredCvAgentContext,
  runApplicationAnswerAgents,
  runTailoredCvAgents,
} from '../shared/agent-workflows.js';
import {
  buildEvidenceRetrievalInputs,
  rerankMatchMapWithEmbeddings,
} from '../shared/evidence-retrieval.js';
import {
  isHfInferenceRouterUrl,
  localEmbeddingsUrl,
  buildEmbeddingsRequestBody,
  parseEmbeddingsResponse,
} from '../shared/hf-inference-client.js';
import {
  coercePositiveInteger,
  providerEndpoint,
  OpenRouterFreeModelCache,
  PREFERRED_OPENROUTER_FREE_MODELS,
  buildOpenRouterFallbackModelOrder,
  isRetryableOpenRouterModelError,
  shouldUseOpenRouterFallback,
} from './llm-fallback.js';
import {
  DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
  LIGHTWEIGHT_MODEL_RECOMMENDATION,
  WORKFLOW_AGENT_CHAINS,
  DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL,
  selectEmbeddingRoute,
  selectModelRoute,
} from './model-router.js';

const PORT = Number(process.env.PORT || 10000);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_URL = providerEndpoint(process.env.GROQ_API_URL, 'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_URL');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = providerEndpoint(process.env.OPENROUTER_API_URL, 'https://openrouter.ai/api/v1/chat/completions', 'OPENROUTER_API_URL');
const OPENROUTER_MODELS_URL = providerEndpoint(process.env.OPENROUTER_MODELS_URL, 'https://openrouter.ai/api/v1/models', 'OPENROUTER_MODELS_URL');
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || '').trim();
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || 'https://draftapply.com';
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'DraftApply';
const OPENROUTER_TAILOR_FALLBACK = !/^false$/i.test(process.env.OPENROUTER_TAILOR_FALLBACK || 'true');
// Structured CV generation (docs/structured-cv-generation.md): the model
// returns only mutable content as JSON against a locked skeleton, and the
// final text is rendered deterministically. Default on; disabling it disables
// hosted CV generation rather than falling back to model-authored free text.
const STRUCTURED_CV_GENERATION = !/^false$/i.test(process.env.STRUCTURED_CV_GENERATION || 'true');
const OPENROUTER_USE_MODELS_ARRAY = /^true$/i.test(process.env.OPENROUTER_USE_MODELS_ARRAY || 'false');
const OPENROUTER_REQUIRE_DATA_PRIVACY = true;
const OPENROUTER_PROVIDER_SORT = (process.env.OPENROUTER_PROVIDER_SORT || 'throughput').trim();
const OPENROUTER_MODEL_CACHE_TTL_MS = Number(process.env.OPENROUTER_MODEL_CACHE_TTL_MS || 10 * 60 * 1000);
const OPENROUTER_MAX_FALLBACK_MODELS = coercePositiveInteger(process.env.OPENROUTER_MAX_FALLBACK_MODELS, 6);
const LOCAL_LLM_BASE_URL = (process.env.LOCAL_LLM_BASE_URL || '').trim();
const LOCAL_LLM_API_KEY = process.env.LOCAL_LLM_API_KEY || 'local';
const LOCAL_LLM_MODEL = (process.env.LOCAL_LLM_MODEL || DEFAULT_LIGHTWEIGHT_CHAT_MODEL).trim();
const LOCAL_LLM_PREFER_FOR_GENERATION = /^true$/i.test(process.env.LOCAL_LLM_PREFER_FOR_GENERATION || 'false');
const LOCAL_EMBEDDING_BASE_URL = (process.env.LOCAL_EMBEDDING_BASE_URL || '').trim();
const LOCAL_EMBEDDING_API_KEY = process.env.LOCAL_EMBEDDING_API_KEY || LOCAL_LLM_API_KEY;
const LOCAL_EMBEDDING_MODEL = (process.env.LOCAL_EMBEDDING_MODEL || DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL).trim();
const LOCAL_EMBEDDING_TIMEOUT_MS = coercePositiveInteger(process.env.LOCAL_EMBEDDING_TIMEOUT_MS, 12000);
// Recalibrated from live testing against mxbai-embed-large-v1 (see
// shared/evidence-retrieval-eval-fixtures.js / npm run eval:evidence-retrieval).
// The prior 0.68/0.54 defaults were tuned without ever benchmarking a live
// model and rejected almost every true match. 0.60/0.50 keeps deliberate
// margin below the fixture's razor-thin best-fit (0.576) since that was
// measured on only 8 labeled cases - not tight enough to hardcode exactly.
const LOCAL_EMBEDDING_PROMOTE_THRESHOLD = Number(process.env.LOCAL_EMBEDDING_PROMOTE_THRESHOLD || 0.60);
const LOCAL_EMBEDDING_ENRICH_THRESHOLD = Number(process.env.LOCAL_EMBEDDING_ENRICH_THRESHOLD || 0.50);
const TOKEN_SECRET = process.env.TOKEN_SECRET;
const ALLOW_LEGACY_RAW_PROMPTS = /^true$/i.test(process.env.ALLOW_LEGACY_RAW_PROMPTS || 'false');
const REQUEST_DEADLINE_MS = coercePositiveInteger(process.env.REQUEST_DEADLINE_MS, 90000);
const OPENROUTER_ZDR_REQUIRED = true;
const REDIS_URL = (process.env.REDIS_URL || '').trim();
const REQUIRE_DURABLE_QUOTAS = /^true$/i.test(process.env.REQUIRE_DURABLE_QUOTAS || (process.env.NODE_ENV === 'production' ? 'true' : 'false'));
const REDIS_PING_INTERVAL_MS = coercePositiveInteger(process.env.REDIS_PING_INTERVAL_MS, 60_000);
const REDIS_CONNECT_TIMEOUT_MS = coercePositiveInteger(process.env.REDIS_CONNECT_TIMEOUT_MS, 10_000);
const REDIS_RECONNECT_MAX_MS = coercePositiveInteger(process.env.REDIS_RECONNECT_MAX_MS, 10_000);
const REDIS_STARTUP_TIMEOUT_MS = coercePositiveInteger(process.env.REDIS_STARTUP_TIMEOUT_MS, 30_000);

// Recipe module – default is the bundled open-source recipe. Set RECIPE_PATH to override.
const RECIPE_PATH = process.env.RECIPE_PATH || './recipe/index.js';
let recipe;
try {
  const absPath = resolve(RECIPE_PATH);
  recipe = await import(pathToFileURL(absPath).href);
  console.log(`Recipe loaded from ${RECIPE_PATH}`);
} catch (err) {
  console.error(`Failed to load recipe from ${RECIPE_PATH}: ${err.message}`);
  console.error('Falling back to bundled recipe.');
  recipe = await import('./recipe/index.js');
}

if ((!GROQ_API_KEY && !OPENROUTER_API_KEY && !LOCAL_LLM_BASE_URL) || !TOKEN_SECRET) {
  console.error('Missing required env vars: TOKEN_SECRET and at least one LLM route (GROQ_API_KEY, OPENROUTER_API_KEY, or LOCAL_LLM_BASE_URL) must be set. Exiting.');
  process.exit(1);
}

const SERVER_STARTED_AT = new Date().toISOString();

let admissionStore;
let redisClient;
if (REDIS_URL) {
  redisClient = createClient(redisClientOptions(REDIS_URL, {
    pingIntervalMs: REDIS_PING_INTERVAL_MS,
    connectTimeoutMs: REDIS_CONNECT_TIMEOUT_MS,
    reconnectMaxMs: REDIS_RECONNECT_MAX_MS,
  }));
  let lastRedisErrorAt = 0;
  let lastRedisRecoveryAt = 0;
  let suppressedRedisErrors = 0;
  let redisReadyOnce = false;
  redisClient.on('error', error => {
    const now = Date.now();
    if (now - lastRedisErrorAt < 30_000) {
      suppressedRedisErrors += 1;
      return;
    }
    const repeated = suppressedRedisErrors ? ` (${suppressedRedisErrors} repeated errors suppressed)` : '';
    console.error(`[DraftApply] Redis safety store unavailable${repeated}:`, error.message);
    lastRedisErrorAt = now;
    suppressedRedisErrors = 0;
  });
  redisClient.on('ready', () => {
    if (redisReadyOnce && lastRedisErrorAt && lastRedisRecoveryAt !== lastRedisErrorAt) {
      const repeated = suppressedRedisErrors ? `; ${suppressedRedisErrors} repeated errors suppressed` : '';
      console.log(`[DraftApply] Redis safety store reconnected${repeated}.`);
      lastRedisRecoveryAt = lastRedisErrorAt;
    }
    redisReadyOnce = true;
    suppressedRedisErrors = 0;
  });
  await connectRedisAtStartup(redisClient, REDIS_STARTUP_TIMEOUT_MS);
  admissionStore = new RedisAdmissionStore(redisClient);
} else {
  if (REQUIRE_DURABLE_QUOTAS && (GROQ_API_KEY || OPENROUTER_API_KEY)) {
    console.error('Durable quota storage is required for paid providers; configure REDIS_URL or explicitly set REQUIRE_DURABLE_QUOTAS=false for local development.');
    process.exit(1);
  }
  admissionStore = new MemoryAdmissionStore();
}
const circuitOptions = {
  failureThreshold: coercePositiveInteger(process.env.CIRCUIT_FAILURE_THRESHOLD, 3),
  openMs: coercePositiveInteger(process.env.CIRCUIT_OPEN_MS, 30000),
  halfOpenLeaseMs: REQUEST_DEADLINE_MS + 5000,
};
const circuitBreaker = redisClient
  ? new RedisCircuitBreaker(redisClient, circuitOptions)
  : new CircuitBreaker(circuitOptions);

const app = express();
app.disable('x-powered-by');
// Render (and most PaaS/load-balancer setups) sit exactly one reverse-proxy
// hop in front of this app. Without this, Express's req.ip resolves to that
// proxy's own address for every caller - not the real client - which
// collapses every per-IP rate limiter (registerLimiter, generateLimiter,
// healthProbeLimiter) into one shared global bucket instead of isolating
// callers from each other. `1` trusts exactly the first hop's
// X-Forwarded-For entry; it must not be set to `true` (trust the whole
// chain), which would let a client spoof its own IP via that header.
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'RateLimit-Policy']
}));
app.use(express.json({ limit: '1mb' }));
app.use(requestSafetyMiddleware({ deadlineMs: REQUEST_DEADLINE_MS }));

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signToken(payloadObj) {
  const payloadB64 = base64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest();
  return `${payloadB64}.${base64url(sig)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'format' };
  const [payloadB64, sigB64] = parts;
  const expectedSig = base64url(crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest());
  const expectedBuf = Buffer.from(expectedSig);
  const actualBuf = Buffer.from(sigB64);
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: 'sig' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'expired' };
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return { ok: false, reason: 'iat' };
  if (typeof payload.jti !== 'string' || payload.jti.length < 8) return { ok: false, reason: 'jti' };

  return { ok: true, payload };
}

function getBearerToken(req) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

class LLMProviderError extends Error {
  constructor(provider, status, detail = '', retryAfterMs = null, model = null) {
    super(`${provider} request failed${status ? ` (${status})` : ''}`);
    this.name = 'LLMProviderError';
    this.provider = provider;
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
    this.model = model;
  }
}

const openRouterModelCache = new OpenRouterFreeModelCache({
  fetchFn: fetch,
  apiKey: OPENROUTER_API_KEY,
  modelsUrl: OPENROUTER_MODELS_URL,
  ttlMs: Number.isFinite(OPENROUTER_MODEL_CACHE_TTL_MS) ? OPENROUTER_MODEL_CACHE_TTL_MS : 10 * 60 * 1000,
});

function formatRetryAfter(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';

  const totalSeconds = Math.max(1, Math.ceil(value / 1000));
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0
      ? `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${seconds === 1 ? '' : 's'}`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0
    ? `${hours} hour${hours === 1 ? '' : 's'} ${remainderMinutes} minute${remainderMinutes === 1 ? '' : 's'}`
    : `${hours} hour${hours === 1 ? '' : 's'}`;
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

function retryAfterMsFromHeaders(headers) {
  const retryAfter = parseRetryAfterMs(headers?.get?.('Retry-After') || headers?.get?.('retry-after'));
  if (retryAfter != null) return retryAfter;

  const reset = headers?.get?.('RateLimit-Reset') || headers?.get?.('X-RateLimit-Reset') || headers?.get?.('x-ratelimit-reset');
  if (!reset) return null;
  const resetNumber = Number(reset);
  if (!Number.isFinite(resetNumber)) return null;

  // Some providers send seconds-until-reset; others send Unix seconds.
  return resetNumber > 1e9
    ? Math.max(0, resetNumber * 1000 - Date.now())
    : Math.max(0, resetNumber * 1000);
}

function retryAfterMsFromProviderDetail(detail = '') {
  const text = String(detail || '');
  const match = text.match(/try again in\s+((?:(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*)?(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?)/i);
  if (!match) return null;

  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const ms = ((hours * 60 * 60) + (minutes * 60) + seconds) * 1000;
  return ms > 0 ? ms : null;
}

function logLLMAttempt({ provider, model, attempt, outcome, status, fallbackFrom, elapsedMs }) {
  const entry = {
    stage: 'generation',
    provider,
    model,
    attempt,
    outcome,
    status: status || undefined,
    fallbackFrom: fallbackFrom || undefined,
    elapsedMs,
  };
  recordProviderTrace(entry);
  telemetry({ stage: entry.stage, provider, model, outcome, latency: elapsedMs });
}

function llmErrorResponse(error, context = {}) {
  const provider = error?.provider || 'provider';
  const status = Number(error?.status);
  const fallbackDisabled = context.allowFallback === false && provider === 'groq' && OPENROUTER_API_KEY;
  const retryAfter = formatRetryAfter(error?.retryAfterMs);
  const retryText = retryAfter ? ` Try again in ${retryAfter}.` : ' Try again shortly.';

  if (status === 429) {
    return {
      status: 429,
      body: {
        error: fallbackDisabled
          ? `Groq rate limit reached. OpenRouter fallback is disabled for Tailor CV to protect CV quality.${retryText} You can enable OPENROUTER_TAILOR_FALLBACK=true if you want Tailor CV to use OpenRouter as a backup.`
          : `${provider === 'openrouter' ? 'OpenRouter' : 'Groq'} rate limit reached.${retryText}`,
        provider,
        retryAfterMs: Number.isFinite(Number(error?.retryAfterMs)) ? Number(error.retryAfterMs) : undefined,
      },
    };
  }

  return {
    status: 502,
    body: {
      error: fallbackDisabled
        ? `Groq is temporarily unavailable. OpenRouter fallback is disabled for Tailor CV to protect CV quality.${retryText} You can enable OPENROUTER_TAILOR_FALLBACK=true if you want Tailor CV to use OpenRouter as a backup.`
        : `${provider === 'openrouter' ? 'OpenRouter' : 'Groq'} is temporarily unavailable.`,
      provider,
    },
  };
}

function llmProviderConfig(provider, model) {
  if (provider === 'local-openai') {
    return {
      provider,
      apiKey: LOCAL_LLM_API_KEY,
      model: model || LOCAL_LLM_MODEL,
      url: localChatCompletionsUrl(LOCAL_LLM_BASE_URL),
      headers: {},
    };
  }

  if (provider === 'groq') {
    return {
      provider,
      apiKey: GROQ_API_KEY,
      model: GROQ_MODEL,
      url: GROQ_API_URL,
      headers: {},
    };
  }

  return {
    provider: 'openrouter',
    apiKey: OPENROUTER_API_KEY,
    model: model || OPENROUTER_MODEL || 'openrouter/free',
    url: OPENROUTER_API_URL,
    headers: {
      'HTTP-Referer': OPENROUTER_SITE_URL,
      'X-Title': OPENROUTER_APP_NAME,
    },
  };
}

function localChatCompletionsUrl(rawBaseUrl) {
  const base = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

async function callEmbeddingEndpoint(texts, {
  timeoutMs = LOCAL_EMBEDDING_TIMEOUT_MS,
  model = LOCAL_EMBEDDING_MODEL,
} = {}) {
  const input = (Array.isArray(texts) ? texts : [])
    .map(text => String(text || '').trim())
    .filter(Boolean);
  if (!LOCAL_EMBEDDING_BASE_URL || input.length === 0) return null;

  const useHfNativeShape = isHfInferenceRouterUrl(LOCAL_EMBEDDING_BASE_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedTimeout(timeoutMs));
  const startedAt = Date.now();
  try {
    const response = await fetch(localEmbeddingsUrl(LOCAL_EMBEDDING_BASE_URL, model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LOCAL_EMBEDDING_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify(buildEmbeddingsRequestBody(useHfNativeShape, model, input)),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LLMProviderError('local-openai-embeddings', response.status, detail.slice(0, 500), null, model);
    }

    const data = await response.json();
    const embeddings = parseEmbeddingsResponse(useHfNativeShape, data);

    if (embeddings.length !== input.length) {
      throw new LLMProviderError('local-openai-embeddings', 502, 'Embedding count mismatch', null, model);
    }

    logLLMAttempt({
      provider: 'local-openai-embeddings',
      model,
      attempt: 1,
      outcome: 'success',
      elapsedMs: Date.now() - startedAt,
    });

    return embeddings;
  } catch (error) {
    if (error?.name === 'AbortError') {
      logLLMAttempt({
        provider: 'local-openai-embeddings',
        model,
        attempt: 1,
        outcome: 'timeout',
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (error?.name === 'AbortError' && remainingMs() <= 0) throw new RequestDeadlineError();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Opt-in liveness check for /api/health?probe=embedding. Makes one real
// embedding call so operators can distinguish "env var is set" from "the
// endpoint actually works" (right host shape, token, and a responding model),
// without every health hit paying for an external round-trip.
async function probeEmbeddingLiveness() {
  if (!LOCAL_EMBEDDING_BASE_URL) {
    return { configured: false, status: 'not_configured' };
  }
  const startedAt = Date.now();
  try {
    const vectors = await callEmbeddingEndpoint(['DraftApply embedding liveness probe.']);
    const dimensions = Array.isArray(vectors?.[0]) ? vectors[0].length : 0;
    if (!dimensions) {
      return { configured: true, status: 'error', reason: 'Endpoint returned no usable vector.', elapsedMs: Date.now() - startedAt };
    }
    return { configured: true, status: 'live', model: LOCAL_EMBEDDING_MODEL, dimensions, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `Timed out after ${LOCAL_EMBEDDING_TIMEOUT_MS}ms.`
      : String(error?.message || error).slice(0, 200);
    return { configured: true, status: 'error', reason, elapsedMs: Date.now() - startedAt };
  }
}

async function callProviderChat(provider, {
  messages,
  temperature = 0.7,
  maxTokens,
  stream = false,
  timeoutMs = 60000,
  model,
  models,
  providerPreferences,
  metadata = false,
  attempt = 1,
  fallbackFrom = null,
  responseFormat = null,
}) {
  const config = llmProviderConfig(provider, model);
  if (!config.apiKey) {
    throw new LLMProviderError(provider, 0, 'Missing API key', null, config.model);
  }
  const useModelsArray = provider === 'openrouter' && Array.isArray(models) && models.length > 0;
  if (!config.model && !useModelsArray) {
    throw new LLMProviderError(provider, 0, 'Missing model', null, config.model);
  }

  assertBudget();
  const circuitKey = `${provider}:${config.model || (models || []).join(',')}`;
  if (!await circuitBreaker.permit(circuitKey)) throw new LLMProviderError(provider, 503, 'Circuit open', null, config.model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedTimeout(timeoutMs));
  const startedAt = Date.now();
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...(metadata ? { 'X-OpenRouter-Metadata': 'enabled' } : {}),
        ...config.headers,
      },
      signal: controller.signal,
      body: JSON.stringify({
        ...(useModelsArray ? { models } : { model: config.model }),
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(providerPreferences ? { provider: providerPreferences } : {}),
        // JSON mode only on Groq: OpenRouter free-tier fallback models vary
        // in support and a 400 there would burn the fallback chain. The
        // structured path always salvage-parses regardless, so omitting it
        // for other providers costs nothing but a lower JSON hit rate.
        ...(responseFormat && provider === 'groq' ? { response_format: responseFormat } : {}),
        stream,
        ...(stream && provider === 'groq' ? { stream_options: { include_usage: true } } : {}),
        messages,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryAfterMs = retryAfterMsFromHeaders(response.headers) ?? retryAfterMsFromProviderDetail(text);
      const attemptedModel = useModelsArray ? models.join(' > ') : config.model;
      logLLMAttempt({ provider, model: attemptedModel, attempt, outcome: 'error', status: response.status, fallbackFrom, elapsedMs: Date.now() - startedAt });
      throw new LLMProviderError(provider, response.status, text.slice(0, 500), retryAfterMs, attemptedModel);
    }

    const requestedModel = useModelsArray ? models[0] : config.model;
    let finalized = false;
    const markSuccess = async (actualModel = requestedModel) => {
      if (finalized) return;
      finalized = true;
      // Admission already succeeded before this provider call. If Redis drops
      // mid-request, do not discard a complete paid-provider response merely
      // because distributed circuit telemetry cannot be updated.
      try { await circuitBreaker.success(circuitKey); } catch {}
      logLLMAttempt({ provider, model: actualModel, attempt, outcome: 'success', fallbackFrom, elapsedMs: Date.now() - startedAt });
    };
    const markFailure = async (error, actualModel = requestedModel) => {
      if (finalized) return;
      finalized = true;
      try { await circuitBreaker.failure(circuitKey); } catch {}
      logLLMAttempt({
        provider,
        model: actualModel,
        attempt,
        outcome: error?.name === 'AbortError' ? 'timeout' : 'error',
        status: error?.status,
        fallbackFrom,
        elapsedMs: Date.now() - startedAt,
      });
    };
    const originalJson = response.json.bind(response);
    response.json = async () => {
      try {
        const body = await originalJson();
        recordProviderUsage(body?.usage);
        await markSuccess(body?.model || requestedModel);
        return body;
      } catch (error) {
        await markFailure(error);
        throw error;
      }
    };
    return {
      response,
      provider: config.provider,
      model: requestedModel,
      requestedModels: useModelsArray ? models : undefined,
      markSuccess,
      markFailure,
    };
  } catch (error) {
    try { await circuitBreaker.failure(circuitKey); } catch {}
    if (error?.name === 'AbortError') {
      logLLMAttempt({
        provider,
        model: useModelsArray ? models.join(' > ') : config.model,
        attempt,
        outcome: 'timeout',
        fallbackFrom,
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw error;
  }
}

async function getOpenRouterFallbackModelOrder() {
  assertBudget();
  const models = await openRouterModelCache.getModels({ timeoutMs: boundedTimeout(10000) });
  assertBudget();
  const preferred = OPENROUTER_MODEL
    ? [OPENROUTER_MODEL, ...PREFERRED_OPENROUTER_FREE_MODELS.filter(model => model !== OPENROUTER_MODEL)]
    : PREFERRED_OPENROUTER_FREE_MODELS;
  const order = buildOpenRouterFallbackModelOrder(models, preferred);
  const orderWithConfiguredModel = OPENROUTER_MODEL && !order.includes(OPENROUTER_MODEL)
    ? [OPENROUTER_MODEL, ...order]
    : order;
  return orderWithConfiguredModel.slice(0, OPENROUTER_MAX_FALLBACK_MODELS);
}

async function callOpenRouterFreeFallback(options, { callStart, fallbackFrom = 'groq' } = {}) {
  let orderedModels;
  try {
    orderedModels = await getOpenRouterFallbackModelOrder();
  } catch (error) {
    if (error instanceof RequestDeadlineError || (error?.name === 'AbortError' && remainingMs() <= 0)) throw new RequestDeadlineError();
    throw new LLMProviderError('openrouter', 0, error.message || 'Could not load OpenRouter free model catalogue');
  }
  if (Number.isFinite(Number(options.maxFallbackModels)) && Number(options.maxFallbackModels) > 0) {
    orderedModels = orderedModels.slice(0, Number(options.maxFallbackModels));
  }
  if (orderedModels.length === 0) {
    throw new LLMProviderError('openrouter', 0, 'No free OpenRouter text models are currently available');
  }

  const providerPreferences = {
    allow_fallbacks: true,
    sort: OPENROUTER_PROVIDER_SORT || 'throughput',
    ...(OPENROUTER_REQUIRE_DATA_PRIVACY ? { data_collection: 'deny' } : {}),
    ...(OPENROUTER_ZDR_REQUIRED ? { zdr: true } : {}),
  };

  if (OPENROUTER_USE_MODELS_ARRAY) {
    try {
      return {
        ...(await callProviderChat('openrouter', {
          ...options,
          models: orderedModels,
          providerPreferences,
          metadata: true,
          timeoutMs: Math.max(8000, options.fallbackTimeoutMs || options.timeoutMs || 60000),
          attempt: 1,
          fallbackFrom,
        })),
        fallbackFrom,
        openRouterStrategy: 'models-array',
        openRouterModels: orderedModels,
      };
    } catch (error) {
      if (Number(error?.status) === 401 || Number(error?.status) === 403) throw error;
      if (!isRetryableOpenRouterModelError(error)) throw error;
      console.warn(`[DraftApply] OpenRouter models-array fallback failed (${error.status || error.name || 'error'}); trying manual model loop.`);
    }
  }

  let lastError = null;
  for (let i = 0; i < orderedModels.length; i += 1) {
    assertBudget();
    const model = orderedModels[i];
    const timeoutMs = Math.max(8000, options.fallbackTimeoutMs || options.timeoutMs || 60000);
    try {
      return {
        ...(await callProviderChat('openrouter', {
          ...options,
          model,
          providerPreferences,
          metadata: true,
          timeoutMs,
          attempt: i + 1,
          fallbackFrom,
        })),
        fallbackFrom,
        openRouterStrategy: 'manual-loop',
        openRouterModels: orderedModels,
      };
    } catch (error) {
      lastError = error;
      if (Number(error?.status) === 401 || Number(error?.status) === 403) throw error;
      if (!isRetryableOpenRouterModelError(error)) throw error;
      console.warn(`[DraftApply] OpenRouter model ${model} failed (${error.status || error.name || 'error'}); trying next free model.`);
    }
  }

  throw lastError || new LLMProviderError('openrouter', 0, 'All OpenRouter free models failed');
}

async function callChatCompletionWithFallback(options) {
  assertBudget();
  const route = selectModelRoute(options.workflow || 'application_answer', {
    hasLocal: Boolean(LOCAL_LLM_BASE_URL),
    hasHosted: Boolean(GROQ_API_KEY || OPENROUTER_API_KEY),
    preferLocalForGeneration: LOCAL_LLM_PREFER_FOR_GENERATION,
    localModel: LOCAL_LLM_MODEL,
  });

  if (route.provider === 'local-openai') {
    try {
      return {
        ...(await callProviderChat('local-openai', {
          ...options,
          model: route.model,
          attempt: 1,
        })),
        fallbackFrom: null,
        route,
      };
    } catch (error) {
      if (!GROQ_API_KEY && !OPENROUTER_API_KEY) throw error;
      console.warn(`[DraftApply] Local lightweight model ${route.model} failed (${error.status || error.name || 'error'}); falling back to hosted proxy path.`);
    }
  }

  const primary = GROQ_API_KEY ? 'groq' : 'openrouter';
  const callStart = Date.now();
  try {
    if (primary === 'openrouter') return { ...(await callOpenRouterFreeFallback(options, { callStart, fallbackFrom: null })), fallbackFrom: null, route };
    return { ...(await callProviderChat(primary, { ...options, attempt: 1 })), fallbackFrom: null, route };
  } catch (error) {
    if (error instanceof RequestDeadlineError || error?.name === 'AbortError') {
      if (error instanceof RequestDeadlineError) throw error;
      try { assertBudget(); } catch (deadline) { throw deadline; }
    }
    const canFallback = shouldUseOpenRouterFallback(error, {
      primary,
      hasOpenRouter: Boolean(OPENROUTER_API_KEY),
      allowFallback: options.allowFallback,
    });
    if (!canFallback) throw error;

    console.warn(`[DraftApply] Groq ${error.status || error.name || 'error'}; falling back to OpenRouter free models.`);
    return { ...(await callOpenRouterFreeFallback(options, { callStart, fallbackFrom: primary })), route };
  }
}

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const t = getBearerToken(req) || 'no-token';
    return `${t}:${req.ip}`;
  }
});
const costlyAdmission = admissionMiddleware(admissionStore, undefined, reconciledUsage);

// /api/health itself is intentionally open (no auth, no limiter) for uptime
// monitors. But ?probe=embedding makes one real, billed call to the
// configured embedding provider - without a limiter here, an unauthenticated
// caller could loop that query param to run up the operator's provider bill.
const healthProbeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

function authRequired(req, res, next) {
  if (!TOKEN_SECRET) return res.status(500).json({ error: 'Server misconfigured' });
  const t = getBearerToken(req);
  const v = verifyToken(t);
  if (!v.ok) return res.status(401).json({ error: 'Unauthorized', reason: v.reason });
  req.installToken = v.payload;
  next();
}

// Only gate the paid ?probe=embedding path - plain /api/health stays open
// and unthrottled for uptime monitors.
function embeddingProbeGate(req, res, next) {
  if (req.query.probe === 'embedding') {
    return healthProbeLimiter(req, res, () => costlyAdmission(req, res, next));
  }
  return next();
}

app.get('/api/health', embeddingProbeGate, async (req, res) => {
  const applicationRoute = selectModelRoute('application_answer', {
    hasLocal: Boolean(LOCAL_LLM_BASE_URL),
    hasHosted: Boolean(GROQ_API_KEY || OPENROUTER_API_KEY),
    preferLocalForGeneration: LOCAL_LLM_PREFER_FOR_GENERATION,
    localModel: LOCAL_LLM_MODEL,
  });
  const extractionRoute = selectModelRoute('jd_extract', {
    hasLocal: Boolean(LOCAL_LLM_BASE_URL),
    hasHosted: Boolean(GROQ_API_KEY || OPENROUTER_API_KEY),
    localModel: LOCAL_LLM_MODEL,
  });
  const embeddingRoute = selectEmbeddingRoute({
    hasEmbedding: Boolean(LOCAL_EMBEDDING_BASE_URL),
    embeddingModel: LOCAL_EMBEDDING_MODEL,
  });
  // Only make a live embedding call when explicitly requested, so the default
  // health check stays fast and free.
  const embeddingLiveness = req.query.probe === 'embedding' ? await probeEmbeddingLiveness() : undefined;
  const qualityMode = deploymentQualityMode();

  res.json({
    ok: true,
    capabilities: { apiVersion: 2, streamFinal: true, answerValidation: true },
    // Which code is actually running: Render injects RENDER_GIT_COMMIT on
    // every deploy, and startedAt shows when this process last restarted.
    // Without these there is no way to tell whether a pushed fix is live yet.
    build: {
      commit: process.env.RENDER_GIT_COMMIT || null,
      startedAt: SERVER_STARTED_AT,
    },
    safetyStore: {
      type: redisClient ? 'redis' : 'memory',
      ready: redisClient ? redisClient.isReady : true,
    },
    provider: GROQ_API_KEY ? 'groq' : OPENROUTER_API_KEY ? 'openrouter' : 'local-openai',
    model: GROQ_API_KEY ? GROQ_MODEL : OPENROUTER_API_KEY ? 'openrouter-free-dynamic' : LOCAL_LLM_MODEL,
    qualityMode,
    qualityModeReason: qualityModeReason(qualityMode),
    modelRouter: {
      applicationAnswer: applicationRoute,
      lightweightExtraction: extractionRoute,
      evidenceRetrieval: embeddingRoute,
      recommendation: LIGHTWEIGHT_MODEL_RECOMMENDATION,
      localConfigured: Boolean(LOCAL_LLM_BASE_URL),
      embeddingConfigured: Boolean(LOCAL_EMBEDDING_BASE_URL),
      embeddingThresholds: {
        promote: Number.isFinite(LOCAL_EMBEDDING_PROMOTE_THRESHOLD) ? LOCAL_EMBEDDING_PROMOTE_THRESHOLD : 0.60,
        enrich: Number.isFinite(LOCAL_EMBEDDING_ENRICH_THRESHOLD) ? LOCAL_EMBEDDING_ENRICH_THRESHOLD : 0.50,
      },
      ...(embeddingLiveness ? { embeddingLiveness } : {}),
    },
    agentChains: WORKFLOW_AGENT_CHAINS,
    fallbackProvider: GROQ_API_KEY && OPENROUTER_API_KEY ? 'openrouter' : null,
    fallbackModel: GROQ_API_KEY && OPENROUTER_API_KEY ? 'openrouter-free-dynamic' : null,
    fallbackModelPreference: GROQ_API_KEY && OPENROUTER_API_KEY ? PREFERRED_OPENROUTER_FREE_MODELS : [],
    openRouter: OPENROUTER_API_KEY ? {
      useModelsArray: OPENROUTER_USE_MODELS_ARRAY,
      providerSort: OPENROUTER_PROVIDER_SORT || 'throughput',
      requireDataPrivacy: OPENROUTER_REQUIRE_DATA_PRIVACY,
      maxFallbackModels: OPENROUTER_MAX_FALLBACK_MODELS,
    } : undefined,
  });
});

app.post('/api/register', registerLimiter, (req, res) => {
  if (!TOKEN_SECRET) return res.status(500).json({ error: 'Server misconfigured' });

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60 * 24 * 90; // 90 days
  const payload = {
    ver: 1,
    iat: now,
    exp,
    jti: crypto.randomBytes(16).toString('hex')
  };

  const token = signToken(payload);
  res.json({ token, expiresAt: exp * 1000 });
});

// ---------------------------------------------------------------------------
// Deterministic CV fact extraction
// For simple data fields (email, phone, LinkedIn, name, etc.) we skip the LLM
// entirely and extract the value directly from the CV text with regexes.
// Falls back to the LLM if nothing is found.
// ---------------------------------------------------------------------------

function extractNameFromCV(cvText) {
  const lines = (cvText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const titleRe = /\b(engineer|developer|manager|designer|analyst|director|lead|head\s+of|vp|chief|intern|consultant|architect|specialist|officer|coordinator|executive)\b/i;
  const metaRe  = /\b(resume|curriculum\s*vitae|cv|portfolio|profile)\b/i;
  for (const line of lines.slice(0, 5)) {
    if (line.length < 50 && /^[A-Z]/.test(line) && !/[@:/\d]/.test(line) && !titleRe.test(line) && !metaRe.test(line)) {
      return line;
    }
  }
  return null;
}

// Each entry: [questionPattern, extractorFn(cvText) → string|null]
const DETERMINISTIC_EXTRACTORS = [
  [/^e-?mail(\s*address)?$/i, cv => {
    const m = cv.match(/[\w.+'-]+@[\w-]+\.[\w.]+/);
    return m?.[0] ?? null;
  }],
  [/^(phone|mobile|cell(phone)?|telephone)(\s*(number))?$/i, cv => {
    // Match international (+XX ...) or common 10-digit formats
    const m = cv.match(/(?:\+\d[\d\s\-.()]{6,18}\d|\b\d{3}[\s\-.]\d{3}[\s\-.]\d{4}\b)/);
    return m ? m[0].trim() : null;
  }],
  [/^linkedin(?:\s*(?:url|link|profile|page))*$/i, cv => {
    const m = cv.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w\-_%]+\/?/i);
    return m ? normalizeExtractedUrl(m[0]) : null;
  }],
  [/^github(?:\s*(?:url|link|profile|page))*$/i, cv => {
    const m = cv.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w\-]+\/?/i);
    return m ? normalizeExtractedUrl(m[0]) : null;
  }],
  [/^(portfolio|personal\s*website?|personal\s*site|blog)(?:\s*(?:url|link|profile|page|website))*$/i, cv => {
    // Any URL that isn't LinkedIn/GitHub/Twitter
    const labeled = cv.match(/\b(?:portfolio|website|personal\s*site|blog)[:\s-]+((?:https?:\/\/|www\.)?[\w.-]+\.[a-z]{2,}(?:\/[\w\-._~:/?#%@!$&'()*+,;=]*)?)/i);
    const m = labeled?.[1]
           ?? cv.match(/(?:https?:\/\/|www\.)(?!(?:www\.)?(?:linkedin|github|twitter|x)\.com)[\w\-._~:/?#%@!$&'()*+,;=]+/i)?.[0];
    return m ? normalizeExtractedUrl(m) : null;
  }],
  [/^(twitter|x\.com|x)(?:\s*(?:handle|url|link|profile|page))*$/i, cv => {
    const m = cv.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[\w_]+/i)
           ?? cv.match(/@[\w_]{2,30}/);
    return m ? (m[0].startsWith('@') ? m[0] : normalizeExtractedUrl(m[0])) : null;
  }],
  [/^(full\s*)?name$/i, cv => extractNameFromCV(cv)],
  [/^first\s*name$/i, cv => {
    const n = extractNameFromCV(cv);
    return n ? n.split(/\s+/)[0] : null;
  }],
  [/^(last|sur|family)\s*name$/i, cv => {
    const n = extractNameFromCV(cv);
    if (!n) return null;
    const parts = n.split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : null;
  }],
];

function normalizeExtractedUrl(raw) {
  const cleaned = String(raw || '').trim().replace(/[.,;:)]+$/g, '');
  if (!cleaned) return null;
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return `https://${cleaned}`;
}

function tryDeterministicExtract(cleanedQuestion, cvText) {
  for (const [pattern, extractor] of DETERMINISTIC_EXTRACTORS) {
    if (pattern.test(cleanedQuestion)) {
      try {
        const result = extractor(cvText || '');
        if (result?.trim()) return result.trim();
      } catch { /* ignore extractor errors, fall through to LLM */ }
    }
  }
  return null;
}

function summarizeAgentRun(context = {}) {
  if (!context) return undefined;
  return {
    workflow: context.workflow,
    pipelineStages: context.pipelineStages || context.agentChain,
    agentChain: context.agentChain,
    questionType: context.questionType,
    evidenceCount: context.candidateEvidenceMap?.evidenceItems?.length,
    relevantEvidenceCount: context.relevantEvidence?.length,
    requirementCount: context.roleRequirementMap?.requirements?.length,
    matchedRequirementCount: context.matchedRequirements?.length,
    missingRequirementCount: context.gapAnalysis?.missingRequirements?.length,
    supportedKeywordCount: context.keywordOptimisation?.supportedKeywords?.length,
    riskyKeywordCount: context.keywordOptimisation?.riskyKeywords?.length,
  };
}

function deploymentQualityMode() {
  if (GROQ_API_KEY) {
    return OPENROUTER_API_KEY
      ? 'hosted_primary_with_openrouter_fallback'
      : 'hosted_primary';
  }
  if (LOCAL_LLM_BASE_URL) return 'local_private';
  if (OPENROUTER_API_KEY) {
    return OPENROUTER_MODEL
      ? 'configured_openrouter'
      : 'best_effort_free_fallback';
  }
  return 'unavailable';
}

function qualityModeReason(mode) {
  const reasons = {
    deterministic_local: 'Answered without an LLM call using local CV extraction.',
    hosted_primary: 'Groq is configured as the primary hosted generation path.',
    hosted_primary_with_openrouter_fallback: 'Groq is configured as primary, with OpenRouter available only as fallback.',
    local_private: 'A local OpenAI-compatible endpoint is configured for private generation.',
    configured_openrouter: 'A configured OpenRouter model is selected instead of random free routing.',
    best_effort_free_fallback: 'Only OpenRouter free/best-effort routing is available; reliability may vary.',
    openrouter_fallback: 'The primary hosted provider failed, so DraftApply used the ranked OpenRouter fallback chain.',
    unavailable: 'No LLM route is configured.',
  };
  return reasons[mode] || reasons.unavailable;
}

function responseQualityMode(completion = {}) {
  if (completion.provider === 'deterministic') return 'deterministic_local';
  if (completion.provider === 'local-openai') return 'local_private';
  if (completion.provider === 'groq') {
    return OPENROUTER_API_KEY ? 'hosted_primary_with_openrouter_fallback' : 'hosted_primary';
  }
  if (completion.provider === 'openrouter') {
    if (completion.fallbackFrom) return 'openrouter_fallback';
    return OPENROUTER_MODEL ? 'configured_openrouter' : 'best_effort_free_fallback';
  }
  return deploymentQualityMode();
}

function buildQualityMetadata(completion = {}) {
  const qualityMode = responseQualityMode(completion);
  return {
    qualityMode,
    qualityModeReason: qualityModeReason(qualityMode),
  };
}

function buildTruthfulnessReport(context = {}) {
  if (!context) return undefined;
  const matchMap = Array.isArray(context.matchMap) ? context.matchMap : [];
  const domainWarnings = Array.isArray(context.truthfulness?.domainCredentialWarnings)
    ? context.truthfulness.domainCredentialWarnings
    : Array.isArray(context.domainRisk?.credentialWarnings)
      ? context.domainRisk.credentialWarnings
      : [];
  const toClaim = item => ({
    requirement: compactText(item.requirement, 120),
    type: item.type,
    evidence: (Array.isArray(item.evidence) ? item.evidence : [])
      .slice(0, 3)
      .map(evidence => compactText(evidence, 160)),
    confirmedByUser: Boolean(item.confirmedByUser),
    retrievalScore: Number.isFinite(Number(item.retrievalScore)) ? Number(item.retrievalScore) : undefined,
  });

  const supportedClaims = matchMap
    .filter(item => item.allowedToMention && item.status === 'strong_match')
    .map(toClaim);
  const transferableClaims = matchMap
    .filter(item => item.allowedToMention && item.status === 'partial_match')
    .map(toClaim);
  const userConfirmedClaims = matchMap
    .filter(item => item.allowedToMention && item.confirmedByUser)
    .map(toClaim);
  const blockedClaims = matchMap
    .filter(item => !item.allowedToMention)
    .map(item => ({
      requirement: compactText(item.requirement, 120),
      type: item.type,
      reason: 'Not confirmed in the CV or by the user.',
    }));
  // A missing credential can be surfaced by both the deterministic matchMap
  // (unmatched JD requirement) and the domain-pack classifier (missing
  // credential) - drop credential mentions already covered by blockedClaims,
  // and drop the whole domain entry if every credential it names is already
  // represented, so the same gap isn't listed (and counted) twice.
  const blockedRequirementKeys = new Set(
    blockedClaims.map(item => normalizeClaimKey(item.requirement))
  );
  const domainBlockedClaims = domainWarnings
    .filter(item => item.severity === 'block')
    .map(item => ({
      ...item,
      missingCredentials: (item.missingCredentials || [])
        .filter(credential => !blockedRequirementKeys.has(normalizeClaimKey(credential))),
    }))
    .filter(item => item.missingCredentials.length > 0)
    .map(item => ({
      requirement: compactText(item.missingCredentials.join(', ') || item.profileId, 120),
      type: 'credential',
      reason: compactText(item.message || 'Credential requested by the JD is not clearly supported by the CV.', 180),
      profileId: item.profileId,
    }));
  const allBlockedClaims = [...blockedClaims, ...domainBlockedClaims];

  return {
    supportedClaims,
    transferableClaims,
    userConfirmedClaims,
    blockedClaims: allBlockedClaims,
    domainCredentialWarnings: domainWarnings.map(item => ({
      profileId: item.profileId,
      severity: item.severity,
      message: compactText(item.message, 180),
      missingCredentials: (item.missingCredentials || []).slice(0, 6).map(value => compactText(value, 80)),
      confirmationPrompts: (item.confirmationPrompts || []).slice(0, 3).map(value => compactText(value, 120)),
    })),
    domainRisk: summarizeDomainRisk(context.domainRisk),
    counts: {
      supported: supportedClaims.length,
      transferable: transferableClaims.length,
      userConfirmed: userConfirmedClaims.length,
      blocked: allBlockedClaims.length,
    },
    reviewRequired: allBlockedClaims.length > 0 || transferableClaims.length > 0 || Boolean(context.domainRisk?.reviewRequired),
  };
}

const GROUNDING_SCHEMA_VERSION = '1.0';
const ANSWER_VALIDATOR_VERSION = '1.0';

function answerValidation(answer, context, body, question, questionType) {
  return validateApplicationAnswer(answer, {
    context: buildGroundingContext(context?.cvData || {}, {
      targetCompany: body.company || '',
      confirmedFacts: Array.isArray(body.confirmedFacts) ? body.confirmedFacts.filter(value => typeof value === 'string') : [],
    }),
    question,
    questionType,
  });
}

function pipelineMetadata(context) {
  const inputGroundingReport = buildTruthfulnessReport(context);
  const pipelineRun = summarizeAgentRun(context);
  const pipelineInsights = buildAgentInsights(context);
  return {
    groundingSchemaVersion: GROUNDING_SCHEMA_VERSION,
    validatorVersion: ANSWER_VALIDATOR_VERSION,
    inputGroundingReport,
    truthfulnessReport: inputGroundingReport, // Deprecated compatibility alias for one release.
    pipelineStages: context?.pipelineStages || context?.agentChain,
    pipelineRun,
    pipelineInsights,
    agentChain: context?.agentChain, // Deprecated aliases.
    agentRun: pipelineRun,
    agentInsights: pipelineInsights,
  };
}

async function consumeOpenAIStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let model;
  let openRouterMetadata;
  let usage;
  const consumeEvent = event => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') return;
    try {
      const json = JSON.parse(data);
      answer += json.choices?.[0]?.delta?.content || '';
      model = json.model || model;
      openRouterMetadata = json.openrouter_metadata || openRouterMetadata;
      usage = json.usage || usage;
    } catch (_) { /* malformed provider events are not forwarded */ }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    events.forEach(consumeEvent);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer); // final unterminated SSE event
  return { answer, model, openRouterMetadata, usage };
}

function compactText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function normalizeClaimKey(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function summarizeDomainRisk(domainRisk = null) {
  if (!domainRisk?.detected) return undefined;
  return {
    detected: true,
    primaryProfile: domainRisk.primaryProfile ? {
      id: domainRisk.primaryProfile.id,
      label: compactText(domainRisk.primaryProfile.label, 100),
      riskLevel: domainRisk.primaryProfile.riskLevel,
      evidenceStrictness: domainRisk.primaryProfile.evidenceStrictness,
    } : null,
    matchedProfiles: (domainRisk.matchedProfiles || []).slice(0, 3).map(profile => ({
      id: profile.id,
      label: compactText(profile.label, 100),
      riskLevel: profile.riskLevel,
      keywordMatches: (profile.keywordMatches || []).slice(0, 5).map(item => compactText(item, 60)),
      credentialMatches: (profile.credentialMatches || []).slice(0, 5).map(item => compactText(item, 60)),
    })),
    credentialWarnings: (domainRisk.credentialWarnings || []).slice(0, 4).map(item => ({
      profileId: item.profileId,
      severity: item.severity,
      message: compactText(item.message, 180),
      missingCredentials: (item.missingCredentials || []).slice(0, 6).map(value => compactText(value, 80)),
    })),
    reviewPrompts: (domainRisk.reviewPrompts || []).slice(0, 6).map(item => compactText(item, 140)),
    reviewRequired: Boolean(domainRisk.reviewRequired),
    sparseContext: Boolean(domainRisk.sparseContext),
  };
}

function buildAgentInsights(context = {}) {
  if (!context) return undefined;

  const base = {
    workflow: context.workflow,
    pipelineStages: context.pipelineStages || context.agentChain,
    agentChain: context.agentChain,
    questionType: context.questionType,
    domainRisk: summarizeDomainRisk(context.domainRisk),
  };

  if (context.workflow === 'applicationAnswer') {
    return {
      ...base,
      evidence: (context.relevantEvidence || []).slice(0, 4).map(item => ({
        type: item.type,
        label: compactText(item.label, 80),
        text: compactText(item.text, 180),
      })),
      matchedRequirements: (context.matchedRequirements || []).slice(0, 4).map(item => ({
        requirement: compactText(item.requirement, 90),
        status: item.status,
        supported: Boolean(item.allowedToMention),
        evidenceCount: Array.isArray(item.evidence) ? item.evidence.length : 0,
      })),
      truthfulness: {
        unsupportedCount: context.truthfulness?.unsupportedClaims?.length || 0,
        allowedCount: context.truthfulness?.allowedClaims?.length || 0,
      },
    };
  }

  if (context.workflow === 'tailoredCv') {
    return {
      ...base,
      gapAnalysis: {
        missingRequirements: (context.gapAnalysis?.missingRequirements || []).slice(0, 8).map(item => compactText(item, 80)),
        transferableRequirements: (context.gapAnalysis?.transferableRequirements || []).slice(0, 8).map(item => compactText(item, 80)),
        confirmedAdditions: (context.gapAnalysis?.confirmedAdditions || []).slice(0, 8).map(item => compactText(item, 80)),
      },
      keywordOptimisation: {
        supportedKeywords: (context.keywordOptimisation?.supportedKeywords || []).slice(0, 12).map(item => compactText(item, 60)),
        riskyKeywords: (context.keywordOptimisation?.riskyKeywords || []).slice(0, 12).map(item => compactText(item, 60)),
      },
      atsFormatting: {
        targetTitle: compactText(context.atsFormatting?.targetTitle, 80),
        requiredVisibleEvidence: (context.atsFormatting?.requiredVisibleEvidence || []).slice(0, 8).map(item => compactText(item, 80)),
      },
      evidenceRetrieval: context.evidenceRetrieval ? {
        provider: context.evidenceRetrieval.provider,
        model: context.evidenceRetrieval.model,
        status: context.evidenceRetrieval.status,
        promotedCount: context.evidenceRetrieval.promotedCount,
        enrichedCount: context.evidenceRetrieval.enrichedCount,
      } : undefined,
      truthfulness: {
        unsupportedCount: context.truthfulness?.unsupportedClaims?.length || 0,
        allowedCount: context.truthfulness?.allowedClaims?.length || 0,
      },
    };
  }

  return base;
}

async function applyEmbeddingRetrieval(tailorAgentContext, tailor = new CVTailor()) {
  const embeddingRoute = selectEmbeddingRoute({
    hasEmbedding: Boolean(LOCAL_EMBEDDING_BASE_URL),
    embeddingModel: LOCAL_EMBEDDING_MODEL,
  });

  if (!LOCAL_EMBEDDING_BASE_URL) {
    return {
      ...tailorAgentContext,
      evidenceRetrieval: {
        ...embeddingRoute,
        status: 'deterministic',
      },
    };
  }

  const retrievalInputs = buildEvidenceRetrievalInputs(
    tailorAgentContext.candidateEvidenceMap,
    tailorAgentContext.roleRequirementMap,
  );

  if (retrievalInputs.texts.length === 0) {
    return {
      ...tailorAgentContext,
      evidenceRetrieval: {
        ...embeddingRoute,
        status: 'skipped',
        reason: 'No CV evidence or JD requirements available.',
      },
    };
  }

  try {
    const embeddings = await callEmbeddingEndpoint(retrievalInputs.texts);
    const { matchMap, retrieval } = rerankMatchMapWithEmbeddings(
      tailorAgentContext.matchMap,
      retrievalInputs,
      embeddings,
      {
        provider: embeddingRoute.provider,
        model: embeddingRoute.model,
        promoteThreshold: Number.isFinite(LOCAL_EMBEDDING_PROMOTE_THRESHOLD)
          ? LOCAL_EMBEDDING_PROMOTE_THRESHOLD
          : 0.60,
        enrichThreshold: Number.isFinite(LOCAL_EMBEDDING_ENRICH_THRESHOLD)
          ? LOCAL_EMBEDDING_ENRICH_THRESHOLD
          : 0.50,
      },
    );

    return {
      ...rebuildTailoredCvAgentContext(tailorAgentContext, matchMap, tailor),
      evidenceRetrieval: {
        ...embeddingRoute,
        ...retrieval,
      },
    };
  } catch (error) {
    if (error instanceof RequestDeadlineError) throw error;
    console.warn('[DraftApply] Embedding retrieval skipped:', String(error.message || error).slice(0, 160));
    return {
      ...tailorAgentContext,
      evidenceRetrieval: {
        ...embeddingRoute,
        status: 'fallback',
        reason: 'Embedding endpoint failed; deterministic matching was used.',
      },
    };
  }
}

/**
 * Strip common form-field artifacts (*, :, ?) so recipe patterns match cleanly.
 * This runs engine-side so every recipe benefits without duplicating the logic.
 */
function cleanFieldLabel(raw) {
  return (raw || '')
    .trim()
    .replace(/[*:?.\u2217\u2731]+$/g, '')   // trailing *, :, ?, ., unicode asterisks
    .replace(/^(please\s+)?(?:enter|provide|input|type|specify|share|add|include|paste)\s+(?:a\s+|the\s+)?(?:url|link)\s+(?:to|for)\s+(?:your\s+)?/i, '')
    .replace(/^(please\s+)?link\s+(?:to\s+)?(?:your\s+)?/i, '')
    .replace(/^(please\s+(enter|provide|input|type|specify|link|share|add|include|paste)\s+(your\s+)?)/i, '')
    .replace(/^(enter\s+(your\s+)?)/i, '')
    .replace(/^(your\s+)/i, '')
    .trim();
}

app.post('/api/generate', authRequired, generateLimiter, costlyAdmission, async (req, res) => {
  const body = req.body || {};

  let systemPrompt, userPrompt, temperature, maxTokens, questionType;
  let answerAgentContext = null;

  // Detect payload format:
  //   Structured (new): body.question exists  →  run through recipe
  //   Legacy:           body.systemPrompt + body.userPrompt  →  pass through
  if (typeof body.question === 'string' && body.question.length > 0) {
    // ── Structured payload → recipe builds the prompts ──
    if (typeof body.cvText !== 'string' || body.cvText.length < 50) {
      return res.status(400).json({ error: 'Missing or empty cvText' });
    }
    // Clean the question label (strip *, :, "Please enter your...", etc.)
    const cleanedQuestion = cleanFieldLabel(body.question);
    if (!cleanedQuestion) {
      return res.status(400).json({ error: 'Question is empty after cleaning' });
    }

    // Deterministic stage-2 agents parse CV/JD, build the candidate evidence
    // map, construct the role requirement map, and score supported/missing
    // requirements before the recipe builds the final prompt.
    try {
      answerAgentContext = runApplicationAnswerAgents({
        question: cleanedQuestion,
        cvText: body.cvText,
        jobDescription: body.jobDescription || '',
        jobTitle: body.jobTitle || '',
        company: body.company || '',
      });
    } catch (_) {}

    // Direct extraction still receives the same final grounding contract.
    const deterministicAnswer = tryDeterministicExtract(cleanedQuestion, body.cvText);
    if (deterministicAnswer) {
      const validation = answerValidation(deterministicAnswer, answerAgentContext, body, cleanedQuestion, 'data_extraction');
      return res.json({
        answer: deterministicAnswer, validation,
        provider: 'deterministic', model: 'deterministic-extraction',
        ...buildQualityMetadata({ provider: 'deterministic' }),
        ...pipelineMetadata(answerAgentContext),
        ...safetyMetadata(),
      });
    }

    try {
      const result = recipe.buildPrompts({
        question:       cleanedQuestion,
        length:         body.length || 'medium',
        tone:           body.tone || 'natural',
        cvText:         body.cvText,
        cvData:         answerAgentContext?.cvData,
        jdData:         answerAgentContext?.jdData,
        matchMap:       answerAgentContext?.matchMap?.length > 0 ? answerAgentContext.matchMap : undefined,
        domainRisk:     answerAgentContext?.domainRisk,
        roleProfile:    answerAgentContext?.jdData?.roleProfile || undefined,
        jobTitle:       body.jobTitle || undefined,
        company:        body.company || undefined,
        jobDescription: body.jobDescription || undefined,
        requirements:   Array.isArray(body.requirements) ? body.requirements : undefined,
        pageUrl:        body.pageUrl || undefined,
        platform:       body.platform || undefined,
        maxChars:       Number.isFinite(Number(body.maxChars)) ? Number(body.maxChars) : undefined,
      });
      systemPrompt = result.systemPrompt;
      userPrompt   = result.userPrompt;
      temperature  = typeof result.temperature === 'number' ? result.temperature : 0.7;
      maxTokens    = typeof result.maxTokens === 'number' ? result.maxTokens : undefined;
      questionType = result.questionType || undefined;
      if (answerAgentContext && result.questionType) answerAgentContext.questionType = result.questionType;
    } catch (err) {
      return res.status(500).json({ error: 'Recipe error', details: String(err.message).slice(0, 200) });
    }
  } else if (typeof body.systemPrompt === 'string' && typeof body.userPrompt === 'string') {
    // ── Legacy raw prompt payload (backward-compat) ──
    if (!ALLOW_LEGACY_RAW_PROMPTS) return res.status(400).json({
      error: 'Raw legacy prompts are disabled.',
      code: 'legacy_raw_prompts_disabled',
      ...safetyMetadata(),
    });
    systemPrompt = body.systemPrompt;
    userPrompt   = body.userPrompt;
    temperature  = typeof body.temperature === 'number' ? body.temperature : 0.7;
  } else {
    return res.status(400).json({ error: 'Missing prompt data. Send either structured (question + cvText) or legacy (systemPrompt + userPrompt).' });
  }

  // Validate prompt sizes
  if (typeof systemPrompt !== 'string' || systemPrompt.length < 10) {
    return res.status(400).json({ error: 'System prompt too short' });
  }
  if (typeof userPrompt !== 'string' || userPrompt.length < 10) {
    return res.status(400).json({ error: 'User prompt too short' });
  }
  if (systemPrompt.length > 30000 || userPrompt.length > 120000) {
    return res.status(413).json({ error: 'Prompt too large' });
  }

  const useStream = body.stream === true;

  try {
    const completion = await callChatCompletionWithFallback({
      workflow: 'application_answer',
      temperature,
      maxTokens,
      stream: useStream,
      timeoutMs: 60000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
    });
    const response = completion.response;

    if (useStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-DraftApply-Provider', completion.provider);
      res.setHeader('X-DraftApply-Model', completion.model);
      res.setHeader('X-DraftApply-Workflow', completion.route?.workflow || 'applicationAnswer');
      res.setHeader('X-DraftApply-Agent-Chain', (completion.route?.agentChain || WORKFLOW_AGENT_CHAINS.applicationAnswer).join(' > '));
      if (completion.fallbackFrom) res.setHeader('X-DraftApply-Fallback-From', completion.fallbackFrom);

      res.write(`data: ${JSON.stringify({
        draftapplyMeta: {
          provider: completion.provider,
          model: completion.model,
          ...buildQualityMetadata(completion),
          fallbackFrom: completion.fallbackFrom || undefined,
          workflow: completion.route?.workflow || 'applicationAnswer',
          agentChain: completion.route?.agentChain || WORKFLOW_AGENT_CHAINS.applicationAnswer,
          domainRisk: summarizeDomainRisk(answerAgentContext?.domainRisk),
          pipelineStages: completion.route?.agentChain || WORKFLOW_AGENT_CHAINS.applicationAnswer,
        }
      })}\n\n`);
      const keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(': draftapply-keepalive\n\n');
      }, 10000);
      try {
        const streamed = await consumeOpenAIStream(response.body);
        let answer = streamed.answer;
        if (!answer.trim()) throw new Error('No answer from provider');
        let finalCompletion = completion;
        let responseModel = streamed.model || completion.model;
        recordProviderUsage(streamed.usage);
        await completion.markSuccess?.(responseModel);
        let openRouterMetadata = streamed.openRouterMetadata;
        if (questionType && !body.skipEvaluation) {
          const evaluation = evaluateAnswer(answer, questionType);
          if (evaluation.shouldRegenerate) {
            try {
              assertBudget(5000);
              const retry = await callChatCompletionWithFallback({
                workflow: 'application_answer', temperature: Math.min(temperature + 0.15, 0.95), maxTokens,
                stream: false, timeoutMs: 30000,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt },
                  { role: 'assistant', content: answer }, { role: 'user', content: buildRegenerationFeedback(evaluation.flags) }],
              });
              const retryData = await retry.response.json();
              const retryAnswer = retryData?.choices?.[0]?.message?.content;
              if (retryAnswer?.trim() && evaluateAnswer(retryAnswer, questionType).score > evaluation.score) {
                answer = retryAnswer; finalCompletion = retry;
                responseModel = retryData.model || retry.model;
                openRouterMetadata = retryData.openrouter_metadata;
              }
            } catch (error) {
              if (error instanceof RequestDeadlineError || (error?.name === 'AbortError' && remainingMs() <= 0)) throw new RequestDeadlineError();
              /* provider failure leaves the original complete answer */
            }
          }
        }
        const validation = answerValidation(answer, answerAgentContext, body, cleanFieldLabel(body.question || ''), questionType);
        assertBudget();
        const final = {
          version: 1, answer, validation,
          provider: finalCompletion.provider, model: responseModel,
          finalModel: responseModel,
          openRouterMetadata, fallbackFrom: finalCompletion.fallbackFrom || undefined,
          ...buildQualityMetadata(finalCompletion), ...pipelineMetadata(answerAgentContext), ...safetyMetadata(),
          finalProvider: { provider: finalCompletion.provider, model: responseModel, stage: 'generation' },
        };
        res.write(`data: ${JSON.stringify({ draftapplyFinal: final })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch (streamError) {
        // Redis may disconnect after SSE headers have already been sent.
        // Circuit-state recording is best-effort here: never let it escape
        // into Express 4 or replace the existing terminal SSE error event.
        try { await completion.markFailure?.(streamError); } catch {}
        const code = streamError instanceof RequestDeadlineError || streamError?.name === 'AbortError'
          ? 'request_deadline_exceeded'
          : 'stream_generation_failed';
        res.write(`data: ${JSON.stringify({ draftapplyError: { code, error: code === 'request_deadline_exceeded' ? 'Request deadline exceeded.' : 'Answer generation failed.' } })}\n\n`);
      } finally {
        clearInterval(keepAlive);
        res.end();
      }
      return;
    }

    const data = await response.json();
    let answer = data?.choices?.[0]?.message?.content;
    if (!answer?.trim()) return res.status(502).json({ error: 'No answer from provider' });
    let responseModel = data?.model || completion.model;
    let finalCompletion = completion;
    let openRouterMetadata = data?.openrouter_metadata || undefined;

    // Quality gate: one conditional regeneration attempt for low-scoring answers.
    // Only runs for structured payloads (questionType set) and never for
    // prefetch requests (skipEvaluation: true) — prefetch uses
    // one LLM call so cached answers arrive faster.
    if (questionType && !body.skipEvaluation) {
      const evaluation = evaluateAnswer(answer, questionType);
      if (evaluation.shouldRegenerate) {
        try {
          const retryTemp = Math.min(temperature + 0.15, 0.95);
          const feedbackMsg = buildRegenerationFeedback(evaluation.flags);
          const retry = await callChatCompletionWithFallback({
            workflow: 'application_answer',
            temperature: retryTemp,
            maxTokens,
            stream: false,
            timeoutMs: 30000,
            // Multi-turn: show the model its bad answer then explain exactly what to fix.
            // This is far more effective than resending the same prompt at a higher temp.
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: answer },
              { role: 'user', content: feedbackMsg },
            ],
          });
          const retryData = await retry.response.json();
          const retryAnswer = retryData?.choices?.[0]?.message?.content;
          if (retryAnswer?.trim()) {
            const retryEval = evaluateAnswer(retryAnswer, questionType);
            if (retryEval.score > evaluation.score) {
              answer = retryAnswer;
              finalCompletion = retry;
              responseModel = retryData?.model || retry.model || responseModel;
              openRouterMetadata = retryData?.openrouter_metadata || openRouterMetadata;
            }
          }
        } catch (error) {
          if (error instanceof RequestDeadlineError || (error?.name === 'AbortError' && remainingMs() <= 0)) throw new RequestDeadlineError();
          // Regeneration failed — use original answer.
        }
      }
    }

    const validation = answerAgentContext
      ? answerValidation(answer, answerAgentContext, body, cleanFieldLabel(body.question || ''), questionType)
      : undefined;
    assertBudget();
    res.json({
      answer,
      validation,
      provider: finalCompletion.provider,
      model: responseModel,
      finalModel: responseModel,
      ...buildQualityMetadata(finalCompletion),
      requestedModel: completion.model,
      requestedModels: completion.requestedModels,
      openRouterMetadata,
      openRouterStrategy: completion.openRouterStrategy,
      fallbackFrom: completion.fallbackFrom || undefined,
      workflow: completion.route?.workflow || 'applicationAnswer',
      agentChain: completion.route?.agentChain || WORKFLOW_AGENT_CHAINS.applicationAnswer,
      domainRisk: summarizeDomainRisk(answerAgentContext?.domainRisk),
      ...pipelineMetadata(answerAgentContext),
      ...safetyMetadata(),
      finalProvider: { provider: finalCompletion.provider, model: responseModel, stage: 'generation' },
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e instanceof RequestDeadlineError) {
      return res.status(504).json({ error: 'Request deadline exceeded.', code: 'request_deadline_exceeded', ...safetyMetadata() });
    }
    if (e instanceof LLMProviderError) {
      console.error(`[DraftApply] ${e.provider} generate error`, { status: e.status });
      const { status, body } = llmErrorResponse(e);
      return res.status(status).json(body);
    }
    console.error('[DraftApply] Generate error:', e.message);
    return res.status(500).json({ error: 'Failed to generate answer.' });
  }
});

// Optional: keep file upload UX working (PDF/DOCX/TXT)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/api/cv/upload', authRequired, generateLimiter, upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const buffer = req.file.buffer;
    const mimetype = req.file.mimetype;

    let text = '';
    let linkAnnotations = [];
    if (mimetype === 'application/pdf') {
      // Extract text AND hyperlink annotations (e.g. LinkedIn URL hidden behind hyperlinked text)
      const collectedUrls = [];
      const pdfData = await pdfParse(buffer, {
        pagerender: async function(pageData) {
          try {
            const annotations = await pageData.getAnnotations();
            for (const ann of annotations) {
              const url = ann.url || ann.unsafeUrl;
              if (url) collectedUrls.push(url);
            }
          } catch (_) { /* annotations unavailable, ignore */ }
          // Standard text rendering (matches pdf-parse default)
          const textContent = await pageData.getTextContent();
          let lastY = '';
          let pageText = '';
          for (const item of textContent.items) {
            if (lastY === item.transform[5] || !lastY) {
              pageText += item.str;
            } else {
              pageText += '\n' + item.str;
            }
            lastY = item.transform[5];
          }
          return pageText;
        }
      });
      text = pdfData.text;
      if (collectedUrls.length > 0) {
        const uniqueUrls = [...new Set(collectedUrls)];
        linkAnnotations = uniqueUrls.map(url => ({ text: linkLabelFromUrl(url), url }));
        text += '\n\nLinks:\n' + uniqueUrls.join('\n');
      }
    } else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // Extract text + hyperlink URLs (e.g. LinkedIn linked behind display text)
      const [rawResult, htmlResult] = await Promise.all([
        mammoth.extractRawText({ buffer }),
        mammoth.convertToHtml({ buffer })
      ]);
      text = rawResult.value;
      linkAnnotations = extractLinkAnnotationsFromHtml(htmlResult.value);
      const docxUrls = [...new Set(linkAnnotations.map(item => item.url))];
      if (docxUrls.length > 0) {
        text += '\n\nLinks:\n' + docxUrls.join('\n');
      }
    } else if (mimetype === 'text/plain') {
      text = buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    text = String(text)
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    res.json({
      success: true,
      text,
      linkAnnotations,
      filename: req.file.originalname,
      size: req.file.size
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to process CV file' });
  }
});

function extractLinkAnnotationsFromHtml(html = '') {
  const annotations = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(String(html || '')))) {
    const url = normaliseAnnotationUrl(decodeHtmlEntities(match[1]));
    const label = cleanAnnotationLabel(match[2]) || linkLabelFromUrl(url);
    if (!url || !label) continue;
    const key = `${label.toLowerCase()}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    annotations.push({ text: label, url });
  }
  return annotations.slice(0, 100);
}

function cleanAnnotationLabel(value = '') {
  return decodeHtmlEntities(String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, 120);
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normaliseAnnotationUrl(url = '') {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return '';
  return clean;
}

function linkLabelFromUrl(url = '') {
  const raw = String(url || '').trim();
  if (/linkedin\.com/i.test(raw)) return 'LinkedIn';
  if (/github\.com/i.test(raw)) return 'GitHub';
  if (/behance\.net/i.test(raw)) return 'Behance';
  if (/dribbble\.com/i.test(raw)) return 'Dribbble';
  if (/kaggle\.com/i.test(raw)) return 'Kaggle';
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch {
    return raw;
  }
}

/**
 * Job Description Extraction endpoint
 * Strips company blurbs, benefits, EEO boilerplate, and application copy from
 * long pasted postings before CV/JD analysis. The popup falls back to raw text
 * if this fails, but production should still provide the route it calls.
 */
app.post('/api/jd/extract', authRequired, generateLimiter, costlyAdmission, async (req, res) => {
  try {
    const { text } = req.body || {};

    if (!text || String(text).trim().length < 100) {
      return res.status(400).json({ error: 'text must be at least 100 characters' });
    }

    const normalizedText = String(text).trim();
    if (normalizedText.length > 60000) {
      return res.status(413).json({ error: 'Job posting is too large. Please paste a shorter posting.' });
    }

    const systemPrompt = `You are a job posting parser. Extract only the job-relevant content from a full job posting.

Return ONLY these sections when present:
- Responsibilities / What you will do
- Required qualifications / Minimum requirements
- Preferred qualifications / Nice to have
- Required technical skills and tools

Remove completely:
- Company descriptions, mission statements, values, culture blurbs
- Benefits, compensation, equity, perks
- Equal opportunity / EEO statements
- Application instructions or "how to apply" sections
- "About us" or "Who we are" sections

Preserve the original bullet point structure and section headings. Output only the extracted content with no preamble, no commentary, and no markdown code fences.`;

    const completion = await callChatCompletionWithFallback({
      workflow: 'jd_extract',
      temperature: 0.1,
      maxTokens: 2000,
      timeoutMs: 30000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Extract the job requirements from this posting:\n\n${normalizedText}` },
      ],
    });

    const data = await completion.response.json();
    const extractedText = data?.choices?.[0]?.message?.content?.trim();
    if (!extractedText) {
      return res.status(502).json({ error: 'No output from provider' });
    }

    res.json({
      extractedText,
      provider: completion.provider,
      model: data?.model || completion.model,
      ...buildQualityMetadata(completion),
      requestedModel: completion.model,
      requestedModels: completion.requestedModels,
      openRouterMetadata: data?.openrouter_metadata || undefined,
      openRouterStrategy: completion.openRouterStrategy,
      fallbackFrom: completion.fallbackFrom || undefined,
      workflow: completion.route?.workflow || 'tailoredCv',
      agentChain: completion.route?.agentChain || WORKFLOW_AGENT_CHAINS.tailoredCv,
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e instanceof RequestDeadlineError) {
      return res.status(504).json({ error: 'Request deadline exceeded.', code: 'request_deadline_exceeded', ...safetyMetadata() });
    }
    if (e instanceof LLMProviderError) {
      console.error(`[DraftApply] ${e.provider} JD extract error`, { status: e.status });
      const { status, body } = llmErrorResponse(e);
      return res.status(status).json(body);
    }
    console.error('[DraftApply] JD extract error:', e.message);
    return res.status(500).json({ error: 'Failed to extract job description.' });
  }
});

/**
 * Ask the LLM to suggest tools commonly used in a given role that are not
 * already present in the JD. Designed to be fired as a non-blocking Promise
 * that runs in parallel with the sync match analysis.
 *
 * Returns an array of tool name strings, or null on any failure.
 */
async function fetchLLMDomainSuggestions(jobTitle, jdTools) {
  if (!jobTitle) return null;

  const toolList = (jdTools || []).slice(0, 25).join(', ') || 'none specified';

  try {
    const { response } = await callChatCompletionWithFallback({
      workflow: 'domain_suggestions',
      temperature: 0.2,
      maxTokens: 300,
      timeoutMs: 8000,
      messages: [
        {
          role: 'system',
          content: 'You are a technical hiring expert. Respond only with valid JSON — no markdown, no explanation.',
        },
        {
          role: 'user',
          content: `Job title: ${jobTitle}\nTechnologies already in the job description: ${toolList}\n\nList up to 15 additional tools, frameworks, or technologies that are commonly expected or genuinely valued for this exact role type but are NOT in the list above. Focus on what a hiring manager for this role would realistically look for.\n\nOutput a JSON array of strings only, e.g.: ["Tool1", "Tool2"]`,
        },
      ],
    });

    const data = await response.json();
    const text = (data?.choices?.[0]?.message?.content || '').trim();
    if (!text) return null;

    // Extract JSON array even if the model wraps it in backticks
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter(t => typeof t === 'string' && t.trim().length > 0)
      .map(t => t.trim())
      .slice(0, 15);
  } catch (error) {
    if (error instanceof RequestDeadlineError || (error?.name === 'AbortError' && remainingMs() <= 0)) throw new RequestDeadlineError();
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM JD enrichment cache
// Keyed by a normalised hash of the JD text so the same role pasted multiple
// times (whitespace variations, etc.) reuses the cached analysis.
// Short TTL — entries expire after 20 minutes to handle rate-limit recovery.
// ---------------------------------------------------------------------------

const JD_ENRICHMENT_CACHE = new Map(); // key → { data, expiresAt }
const JD_ENRICHMENT_TTL_MS = 20 * 60 * 1000;

function normaliseJdKey(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 4000);
}

function jdCacheGet(key) {
  const entry = JD_ENRICHMENT_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { JD_ENRICHMENT_CACHE.delete(key); return null; }
  return entry.data;
}

function jdCacheSet(key, data) {
  // Evict if growing too large (> 100 entries) to avoid unbounded memory
  if (JD_ENRICHMENT_CACHE.size >= 100) {
    const firstKey = JD_ENRICHMENT_CACHE.keys().next().value;
    JD_ENRICHMENT_CACHE.delete(firstKey);
  }
  JD_ENRICHMENT_CACHE.set(key, { data, expiresAt: Date.now() + JD_ENRICHMENT_TTL_MS });
}

/**
 * Enrich a regex-parsed jdData object with LLM analysis.
 * Returns the enriched jdData (or the original on any failure).
 * Result is cached by normalised JD text hash.
 * @param {object} jdParser  — JDParser instance
 * @param {object} regexParsed — output of jdParser.parse()
 * @param {string} jdText    — raw job description text
 * @returns {{ jdData: object, source: 'llm'|'cache'|'regex' }}
 */
async function enrichJdData(jdParser, regexParsed, jdText) {
  const cacheKey = normaliseJdKey(jdText);
  const cached = jdCacheGet(cacheKey);
  if (cached) return { jdData: cached, source: 'cache' };

  const { systemPrompt: jdSysPrompt, userPrompt: jdUserPrompt } =
    jdParser.buildLLMAnalysisPrompt(jdText);

  try {
    const { response } = await callChatCompletionWithFallback({
      workflow: 'jd_enrichment',
      temperature: 0.1,
      maxTokens: 900,
      timeoutMs: 18000,
      allowFallback: true,
      messages: [
        { role: 'system', content: jdSysPrompt },
        { role: 'user',   content: jdUserPrompt },
      ],
    });
    const data = await response.json();
    const text = (data?.choices?.[0]?.message?.content || '').trim();
    if (!text) return { jdData: regexParsed, source: 'regex' };

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { jdData: regexParsed, source: 'regex' };

    const enriched = jdParser.mergeWithLLMAnalysis(regexParsed, JSON.parse(match[0]));
    jdCacheSet(cacheKey, enriched);
    return { jdData: enriched, source: 'llm' };
  } catch (err) {
    if (err instanceof RequestDeadlineError || (err?.name === 'AbortError' && remainingMs() <= 0)) throw new RequestDeadlineError();
    console.warn('[DraftApply] JD LLM enrichment failed, using regex fallback:', err.message);
    return { jdData: regexParsed, source: 'regex' };
  }
}

app.post('/api/cv/analyze', authRequired, generateLimiter, costlyAdmission, async (req, res) => {
  const { cvText, jobTitle = '', company = '', jobDescription, confirmedSkills = [] } = req.body || {};

  if (!cvText || cvText.length < 100) {
    return res.status(400).json({ error: 'cvText must be at least 100 characters' });
  }
  if (!jobDescription || jobDescription.length < 50) {
    return res.status(400).json({ error: 'jobDescription must be at least 50 characters' });
  }

  try {
    const jdParser = new JDParser();

    // CV parse and regex JD parse are independent — run in parallel
    const [cvData, jdDataRegex] = await Promise.all([
      Promise.resolve(new CVParser().parse(cvText)),
      Promise.resolve(jdParser.parse(jobDescription, jobTitle, company)),
    ]);

    // LLM JD enrichment runs in parallel with domain suggestions
    const [{ jdData, source: jdAnalysisSource }, llmSuggestionsResult] = await Promise.all([
      enrichJdData(jdParser, jdDataRegex, jobDescription),
      fetchLLMDomainSuggestions(jdDataRegex.jobTitle, jdDataRegex.tools).catch(() => null),
    ]);

    const tailor = new CVTailor();
    let tailorAgentContext = runTailoredCvAgents({
      cvText,
      jobDescription,
      jobTitle,
      company,
      confirmedSkills,
      cvData,
      jdData,
      tailor,
    });
    tailorAgentContext = await applyEmbeddingRetrieval(tailorAgentContext, tailor);
    const staticFallback = tailor.suggestDomainSkills(jdData, cvData);
    const llmRaw = llmSuggestionsResult;

    // Filter LLM suggestions against what's already in the JD or CV
    let domainSuggestions = staticFallback;
    if (llmRaw?.length > 0) {
      const inJd = new Set([
        ...(jdData.tools          || []).map(t => t.toLowerCase()),
        ...(jdData.requiredSkills  || []).map(s => s.toLowerCase()),
        ...(jdData.preferredSkills || []).map(s => s.toLowerCase()),
      ]);
      const cvLower = cvText.toLowerCase();

      const filtered = llmRaw.filter(tool => {
        const low = tool.toLowerCase();
        // Skip if tool (or any 4+ char word of it) already appears in the JD
        if (inJd.has(low)) return false;
        if (low.split(/\s+/).some(w => w.length >= 4 && inJd.has(w))) return false;
        // Skip if already in the candidate's CV
        if (cvLower.includes(low)) return false;
        return true;
      });

      if (filtered.length > 0) domainSuggestions = filtered;
    }

    assertBudget();
    return res.json({
      matchReport: tailorAgentContext.matchReport,
      jobTitle: jdData.jobTitle,
      company:  jdData.company,
      domainSuggestions,
      jdAnalysisSource,
      workflow: 'tailoredCv',
      agentChain: WORKFLOW_AGENT_CHAINS.tailoredCv,
      gapAnalysis: tailorAgentContext.gapAnalysis,
      keywordOptimisation: tailorAgentContext.keywordOptimisation,
      atsFormatting: tailorAgentContext.atsFormatting,
      truthfulness: tailorAgentContext.truthfulness,
      truthfulnessReport: buildTruthfulnessReport(tailorAgentContext),
      domainRisk: summarizeDomainRisk(tailorAgentContext.domainRisk),
      ...buildQualityMetadata({ provider: 'deterministic' }),
      evidenceRetrieval: tailorAgentContext.evidenceRetrieval,
      agentRun: summarizeAgentRun(tailorAgentContext),
      agentInsights: buildAgentInsights(tailorAgentContext),
      modelRouter: selectModelRoute('jd_enrichment', {
        hasLocal: Boolean(LOCAL_LLM_BASE_URL),
        hasHosted: Boolean(GROQ_API_KEY || OPENROUTER_API_KEY),
        localModel: LOCAL_LLM_MODEL,
      }),
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e instanceof RequestDeadlineError) {
      return res.status(504).json({ error: 'Request deadline exceeded.', code: 'request_deadline_exceeded', ...safetyMetadata() });
    }
    console.error('[DraftApply] Analyze error:', e.message);
    return res.status(500).json({ error: 'Failed to analyze CV match.' });
  }
});

app.post('/api/cv/tailor', authRequired, generateLimiter, costlyAdmission, async (req, res) => {
  const { cvText, jobTitle = '', company = '', jobDescription, confirmedSkills = [] } = req.body || {};

  if (!cvText || cvText.length < 100) {
    return res.status(400).json({ error: 'cvText must be at least 100 characters' });
  }
  if (!jobDescription || jobDescription.length < 50) {
    return res.status(400).json({ error: 'jobDescription must be at least 50 characters' });
  }

  try {
    const jdParser = new JDParser();

    // CV parse and regex JD parse are independent — run in parallel
    const [cvData, jdDataRegex] = await Promise.all([
      Promise.resolve(new CVParser().parse(cvText)),
      Promise.resolve(jdParser.parse(jobDescription, jobTitle, company)),
    ]);

    // LLM JD enrichment — sequential after regex parse so matchMap is built
    // from the final enriched JD, not stale regex data
    const { jdData, source: jdAnalysisSource } =
      await enrichJdData(jdParser, jdDataRegex, jobDescription);

    const tailor  = new CVTailor();
    let tailorAgentContext = runTailoredCvAgents({
      cvText,
      jobDescription,
      jobTitle,
      company,
      confirmedSkills,
      cvData,
      jdData,
      tailor,
    });
    tailorAgentContext = await applyEmbeddingRetrieval(tailorAgentContext, tailor);
    const matchMap = tailorAgentContext.matchMap;

    // Structured generation is mandatory: the model may only fill mutable
    // content slots, while deterministic code owns identity and formatting.
    let completion = null;
    let data = null;
    let tailorProvider = null;
    let tailoredCvText = '';
    let auditSkipped = false;
    let structuredCv = null;
    const generationMode = 'structured';

    // ── Structured path (docs/structured-cv-generation.md) ──
    // The model returns only mutable content JSON; companies/dates/titles/
    // education come verbatim from cvData and are rendered by a template, so
    // the malformed-structure bug class cannot occur. We deliberately fail
    // closed instead of returning a model-authored free-text CV.
    if (!STRUCTURED_CV_GENERATION) {
      return res.status(503).json({
        error: 'Structured CV generation is disabled. DraftApply will not generate an ungrounded free-text CV.',
        code: 'structured_cv_generation_required',
      });
    }
    if (!Array.isArray(cvData.experience) || cvData.experience.length === 0) {
      return res.status(422).json({
        error: 'No work-experience roles could be parsed from this CV. Review the CV formatting and try again.',
        code: 'cv_experience_parse_failed',
      });
    }
    {
      try {
        const structuredPrompt = tailor.buildStructuredTailoringPrompt(cvData, jdData, matchMap, {
          domainRisk: tailorAgentContext.domainRisk,
          confirmedSkills,
        });
        const skeleton = structuredPrompt.skeleton;
        const structuredCompletion = await callChatCompletionWithFallback({
          workflow: 'cv_tailor',
          temperature: structuredPrompt.temperature,
          maxTokens: 2500,
          timeoutMs: 50000,
          fallbackTimeoutMs: 50000,
          maxFallbackModels: 2,
          allowFallback: OPENROUTER_TAILOR_FALLBACK,
          responseFormat: { type: 'json_object' },
          messages: [
            { role: 'system', content: structuredPrompt.systemPrompt },
            { role: 'user',   content: structuredPrompt.userPrompt   },
          ],
        });
        const structuredData = await structuredCompletion.response.json().catch(() => null);
        const structuredRaw = structuredData?.choices?.[0]?.message?.content;
        const structuredTruncated = structuredData?.choices?.[0]?.finish_reason === 'length';
        let content = structuredTruncated
          ? null
          : tailor.validateStructuredContent(
              tailor.parseStructuredContent(structuredRaw),
              skeleton,
              { matchMap, confirmedSkills, cvData }
            );
        let acceptedCompletion = structuredCompletion;
        let acceptedData = structuredData;

        if (content) {
          // Structured audit: same JSON shape, unsupported claims removed.
          // Invalid/truncated audit output keeps the pre-audit content.
          auditSkipped = true;
          try {
            const auditPrompt = tailor.buildStructuredAuditPrompt(skeleton, content, matchMap);
            const auditCompletion = await callChatCompletionWithFallback({
              workflow: 'cv_tailor',
              temperature: auditPrompt.temperature,
              maxTokens: 2500,
              timeoutMs: 30000,
              fallbackTimeoutMs: 30000,
              maxFallbackModels: 2,
              allowFallback: OPENROUTER_TAILOR_FALLBACK,
              responseFormat: { type: 'json_object' },
              messages: [
                { role: 'system', content: auditPrompt.systemPrompt },
                { role: 'user',   content: auditPrompt.userPrompt   },
              ],
            });
            const auditData = await auditCompletion.response.json().catch(() => null);
            if (auditData?.choices?.[0]?.finish_reason !== 'length') {
              const audited = tailor.validateStructuredContent(
                tailor.parseStructuredContent(auditData?.choices?.[0]?.message?.content),
                skeleton,
                { matchMap, confirmedSkills, cvData }
              );
              if (audited) {
                content = audited;
                auditSkipped = false;
                acceptedCompletion = auditCompletion;
                acceptedData = auditData;
              }
            }
          } catch (auditError) {
            if (auditError instanceof RequestDeadlineError || (auditError?.name === 'AbortError' && remainingMs() <= 0)) throw new RequestDeadlineError();
            const detail = auditError instanceof LLMProviderError
              ? `${auditError.provider} ${auditError.status}` : auditError.message;
            console.warn('[DraftApply] Structured audit skipped:', detail);
          }

          structuredCv = { skeleton, content };
          tailoredCvText = tailor.renderTailoredCV(skeleton, content);
          completion = acceptedCompletion;
          data = acceptedData;
          tailorProvider = acceptedCompletion.provider;
        } else {
          console.warn(`[DraftApply] Structured generation output rejected${structuredTruncated ? ' (truncated)' : ''}.`);
          return res.status(502).json({
            error: 'The provider did not return a grounded structured CV. Please try again.',
            code: 'structured_cv_output_invalid',
          });
        }
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        const detail = e instanceof LLMProviderError ? `${e.provider} ${e.status}` : e.message;
        console.warn('[DraftApply] Structured generation failed:', detail);
        throw e;
      }
    }

    const warnings        = [
      ...tailor.validateTailoredCV(cvData, tailoredCvText),
      ...tailor.validateTailoringQuality(cvData, jdData, matchMap, tailoredCvText, confirmedSkills),
    ];
    const changedSections = tailor.detectChangedSections(cvText, tailoredCvText);
    const matchReport     = tailorAgentContext.matchReport;
    const recruiterReview = tailor.buildRecruiterReview(
      cvData,
      jdData,
      matchMap,
      tailoredCvText,
      warnings,
      confirmedSkills
    );
    const { missingKeywords: atsKeywordGaps, coverage: atsKeywordCoverage } =
      tailor.checkAtsKeywordCoverage(tailoredCvText, jdData);

    assertBudget();
    res.json({
      tailoredCvText,
      matchReport,
      recruiterReview,
      warnings,
      changedSections,
      auditSkipped,
      structuredCv,
      generationMode,
      jdAnalysisSource,
      atsKeywordGaps,
      atsKeywordCoverage,
      provider: tailorProvider,
      model: data?.model || completion.model,
      ...buildQualityMetadata(completion),
      requestedModel: completion.model,
      requestedModels: completion.requestedModels,
      openRouterMetadata: data?.openrouter_metadata || undefined,
      openRouterStrategy: completion.openRouterStrategy,
      fallbackFrom: completion.fallbackFrom || undefined,
      workflow: completion.route?.workflow || 'tailoredCv',
      agentChain: completion.route?.agentChain || WORKFLOW_AGENT_CHAINS.tailoredCv,
      gapAnalysis: tailorAgentContext.gapAnalysis,
      keywordOptimisation: tailorAgentContext.keywordOptimisation,
      atsFormatting: tailorAgentContext.atsFormatting,
      truthfulness: tailorAgentContext.truthfulness,
      truthfulnessReport: buildTruthfulnessReport(tailorAgentContext),
      domainRisk: summarizeDomainRisk(tailorAgentContext.domainRisk),
      evidenceRetrieval: tailorAgentContext.evidenceRetrieval,
      agentRun: summarizeAgentRun(tailorAgentContext),
      agentInsights: buildAgentInsights(tailorAgentContext),
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e instanceof RequestDeadlineError) {
      return res.status(504).json({ error: 'Request deadline exceeded.', code: 'request_deadline_exceeded', ...safetyMetadata() });
    }
    if (e instanceof LLMProviderError) {
      console.error(`[DraftApply] ${e.provider} tailor error`, { status: e.status });
      const { status, body } = llmErrorResponse(e, { allowFallback: OPENROUTER_TAILOR_FALLBACK });
      return res.status(status).json(body);
    }
    console.error('[DraftApply] Tailor error:', e.message);
    return res.status(500).json({ error: 'Failed to tailor CV.' });
  }
});

export { app };

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  app.listen(PORT, () => {
    console.log(`DraftApply Render proxy listening on :${PORT}`);
  });
}
