import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { CVParser } from '../shared/cv-parser.js';
import { JDParser } from '../shared/jd-parser.js';
import { CVTailor } from '../shared/cv-tailor.js';
import { evaluateAnswer, buildRegenerationFeedback } from '../shared/answer-evaluator.js';
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
  coercePositiveInteger,
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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || '').trim();
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || 'https://draftapply.com';
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'DraftApply';
const OPENROUTER_TAILOR_FALLBACK = !/^false$/i.test(process.env.OPENROUTER_TAILOR_FALLBACK || 'true');
const OPENROUTER_USE_MODELS_ARRAY = !/^false$/i.test(process.env.OPENROUTER_USE_MODELS_ARRAY || 'true');
const OPENROUTER_REQUIRE_DATA_PRIVACY = !/^false$/i.test(process.env.OPENROUTER_REQUIRE_DATA_PRIVACY || 'true');
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
const LOCAL_EMBEDDING_PROMOTE_THRESHOLD = Number(process.env.LOCAL_EMBEDDING_PROMOTE_THRESHOLD || 0.68);
const LOCAL_EMBEDDING_ENRICH_THRESHOLD = Number(process.env.LOCAL_EMBEDDING_ENRICH_THRESHOLD || 0.54);
const TOKEN_SECRET = process.env.TOKEN_SECRET;

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

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'RateLimit-Policy']
}));
app.use(express.json({ limit: '1mb' }));

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
  console.info('[DraftApply] llm_attempt', JSON.stringify({
    provider,
    model,
    attempt,
    outcome,
    status: status || undefined,
    fallbackFrom: fallbackFrom || undefined,
    elapsedMs,
  }));
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
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: {},
    };
  }

  return {
    provider: 'openrouter',
    apiKey: OPENROUTER_API_KEY,
    model: model || OPENROUTER_MODEL || 'openrouter/free',
    url: 'https://openrouter.ai/api/v1/chat/completions',
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

// Hugging Face's Inference Providers router does not implement the
// OpenAI-compatible /v1/embeddings route (only chat completions) - embedding
// models there are called at /hf-inference/models/{model} with a native
// {inputs: [...]} request and a plain array-of-vectors response, not the
// OpenAI {data: [{embedding}]} shape. Detect that host and speak its shape.
function isHfInferenceRouterUrl(rawBaseUrl) {
  return /(^|\.)router\.huggingface\.co$/i.test(
    (() => {
      try { return new URL(rawBaseUrl).hostname; } catch { return ''; }
    })()
  );
}

function localEmbeddingsUrl(rawBaseUrl, model) {
  const base = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (isHfInferenceRouterUrl(base)) return `${base}/models/${model}`;
  if (/\/embeddings$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
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
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(localEmbeddingsUrl(LOCAL_EMBEDDING_BASE_URL, model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LOCAL_EMBEDDING_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify(useHfNativeShape ? { inputs: input } : { model, input }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LLMProviderError('local-openai-embeddings', response.status, detail.slice(0, 500), null, model);
    }

    const data = await response.json();
    const embeddings = useHfNativeShape
      ? (Array.isArray(data) ? data : [])
      : (data?.data || [])
          .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
          .map(item => item.embedding);

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
    throw error;
  } finally {
    clearTimeout(timeout);
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
}) {
  const config = llmProviderConfig(provider, model);
  if (!config.apiKey) {
    throw new LLMProviderError(provider, 0, 'Missing API key', null, config.model);
  }
  const useModelsArray = provider === 'openrouter' && Array.isArray(models) && models.length > 0;
  if (!config.model && !useModelsArray) {
    throw new LLMProviderError(provider, 0, 'Missing model', null, config.model);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
        stream,
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
    logLLMAttempt({ provider, model: requestedModel, attempt, outcome: 'success', fallbackFrom, elapsedMs: Date.now() - startedAt });
    return {
      response,
      provider: config.provider,
      model: requestedModel,
      requestedModels: useModelsArray ? models : undefined,
    };
  } catch (error) {
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
  } finally {
    clearTimeout(timeout);
  }
}

async function getOpenRouterFallbackModelOrder() {
  const models = await openRouterModelCache.getModels();
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

function authRequired(req, res, next) {
  if (!TOKEN_SECRET) return res.status(500).json({ error: 'Server misconfigured' });
  const t = getBearerToken(req);
  const v = verifyToken(t);
  if (!v.ok) return res.status(401).json({ error: 'Unauthorized', reason: v.reason });
  req.installToken = v.payload;
  next();
}

app.get('/api/health', (req, res) => {
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
  const qualityMode = deploymentQualityMode();

  res.json({
    ok: true,
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
        promote: Number.isFinite(LOCAL_EMBEDDING_PROMOTE_THRESHOLD) ? LOCAL_EMBEDDING_PROMOTE_THRESHOLD : 0.68,
        enrich: Number.isFinite(LOCAL_EMBEDDING_ENRICH_THRESHOLD) ? LOCAL_EMBEDDING_ENRICH_THRESHOLD : 0.54,
      },
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

  return {
    supportedClaims,
    transferableClaims,
    userConfirmedClaims,
    blockedClaims,
    counts: {
      supported: supportedClaims.length,
      transferable: transferableClaims.length,
      userConfirmed: userConfirmedClaims.length,
      blocked: blockedClaims.length,
    },
    reviewRequired: blockedClaims.length > 0 || transferableClaims.length > 0,
  };
}

function compactText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function buildAgentInsights(context = {}) {
  if (!context) return undefined;

  const base = {
    workflow: context.workflow,
    agentChain: context.agentChain,
    questionType: context.questionType,
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
          : 0.68,
        enrichThreshold: Number.isFinite(LOCAL_EMBEDDING_ENRICH_THRESHOLD)
          ? LOCAL_EMBEDDING_ENRICH_THRESHOLD
          : 0.54,
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

app.post('/api/generate', authRequired, generateLimiter, async (req, res) => {
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

    // Short-circuit: plain data fields (name, email, phone, LinkedIn, etc.)
    // can be answered directly from the CV without calling the LLM.
    const deterministicAnswer = tryDeterministicExtract(cleanedQuestion, body.cvText);
    if (deterministicAnswer) {
      const deterministicQuality = buildQualityMetadata({ provider: 'deterministic' });
      return res.json({
        answer: deterministicAnswer,
        provider: 'deterministic',
        ...deterministicQuality,
      });
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

    try {
      const result = recipe.buildPrompts({
        question:       cleanedQuestion,
        length:         body.length || 'medium',
        tone:           body.tone || 'natural',
        cvText:         body.cvText,
        cvData:         answerAgentContext?.cvData,
        jdData:         answerAgentContext?.jdData,
        matchMap:       answerAgentContext?.matchMap?.length > 0 ? answerAgentContext.matchMap : undefined,
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
          agentRun: summarizeAgentRun(answerAgentContext),
          agentInsights: buildAgentInsights(answerAgentContext),
          truthfulnessReport: buildTruthfulnessReport(answerAgentContext),
        }
      })}\n\n`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Forward raw SSE bytes from Groq directly to the client.
          // The background service worker parses OpenAI-compatible SSE, so no
          // transformation is needed — just pass it through.
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        res.end();
      }
      return;
    }

    const data = await response.json();
    let answer = data?.choices?.[0]?.message?.content;
    if (!answer?.trim()) return res.status(502).json({ error: 'No answer from provider' });
    let responseModel = data?.model || completion.model;
    let openRouterMetadata = data?.openrouter_metadata || undefined;

    // Quality gate: one conditional regeneration attempt for low-scoring answers.
    // Only runs for structured payloads (questionType set), never for streaming,
    // and never for prefetch requests (skipEvaluation: true) — prefetch uses
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
              responseModel = retryData?.model || retry.model || responseModel;
              openRouterMetadata = retryData?.openrouter_metadata || openRouterMetadata;
            }
          }
        } catch (_) {
          // Regeneration failed — use original answer.
        }
      }
    }

    res.json({
      answer,
      provider: completion.provider,
      model: responseModel,
      ...buildQualityMetadata(completion),
      requestedModel: completion.model,
      requestedModels: completion.requestedModels,
      openRouterMetadata,
      openRouterStrategy: completion.openRouterStrategy,
      fallbackFrom: completion.fallbackFrom || undefined,
      workflow: completion.route?.workflow || 'applicationAnswer',
      agentChain: completion.route?.agentChain || WORKFLOW_AGENT_CHAINS.applicationAnswer,
      agentRun: summarizeAgentRun(answerAgentContext),
      agentInsights: buildAgentInsights(answerAgentContext),
      truthfulnessReport: buildTruthfulnessReport(answerAgentContext),
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      return res.status(504).json({ error: 'AI service timed out. Please try again.' });
    }
    if (e instanceof LLMProviderError) {
      console.error(`[DraftApply] ${e.provider} generate error ${e.status}:`, String(e.detail || '').slice(0, 400));
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
        text += '\n\nLinks:\n' + uniqueUrls.join('\n');
      }
    } else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // Extract text + hyperlink URLs (e.g. LinkedIn linked behind display text)
      const [rawResult, htmlResult] = await Promise.all([
        mammoth.extractRawText({ buffer }),
        mammoth.convertToHtml({ buffer })
      ]);
      text = rawResult.value;
      const hrefMatches = htmlResult.value.match(/href="([^"]+)"/g) || [];
      const docxUrls = [...new Set(
        hrefMatches
          .map(m => m.slice(6, -1))
          .filter(u => /^https?:\/\//.test(u))
      )];
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
      filename: req.file.originalname,
      size: req.file.size
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to process CV file' });
  }
});

/**
 * Job Description Extraction endpoint
 * Strips company blurbs, benefits, EEO boilerplate, and application copy from
 * long pasted postings before CV/JD analysis. The popup falls back to raw text
 * if this fails, but production should still provide the route it calls.
 */
app.post('/api/jd/extract', authRequired, generateLimiter, async (req, res) => {
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
    if (e?.name === 'AbortError') {
      return res.status(504).json({ error: 'Job description extraction timed out. Please try again.' });
    }
    if (e instanceof LLMProviderError) {
      console.error(`[DraftApply] ${e.provider} JD extract error ${e.status}:`, String(e.detail || '').slice(0, 400));
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
  } catch {
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
    console.warn('[DraftApply] JD LLM enrichment failed, using regex fallback:', err.message);
    return { jdData: regexParsed, source: 'regex' };
  }
}

app.post('/api/cv/analyze', authRequired, generateLimiter, async (req, res) => {
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
    console.error('[DraftApply] Analyze error:', e.message);
    return res.status(500).json({ error: 'Failed to analyze CV match.' });
  }
});

app.post('/api/cv/tailor', authRequired, generateLimiter, async (req, res) => {
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

    const { systemPrompt, userPrompt } = tailor.buildTailoringPrompt(cvData, jdData, matchMap);

    const completion = await callChatCompletionWithFallback({
      workflow: 'cv_tailor',
      temperature: 0.3,
      maxTokens: 4000,
      timeoutMs: 50000,
      fallbackTimeoutMs: 50000,
      maxFallbackModels: 2,
      allowFallback: OPENROUTER_TAILOR_FALLBACK,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ],
    });

    const tailorProvider = completion.provider;
    const data = await completion.response.json().catch(() => null);
    if (!data) {
      console.error(`[DraftApply] ${tailorProvider} tailor response body failed to parse`);
      return res.status(502).json({ error: 'Unexpected response from AI provider. Please try again.' });
    }
    let tailoredCvText = tailor.finalizeTailoredCV(data?.choices?.[0]?.message?.content, {
      cvData,
      jdData,
      matchMap,
      confirmedSkills,
    });
    if (!tailoredCvText?.trim()) {
      console.error(`[DraftApply] ${tailorProvider} returned empty tailor content`);
      return res.status(502).json({ error: 'No output from provider' });
    }

    let auditSkipped = false;
    try {
      const { systemPrompt: auditSystemPrompt, userPrompt: auditUserPrompt, temperature: auditTemperature } =
        tailor.buildTailoredCvAuditPrompt(cvData, jdData, matchMap, tailoredCvText, confirmedSkills);
      const auditCompletion = await callChatCompletionWithFallback({
        workflow: 'cv_tailor',
        temperature: auditTemperature,
        maxTokens: 4500,
        timeoutMs: 30000,
        fallbackTimeoutMs: 30000,
        maxFallbackModels: 2,
        allowFallback: OPENROUTER_TAILOR_FALLBACK,
        messages: [
          { role: 'system', content: auditSystemPrompt },
          { role: 'user',   content: auditUserPrompt },
        ],
      });

      const auditData = await auditCompletion.response.json().catch(() => null);
      const auditedText = auditData?.choices?.[0]?.message?.content;
      if (auditedText?.trim() && tailor.isValidCvOutput(auditedText)) {
        const finalizedAudit = tailor.finalizeTailoredCV(auditedText, {
          cvData,
          jdData,
          matchMap,
          confirmedSkills,
        });
        if (finalizedAudit?.trim()) tailoredCvText = finalizedAudit;
        else auditSkipped = true;
      } else {
        auditSkipped = true;
        if (auditedText?.trim()) {
          console.warn('[DraftApply] Audit output rejected: response does not look like a CV');
        }
      }
    } catch (e) {
      auditSkipped = true;
      const detail = e instanceof LLMProviderError ? `${e.provider} ${e.status}` : e.message;
      console.warn('[DraftApply] Tailored CV audit skipped:', detail);
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

    res.json({
      tailoredCvText,
      matchReport,
      recruiterReview,
      warnings,
      changedSections,
      auditSkipped,
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
      evidenceRetrieval: tailorAgentContext.evidenceRetrieval,
      agentRun: summarizeAgentRun(tailorAgentContext),
      agentInsights: buildAgentInsights(tailorAgentContext),
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      return res.status(504).json({ error: 'AI service timed out. Please try again.' });
    }
    if (e instanceof LLMProviderError) {
      console.error(`[DraftApply] ${e.provider} tailor error ${e.status}:`, String(e.detail || '').slice(0, 400));
      const { status, body } = llmErrorResponse(e, { allowFallback: OPENROUTER_TAILOR_FALLBACK });
      return res.status(status).json(body);
    }
    console.error('[DraftApply] Tailor error:', e.message);
    return res.status(500).json({ error: 'Failed to tailor CV.' });
  }
});

app.listen(PORT, () => {
  console.log(`DraftApply Render proxy listening on :${PORT}`);
});
