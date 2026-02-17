# AGENTS.md — DraftApply

## Project overview

DraftApply is a fully open-source (MIT) Chrome extension + backend that generates tailored job application answers from a user's CV. The production architecture is:

```
Chrome Extension → Render Proxy (token-gated) → Groq API (ZDR)
```

A local web app (backend + frontend) exists for development and offline use with multiple LLM providers.

## Repository structure

| Directory | Purpose |
|---|---|
| `extension-ready/` | Chrome Manifest V3 extension (production) — content scripts, background service worker, popup UI |
| `render-proxy/` | Hosted proxy on Render — token auth, rate limiting, recipe-based prompt building, Groq API calls |
| `backend/` | Local Express API server — multi-provider LLM support (Ollama, Groq, Gemini, etc.) |
| `frontend/` | Local web app UI (vanilla HTML/CSS/JS) served by the backend |
| `shared/` | Shared modules used by the local web app (prompt builder, CV parser, answer generator) |
| `store-assets/` | Chrome Web Store listing images |
| `screenshots/` | App screenshots |

## Tech stack & conventions

- **Runtime:** Node.js ≥ 18, ES modules (`"type": "module"` everywhere)
- **Backend framework:** Express 4
- **Extension:** Chrome Manifest V3, vanilla JS (no bundler, no framework)
- **Frontend (local):** Vanilla HTML/CSS/JS — no build step
- **File parsing:** `pdf-parse`, `mammoth` (DOCX), plain text
- **Security (proxy):** `helmet`, `express-rate-limit`, HMAC-signed install tokens
- **No TypeScript.** The entire codebase is plain JavaScript.
- **No test framework** is currently configured.

## Key conventions

- All JS files use ES module `import`/`export` syntax (never `require`).
- The proxy uses a **recipe module** (`render-proxy/recipe/index.js`) that builds LLM prompts server-side. The extension never constructs prompts directly.
- The extension stores the CV locally in `chrome.storage.local` — it is never persisted server-side.
- Environment variables hold all secrets (`.env` files are gitignored). Never log or expose `GROQ_API_KEY` or `TOKEN_SECRET`.
- The proxy accepts two payload formats: **structured** (question + cvText + job context → recipe builds prompts) and **legacy** (raw systemPrompt + userPrompt). Prefer structured.

## Running locally

```bash
# Backend (local web app) — defaults to Ollama
cd backend && npm install && npm run dev
# App at http://localhost:3001

# Render proxy (needs GROQ_API_KEY and TOKEN_SECRET env vars)
cd render-proxy && npm install && npm start

# Extension — load extension-ready/ as unpacked in chrome://extensions
```

## Environment variables

### Render proxy (`render-proxy/`)
| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | Yes | Groq API key |
| `TOKEN_SECRET` | Yes | HMAC secret for signing install tokens |
| `GROQ_MODEL` | No | Model override (default: `llama-3.3-70b-versatile`) |
| `RECIPE_PATH` | No | Path to custom recipe module (default: `./recipe/index.js`) |

### Local backend (`backend/`)
| Variable | Required | Description |
|---|---|---|
| `LLM_PROVIDER` | No | Provider name (default: `ollama`). Options: ollama, lmstudio, localai, groq, gemini, mistral, together, openai |
| `GROQ_API_KEY` | If using Groq | Groq API key |
| `PORT` | No | Server port (default: `3001`) |

## API endpoints

### Render proxy
| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/health` | GET | No | Health check |
| `/api/register` | POST | No | Issue install token (90-day expiry, rate-limited) |
| `/api/generate` | POST | Bearer token | Generate answer via recipe + Groq |
| `/api/cv/upload` | POST | Bearer token | Extract text from uploaded PDF/DOCX/TXT |

### Local backend
| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Health check |
| `/api/providers` | GET | List available LLM providers |
| `/api/llm-status` | GET | Check current provider availability |
| `/api/generate` | POST | Generate answer (supports streaming) |
| `/api/cv/upload` | POST | Upload and parse CV file |
| `/api/cv/text` | POST | Submit CV as plain text |

## Extension architecture

- **`manifest.json`** — Manifest V3, permissions: storage, contextMenus, activeTab, scripting
- **`background.js`** — Service worker: handles context menu, on-demand content script injection, install token management
- **`content.js`** — Injected into job application pages: adds DraftApply buttons to form fields, shows answer modal, handles iframe relay
- **`page-extractor.js`** — Extracts job title, company, description, and requirements from the current page DOM
- **`popup.html` / `popup.js`** — Extension popup: CV input/upload, activation toggle
- **`content.css`** — Styles for injected UI elements

## Security rules

- **Never** commit `.env` files, API keys, or the `TOKEN_SECRET`.
- **Never** log secrets to console or include them in error responses.
- The proxy uses `helmet` and rate limiting — preserve these in any changes.
- Install tokens use HMAC-SHA256 with timing-safe comparison — do not weaken this.
- CV data flows extension → proxy → LLM and back. It is **never stored** server-side.

## Privacy

- CV is stored only in `chrome.storage.local`.
- Groq is configured with Zero Data Retention (ZDR).
- No analytics or tracking is included.
