# DraftApply

Generate tailored job application answers using your CV + the job posting context.

## What this repo contains

- **Chrome extension (recommended)**: `extension-ready/`
  - No user API keys required (uses a hosted proxy)
  - In-page UI + right-click menu + “Insert Answer”
- **Hosted proxy (Render)**: `render-proxy/`
  - Holds the Groq API key server-side
  - Token-gated endpoints for generation and CV file text extraction
- **Local web app (optional)**: `backend/` + `frontend/`
  - Multi-provider LLM support (Ollama/Groq/Gemini/etc.)
- **Web Store assets**: `store-assets/`

## Chrome extension (recommended)

The extension calls the hosted proxy:

- `https://draftapply.onrender.com`

### Install (unpacked)

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension-ready/` folder

### Use

1. Click the DraftApply extension icon → add your CV (paste text or upload) → **Save CV**
2. On a job application page:
   - Highlight a question → right-click → **DraftApply - Answer using my CV**
   - Or click the **DraftApply button** next to a text field
3. Click **Insert Answer** to fill the field (clipboard fallback is used if insertion isn’t possible)

### Privacy

See `PRIVACY_POLICY.md`. In short:

- **CV is stored locally** in your browser (`chrome.storage.local`)
- DraftApply **does not store** your CV or generated answers on our servers
- The LLM provider (Groq) is configured with **Zero Data Retention (ZDR)**

## Hosted proxy (Render)

The proxy is the open-source **engine** that handles auth, rate limiting, CV extraction, and LLM calls. It has a **pluggable recipe interface** — the prompt engineering / tailoring logic is loaded as a separate module at startup.

- See `render-proxy/README.md` for full documentation (API contract, recipe interface, deploy steps).
- Required env vars:
  - `GROQ_API_KEY`
  - `TOKEN_SECRET`
  - (optional) `GROQ_MODEL`
  - (optional) `RECIPE_PATH` — path to your custom recipe module (defaults to the bundled example)

## Local web app (optional)

The local web app is useful for development/testing or running fully locally.

### Option A: Ollama (local, private)

```bash
brew install ollama
ollama pull llama3.2
ollama serve

cd backend
npm install
npm run dev
```

Open:

- `http://localhost:3001`

### Option B: Groq (cloud)

```bash
cd backend
cp .env.example .env
# edit .env:
#   LLM_PROVIDER=groq
#   GROQ_API_KEY=...

npm install
npm run dev
```

Open:

- `http://localhost:3001`

### Supported providers (local web app)

Local:

- Ollama
- LM Studio
- LocalAI

Cloud:

- Groq
- Google Gemini
- Mistral
- Together AI
- OpenAI

## API endpoints

### Local backend (`backend/`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/providers` | GET | List providers |
| `/api/llm-status` | GET | Provider readiness |
| `/api/cv/upload` | POST | Upload CV file |
| `/api/cv/text` | POST | Submit CV as text |
| `/api/generate` | POST | Generate answer |

### Hosted proxy (`render-proxy/`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/register` | POST | Get install token |
| `/api/generate` | POST | Generate answer (structured payload or legacy prompts) |
| `/api/cv/upload` | POST | Extract text from PDF/DOCX/TXT |

The extension sends a **structured payload** (question, CV text, job context) to `/api/generate`. The proxy's recipe module builds the LLM prompts server-side. See `render-proxy/README.md` for the full API contract.

## Store listing assets

- **Store icon (128×128)**: `store-assets/store-icon-128.png`
- **Promo tiles**: `store-assets/small-promo-440x280.png`, `store-assets/marquee-promo-1400x560.png`
- **Screenshots**: `store-assets/` (1280×800)

## Troubleshooting

- **Context menu error “duplicate id draftapply”**: reload the extension (fixed in `background.js`)
- **Icon/menu not updating**: Chrome caches icons aggressively; after updating icons:
  - `chrome://extensions` → click **Update** (or reload unpacked)
  - close/reopen the Extensions menu
- **Ollama not responding (local)**:

```bash
ollama serve
```

## License

MIT
