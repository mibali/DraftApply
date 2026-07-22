export const PREFERRED_OPENROUTER_FREE_MODELS = [
  'qwen/qwen3-32b:free',
  'deepseek/deepseek-r1:free',
  'tencent/hy3:free',
  'google/gemma-3-27b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct',
];

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_STALE_TTL_MS = 6 * 60 * 60 * 1000;
const NON_TEXT_MODEL_ID_RE = /(?:^|[/:._-])(audio|clip|dall-?e|embedding|embed|flux|image|imagen|lyria|moderation|rerank|stable-?diffusion|tts|video|vision|whisper)(?:$|[/:._-])/i;

export function providerEndpoint(value, fallback, name = 'provider URL') {
  const raw = String(value || fallback || '').trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be a valid absolute URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} must use http or https`);
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  return url.href;
}

export function coercePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function priceIsFree(value) {
  if (value == null || value === '') return true;
  return Number(value) === 0;
}

function isExpired(model, now = Date.now()) {
  if (!model?.expiration_date) return false;
  const expiry = Date.parse(model.expiration_date);
  return Number.isFinite(expiry) && expiry <= now;
}

function daysUntilExpiry(model, now = Date.now()) {
  if (!model?.expiration_date) return Infinity;
  const expiry = Date.parse(model.expiration_date);
  if (!Number.isFinite(expiry)) return Infinity;
  return (expiry - now) / (24 * 60 * 60 * 1000);
}

export function isOpenRouterFreeTextModel(model, now = Date.now()) {
  if (!model || typeof model.id !== 'string' || !model.id) return false;
  if (isExpired(model, now)) return false;
  if (NON_TEXT_MODEL_ID_RE.test(model.id)) return false;

  const inputModalities = model.architecture?.input_modalities || [];
  const outputModalities = model.architecture?.output_modalities || [];
  const supportsTextInput = inputModalities.length === 0 || inputModalities.includes('text');
  const supportsTextOutput = outputModalities.length === 0 || outputModalities.includes('text');
  if (!supportsTextInput || !supportsTextOutput) return false;

  const pricing = model.pricing || {};
  return priceIsFree(pricing.prompt)
    && priceIsFree(pricing.completion)
    && priceIsFree(pricing.request);
}

export function scoreOpenRouterModelForDraftApply(model, now = Date.now()) {
  if (!isOpenRouterFreeTextModel(model, now)) return -Infinity;

  const id = String(model.id || '').toLowerCase();
  const name = String(model.name || '').toLowerCase();
  const description = String(model.description || '').toLowerCase();
  const haystack = `${id} ${name} ${description}`;
  const contextLength = Number(model.context_length || model.top_provider?.context_length || 0);
  const supported = new Set(model.supported_parameters || []);

  let score = 0;

  if (/qwen|deepseek|gemma|llama|mistral|mixtral|glm|kimi|hy3|nemotron|command/.test(haystack)) score += 30;
  if (/instruct|instruction|chat|assistant|reasoning|agentic/.test(haystack)) score += 16;
  if (/structured_outputs|response_format/.test([...supported].join(' '))) score += 8;
  if (supported.has('temperature')) score += 4;
  if (supported.has('max_tokens')) score += 4;
  if (contextLength >= 32000) score += 10;
  if (contextLength >= 128000) score += 6;

  if (/code|coder|coding/.test(haystack)) score -= 12;
  if (/roleplay|story|storytelling|image|audio|speech/.test(haystack)) score -= 16;
  if (model.reasoning?.mandatory) score -= 8;
  if (model.reasoning?.default_enabled) score -= 4;

  const expiryDays = daysUntilExpiry(model, now);
  if (expiryDays < 3) score -= 40;
  else if (expiryDays < 14) score -= 12;

  const created = Number(model.created || 0);
  if (created > 0) score += Math.min(5, created / 1_000_000_000);

  return score;
}

export function buildOpenRouterFallbackModelOrder(models, preferred = PREFERRED_OPENROUTER_FREE_MODELS, now = Date.now()) {
  const freeModelsById = new Map();
  for (const model of models || []) {
    if (!isOpenRouterFreeTextModel(model, now)) continue;
    if (!freeModelsById.has(model.id)) freeModelsById.set(model.id, model);
  }

  const freeIds = [...freeModelsById.keys()];
  const freeSet = new Set(freeIds);
  const preferredAvailable = preferred.filter(id => freeSet.has(id));
  const preferredSet = new Set(preferredAvailable);
  const remainder = freeIds
    .filter(id => !preferredSet.has(id))
    .sort((a, b) => {
      const scoreDiff = scoreOpenRouterModelForDraftApply(freeModelsById.get(b), now) -
        scoreOpenRouterModelForDraftApply(freeModelsById.get(a), now);
      if (scoreDiff !== 0) return scoreDiff;
      return a.localeCompare(b);
    });
  return [...preferredAvailable, ...remainder];
}

export function isRetryablePrimaryProviderError(error) {
  if (error?.name === 'AbortError') return true;
  const status = Number(error?.status);
  return status === 429 || status === 408 || status >= 500;
}

export function isRetryableOpenRouterModelError(error) {
  if (error?.name === 'AbortError') return true;
  const status = Number(error?.status);
  return status === 429 || status === 408 || status === 404 || status >= 500;
}

export function shouldUseOpenRouterFallback(error, {
  primary = 'groq',
  hasOpenRouter = false,
  allowFallback = true,
} = {}) {
  return allowFallback !== false
    && primary === 'groq'
    && hasOpenRouter
    && isRetryablePrimaryProviderError(error);
}

export class OpenRouterFreeModelCache {
  constructor({
    fetchFn,
    apiKey,
    modelsUrl = 'https://openrouter.ai/api/v1/models',
    ttlMs = DEFAULT_CACHE_TTL_MS,
    staleTtlMs = DEFAULT_STALE_TTL_MS,
    fetchTimeoutMs = 10000,
    now = () => Date.now(),
  }) {
    this.fetchFn = fetchFn;
    this.apiKey = apiKey;
    this.modelsUrl = providerEndpoint(modelsUrl, undefined, 'OpenRouter models URL');
    this.ttlMs = ttlMs;
    this.staleTtlMs = staleTtlMs;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.now = now;
    this.cachedAt = 0;
    this.models = null;
    this.inFlight = null;
  }

  async getModels({ timeoutMs = this.fetchTimeoutMs } = {}) {
    const age = this.now() - this.cachedAt;
    if (this.models && age < this.ttlMs) return this.models;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchModels(timeoutMs)
      .then(models => {
        this.models = models;
        this.cachedAt = this.now();
        return models;
      })
      .catch(error => {
        const staleAge = this.now() - this.cachedAt;
        if (this.models && staleAge < this.staleTtlMs) return this.models;
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  async fetchModels(timeoutMs = this.fetchTimeoutMs) {
    if (!this.fetchFn) throw new Error('OpenRouter model fetch is unavailable');
    const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await this.fetchFn(this.modelsUrl, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`OpenRouter models fetch failed (${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data?.data)) throw new Error('OpenRouter models response was malformed');
      return data.data;
    } finally {
      clearTimeout(timeout);
    }
  }
}
