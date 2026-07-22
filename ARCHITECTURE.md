# DraftApply Architecture

DraftApply is a privacy-aware Chrome extension and proxy for CV-grounded job application answers and tailored CVs.

```text
Chrome Extension
  -> Page Context Extractor
  -> Local CV Store
  -> Render Proxy
     -> deterministic pipeline stages
     -> recipe prompt builder
     -> model router
     -> Groq primary / local model / OpenRouter fallback
```

## Runtime Boundaries

- `extension-ready/` is the official extension source. Its checked-in `build-config.js` selects the official hosted proxy; it stores CV text in `chrome.storage.local`, extracts page context, displays generated output, and inserts text into form fields.
- `render-proxy/` authenticates install tokens, applies rate limiting, parses CV/JD inputs, builds prompts, routes models, and returns generation metadata. Self-hosters deploy this service and use `scripts/build-extension.js --proxy-url=...` to generate a matching extension and host permission under `dist/` without modifying source or using a bundler.
- `shared/` contains deterministic parsers, Tailor CV logic, workflow-agent helpers, and evidence-retrieval helpers.
- `shared/domain-packs/` contains compact, versioned domain knowledge snapshots for regulated, credential-heavy, sparse, academic, trade, aviation, healthcare, legal, and portfolio-heavy roles.
- `backend/` and `frontend/` form a separate local development/offline web app. They are not a self-hosted extension backend and are not selected by extension build configuration.

Thus there are three distinct distributions: the official Chrome extension plus official Render proxy, a generated self-hosted extension plus a compatible self-hosted `render-proxy`, and the independent local web app.

## Deterministic Generation Pipeline

The named stages are ordinary deterministic modules, not autonomous agents. A model performs generation after input preparation; output is then validated.

Application answers:

```text
Question Classifier
  -> CV Grounding
  -> Job Context Matcher
  -> Input Grounding Report
  -> Answer Drafting Prompt
  -> Tone/Length Controls
  -> Final Answer Validation
  -> Final Answer
```

Tailored CV:

```text
CV Parser + JD Parser
  -> Candidate Evidence Map + Role Requirement Map
  -> Match Scoring
  -> Gap and Keyword Analysis
  -> CV Rewrite Prompt
  -> ATS Formatting Hints
  -> Input Grounding Report
  -> Final Output Validation
  -> Tailored CV
```

## Model Routing

Default recommendation:

1. Groq primary for final user-visible generation.
2. Optional local OpenAI-compatible Qwen endpoint for extraction and privacy-sensitive lightweight steps.
3. OpenRouter ranked fallback chain for transient Groq failures.
4. Optional `OPENROUTER_MODEL` for a configured paid/reliable OpenRouter route.

OpenRouter free routing is best-effort. The proxy avoids random `openrouter/free` as the product promise and instead builds a ranked model list from the official catalog.

## Risk Metadata Contract

Generated responses expose:

- `qualityMode`: route reliability, such as `hosted_primary`, `local_private`, `configured_openrouter`, `openrouter_fallback`, or `best_effort_free_fallback`.
- `qualityModeReason`: human-readable explanation.
- `inputGroundingReport`: pre-generation supported, transferable, user-confirmed, and blocked claims (`truthfulnessReport` is a deprecated compatibility alias).
- final validation metadata: checks the generated text rather than presenting input analysis as output proof.
- `agentInsights`: compact UI-safe evidence and workflow summaries.
- `providerTrace` and final-provider metadata: route attempts without prompt/CV bodies or credentials.

The UI should show this metadata instead of hiding provider uncertainty or unsupported-claim risk.

## Domain Knowledge Refresh

DraftApply uses domain packs to close gaps where generic CV matching is not enough:

- regulated professions such as legal, clinical healthcare, aviation, clearance-heavy public sector roles, and licensed trades
- academic/research CVs where publications, grants, supervision, and methods matter
- creative portfolios where written CV evidence is only part of the proof
- sparse or vague job descriptions that require stronger user confirmation

The runtime reads `shared/domain-packs/domain-pack.snapshot.json`. It does not fetch live third-party datasets during answer or CV generation. This keeps the extension/proxy deterministic, fast, and privacy-aware.

Source metadata lives in `shared/domain-packs/sources.json`. A scheduled GitHub Actions workflow runs `npm run refresh:domain-packs` with remote monitoring enabled, validates the snapshot, runs the test suite, and opens a pull request when the compact snapshot changes. Maintainers review attribution, checksums, and profile/rule changes before merge. Stable official raw export URLs can be added to `expectedRawFiles`; otherwise the workflow monitors each official landing page as a change signal.

## Domain Risk Layer

The domain pack snapshot is consumed by `shared/domain-packs/domain-classifier.js` and wired into deterministic pipeline stages. The classifier emits advisory metadata first:

- `domainRisk.primaryProfile`
- `domainRisk.credentialWarnings`
- `domainRisk.reviewPrompts`
- `truthfulnessReport.domainCredentialWarnings`

For normal well-described non-regulated roles this metadata is absent and the existing generation path is unchanged. For regulated or credential-heavy roles, unverified credentials requested by the JD are represented as blocked truthfulness claims and shown as review cues in the extension UI. The recipe and Tailor CV prompt builders receive the same metadata so they avoid claiming licenses, clearances, certifications, publications, or portfolio proof unless the CV or user confirmation supports them.
