/**
 * DraftApply model routing policy.
 *
 * The extension stays lightweight: it sends structured browser context to the
 * proxy. The proxy then decides whether a workflow should use a configured
 * lightweight OpenAI-compatible model endpoint or the hosted LLM path.
 */

export const DEFAULT_LIGHTWEIGHT_CHAT_MODEL = 'Qwen/Qwen3-4B-Instruct-2507';
// Qwen/Qwen3-Embedding-0.6B has no live Inference Providers route as of this
// writing (empty inferenceProviderMapping) and could not be benchmarked.
// mixedbread-ai/mxbai-embed-large-v1 was benchmarked live (via HF's
// hf-inference provider) against a deterministic keyword-matching baseline
// on shared/evidence-retrieval-eval-fixtures.js: at a recalibrated threshold
// it reached F1=0.89 with perfect precision (0 false positives), vs the
// baseline's F1=0.57 - see npm run eval:evidence-retrieval.
export const DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL = 'mixedbread-ai/mxbai-embed-large-v1';

export const LIGHTWEIGHT_MODEL_RECOMMENDATION = {
  chatModel: DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
  embeddingModel: DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL,
  rationale: [
    'Qwen3-4B-Instruct-2507 is Apache-2.0, text-first, strong at instruction following, and supports long context for CV + JD prompts.',
    'mxbai-embed-large-v1 was live-benchmarked (npm run eval:evidence-retrieval) against deterministic keyword matching and won with perfect precision - it never falsely promoted an unsupported requirement, which matters given the Truthfulness Guard Agent downstream. Qwen3-Embedding-0.6B has no live free-tier route to benchmark against as of this writing.',
    'Hosted Groq/OpenRouter remains the default for final answer and CV generation unless a local OpenAI-compatible endpoint is explicitly configured.',
  ],
};

export const WORKFLOW_AGENT_CHAINS = {
  applicationAnswer: [
    'Question Classifier Agent',
    'CV Grounding Agent',
    'Job Context Matcher',
    'Answer Drafting Agent',
    'Tone & Length Agent',
    'Truthfulness Guard Agent',
    'Final Answer Formatter',
  ],
  tailoredCv: [
    'JD Analysis Agent',
    'CV Parsing Agent',
    'Match Scoring Agent',
    'Gap Analysis Agent',
    'Keyword Optimisation Agent',
    'CV Rewrite Agent',
    'ATS Formatting Agent',
    'Truthfulness Guard Agent',
  ],
};

const ROUTE_POLICIES = {
  application_answer: {
    workflow: 'applicationAnswer',
    preferLocalWhenConfigured: false,
    localModel: DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
    hostedReason: 'Final answers are user-visible and benefit from the hosted quality path by default.',
  },
  jd_extract: {
    workflow: 'tailoredCv',
    preferLocalWhenConfigured: true,
    localModel: DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
    hostedReason: 'Falls back to hosted extraction when no local endpoint is configured.',
  },
  domain_suggestions: {
    workflow: 'tailoredCv',
    preferLocalWhenConfigured: true,
    localModel: DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
    hostedReason: 'Falls back to hosted role knowledge when no local endpoint is configured.',
  },
  jd_enrichment: {
    workflow: 'tailoredCv',
    preferLocalWhenConfigured: true,
    localModel: DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
    hostedReason: 'Falls back to hosted JD parsing when no local endpoint is configured.',
  },
  cv_tailor: {
    workflow: 'tailoredCv',
    preferLocalWhenConfigured: false,
    localModel: DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
    hostedReason: 'Tailored CV generation and audit remain on the hosted quality path by default.',
  },
};

export function getAgentChain(workflowName) {
  return WORKFLOW_AGENT_CHAINS[workflowName] || [];
}

export function selectModelRoute(task, {
  hasLocal = false,
  hasHosted = true,
  preferLocalForGeneration = false,
  localModel = DEFAULT_LIGHTWEIGHT_CHAT_MODEL,
} = {}) {
  const policy = ROUTE_POLICIES[task] || ROUTE_POLICIES.application_answer;
  const generationTask = task === 'application_answer' || task === 'cv_tailor';
  const useLocal = hasLocal && (!hasHosted || policy.preferLocalWhenConfigured || (generationTask && preferLocalForGeneration));

  if (useLocal) {
    return {
      task,
      provider: 'local-openai',
      model: localModel || policy.localModel,
      workflow: policy.workflow,
      agentChain: getAgentChain(policy.workflow),
      reason: 'Configured lightweight OpenAI-compatible model endpoint selected.',
    };
  }

  return {
    task,
    provider: hasHosted ? 'hosted-llm-proxy' : 'unavailable',
    model: hasHosted ? 'provider-default' : null,
    workflow: policy.workflow,
    agentChain: getAgentChain(policy.workflow),
    reason: policy.hostedReason,
  };
}

export function selectEmbeddingRoute({
  hasEmbedding = false,
  embeddingModel = DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL,
} = {}) {
  if (hasEmbedding) {
    return {
      task: 'evidence_retrieval',
      provider: 'local-openai-embeddings',
      model: embeddingModel || DEFAULT_LIGHTWEIGHT_EMBEDDING_MODEL,
      workflow: 'tailoredCv',
      agentChain: ['Candidate Evidence Map', 'Role Requirement Map', 'Evidence Reranker'],
      reason: 'Configured lightweight embedding endpoint is available for future CV/JD evidence retrieval.',
    };
  }

  return {
    task: 'evidence_retrieval',
    provider: 'deterministic-token-match',
    model: null,
    workflow: 'tailoredCv',
    agentChain: ['Candidate Evidence Map', 'Role Requirement Map', 'Deterministic Matcher'],
    reason: 'No embedding endpoint configured; DraftApply uses deterministic local match scoring.',
  };
}

export function buildAgentPromptHeader(workflowName) {
  const chain = getAgentChain(workflowName);
  if (!chain.length) return '';
  return `DRAFTAPPLY ORCHESTRATION CHAIN:
${chain.map((name, index) => `${index + 1}. ${name}`).join('\n')}

Operate as this chain in one pass. Do not reveal chain-of-thought or internal agent notes. Return only the final user-facing output.`;
}

export function withAgentPromptHeader(prompts, workflowName) {
  const header = buildAgentPromptHeader(workflowName);
  if (!header || !prompts?.systemPrompt) return prompts;
  return {
    ...prompts,
    systemPrompt: `${header}\n\n${prompts.systemPrompt}`,
    workflow: workflowName,
    agentChain: getAgentChain(workflowName),
  };
}
