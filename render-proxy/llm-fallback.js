export const PREFERRED_OPENROUTER_FREE_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct',
];

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_STALE_TTL_MS = 6 * 60 * 60 * 1000;
const NON_TEXT_MODEL_ID_RE = /(?:^|[/:._-])(audio|clip|dall-?e|embedding|embed|flux|image|imagen|lyria|moderation|rerank|stable-?diffusion|tts|video|vision|whisper)(?:$|[/:._-])/i;

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

export function buildOpenRouterFallbackModelOrder(models, preferred = PREFERRED_OPENROUTER_FREE_MODELS, now = Date.now()) {
  const freeIds = [...new Set(
    (models || [])
      .filter(model => isOpenRouterFreeTextModel(model, now))
      .map(model => model.id)
  )];
  const freeSet = new Set(freeIds);
  const preferredAvailable = preferred.filter(id => freeSet.has(id));
  const preferredSet = new Set(preferredAvailable);
  const remainder = freeIds
    .filter(id => !preferredSet.has(id))
    .sort((a, b) => a.localeCompare(b));
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
    ttlMs = DEFAULT_CACHE_TTL_MS,
    staleTtlMs = DEFAULT_STALE_TTL_MS,
    now = () => Date.now(),
  }) {
    this.fetchFn = fetchFn;
    this.apiKey = apiKey;
    this.ttlMs = ttlMs;
    this.staleTtlMs = staleTtlMs;
    this.now = now;
    this.cachedAt = 0;
    this.models = null;
    this.inFlight = null;
  }

  async getModels() {
    const age = this.now() - this.cachedAt;
    if (this.models && age < this.ttlMs) return this.models;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchModels()
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

  async fetchModels() {
    if (!this.fetchFn) throw new Error('OpenRouter model fetch is unavailable');
    const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    const response = await this.fetchFn('https://openrouter.ai/api/v1/models', { headers });
    if (!response.ok) throw new Error(`OpenRouter models fetch failed (${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw new Error('OpenRouter models response was malformed');
    return data.data;
  }
}
