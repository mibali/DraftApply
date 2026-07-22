// Shared, provider-agnostic pieces of talking to embedding endpoints,
// specifically the Hugging Face Inference Providers quirk: HF's router does
// not implement the OpenAI-compatible /v1/embeddings route (only chat
// completions) - embedding models there are called at
// /hf-inference/models/{model} with a native {inputs: [...]} request and a
// plain array-of-vectors response, not the OpenAI {data: [{embedding}]}
// shape.
//
// This module intentionally stops at URL-building and shape translation.
// Timeout/error-typing/telemetry are left to each caller (render-proxy's
// server.js needs typed LLMProviderError + logLLMAttempt telemetry;
// scripts/eval-evidence-retrieval.js needs neither) - forcing those into a
// shared function would either weaken production's error handling or drag
// server-only infrastructure into the eval script. What was actually
// duplicating and drifting between the two callers was this URL/shape logic,
// so that's the shared boundary.

export function isHfInferenceRouterUrl(rawBaseUrl) {
  return /(^|\.)router\.huggingface\.co$/i.test(
    (() => {
      try { return new URL(rawBaseUrl).hostname; } catch { return ''; }
    })()
  );
}

export function localEmbeddingsUrl(rawBaseUrl, model) {
  const base = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (isHfInferenceRouterUrl(base)) return `${base}/models/${model}`;
  if (/\/embeddings$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

export function buildEmbeddingsRequestBody(useHfNativeShape, model, input) {
  return useHfNativeShape ? { inputs: input } : { model, input };
}

export function parseEmbeddingsResponse(useHfNativeShape, data) {
  if (useHfNativeShape) return Array.isArray(data) ? data : [];
  return (data?.data || [])
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
    .map(item => item.embedding);
}
