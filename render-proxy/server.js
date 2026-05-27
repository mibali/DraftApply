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
import {
  OpenRouterFreeModelCache,
  PREFERRED_OPENROUTER_FREE_MODELS,
  buildOpenRouterFallbackModelOrder,
  isRetryableOpenRouterModelError,
  shouldUseOpenRouterFallback,
} from './llm-fallback.js';

const PORT = Number(process.env.PORT || 10000);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || 'https://draftapply.com';
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'DraftApply';
const OPENROUTER_TAILOR_FALLBACK = !/^false$/i.test(process.env.OPENROUTER_TAILOR_FALLBACK || 'true');
const OPENROUTER_MODEL_CACHE_TTL_MS = Number(process.env.OPENROUTER_MODEL_CACHE_TTL_MS || 10 * 60 * 1000);
const OPENROUTER_MAX_FALLBACK_MODELS = Math.max(1, Number(process.env.OPENROUTER_MAX_FALLBACK_MODELS || 6));
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

if ((!GROQ_API_KEY && !OPENROUTER_API_KEY) || !TOKEN_SECRET) {
  console.error('Missing required env vars: TOKEN_SECRET and at least one LLM key (GROQ_API_KEY or OPENROUTER_API_KEY) must be set. Exiting.');
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
    model,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'HTTP-Referer': OPENROUTER_SITE_URL,
      'X-Title': OPENROUTER_APP_NAME,
    },
  };
}

async function callProviderChat(provider, {
  messages,
  temperature = 0.7,
  maxTokens,
  stream = false,
  timeoutMs = 60000,
  model,
  attempt = 1,
  fallbackFrom = null,
}) {
  const config = llmProviderConfig(provider, model);
  if (!config.apiKey) {
    throw new LLMProviderError(provider, 0, 'Missing API key', null, config.model);
  }
  if (!config.model) {
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
        ...config.headers,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        stream,
        messages,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryAfterMs = retryAfterMsFromHeaders(response.headers) ?? retryAfterMsFromProviderDetail(text);
      logLLMAttempt({ provider, model: config.model, attempt, outcome: 'error', status: response.status, fallbackFrom, elapsedMs: Date.now() - startedAt });
      throw new LLMProviderError(provider, response.status, text.slice(0, 500), retryAfterMs, config.model);
    }

    logLLMAttempt({ provider, model: config.model, attempt, outcome: 'success', fallbackFrom, elapsedMs: Date.now() - startedAt });
    return { response, provider: config.provider, model: config.model };
  } catch (error) {
    if (error?.name === 'AbortError') {
      logLLMAttempt({ provider, model: config.model, attempt, outcome: 'timeout', fallbackFrom, elapsedMs: Date.now() - startedAt });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getOpenRouterFallbackModelOrder() {
  const models = await openRouterModelCache.getModels();
  return buildOpenRouterFallbackModelOrder(models, PREFERRED_OPENROUTER_FREE_MODELS)
    .slice(0, OPENROUTER_MAX_FALLBACK_MODELS);
}

async function callOpenRouterFreeFallback(options, { callStart, fallbackFrom = 'groq' } = {}) {
  let orderedModels;
  try {
    orderedModels = await getOpenRouterFallbackModelOrder();
  } catch (error) {
    throw new LLMProviderError('openrouter', 0, error.message || 'Could not load OpenRouter free model catalogue');
  }
  if (orderedModels.length === 0) {
    throw new LLMProviderError('openrouter', 0, 'No free OpenRouter text models are currently available');
  }

  let lastError = null;
  for (let i = 0; i < orderedModels.length; i += 1) {
    const model = orderedModels[i];
    const elapsed = Date.now() - callStart;
    const timeoutMs = Math.max(8000, (options.timeoutMs || 60000) - elapsed);
    try {
      return {
        ...(await callProviderChat('openrouter', {
          ...options,
          model,
          timeoutMs,
          attempt: i + 1,
          fallbackFrom,
        })),
        fallbackFrom,
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
  const primary = GROQ_API_KEY ? 'groq' : 'openrouter';
  const callStart = Date.now();
  try {
    if (primary === 'openrouter') return { ...(await callOpenRouterFreeFallback(options, { callStart, fallbackFrom: null })), fallbackFrom: null };
    return { ...(await callProviderChat(primary, { ...options, attempt: 1 })), fallbackFrom: null };
  } catch (error) {
    const canFallback = shouldUseOpenRouterFallback(error, {
      primary,
      hasOpenRouter: Boolean(OPENROUTER_API_KEY),
      allowFallback: options.allowFallback,
    });
    if (!canFallback) throw error;

    console.warn(`[DraftApply] Groq ${error.status || error.name || 'error'}; falling back to OpenRouter free models.`);
    return callOpenRouterFreeFallback(options, { callStart, fallbackFrom: primary });
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
  res.json({
    ok: true,
    provider: GROQ_API_KEY ? 'groq' : 'openrouter',
    model: GROQ_API_KEY ? GROQ_MODEL : 'openrouter-free-dynamic',
    fallbackProvider: GROQ_API_KEY && OPENROUTER_API_KEY ? 'openrouter' : null,
    fallbackModel: GROQ_API_KEY && OPENROUTER_API_KEY ? 'openrouter-free-dynamic' : null,
    fallbackModelPreference: GROQ_API_KEY && OPENROUTER_API_KEY ? PREFERRED_OPENROUTER_FREE_MODELS : [],
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
  [/^linkedin(\s*(url|link|profile|page))?$/i, cv => {
    const m = cv.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w\-_%]+\/?/i);
    return m?.[0] ?? null;
  }],
  [/^github(\s*(url|link|profile|page))?$/i, cv => {
    const m = cv.match(/https?:\/\/(?:www\.)?github\.com\/[\w\-]+\/?/i);
    return m?.[0] ?? null;
  }],
  [/^(portfolio|personal\s*website?|personal\s*site|blog)(\s*(url|link))?$/i, cv => {
    // Any URL that isn't LinkedIn/GitHub/Twitter
    const m = cv.match(/https?:\/\/(?!(?:www\.)?(?:linkedin|github|twitter|x)\.com)[\w\-._~:/?#%@!$&'()*+,;=]+/i);
    return m ? m[0].replace(/[.,;:)]+$/, '') : null;
  }],
  [/^(twitter|x\.com|x)(\s*(handle|url|link|profile))?$/i, cv => {
    const m = cv.match(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[\w_]+/i)
           ?? cv.match(/@[\w_]{2,30}/);
    return m?.[0] ?? null;
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

/**
 * Strip common form-field artifacts (*, :, ?) so recipe patterns match cleanly.
 * This runs engine-side so every recipe benefits without duplicating the logic.
 */
function cleanFieldLabel(raw) {
  return (raw || '')
    .trim()
    .replace(/[*:?\u2217\u2731]+$/g, '')   // trailing *, :, ?, unicode asterisks
    .replace(/^(please\s+(enter|provide|input|type|specify)\s+(your\s+)?)/i, '')
    .replace(/^(enter\s+(your\s+)?)/i, '')
    .replace(/^(your\s+)/i, '')
    .trim();
}

app.post('/api/generate', authRequired, generateLimiter, async (req, res) => {
  const body = req.body || {};

  let systemPrompt, userPrompt, temperature, maxTokens;

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
      return res.json({ answer: deterministicAnswer, provider: 'deterministic' });
    }

    // Parse CV and JD into structured data to enrich prompts with a
    // requirements bridge and relevance-ranked evidence hints.
    // Both operations are fast synchronous JS — no network, no LLM.
    // Any parsing failure is silenced; generation falls back to raw-text mode.
    let cvData;
    let jdData;
    let matchMap = [];
    try {
      cvData = new CVParser().parse(body.cvText);
      if (body.jobDescription && cvData) {
        jdData = new JDParser().parse(body.jobDescription, body.jobTitle || '', body.company || '');
        matchMap = new CVTailor().buildMatchMap(cvData, jdData);
      }
    } catch (_) {}

    try {
      const result = recipe.buildPrompts({
        question:       cleanedQuestion,
        length:         body.length || 'medium',
        tone:           body.tone || 'natural',
        cvText:         body.cvText,
        cvData:         cvData,
        jdData:         jdData,
        matchMap:       matchMap.length > 0 ? matchMap : undefined,
        roleProfile:    jdData?.roleProfile || undefined,
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
      if (completion.fallbackFrom) res.setHeader('X-DraftApply-Fallback-From', completion.fallbackFrom);

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
    const answer = data?.choices?.[0]?.message?.content;
    if (!answer?.trim()) return res.status(502).json({ error: 'No answer from provider' });

    res.json({ answer, provider: completion.provider, model: completion.model, fallbackFrom: completion.fallbackFrom || undefined });
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

    res.json({ extractedText, provider: completion.provider, fallbackFrom: completion.fallbackFrom || undefined });
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

app.post('/api/cv/analyze', authRequired, generateLimiter, async (req, res) => {
  const { cvText, jobTitle = '', company = '', jobDescription, confirmedSkills = [] } = req.body || {};

  if (!cvText || cvText.length < 100) {
    return res.status(400).json({ error: 'cvText must be at least 100 characters' });
  }
  if (!jobDescription || jobDescription.length < 50) {
    return res.status(400).json({ error: 'jobDescription must be at least 50 characters' });
  }

  try {
    const cvData = new CVParser().parse(cvText);
    const jdData = new JDParser().parse(jobDescription, jobTitle, company);
    const tailor  = new CVTailor();

    // Fire LLM domain call immediately so it runs in parallel with sync work below
    const llmSuggestionsPromise = fetchLLMDomainSuggestions(jdData.jobTitle, jdData.tools);

    // Sync work (fast — no LLM involved)
    const matchMap        = tailor.buildMatchMap(cvData, jdData, confirmedSkills);
    const staticFallback  = tailor.suggestDomainSkills(jdData, cvData);

    // Await the LLM domain call (already running in parallel)
    const llmRaw = await llmSuggestionsPromise.catch(() => null);

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
      matchReport: tailor.buildMatchSummary(matchMap),
      jobTitle: jdData.jobTitle,
      company:  jdData.company,
      domainSuggestions,
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

  const cvData  = new CVParser().parse(cvText);
  const jdParser = new JDParser();
  const jdData   = jdParser.parse(jobDescription, jobTitle, company);

  const tailor  = new CVTailor();
  const matchMap = tailor.buildMatchMap(cvData, jdData, confirmedSkills);

  const { systemPrompt, userPrompt } = tailor.buildTailoringPrompt(cvData, jdData, matchMap);

  try {
    const completion = await callChatCompletionWithFallback({
      temperature: 0.3,
      maxTokens: 4000,
      timeoutMs: 60000,
      allowFallback: OPENROUTER_TAILOR_FALLBACK,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ],
    });

    const tailorProvider = completion.provider;
    const data = await completion.response.json();
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

    try {
      const { systemPrompt: auditSystemPrompt, userPrompt: auditUserPrompt, temperature: auditTemperature } =
        tailor.buildTailoredCvAuditPrompt(cvData, jdData, matchMap, tailoredCvText, confirmedSkills);
      const auditCompletion = await callChatCompletionWithFallback({
        temperature: auditTemperature,
        maxTokens: 3500,
        timeoutMs: 25000,
        allowFallback: OPENROUTER_TAILOR_FALLBACK,
        messages: [
          { role: 'system', content: auditSystemPrompt },
          { role: 'user',   content: auditUserPrompt },
        ],
      });

      const auditData = await auditCompletion.response.json();
      const auditedText = auditData?.choices?.[0]?.message?.content;
      const finalizedAudit = tailor.finalizeTailoredCV(auditedText, {
        cvData,
        jdData,
        matchMap,
        confirmedSkills,
      });
      if (finalizedAudit?.trim()) tailoredCvText = finalizedAudit;
    } catch (e) {
      const detail = e instanceof LLMProviderError ? `${e.provider} ${e.status}` : e.message;
      console.warn('[DraftApply] Tailored CV audit skipped:', detail);
    }

    const warnings        = [
      ...tailor.validateTailoredCV(cvData, tailoredCvText),
      ...tailor.validateTailoringQuality(cvData, jdData, matchMap, tailoredCvText, confirmedSkills),
    ];
    const changedSections = tailor.detectChangedSections(cvText, tailoredCvText);
    const matchReport     = tailor.buildMatchSummary(matchMap);
    const recruiterReview = tailor.buildRecruiterReview(
      cvData,
      jdData,
      matchMap,
      tailoredCvText,
      warnings,
      confirmedSkills
    );

    res.json({
      tailoredCvText,
      matchReport,
      recruiterReview,
      warnings,
      changedSections,
      provider: tailorProvider,
      model: completion.model,
      fallbackFrom: completion.fallbackFrom || undefined
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
