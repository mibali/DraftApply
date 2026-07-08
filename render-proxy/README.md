# DraftApply Proxy Engine (Open Source)

This service keeps your **Groq API key server-side** and exposes a small HTTPS API that the DraftApply Chrome extension calls to generate answers.

The proxy uses a **pluggable recipe interface**: the default recipe (`recipe/index.js`) is fully open source and includes prompt logic for data extraction, cover letters, "why company" questions, and anti-recency-bias answers. You can override it with `RECIPE_PATH` to use a custom module.

---

## Architecture

```
Extension  ──(structured JSON)──▶  Proxy Engine  ──▶  Recipe Module  ──▶  LLM (Groq)
                                     (open source)      (default: recipe/index.js)
```

| Component | Description |
|-----------|-------------|
| **Proxy engine** (`server.js`) | Auth, rate limits, CV upload, LLM call, request validation |
| **Recipe** (`recipe/index.js`) | Default prompt builder: data extraction, cover letters, why-company, full-CV context |
| **Extension** | UI, page extraction, sends structured data to proxy |

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | None | Health check |
| `POST` | `/api/register` | None (rate-limited) | Issue install token → `{ token, expiresAt }` |
| `POST` | `/api/generate` | `Bearer <token>` | Generate an answer (structured or legacy payload) |
| `POST` | `/api/cv/upload` | `Bearer <token>` | Upload CV file (PDF/DOCX/TXT) → extracted text |

### `POST /api/generate` – Structured Payload (preferred)

```json
{
  "question":       "Why do you want to join our team?",
  "length":         "medium",
  "cvText":         "Full CV text...",
  "jobTitle":       "Senior Engineer",
  "company":        "Acme Corp",
  "jobDescription": "We are looking for...",
  "requirements":   ["3+ years experience", "React", "Node.js"],
  "pageUrl":        "https://jobs.example.com/apply/123",
  "platform":       "greenhouse"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `question` | `string` | Yes | The application question or field label |
| `cvText` | `string` | Yes | Full CV text (min 5 chars) |
| `length` | `string` | No | `"short"`, `"medium"` (default), or `"long"` |
| `jobTitle` | `string` | No | Extracted job title |
| `company` | `string` | No | Extracted company name |
| `jobDescription` | `string` | No | Extracted job description text |
| `requirements` | `string[]` | No | Extracted key requirements |
| `pageUrl` | `string` | No | URL of the application page |
| `platform` | `string` | No | Detected ATS platform |

**Response:**

```json
{
  "answer": "Generated answer text...",
  "provider": "groq",
  "model": "llama-3.3-70b-versatile"
}
```

### Legacy Payload (backward-compatible)

```json
{
  "systemPrompt": "You are...",
  "userPrompt": "CV: ...\nQuestion: ...",
  "temperature": 0.7
}
```

The proxy accepts either format. Structured payloads are routed through the recipe module; legacy payloads are passed directly to the LLM.

---

## Recipe Plug-in Interface

The recipe module must export a single function:

```js
export function buildPrompts(input) {
  // input: { question, length, cvText, jobTitle, company, jobDescription, requirements, pageUrl, platform }
  return {
    systemPrompt: '...',
    userPrompt: '...',
    temperature: 0.7  // optional
  };
}
```

The default recipe at `recipe/index.js` handles:

- **Data extraction** (name, email, phone, LinkedIn, etc.) – returns only the value
- **Cover letter** – full letter with greeting, paragraphs, closing
- **"Why company"** – tailored to job context and CV
- **General questions** – uses full CV (head + tail to avoid recency bias) and job description

### Using a custom recipe

Set the `RECIPE_PATH` environment variable to the path of your recipe module:

```bash
RECIPE_PATH=./my-recipe/index.js npm start
```

If `RECIPE_PATH` is not set (or fails to load), the proxy uses the bundled recipe at `recipe/index.js`.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROQ_API_KEY` | Yes, unless `OPENROUTER_API_KEY` or `LOCAL_LLM_BASE_URL` is set | — | Groq API key; used as the primary hosted LLM provider when present |
| `OPENROUTER_API_KEY` | No | — | OpenRouter API key; used as fallback when Groq is rate-limited, times out, or returns a transient error. Free fallback models are discovered from OpenRouter's official models API. |
| `OPENROUTER_MODEL` | No | — | Optional configured OpenRouter model. Use this when you want a paid/reliable OpenRouter route ahead of free fallback. |
| `OPENROUTER_MAX_FALLBACK_MODELS` | No | `6` | Maximum OpenRouter free models to try per request after Groq fails |
| `OPENROUTER_USE_MODELS_ARRAY` | No | `true` | Send the ranked fallback chain to OpenRouter as one `models` request so OpenRouter handles model/provider failover. Set `false` to use DraftApply's older manual loop. |
| `OPENROUTER_PROVIDER_SORT` | No | `throughput` | Provider routing preference for OpenRouter fallback. `throughput` is the default for reducing free-model stalls. |
| `OPENROUTER_REQUIRE_DATA_PRIVACY` | No | `true` | Adds OpenRouter provider routing preferences that deny providers marked as collecting data. |
| `OPENROUTER_MODEL_CACHE_TTL_MS` | No | `600000` | How long to cache OpenRouter's official models catalogue in memory |
| `OPENROUTER_TAILOR_FALLBACK` | No | `true` | Tailor CV generation/audit falls back to OpenRouter by default when `OPENROUTER_API_KEY` is set. Set to `false` only if you want Tailor CV to hard-fail rather than use OpenRouter as backup. |
| `OPENROUTER_SITE_URL` | No | `https://draftapply.com` | Optional OpenRouter attribution header |
| `OPENROUTER_APP_NAME` | No | `DraftApply` | Optional OpenRouter attribution header |
| `LOCAL_LLM_BASE_URL` | No | — | Optional OpenAI-compatible local/lightweight model endpoint, e.g. Ollama/vLLM/LM Studio. When set, extraction-style workflows route here first. |
| `LOCAL_LLM_API_KEY` | No | `local` | Bearer token sent to `LOCAL_LLM_BASE_URL`; many local servers ignore it. |
| `LOCAL_LLM_MODEL` | No | `Qwen/Qwen3-4B-Instruct-2507` | Recommended lightweight chat model for local agent steps. |
| `LOCAL_LLM_PREFER_FOR_GENERATION` | No | `false` | Set to `true` only if you want final answer/CV generation to prefer the local lightweight route before hosted fallback. |
| `LOCAL_EMBEDDING_BASE_URL` | No | — | Optional OpenAI-compatible embeddings endpoint used for CV/JD evidence retrieval and reranking. |
| `LOCAL_EMBEDDING_API_KEY` | No | `LOCAL_LLM_API_KEY` or `local` | Bearer token for the embeddings endpoint. |
| `LOCAL_EMBEDDING_MODEL` | No | `mixedbread-ai/mxbai-embed-large-v1` | Live-benchmarked embedding model for CV/JD evidence matching (see below). |
| `LOCAL_EMBEDDING_TIMEOUT_MS` | No | `12000` | Timeout for the optional embeddings call. On failure, DraftApply falls back to deterministic matching. |
| `LOCAL_EMBEDDING_PROMOTE_THRESHOLD` | No | `0.60` | Minimum cosine similarity to promote a missing requirement to transferable/partial evidence. |
| `LOCAL_EMBEDDING_ENRICH_THRESHOLD` | No | `0.50` | Minimum cosine similarity to enrich already-supported requirements with better evidence snippets. |
| `TOKEN_SECRET` | Yes | — | Random long string for signing install tokens |
| `GROQ_MODEL` | No | `llama-3.3-70b-versatile` | Groq model identifier |
| `RECIPE_PATH` | No | `./recipe/index.js` | Path to recipe module (optional override) |
| `PORT` | No | `10000` | Server listen port |

---

## Deploy on Render

1. Push this repo to GitHub.
2. Render → New → Web Service → connect repo.
3. Root directory: `render-proxy`
4. Build command: `npm install`
5. Start command: `npm start`
6. Add env vars: `GROQ_API_KEY`, `TOKEN_SECRET`. Optionally add `OPENROUTER_API_KEY` for fallback. Leave `OPENROUTER_TAILOR_FALLBACK` unset to allow Tailor CV fallback, or set it to `false` if you deliberately want Tailor CV to fail rather than use OpenRouter. No need to set `RECIPE_PATH` unless you use a custom recipe.

### Lightweight model router

DraftApply now exposes a conservative model-router policy:

- Final application answers and tailored CV generation stay on the hosted quality path by default.
- JD extraction, JD enrichment, and domain suggestion steps can use a configured local OpenAI-compatible endpoint first.
- Recommended lightweight local chat model: `Qwen/Qwen3-4B-Instruct-2507`.
- Recommended evidence matching / retrieval model: `mixedbread-ai/mxbai-embed-large-v1`, reachable free via Hugging
  Face's `hf-inference` provider at `https://router.huggingface.co/hf-inference` (see
  [`docs/embedding-model-evaluation.md`](../docs/embedding-model-evaluation.md) for how this was chosen).
- `/api/health` reports whether the optional embedding endpoint is configured and shows the active retrieval thresholds.
- `/api/health` also reports `qualityMode`, so operators can tell whether the deployment is on hosted primary, local private, configured OpenRouter, or best-effort free fallback.
- If `LOCAL_EMBEDDING_BASE_URL` is set, Tailor CV analysis/generation uses embeddings to rerank CV evidence against JD requirements. If embeddings fail, time out, or return malformed data, deterministic matching remains active.

Run `npm run eval:evidence-retrieval` to check whether embedding-reranked matching actually beats deterministic
keyword matching on a hand-labeled fixture (`shared/evidence-retrieval-eval-fixtures.js`). Without
`LOCAL_EMBEDDING_BASE_URL` set, it runs on a bag-of-words fallback purely so the script executes — that mode
cannot prove real quality and says so explicitly. Set `LOCAL_EMBEDDING_BASE_URL` to a live embedding endpoint
(e.g. `https://router.huggingface.co/hf-inference`) to get a real precision/recall/F1 comparison; the script
exits non-zero if the live embedding path underperforms the deterministic baseline at the *configured*
thresholds, and separately reports the best F1 achievable at any threshold so a bad result can be told apart
from a miscalibrated one.

This keeps the browser extension unchanged and privacy-first while letting operators evaluate smaller open models for lower-risk agent steps.

### OpenRouter fallback orchestration

OpenRouter free models are best-effort capacity. OpenRouter documents that free-model availability can vary, rate limits are lower, latency may be higher, and the `openrouter/free` router selects randomly. DraftApply therefore avoids random free routing for production flows.

The proxy now:

- Builds a DraftApply-specific ranked shortlist from the official model catalogue instead of falling through to alphabetical free-model order.
- Sends the shortlist to OpenRouter with the `models` fallback array so OpenRouter performs model/provider failover in one request.
- Sorts OpenRouter providers by throughput by default.
- Requests OpenRouter router metadata so the actual served model can be surfaced in extension UI.
- Keeps Groq/local Qwen as the preferred quality path. OpenRouter free remains a fallback, not the main production plan.

For reliability, the recommended production path is:

1. Groq primary for final answer/CV generation.
2. Local/OpenAI-compatible Qwen for extraction and privacy-sensitive lightweight agent steps.
3. OpenRouter fallback with `OPENROUTER_USE_MODELS_ARRAY=true`.
4. If free models remain unreliable for your traffic, configure a paid OpenRouter model via `OPENROUTER_MODEL` or prefer local Qwen instead of free-only fallback.

A free way to run the local chat model: [`hf-space-local-llm/`](../hf-space-local-llm/) is a
`llama.cpp`-based Hugging Face Space (Docker SDK, free CPU tier) behind an OpenAI-compatible API.
`Qwen/Qwen3-4B-Instruct-2507` measured too slow on that free CPU tier (~0.2-0.5 tok/s); the Space
currently pulls `Qwen/Qwen3-1.7B` instead, pending a speed benchmark on the same hardware. Deploy
it as its own Space, then point `LOCAL_LLM_BASE_URL` at it — see that directory's README for setup,
the required `LLM_API_KEY` secret, and current benchmark notes.

### Stage-2/3/4 agents, UI insights, and retrieval

The proxy also runs a shared deterministic agent layer before final model calls:

- Application answers: question classification, CV grounding, job-context matching, truthfulness guard metadata.
- Tailored CVs: JD analysis, CV parsing, match scoring, gap analysis, keyword optimisation, ATS formatting hints, truthfulness guard metadata.

These agents live in `shared/agent-workflows.js`. They do not add extra LLM calls; they turn existing parser/matcher output into stable workflow packages that the recipe, Tailor CV flow, and UI can consume safely. Stage 3 exposes compact `agentInsights` to the extension so users can see evidence, gaps, supported keywords, ATS hints, and truthfulness-guard counts without sending prompts from the browser.

Stage 4 adds optional embedding retrieval in `shared/evidence-retrieval.js`. When `LOCAL_EMBEDDING_BASE_URL` is configured, the proxy embeds compact CV evidence snippets and JD requirements, reranks evidence, and may promote high-confidence missing requirements to transferable partial matches. The promotion threshold is deliberately conservative, and any embedding failure falls back to deterministic matching.

### Reliability and truthfulness contract

All generated or analyzed outputs now include explicit risk metadata:

- `qualityMode` and `qualityModeReason` identify the route used, for example `hosted_primary`, `local_private`, `configured_openrouter`, `openrouter_fallback`, or `best_effort_free_fallback`.
- `truthfulnessReport` groups JD/CV claims into `supportedClaims`, `transferableClaims`, `userConfirmedClaims`, and `blockedClaims`.
- `reviewRequired` is `true` when transferable or blocked claims exist, so the extension can keep review-before-sending visible without parsing model text.

This is intentionally an open-source product contract: contributors can add providers or UI views without hiding model reliability or unsupported-claim risk.

For production validation, run:

```bash
npm test
npm run test:static
npm run test:unit
npm run verify:architecture
```

`test:static` runs architecture syntax checks and release metadata validation. `test:unit` runs Vitest. If Vitest fails before running tests with an `esbuild` service error, run `npm rebuild esbuild` once and retry. `verify:architecture` is a dependency-light syntax gate for the extension/proxy architecture files; it is useful on machines where native Vitest dependencies are blocked, but it does not replace the full test suite.

---

## Privacy Guarantees

- **No logging of CV text, job descriptions, or generated answers** in the proxy engine.
- **GROQ_API_KEY**, **OPENROUTER_API_KEY**, and **TOKEN_SECRET** are read from env vars only — never committed.
- **Rate limiting** and **token auth** are built into the engine.
- The extension stores the CV locally in `chrome.storage.local` — it is never persisted server-side.
- Groq is configured with **Zero Data Retention (ZDR)** — prompts and completions are not stored by the LLM provider.
- If OpenRouter fallback is enabled, provider retention depends on the selected OpenRouter model/provider. Review that model's privacy notes before sending sensitive CVs.

---

## Development

```bash
cd render-proxy
npm install
GROQ_API_KEY=your-key OPENROUTER_API_KEY=your-openrouter-key TOKEN_SECRET=your-secret npm start
```

The server starts on `http://localhost:10000`.
