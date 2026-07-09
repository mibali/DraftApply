import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const serverJs = fs.readFileSync(new URL('../render-proxy/server.js', import.meta.url), 'utf8');
const recipeJs = fs.readFileSync(new URL('../render-proxy/recipe/index.js', import.meta.url), 'utf8');
const agentWorkflowsJs = fs.readFileSync(new URL('../shared/agent-workflows.js', import.meta.url), 'utf8');
const evidenceRetrievalJs = fs.readFileSync(new URL('../shared/evidence-retrieval.js', import.meta.url), 'utf8');

describe('render proxy agent architecture', () => {
  it('keeps the multi-agent router additive to the existing hosted proxy flow', () => {
    expect(serverJs).toContain("from './model-router.js'");
    expect(serverJs).toContain('LOCAL_LLM_BASE_URL');
    expect(serverJs).toContain('LOCAL_LLM_PREFER_FOR_GENERATION');
    expect(serverJs).toContain('LOCAL_EMBEDDING_BASE_URL');
    expect(serverJs).toContain('LOCAL_EMBEDDING_PROMOTE_THRESHOLD');
    expect(serverJs).toContain('selectEmbeddingRoute');
    expect(serverJs).toContain('applyEmbeddingRetrieval');
    expect(serverJs).toContain('function localChatCompletionsUrl');
    expect(serverJs).toContain("/\\/chat\\/completions$/i");
    expect(serverJs).toContain("workflow: 'application_answer'");
    expect(serverJs).toContain("workflow: 'cv_tailor'");
    expect(serverJs).toContain('falling back to hosted proxy path');
    expect(serverJs).toContain('runApplicationAnswerAgents');
    expect(serverJs).toContain('runTailoredCvAgents');
  });

  it('exposes workflow and agent-chain metadata without replacing existing response fields', () => {
    expect(serverJs).toContain("res.setHeader('X-DraftApply-Workflow'");
    expect(serverJs).toContain("res.setHeader('X-DraftApply-Agent-Chain'");
    expect(serverJs).toContain('answer,');
    expect(serverJs).toContain('tailoredCvText,');
    expect(serverJs).toContain('agentChain: completion.route?.agentChain');
    expect(serverJs).toContain('agentInsights: buildAgentInsights');
    expect(serverJs).toContain('truthfulnessReport: buildTruthfulnessReport');
    expect(serverJs).toContain('domainRisk: summarizeDomainRisk');
    expect(serverJs).toContain('...buildQualityMetadata(completion)');
    expect(serverJs).toContain('draftapplyMeta');
  });

  it('exposes explicit reliability and truthfulness contracts for open-source deployments', () => {
    expect(serverJs).toContain('function deploymentQualityMode');
    expect(serverJs).toContain('function buildQualityMetadata');
    expect(serverJs).toContain('best_effort_free_fallback');
    expect(serverJs).toContain('configured_openrouter');
    expect(serverJs).toContain('function buildTruthfulnessReport');
    expect(serverJs).toContain('supportedClaims');
    expect(serverJs).toContain('transferableClaims');
    expect(serverJs).toContain('userConfirmedClaims');
    expect(serverJs).toContain('blockedClaims');
    expect(serverJs).toContain('reviewRequired');
    expect(serverJs).toContain('domainCredentialWarnings');
  });

  it('normalizes match reports to both extension and architecture-doc field names', () => {
    expect(agentWorkflowsJs).toContain('function normalizeMatchReport');
    expect(agentWorkflowsJs).toContain('unsupportedRequirements: unsupported');
    expect(agentWorkflowsJs).toContain('missingSkills,');
    expect(agentWorkflowsJs).toContain('transferableMatches');
  });

  it('injects the application answer agent chain in recipe-built prompts', () => {
    expect(recipeJs).toContain("import { withAgentPromptHeader } from '../model-router.js'");
    expect(recipeJs).toContain("withAgentPromptHeader(result, 'applicationAnswer')");
  });

  it('implements the stage-2 deterministic agents as shared modules', () => {
    expect(agentWorkflowsJs).toContain('questionClassifierAgent');
    expect(agentWorkflowsJs).toContain('candidateEvidenceMapAgent');
    expect(agentWorkflowsJs).toContain('roleRequirementMapAgent');
    expect(agentWorkflowsJs).toContain('cvGroundingAgent');
    expect(agentWorkflowsJs).toContain('jobContextMatcherAgent');
    expect(agentWorkflowsJs).toContain('matchScoringAgent');
    expect(agentWorkflowsJs).toContain('gapAnalysisAgent');
    expect(agentWorkflowsJs).toContain('keywordOptimisationAgent');
    expect(agentWorkflowsJs).toContain('atsFormattingAgent');
    expect(agentWorkflowsJs).toContain('domainRiskClassifierAgent');
    expect(agentWorkflowsJs).toContain('truthfulnessGuardAgent');
  });

  it('exposes stage-3 UI insight contracts without exposing raw workflow context', () => {
    expect(serverJs).toContain('function buildAgentInsights');
    expect(serverJs).toContain('matchedRequirements: (context.matchedRequirements || [])');
    expect(serverJs).toContain('keywordOptimisation: {');
    expect(serverJs).toContain('evidenceRetrieval: context.evidenceRetrieval');
    expect(serverJs).toContain('truthfulness: {');
  });

  it('deduplicates matchMap and domain-pack blocked claims by requirement key before reporting', () => {
    // A missing credential can be flagged both by the deterministic matchMap
    // (unmatched JD requirement) and the domain-pack classifier (missing
    // credential) - without dedup the same gap is listed and counted twice.
    expect(serverJs).toContain('function normalizeClaimKey');
    expect(serverJs).toContain('blockedRequirementKeys.has(normalizeClaimKey(credential))');
    expect(serverJs).toContain('.filter(item => item.missingCredentials.length > 0)');
  });

  it('implements stage-4 embedding retrieval as optional reranking with fallback', () => {
    expect(serverJs).toContain('localEmbeddingsUrl');
    expect(serverJs).toContain('function callEmbeddingEndpoint');
    expect(serverJs).toContain('rerankMatchMapWithEmbeddings');
    expect(serverJs).toContain('Embedding endpoint failed; deterministic matching was used');
    expect(evidenceRetrievalJs).toContain('promoteThreshold');
    expect(evidenceRetrievalJs).toContain("status: 'partial_match'");
  });
});
