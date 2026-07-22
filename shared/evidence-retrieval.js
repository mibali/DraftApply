function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compact(value, max = 220) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function normaliseVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return [];
  const numeric = vector.map(value => Number(value));
  if (numeric.some(value => !Number.isFinite(value))) return [];
  const magnitude = Math.sqrt(numeric.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return [];
  return numeric.map(value => value / magnitude);
}

export function cosineSimilarity(a, b) {
  const left = normaliseVector(a);
  const right = normaliseVector(b);
  if (!left.length || left.length !== right.length) return 0;
  const len = left.length;
  let dot = 0;
  for (let i = 0; i < len; i += 1) dot += left[i] * right[i];
  return dot;
}

export function buildEvidenceRetrievalInputs(candidateEvidenceMap = {}, roleRequirementMap = {}, {
  maxEvidence = 80,
  maxRequirements = 80,
} = {}) {
  const evidenceItems = (candidateEvidenceMap.evidenceItems || [])
    .map((item, index) => ({
      id: item.sourceId || item.id || `cv_${index}`,
      sourceId: item.sourceId || item.id || `cv_${index}`,
      roleSourceId: item.roleSourceId,
      type: item.type || 'evidence',
      label: cleanText(item.label || item.type || 'CV evidence'),
      text: compact(item.text || item.label || '', 360),
    }))
    .filter(item => item.text)
    .slice(0, maxEvidence);

  const requirements = (roleRequirementMap.requirements || [])
    .map((item, index) => ({
      id: `req_${index}`,
      requirement: cleanText(item.requirement),
      type: item.type || 'required',
      priority: Number(item.priority || 1),
    }))
    .filter(item => item.requirement)
    .slice(0, maxRequirements);

  return {
    evidenceItems,
    requirements,
    texts: [
      ...evidenceItems.map(item => `${item.label}: ${item.text}`),
      ...requirements.map(item => `${item.type} requirement: ${item.requirement}`),
    ],
  };
}

export function rerankMatchMapWithEmbeddings(matchMap = [], retrievalInputs = {}, embeddings = [], {
  // Defaults recalibrated for mxbai-embed-large-v1 - see
  // docs/embedding-model-evaluation.md. Callers (server.js) pass explicit
  // values from LOCAL_EMBEDDING_*_THRESHOLD; these are the fallback.
  promoteThreshold = 0.60,
  enrichThreshold = 0.50,
  maxEvidencePerRequirement = 3,
  provider = 'local-openai-embeddings',
  model = '',
} = {}) {
  const evidenceItems = retrievalInputs.evidenceItems || [];
  const requirements = retrievalInputs.requirements || [];
  if (!Array.isArray(matchMap) || !matchMap.length || !evidenceItems.length || !requirements.length) {
    return {
      matchMap,
      retrieval: { provider, model, status: 'skipped', reason: 'No evidence or requirements to rerank.' },
    };
  }

  const evidenceVectors = embeddings.slice(0, evidenceItems.length);
  const requirementVectors = embeddings.slice(evidenceItems.length, evidenceItems.length + requirements.length);
  if (evidenceVectors.length !== evidenceItems.length || requirementVectors.length !== requirements.length) {
    return {
      matchMap,
      retrieval: { provider, model, status: 'skipped', reason: 'Embedding count did not match retrieval inputs.' },
    };
  }

  const allVectors = [...evidenceVectors, ...requirementVectors];
  const dimensions = allVectors[0]?.length;
  const vectorsAreValid = Number.isInteger(dimensions) && dimensions > 0 && allVectors.every(vector => (
    Array.isArray(vector)
    && vector.length === dimensions
    && vector.every(value => Number.isFinite(Number(value)))
  ));
  if (!vectorsAreValid) {
    return {
      matchMap,
      retrieval: { provider, model, status: 'skipped', reason: 'Embedding vectors were malformed or had inconsistent dimensions.' },
    };
  }

  const requirementScores = new Map();
  requirements.forEach((req, reqIndex) => {
    const scoredEvidence = evidenceItems
      .map((evidence, evidenceIndex) => ({
        ...evidence,
        retrievalIndex: evidenceIndex,
        score: cosineSimilarity(requirementVectors[reqIndex], evidenceVectors[evidenceIndex]),
      }))
      .filter(item => Number.isFinite(item.score))
      .sort((a, b) => (b.score - a.score) || a.retrievalIndex - b.retrievalIndex)
      .slice(0, maxEvidencePerRequirement);

    requirementScores.set(req.requirement.toLowerCase(), {
      requirement: req.requirement,
      topScore: scoredEvidence[0]?.score || 0,
      evidence: scoredEvidence,
    });
  });

  let enrichedCount = 0;

  const enhanced = matchMap.map(item => {
    const scored = requirementScores.get(String(item.requirement || '').toLowerCase());
    if (!scored || scored.topScore < enrichThreshold) return item;

    const retrievalEvidence = scored.evidence
      .filter(evidence => evidence.score >= enrichThreshold)
      .map(evidence => ({
        id: evidence.id,
        sourceId: evidence.sourceId || evidence.id,
        roleSourceId: evidence.roleSourceId,
        text: evidence.text,
        similarity: Number(evidence.score.toFixed(4)),
      }));

    if (retrievalEvidence.length === 0) return item;

    const base = {
      ...item,
      retrievalScore: Number(scored.topScore.toFixed(4)),
      retrievalProvider: provider,
      retrievalModel: model,
      retrievalEvidence,
    };

    enrichedCount += 1;
    return base;
  });

  return {
    matchMap: enhanced,
    retrieval: {
      provider,
      model,
      status: 'active',
      evidenceCount: evidenceItems.length,
      requirementCount: requirements.length,
      promotedCount: 0,
      enrichedCount,
      promoteThreshold,
      enrichThreshold,
      authorizationMode: 'ranking-only',
    },
  };
}
