# DraftApply Architecture

DraftApply is a privacy-aware Chrome extension and proxy for CV-grounded job application answers and tailored CVs.

```text
Chrome Extension
  -> Page Context Extractor
  -> Local CV Store
  -> Render Proxy
     -> deterministic workflow agents
     -> recipe prompt builder
     -> model router
     -> Groq primary / local model / OpenRouter fallback
```

## Runtime Boundaries

- `extension-ready/` stores CV text in `chrome.storage.local`, extracts page context, displays generated output, and inserts text into form fields.
- `render-proxy/` authenticates install tokens, applies rate limiting, parses CV/JD inputs, builds prompts, routes models, and returns generation metadata.
- `shared/` contains deterministic parsers, Tailor CV logic, workflow-agent helpers, and evidence-retrieval helpers.
- `backend/` and `frontend/` are local development/offline app surfaces.

## Workflow Agents

The multi-agent design is implemented as deterministic workflow stages plus one-pass LLM orchestration. This keeps cost and latency controlled while still making evidence, gaps, and truthfulness visible.

Application answers:

```text
Question Classifier
  -> CV Grounding
  -> Job Context Matcher
  -> Answer Drafting Prompt
  -> Tone/Length Controls
  -> Truthfulness Metadata
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
  -> Truthfulness Metadata
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
- `truthfulnessReport`: supported, transferable, user-confirmed, and blocked claims.
- `agentInsights`: compact UI-safe evidence and workflow summaries.

The UI should show this metadata instead of hiding provider uncertainty or unsupported-claim risk.
