# Embedding model evaluation for CV/JD evidence retrieval

## Why this exists

`LOCAL_EMBEDDING_MODEL` recommended `Qwen/Qwen3-Embedding-0.6B` for evidence retrieval/reranking, but that
model has no live route on Hugging Face's Inference Providers (`inferenceProviderMapping` is empty for it) - it
cannot be reached without self-hosting. This doc records what was actually tested as a free, live replacement,
and why `mixedbread-ai/mxbai-embed-large-v1` is the current default.

## Method

`npm run eval:evidence-retrieval` runs a hand-labeled fixture
(`shared/evidence-retrieval-eval-fixtures.js`: one CV's worth of evidence sentences against a set of JD
requirements, several deliberately worded as paraphrases with zero literal word overlap with the evidence)
through the actual production reranking code (`rerankMatchMapWithEmbeddings`), and computes precision/recall/F1
against a deterministic keyword-matching baseline.

## Findings, in order

1. **HF's OpenAI-compatible router (`router.huggingface.co/v1/...`) does not support embeddings** - only chat
   completions. Embedding models must be called at `https://router.huggingface.co/hf-inference/models/{model}`
   with a native `{"inputs": [...]}` request and a plain array-of-vectors response, not the OpenAI
   `{"data": [...]}` shape. `server.js`'s `callEmbeddingEndpoint` now detects this host and branches accordingly.

2. **`BAAI/bge-small-en-v1.5`** (33M params, live on `hf-inference`) tied the deterministic baseline at the old
   0.68/0.54 thresholds (F1=0.57) - but its raw similarity scores didn't cleanly separate true from false
   matches: the irrelevant requirement `GraphQL` scored *higher* (0.672) than three genuinely-supported
   paraphrase matches. Adding BGE's documented query-instruction prefix
   (`"Represent this sentence for searching relevant passages: "`) made this worse, not better - it shifted
   every score down by roughly the same amount without fixing the ordering, collapsing F1 to 0.00. That ruled
   out "missing prefix" as the explanation.

3. **`mixedbread-ai/mxbai-embed-large-v1`** (335M params, live on `hf-inference`) looked *worse* than
   `bge-small` at the old thresholds (F1=0.33) - but that was a threshold-calibration artifact, not a quality
   regression. Sweeping every possible single threshold against this model's actual score distribution found
   F1=0.89 at threshold≈0.576, with **perfect precision (1.00)** - zero false positives, missing only the single
   hardest paraphrase case. `bge-small`'s best-possible F1 at its own optimal threshold was 0.83 with precision
   0.71 (2 false positives).

## Decision

**`mixedbread-ai/mxbai-embed-large-v1`**, with `LOCAL_EMBEDDING_PROMOTE_THRESHOLD=0.60` /
`LOCAL_EMBEDDING_ENRICH_THRESHOLD=0.50`.

Precision was weighted over recall and over raw model size: DraftApply has a dedicated Truthfulness Guard Agent
specifically to prevent fabricated claims, so a false positive here (promoting a requirement the CV doesn't
actually support) is a worse failure mode than a false negative (missing a real match the candidate can still
mention themselves). `mxbai-embed-large-v1` is ~10x larger than `bge-small-en-v1.5`, but its stronger score
separation is why it's the recommended default despite the size/latency cost.

### Embeddings are additive to keyword matching, not a replacement

When the fixture was expanded from 8 to 13 labeled cases, the picture got more honest: at the production-safe
0.60 threshold, embeddings-in-isolation only *tie* the keyword baseline (both F1≈0.67), and the score
distributions of true vs. false matches genuinely overlap (irrelevant requirements can score 0.53-0.58, right in
the range of some true paraphrase matches) - no single threshold cleanly separates them.

But keyword matching and embeddings catch *different* true positives: keyword overlap catches literal matches
(`SQL`, `Technical writing`), embeddings catch pure paraphrases with zero shared words (`User research`,
`Vendor negotiation`). Production runs embeddings *after* deterministic matching and promotes on top of it, so
the shipped behaviour is the **union** of both - which lands above either method alone while keeping perfect
precision at the 0.60 threshold. The eval's `>> Combined` row measures this union, and the pass/fail gate is on
that combined result, since that is what actually ships. The earlier 8-case run's headline "F1=0.89 with perfect
precision" was partly small-sample luck; the combined-union framing is the durable finding.

## Caveats / what would change this

- The fixture has 13 labeled requirement/evidence pairs. That's enough to establish direction (the combined
  keyword+embedding union beats keyword-only; the old 0.68/0.54 thresholds were miscalibrated) but not enough to
  trust an exact threshold value blindly - it should be revisited as more real CV/JD pairs are added.
- `Qwen/Qwen3-Embedding-0.6B` was never actually benchmarked (no live route to test against). If HF or another
  provider starts serving it, it's worth re-running `npm run eval:evidence-retrieval` against it before
  assuming the current recommendation still holds.
- Thresholds were calibrated against `mxbai-embed-large-v1` specifically. Swapping `LOCAL_EMBEDDING_MODEL` to a
  different model without re-running the eval will silently carry over thresholds that were never tested
  against that model's score distribution - re-run the eval whenever the model changes.
