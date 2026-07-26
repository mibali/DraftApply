# DraftApply Proxy Engine (Open Source)

This service keeps your **Groq API key server-side** and exposes a small HTTPS API that the DraftApply Chrome extension calls to generate answers.

It is the compatible backend for either the official extension/proxy deployment or a generated self-hosted extension pointed at a self-hosted proxy. The trusted-loopback `backend/` + `frontend/` web app is a third, separate product: it does not implement this service's token or extension protocol.

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
| `GET` | `/api/ready` | None | Readiness check for deployment traffic |
| `POST` | `/api/register` | None (rate-limited) | Issue install token → `{ token, expiresAt }` |
| `POST` | `/api/generate` | `Bearer <token>` | Generate an answer (structured or legacy payload) |
| `POST` | `/api/cv/upload` | `Bearer <token>` | Upload CV file (PDF/DOCX/TXT) → extracted text |
| `POST` | `/api/jd/extract` | `Bearer <token>` | Normalize pasted job-description text |
| `POST` | `/api/cv/analyze` | `Bearer <token>` | Analyze CV/JD fit without generating a CV |
| `POST` | `/api/cv/tailor` | `Bearer <token>` | Generate a validated structured tailored CV |

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
| `cvText` | `string` | Yes | Full CV text (50–60,000 characters by default) |
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
  "model": "llama-3.3-70b-versatile",
  "inputGroundingReport": {},
  "validation": {},
  "providerTrace": []
}
```

`inputGroundingReport` describes evidence available before generation. `validation` checks the produced answer; neither is a provider privacy control. `providerTrace`/final-provider metadata identifies routing where the response protocol permits. `/api/health` advertises `capabilities.answerValidation` so clients can fail closed when final validation is required.

### Legacy Payload (disabled by default)

```json
{
  "systemPrompt": "You are...",
  "userPrompt": "CV: ...\nQuestion: ...",
  "temperature": 0.7
}
```

Hosted raw prompts are rejected with stable code `legacy_raw_prompts_disabled` unless an operator explicitly sets `ALLOW_LEGACY_RAW_PROMPTS=true`. Structured internal CV generation remains supported.

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
| `GROQ_API_URL` | No | Groq API endpoint | Override with an HTTP(S) OpenAI-compatible gateway endpoint. |
| `OPENROUTER_API_KEY` | No | — | OpenRouter API key; used as fallback when Groq is rate-limited, times out, or returns a transient error. Free fallback models are discovered from OpenRouter's official models API. |
| `OPENROUTER_API_URL` | No | OpenRouter chat endpoint | Override the HTTP(S) compatible chat endpoint. |
| `OPENROUTER_MODELS_URL` | No | OpenRouter models endpoint | Override the HTTP(S) models catalogue endpoint. Useful for compatible gateways and isolated integration tests. |
| `OPENROUTER_MODEL` | No | — | Optional configured OpenRouter model. Use this when you want a paid/reliable OpenRouter route ahead of free fallback. |
| `OPENROUTER_MAX_FALLBACK_MODELS` | No | `6` | Maximum OpenRouter free models to try per request after Groq fails |
| `OPENROUTER_USE_MODELS_ARRAY` | No | `false` | Opt into OpenRouter's opaque `models` fallback array. The default manual loop preserves model attribution. |
| `OPENROUTER_PROVIDER_SORT` | No | `throughput` | Provider routing preference for OpenRouter fallback. `throughput` is the default for reducing free-model stalls. |
| OpenRouter privacy controls | — | — | Hosted requests unconditionally set `provider.zdr=true` and deny data-collecting providers. |
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
| `LOCAL_EMBEDDING_PROMOTE_THRESHOLD` | No | `0.60` | Legacy-named similarity threshold used for evidence ranking; embeddings do not promote unsupported requirements. |
| `LOCAL_EMBEDDING_ENRICH_THRESHOLD` | No | `0.50` | Similarity threshold for ranking snippets attached to already-supported requirements. |
| `TOKEN_SECRET` | Yes | — | Random long string for signing install tokens |
| `GROQ_MODEL` | No | `llama-3.3-70b-versatile` | Groq model identifier |
| `RECIPE_PATH` | No | `./recipe/index.js` | Path to recipe module (optional override) |
| `PORT` | No | `10000` | Server listen port |
| `ALLOW_LEGACY_RAW_PROMPTS` | No | `false` | Allow caller-controlled raw prompts (not recommended when hosted). |
| `REQUEST_DEADLINE_MS` | No | `90000` | Absolute budget shared by all provider attempts and body consumption. |
| `PROVIDER_RESPONSE_MAX_BYTES` | No | `2097152` | Maximum buffered successful provider response, including SSE. |
| `PROVIDER_ERROR_MAX_BYTES` | No | `65536` | Maximum provider error body consumed for retry classification. |
| `REDIS_URL` | Production | — | Persistent, atomic multi-instance admission/quota store. |
| `REQUIRE_DURABLE_QUOTAS` | No | `true` in production | Refuse startup with hosted keys when Redis is absent. Explicitly disable for local development only. |
| `REDIS_PING_INTERVAL_MS` | No | `60000` | Application-level keepalive for managed Redis TLS connections. |
| `REDIS_CONNECT_TIMEOUT_MS` | No | `10000` | Timeout for each Redis connection attempt. |
| `REDIS_RECONNECT_MAX_MS` | No | `10000` | Maximum reconnect backoff after a Redis disconnect. |
| `REDIS_STARTUP_TIMEOUT_MS` | No | `30000` | Overall deadline for the initial Redis connection before deployment fails. |
| `QUOTA_MAX_CONCURRENT_PER_SUBJECT` | No | `1` | Maximum simultaneous paid workflows per installation. |
| `QUOTA_MAX_REQUESTS_PER_SUBJECT` | No | `100` | Maximum admitted paid workflows per installation per 24-hour UTC bucket. |
| `QUOTA_MAX_TOKENS_PER_SUBJECT` | No | `5000000` | Maximum reconciled/reserved provider tokens per installation per 24-hour UTC bucket. |
| `QUOTA_MAX_SPEND_MICROS_PER_SUBJECT` | No | `5000000` | Maximum estimated/reconciled spend per installation per 24-hour UTC bucket, in millionths of a dollar (`5000000` = $5). |
| `CIRCUIT_FAILURE_THRESHOLD` / `CIRCUIT_OPEN_MS` | No | `3` / `30000` | Provider/model circuit policy. |

---

## Deploy on Render

Production deployments using Groq or OpenRouter must provision Redis and set `REDIS_URL`. With `NODE_ENV=production`, the server refuses to start with hosted keys and no durable quota store. Admission atomically reserves request, token/spend, and lease-based concurrency capacity across instances, then reconciles provider-reported usage when every attempt reports it. Missing usage remains conservatively reserved. Redis also coordinates provider/model circuit breakers across proxy instances and permits only one half-open probe.

Provider attempts produce payload-safe structured telemetry. JSON responses and streaming metadata include `requestId`, `providerTrace`, and the final mutating provider where protocol permits; traces never contain prompts, CV/JD text, bodies, or credentials. OpenRouter defaults to `data_collection: deny`, `zdr: true`, and observable manual model fallback. Absolute deadline failures use stable HTTP 504 code `request_deadline_exceeded`.

1. Push this repo to GitHub.
2. Render → New → Web Service → connect repo.
3. Root directory: `render-proxy`
4. Build command: `npm ci`
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
- Tries the shortlist explicitly by default so provider/model attribution remains observable. Operators can opt into OpenRouter's opaque `models` fallback array with `OPENROUTER_USE_MODELS_ARRAY=true`.
- Sorts OpenRouter providers by throughput by default.
- Requests OpenRouter router metadata so the actual served model can be surfaced in extension UI.
- Keeps Groq/local Qwen as the preferred quality path. OpenRouter free remains a fallback, not the main production plan.

For reliability, the recommended production path is:

1. Groq primary for final answer/CV generation.
2. Local/OpenAI-compatible Qwen for extraction and privacy-sensitive lightweight agent steps.
3. OpenRouter fallback with `OPENROUTER_USE_MODELS_ARRAY=true`.
4. If free models remain unreliable for your traffic, configure a paid OpenRouter model via `OPENROUTER_MODEL` or prefer local Qwen instead of free-only fallback.

For a local route, deploy a separately secured OpenAI-compatible service such as Ollama, LM Studio,
vLLM, or llama.cpp and point `LOCAL_LLM_BASE_URL` at it. The repository does not contain or maintain
a hosted-model deployment template; operators are responsible for authentication, logging, retention,
capacity, and model-quality validation of that service.

### Deterministic pipeline, UI insights, and retrieval

Before and after the final model call, the proxy runs ordinary deterministic pipeline stages—not autonomous agents:

- Application answers: validation, question classification, CV grounding, job-context matching, prompt construction, model routing, and final-answer validation.
- Tailored CVs: JD analysis, CV parsing, match scoring, gap analysis, keyword analysis, prompt construction, model routing, and final-output validation.

The deterministic helpers live in `shared/agent-workflows.js`. They turn parser/matcher output into stable packages consumed by the recipe, Tailor CV flow, and UI. Compact `agentInsights` can expose evidence, gaps, supported keywords, and ATS hints.

Optional retrieval in `shared/evidence-retrieval.js` embeds compact CV evidence snippets and JD requirements to rank relevant evidence. Similarity is not proof and cannot promote a missing requirement to supported or transferable status. Failure falls back to deterministic matching.

`shared/domain-packs/domain-pack.snapshot.json` provides additional review cues for high-risk role families such as legal, clinical healthcare, aviation, clearance-heavy government roles, academic/research CVs, creative portfolios, licensed trades, and sparse job descriptions. These packs are refreshed offline through the repository workflow and reviewed as pull requests. The proxy must treat them as local read-only metadata during generation; it should not fetch live third-party domain datasets in the request path.

### Reliability and truthfulness contract

Generated or analyzed outputs include explicit risk metadata where supported by the endpoint/protocol:

- `qualityMode` and `qualityModeReason` identify the route used, for example `hosted_primary`, `local_private`, `configured_openrouter`, `openrouter_fallback`, or `best_effort_free_fallback`.
- `inputGroundingReport` groups pre-generation JD/CV claims into `supportedClaims`, `transferableClaims`, `userConfirmedClaims`, and `blockedClaims`; `truthfulnessReport` is a deprecated compatibility alias.
- Final-validation metadata evaluates claims in the generated output rather than treating input grounding as proof of the answer.
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

## Privacy and operator responsibilities

- **No logging of CV text, job descriptions, or generated answers** in the proxy engine.
- **GROQ_API_KEY**, **OPENROUTER_API_KEY**, and **TOKEN_SECRET** are read from env vars only — never committed.
- **Rate limiting** and **token auth** are built into the engine.
- The extension stores the CV in `chrome.storage.local`; proxy application code does not intentionally persist CV/job payloads or answers. Hosting, Redis, reverse proxies, and security systems may still retain operational metadata according to operator configuration.
- Operators must enable and verify Groq ZDR in their own account console. Repository code cannot prove that account control is active.
- OpenRouter calls request `zdr: true` and deny data collection by default. Operators must still verify OpenRouter settings and disclose the actually selected downstream provider and its policy.
- Local OpenAI-compatible endpoints have their own logging and retention behavior; “local” does not itself guarantee no retention.

See the full [privacy/provider deployment matrix](../docs/privacy-provider-matrix.md). Grounding and final validation improve claim safety, not data privacy.

---

## Development

```bash
cd render-proxy
npm install
GROQ_API_KEY=your-key OPENROUTER_API_KEY=your-openrouter-key TOKEN_SECRET=your-secret npm start
```

The server starts on `http://localhost:10000`.
