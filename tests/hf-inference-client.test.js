import { describe, expect, it } from 'vitest';
import {
  isHfInferenceRouterUrl,
  localEmbeddingsUrl,
  buildEmbeddingsRequestBody,
  parseEmbeddingsResponse,
} from '../shared/hf-inference-client.js';

describe('isHfInferenceRouterUrl', () => {
  it('recognises the HF Inference Providers router host', () => {
    expect(isHfInferenceRouterUrl('https://router.huggingface.co/hf-inference')).toBe(true);
    expect(isHfInferenceRouterUrl('https://router.huggingface.co')).toBe(true);
  });

  it('does not match unrelated or self-hosted hosts', () => {
    expect(isHfInferenceRouterUrl('https://api.openai.com/v1')).toBe(false);
    expect(isHfInferenceRouterUrl('http://localhost:11434')).toBe(false);
    expect(isHfInferenceRouterUrl('not-a-url')).toBe(false);
    expect(isHfInferenceRouterUrl('')).toBe(false);
  });
});

describe('localEmbeddingsUrl', () => {
  it('builds the HF-native /models/{model} path for the router host', () => {
    expect(localEmbeddingsUrl('https://router.huggingface.co/hf-inference', 'BAAI/bge-small-en-v1.5'))
      .toBe('https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5');
  });

  it('builds a generic OpenAI-compatible /v1/embeddings path for other hosts', () => {
    expect(localEmbeddingsUrl('http://localhost:11434', 'model')).toBe('http://localhost:11434/v1/embeddings');
    expect(localEmbeddingsUrl('http://localhost:11434/v1', 'model')).toBe('http://localhost:11434/v1/embeddings');
    expect(localEmbeddingsUrl('http://localhost:11434/v1/embeddings', 'model')).toBe('http://localhost:11434/v1/embeddings');
  });
});

describe('buildEmbeddingsRequestBody', () => {
  it('uses the native {inputs} shape for HF', () => {
    expect(buildEmbeddingsRequestBody(true, 'model', ['a', 'b'])).toEqual({ inputs: ['a', 'b'] });
  });

  it('uses the OpenAI {model, input} shape otherwise', () => {
    expect(buildEmbeddingsRequestBody(false, 'model', ['a', 'b'])).toEqual({ model: 'model', input: ['a', 'b'] });
  });
});

describe('parseEmbeddingsResponse', () => {
  it('returns the plain array as-is for the HF-native shape', () => {
    const data = [[0.1, 0.2], [0.3, 0.4]];
    expect(parseEmbeddingsResponse(true, data)).toBe(data);
  });

  it('returns an empty array if the HF-native response is not an array', () => {
    expect(parseEmbeddingsResponse(true, { error: 'nope' })).toEqual([]);
  });

  it('unwraps and index-sorts the OpenAI {data:[{index,embedding}]} shape', () => {
    const data = { data: [{ index: 1, embedding: [0.3, 0.4] }, { index: 0, embedding: [0.1, 0.2] }] };
    expect(parseEmbeddingsResponse(false, data)).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });
});
