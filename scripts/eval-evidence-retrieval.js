// Evaluates whether embedding-reranked evidence matching actually beats
// deterministic keyword matching, using the labeled fixture in
// shared/evidence-retrieval-eval-fixtures.js.
//
// Without LOCAL_EMBEDDING_BASE_URL configured, the "embedding" row runs on a
// plain bag-of-words fallback purely so this script executes without a live
// model - that fallback cannot demonstrate real semantic quality and the
// script says so explicitly. Point LOCAL_EMBEDDING_BASE_URL at a live
// endpoint (e.g. https://router.huggingface.co/hf-inference) to get a real
// pass/fail result - see docs/embedding-model-evaluation.md for how the
// current default model/thresholds were chosen.

import { buildEvidenceRetrievalInputs, rerankMatchMapWithEmbeddings, cosineSimilarity } from '../shared/evidence-retrieval.js';
import { EVAL_EVIDENCE_ITEMS, EVAL_REQUIREMENTS } from '../shared/evidence-retrieval-eval-fixtures.js';

const LOCAL_EMBEDDING_BASE_URL = (process.env.LOCAL_EMBEDDING_BASE_URL || '').trim();
const LOCAL_EMBEDDING_API_KEY = process.env.LOCAL_EMBEDDING_API_KEY || 'local';
const LOCAL_EMBEDDING_MODEL = process.env.LOCAL_EMBEDDING_MODEL || 'mixedbread-ai/mxbai-embed-large-v1';
const PROMOTE_THRESHOLD = Number(process.env.LOCAL_EMBEDDING_PROMOTE_THRESHOLD || 0.60);
const ENRICH_THRESHOLD = Number(process.env.LOCAL_EMBEDDING_ENRICH_THRESHOLD || 0.50);
// Some embedding models (BGE, E5) are calibrated for asymmetric retrieval and
// expect an instruction prefix on the short "query" side only - here, the JD
// requirement, not the CV evidence sentence. Empty by default (matches
// current production behaviour); set to test whether prefixing fixes poor
// true/false score separation. BGE's documented prefix:
// "Represent this sentence for searching relevant passages: "
const REQUIREMENT_QUERY_PREFIX = process.env.LOCAL_EMBEDDING_QUERY_PREFIX || '';

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'into']);

function significantWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOPWORDS.has(word));
}

// Mirrors the keyword/substring matching DraftApply falls back to whenever no
// embedding endpoint is configured - the baseline this eval measures against.
function baselinePromotable(requirement, evidenceTexts) {
  const reqWords = significantWords(requirement);
  if (!reqWords.length) return false;
  return evidenceTexts.some(text => {
    const evWords = new Set(significantWords(text));
    const hits = reqWords.filter(word => evWords.has(word)).length;
    return hits / reqWords.length >= 0.5;
  });
}

// Mirrors render-proxy/server.js's isHfInferenceRouterUrl/localEmbeddingsUrl:
// HF's Inference Providers router only implements OpenAI-compatible routes
// for chat completions - embeddings there live at
// /hf-inference/models/{model} with a native {inputs: [...]} request and a
// plain array-of-vectors response, not the OpenAI {data: [...]} shape.
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

async function fetchRealEmbeddings(texts) {
  const useHfNativeShape = isHfInferenceRouterUrl(LOCAL_EMBEDDING_BASE_URL);
  const response = await fetch(localEmbeddingsUrl(LOCAL_EMBEDDING_BASE_URL, LOCAL_EMBEDDING_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LOCAL_EMBEDDING_API_KEY}` },
    body: JSON.stringify(useHfNativeShape ? { inputs: texts } : { model: LOCAL_EMBEDDING_MODEL, input: texts }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return useHfNativeShape
    ? (Array.isArray(data) ? data : [])
    : (data?.data || [])
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
        .map(item => item.embedding);
}

// Fallback so this script runs without a live model. This is a plain vector
// space over shared vocabulary, not a semantic embedding - it will score
// pure paraphrases (no shared words) at 0 similarity, same as the
// deterministic baseline. That is intentional: it must not fabricate a
// quality improvement it cannot actually prove.
function bagOfWordsVectors(texts) {
  const vocab = [...new Set(texts.flatMap(significantWords))];
  return texts.map(text => {
    const counts = significantWords(text).reduce((acc, word) => {
      acc[word] = (acc[word] || 0) + 1;
      return acc;
    }, {});
    return vocab.map(word => counts[word] || 0);
  });
}

// Sweeps every score value as a candidate threshold to find the best F1 this
// model's raw similarity scores could achieve on this fixture - removes the
// confound of the fixed 0.68/0.54 thresholds being calibrated for a
// different model than the one actually being tested.
function bestThresholdF1(scores, groundTruth) {
  const candidates = [...new Set(scores)].sort((a, b) => a - b);
  let best = { threshold: null, f1: -1, metrics: null };
  candidates.forEach(candidate => {
    const predictions = scores.map(score => score >= candidate);
    const metrics = scoreMetrics(predictions, groundTruth);
    if (metrics.f1 > best.f1) best = { threshold: candidate, f1: metrics.f1, metrics };
  });
  return best;
}

function scoreMetrics(predictions, groundTruth) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  predictions.forEach((predicted, index) => {
    const actual = groundTruth[index];
    if (predicted && actual) tp += 1;
    else if (predicted && !actual) fp += 1;
    else if (!predicted && actual) fn += 1;
    else tn += 1;
  });
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, tn, precision, recall, f1 };
}

function printMetrics(label, metrics) {
  process.stdout.write(
    `${label}\n  precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)} f1=${metrics.f1.toFixed(2)} ` +
    `(tp=${metrics.tp} fp=${metrics.fp} fn=${metrics.fn} tn=${metrics.tn})\n`
  );
}

async function main() {
  const evidenceTexts = EVAL_EVIDENCE_ITEMS.map(item => item.text);
  const groundTruth = EVAL_REQUIREMENTS.map(req => req.expectedPromotable);

  const baselinePredictions = EVAL_REQUIREMENTS.map(req => baselinePromotable(req.requirement, evidenceTexts));
  const baselineMetrics = scoreMetrics(baselinePredictions, groundTruth);

  const matchMap = EVAL_REQUIREMENTS.map(req => ({
    requirement: req.requirement,
    type: req.type,
    status: 'missing',
    evidence: [],
    allowedToMention: false,
  }));
  const retrievalInputs = buildEvidenceRetrievalInputs(
    { evidenceItems: EVAL_EVIDENCE_ITEMS },
    { requirements: EVAL_REQUIREMENTS },
  );

  // Prefix only the requirement ("query") side, per BGE/E5's asymmetric
  // retrieval convention - evidence ("passage") text stays plain either way.
  const evidenceCount = retrievalInputs.evidenceItems.length;
  const embeddingTexts = retrievalInputs.texts.map((text, index) => (
    index >= evidenceCount ? `${REQUIREMENT_QUERY_PREFIX}${text}` : text
  ));

  let usingRealEndpoint = Boolean(LOCAL_EMBEDDING_BASE_URL);
  let embeddings;
  if (usingRealEndpoint) {
    try {
      embeddings = await fetchRealEmbeddings(embeddingTexts);
    } catch (error) {
      process.stdout.write(`Live embedding endpoint call failed (${error.message}); falling back to bag-of-words.\n\n`);
      usingRealEndpoint = false;
    }
  }
  if (!usingRealEndpoint) {
    embeddings = bagOfWordsVectors(embeddingTexts);
  }

  const { matchMap: reranked } = rerankMatchMapWithEmbeddings(matchMap, retrievalInputs, embeddings, {
    promoteThreshold: PROMOTE_THRESHOLD,
    enrichThreshold: ENRICH_THRESHOLD,
    provider: usingRealEndpoint ? 'local-openai-embeddings' : 'bag-of-words-fallback',
    model: usingRealEndpoint ? LOCAL_EMBEDDING_MODEL : 'bag-of-words',
  });
  const embeddingPredictions = reranked.map(item => item.status === 'partial_match');
  const embeddingMetrics = scoreMetrics(embeddingPredictions, groundTruth);

  // What production actually does: embeddings run AFTER deterministic matching
  // and promote requirements on top of it, so the shipped behaviour is the
  // union of the two - not embeddings in isolation. Measure that too.
  const combinedPredictions = embeddingPredictions.map((got, index) => got || baselinePredictions[index]);
  const combinedMetrics = scoreMetrics(combinedPredictions, groundTruth);

  // Raw top similarity per requirement, independent of promote/enrich
  // thresholds - lets us see *how close* a miss actually was, since
  // rerankMatchMapWithEmbeddings only attaches a score once a requirement
  // clears enrichThreshold.
  const evidenceVectors = embeddings.slice(0, retrievalInputs.evidenceItems.length);
  const requirementVectors = embeddings.slice(retrievalInputs.evidenceItems.length);
  const topScores = requirementVectors.map(reqVector => Math.max(
    ...evidenceVectors.map(evVector => cosineSimilarity(reqVector, evVector)),
  ));
  const bestPossible = usingRealEndpoint ? bestThresholdF1(topScores, groundTruth) : null;

  process.stdout.write(`Evidence retrieval quality eval (${EVAL_REQUIREMENTS.length} requirements, ${EVAL_EVIDENCE_ITEMS.length} evidence items)\n`);
  process.stdout.write(`Requirement-side query prefix: ${REQUIREMENT_QUERY_PREFIX ? `"${REQUIREMENT_QUERY_PREFIX}"` : '(none)'}\n`);
  process.stdout.write('='.repeat(78) + '\n');
  printMetrics('Deterministic baseline (keyword overlap)', baselineMetrics);
  process.stdout.write('\n');
  printMetrics(
    usingRealEndpoint ? `Embedding-reranked (live: ${LOCAL_EMBEDDING_MODEL}, current thresholds)` : 'Embedding-reranked (bag-of-words fallback - NOT a real quality signal)',
    embeddingMetrics,
  );
  if (bestPossible) {
    process.stdout.write('\n');
    printMetrics(
      `Embedding-reranked (live: ${LOCAL_EMBEDDING_MODEL}, best-possible single threshold=${bestPossible.threshold.toFixed(3)})`,
      bestPossible.metrics,
    );
  }
  process.stdout.write('\n');
  printMetrics(
    usingRealEndpoint
      ? '>> Combined keyword + embedding (what production actually ships)'
      : '>> Combined keyword + bag-of-words (fallback - NOT a real quality signal)',
    combinedMetrics,
  );

  process.stdout.write(`\nPer-requirement (promoteThreshold=${PROMOTE_THRESHOLD}, enrichThreshold=${ENRICH_THRESHOLD}):\n`);
  EVAL_REQUIREMENTS.forEach((req, index) => {
    const baselineGot = baselinePredictions[index];
    const embeddingGot = embeddingPredictions[index];
    const marker = embeddingGot === req.expectedPromotable ? 'OK  ' : 'MISS';
    const score = topScores[index].toFixed(3);
    process.stdout.write(
      `  [${marker}] "${req.requirement}" expected=${req.expectedPromotable} baseline=${baselineGot} embedding=${embeddingGot} topScore=${score} - ${req.note}\n`
    );
  });

  if (!usingRealEndpoint) {
    process.stdout.write(
      '\nNo LOCAL_EMBEDDING_BASE_URL configured (or the call failed): the embedding-reranked row above ran on a ' +
      'plain bag-of-words fallback for pipeline validation only. It cannot demonstrate real semantic quality - set ' +
      'LOCAL_EMBEDDING_BASE_URL to a live embedding endpoint (e.g. https://router.huggingface.co/hf-inference) to get a real pass/fail result.\n'
    );
    return;
  }

  // Gate on the combined result, since that (not embeddings-in-isolation) is
  // what production ships: embeddings must not drag the shipped output below
  // the keyword-only baseline, and should ideally lift it.
  if (combinedMetrics.f1 < baselineMetrics.f1) {
    process.stderr.write(`\nFAIL: combined keyword+embedding F1 (${combinedMetrics.f1.toFixed(2)}) is worse than the keyword-only baseline (${baselineMetrics.f1.toFixed(2)}) - embeddings are actively hurting the shipped output.\n`);
    if (bestPossible.f1 > embeddingMetrics.f1) {
      process.stderr.write(
        `Note: embedding-only best-possible F1=${bestPossible.f1.toFixed(2)} at threshold=${bestPossible.threshold.toFixed(3)} - ` +
        `try recalibrating LOCAL_EMBEDDING_PROMOTE_THRESHOLD/LOCAL_EMBEDDING_ENRICH_THRESHOLD.\n`
      );
    }
    process.exitCode = 1;
    return;
  }
  const lift = combinedMetrics.f1 - baselineMetrics.f1;
  if (lift > 0.001) {
    process.stdout.write(`\nPASS: combined keyword+embedding F1 (${combinedMetrics.f1.toFixed(2)}) beats keyword-only baseline (${baselineMetrics.f1.toFixed(2)}) - embeddings add ${lift.toFixed(2)} F1 by catching paraphrase matches keyword overlap misses.\n`);
  } else {
    process.stdout.write(`\nPASS (no regression): combined F1 (${combinedMetrics.f1.toFixed(2)}) matches baseline (${baselineMetrics.f1.toFixed(2)}) at the configured thresholds. Embedding-only best-possible F1=${bestPossible.f1.toFixed(2)} at threshold=${bestPossible.threshold.toFixed(3)} suggests headroom via recalibration, weighed against the false positives a lower threshold admits.\n`);
  }
}

main();
