import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
  DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL,
  LIGHTWEIGHT_MODEL_RECOMMENDATION,
  WORKFLOW_AGENT_CHAINS,
  buildAgentPromptHeader,
  selectEmbeddingRoute,
  selectModelRoute,
  withAgentPromptHeader,
} from '../render-proxy/model-router.js';

describe('model router', () => {
  it('documents the selected lightweight model strategy', () => {
    expect(LIGHTWEIGHT_MODEL_RECOMMENDATION.chatModel).toBe(DEFAULT_LIGHTWEIGHT_CHAT_MODEL);
    expect(LIGHTWEIGHT_MODEL_RECOMMENDATION.embeddingModel).toBe(DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL);
    expect(DEFAULT_LIGHTWEIGHT_CHAT_MODEL).toBe('Qwen/Qwen3-4B-Instruct-2507');
    expect(DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL).toBe('mixedbread-ai/mxbai-embed-large-v1');
    expect(LIGHTWEIGHT_MODEL_RECOMMENDATION.rationale.join(' ')).toMatch(/hosted Groq\/OpenRouter remains the default/i);
  });

  it('uses hosted generation by default even when local lightweight routing exists', () => {
    const route = selectModelRoute('application_answer', {
      hasLocal: true,
      hasHosted: true,
    });

    expect(route.provider).toBe('hosted-llm-proxy');
    expect(route.workflow).toBe('applicationAnswer');
    expect(route.agentChain).toEqual(WORKFLOW_AGENT_CHAINS.applicationAnswer);
  });

  it('routes extraction-style tasks to local lightweight models when configured', () => {
    const route = selectModelRoute('jd_extract', {
      hasLocal: true,
      hasHosted: true,
      localModel: 'local/qwen3-4b',
    });

    expect(route.provider).toBe('local-openai');
    expect(route.model).toBe('local/qwen3-4b');
    expect(route.workflow).toBe('tailoredCv');
  });

  it('allows explicit local generation preference without making it the default', () => {
    const route = selectModelRoute('application_answer', {
      hasLocal: true,
      hasHosted: true,
      preferLocalForGeneration: true,
    });

    expect(route.provider).toBe('local-openai');
    expect(route.model).toBe(DEFAULT_LIGHTWEIGHT_CHAT_MODEL);
  });

  it('uses local generation when no hosted provider is configured', () => {
    const route = selectModelRoute('application_answer', {
      hasLocal: true,
      hasHosted: false,
    });

    expect(route.provider).toBe('local-openai');
    expect(route.workflow).toBe('applicationAnswer');
  });

  it('injects agent chain instructions without changing the prompt contract', () => {
    const prompts = withAgentPromptHeader({
      systemPrompt: 'You are this candidate.',
      userPrompt: 'Question: Why us?',
      temperature: 0.7,
      maxTokens: 300,
    }, 'applicationAnswer');

    expect(prompts.systemPrompt).toMatch(/DRAFTAPPLY ORCHESTRATION CHAIN/);
    expect(prompts.systemPrompt).toMatch(/Question Classifier Agent/);
    expect(prompts.systemPrompt).toMatch(/Truthfulness Guard Agent/);
    expect(prompts.userPrompt).toBe('Question: Why us?');
    expect(prompts.agentChain).toEqual(WORKFLOW_AGENT_CHAINS.applicationAnswer);
  });

  it('keeps internal agent notes out of user-facing output instructions', () => {
    expect(buildAgentPromptHeader('tailoredCv')).toMatch(/Do not reveal chain-of-thought or internal agent notes/);
  });

  it('routes evidence retrieval to embeddings only when configured', () => {
    const inactive = selectEmbeddingRoute();
    expect(inactive.provider).toBe('deterministic-token-match');

    const active = selectEmbeddingRoute({ hasEmbedding: true });
    expect(active.provider).toBe('local-openai-embeddings');
    expect(active.model).toBe(DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL);
  });
});
