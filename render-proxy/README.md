# DraftApply Proxy Engine (Open Source)

This service keeps your **Groq API key server-side** and exposes a small HTTPS API that the DraftApply Chrome extension calls to generate answers.

The proxy has a **pluggable recipe interface** so you can swap the prompt-engineering / tailoring logic without modifying the engine itself.

---

## Architecture

```
Extension  ──(structured JSON)──▶  Proxy Engine  ──▶  Recipe Module  ──▶  LLM (Groq)
                                     (public)          (pluggable)
```

| Component | Visibility | Responsibility |
|-----------|-----------|----------------|
| **Proxy engine** (`server.js`) | Public / open source | Auth, rate limits, CV upload, LLM call, request validation |
| **Example recipe** (`recipe/index.js`) | Public / open source | Basic non-proprietary prompt builder (sample) |
| **Private recipe** (`recipe-private/`) | **Private** / `.gitignore`'d | Your proprietary prompt engineering, ranking, and tailoring logic |
| **Extension** | Distributed (Chrome Web Store) | UI, page extraction, sends structured data to proxy |

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

### Using a custom recipe

Set the `RECIPE_PATH` environment variable to the path of your recipe module:

```bash
RECIPE_PATH=./recipe-private/index.js npm start
```

If `RECIPE_PATH` is not set (or fails to load), the proxy falls back to the bundled example recipe at `recipe/index.js`.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROQ_API_KEY` | Yes | — | Groq API key |
| `TOKEN_SECRET` | Yes | — | Random long string for signing install tokens |
| `GROQ_MODEL` | No | `llama-3.3-70b-versatile` | Groq model identifier |
| `RECIPE_PATH` | No | `./recipe/index.js` | Path to your recipe module |
| `PORT` | No | `10000` | Server listen port |

---

## Deploy on Render

1. Push this repo to GitHub.
2. Render → New → Web Service → connect repo.
3. Root directory: `render-proxy`
4. Build command: `npm install`
5. Start command: `npm start`
6. Add env vars: `GROQ_API_KEY`, `TOKEN_SECRET`, and `RECIPE_PATH=./recipe-private/index.js`.

### Using a private recipe in deployment

**Option A – Private file in repo (`.gitignore`'d, copied at build time):**
Place your recipe in `render-proxy/recipe-private/index.js` and set `RECIPE_PATH=./recipe-private/index.js`. On Render, either include the file in a private fork or use a build script that fetches it.

**Option B – Private npm package:**
Publish your recipe as a private npm package, add it to `package.json`, and set `RECIPE_PATH=./node_modules/@your-org/draftapply-recipe/index.js`.

**Option C – Git submodule:**
Add your private recipe repo as a submodule under `render-proxy/recipe-private/`.

---

## Privacy Guarantees

- **No logging of CV text, job descriptions, or generated answers** in the proxy engine.
- **GROQ_API_KEY** and **TOKEN_SECRET** are read from env vars only — never committed.
- **Rate limiting** and **token auth** are built into the public engine.
- The extension stores the CV locally in `chrome.storage.local` — it is never persisted server-side.
- Groq is configured with **Zero Data Retention (ZDR)** — prompts and completions are not stored by the LLM provider.

---

## Development

```bash
cd render-proxy
npm install
GROQ_API_KEY=your-key TOKEN_SECRET=your-secret npm start
```

The server starts on `http://localhost:10000`.