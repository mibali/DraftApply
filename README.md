# DraftApply

**Fully open source.** Generate tailored, human-sounding job application answers using your CV and the job posting context — directly on any job application page. See [LICENSE](LICENSE) for terms.

## How it works

1. Save your CV once in the extension popup.
2. On any job application page, click the **DraftApply button** next to a field or highlight a question and right-click **DraftApply - Answer using my CV**.
3. DraftApply extracts the job title, company, description, and requirements from the page, combines them with your full CV, and generates a tailored answer.
4. Edit the answer if you like, then click **Insert Answer** to fill the form field.

DraftApply classifies each question and generates the right kind of answer — a direct sentence for factual fields (notice period, availability), a STAR-method story for behavioural questions, a company-specific paragraph for "why us?", or a full cover letter. For plain fields (name, email, phone, LinkedIn), it extracts the exact value from your CV.

## What this repo contains

| Directory | Purpose |
|-----------|---------|
| `extension-ready/` | **Official Chrome extension source** — configured for the official hosted proxy |
| `render-proxy/` | **Extension proxy** — officially hosted on Render, or deploy it yourself |
| `backend/` + `frontend/` | **Separate local web app** (optional) — multi-provider/offline development UI; it is not the extension proxy |
| `shared/domain-packs/` | **Domain knowledge packs** — reviewable snapshots for regulated, credential-heavy, academic, trade, sparse, and portfolio-heavy roles |
| `store-assets/` | Chrome Web Store listing assets |

## Chrome extension

The extension calls the hosted proxy at `https://draftapply.onrender.com`. No user API keys required.

That checked-in configuration is the **official extension source**. Build it before loading unpacked or packaging so the maintained DOCX export library is included. To connect an extension to your own `render-proxy` deployment, provide its URL to the same build:

```bash
npm install
npm run build:extension
# Or use your own proxy:
npm run build:extension -- --proxy-url=https://draftapply.example.com
# Load dist/extension/ as an unpacked extension.
```

The build validates the URL (HTTPS, except loopback HTTP for development), writes the selected endpoint to `build-config.js`, and changes only the proxy entry in `host_permissions`. Use `--output=path/to/output` to choose another output directory. `build-info.json` records the non-secret endpoint and extension version. Do not point this build at `backend/`: the local web app is a separate application and does not implement the extension proxy contract.

### Install (unpacked)

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Run `npm install && npm run build:extension`, then select `dist/extension/`

### Supported sites

DraftApply works on **any web page**:

- **Auto-activates** on major job platforms: Indeed, LinkedIn, Greenhouse, Lever, Workable, Otta, Glassdoor, Ashby, Breezy, SmartRecruiters, iCIMS, Workday, Taleo, Jobvite, HiringCafe
- **On-demand** on any other page (company career sites, custom ATS): click the extension icon → **Activate on this page**, or use the right-click context menu
- **Embedded forms** (e.g. Greenhouse iframe on a company careers page): DraftApply detects the iframe and relays the modal to the parent page so it's always fully visible

### Usage

1. Click the DraftApply extension icon → paste or upload your CV → **Save CV**
2. On a job application page:
   - **Click** the DraftApply icon button that appears next to form fields (shows on focus/hover), or
   - **Highlight** a question → right-click → **DraftApply - Answer using my CV**
3. Review and edit the generated answer in the modal
4. Choose answer length (Short / Medium / Long) and click **Insert Answer**

### Privacy

See [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) and the [`privacy/provider matrix`](docs/privacy-provider-matrix.md). In short:

- The extension stores the CV in `chrome.storage.local`; generation sends CV/job content through the selected proxy and model route.
- Uploaded PDF/DOCX/TXT files are extracted in memory on the proxy. Scanned-PDF OCR runs locally inside the proxy process and is not sent to an OCR service.
- Proxy application code does not intentionally persist request content or answers, but hosting infrastructure and providers may retain logs or data under their own settings.
- The official operator must verify Groq account ZDR. OpenRouter fallback adds OpenRouter and its selected downstream provider. Open-source code and grounding validation cannot prove provider-account privacy settings.

## Hosted proxy (Render)

The proxy is the open-source **engine** that handles authentication, rate limiting, CV file extraction, and LLM calls. The default **recipe** (`recipe/index.js`) is included in the repo and covers data extraction, cover letters, "why company" questions, and full-CV context; you can override it with `RECIPE_PATH` if needed.

See [`render-proxy/README.md`](render-proxy/README.md) for the full API contract, recipe interface, and deployment steps.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | Yes, unless `OPENROUTER_API_KEY` is set | Groq API key; used as the primary LLM provider when present |
| `OPENROUTER_API_KEY` | No | OpenRouter API key; used as fallback when Groq is rate-limited, times out, or returns a transient error. Free fallback models are discovered from OpenRouter's official models API. |
| `OPENROUTER_MAX_FALLBACK_MODELS` | No | Maximum OpenRouter free models to try per request (default: `6`) |
| `OPENROUTER_TAILOR_FALLBACK` | No | Tailor CV generation/audit falls back to OpenRouter by default when `OPENROUTER_API_KEY` is set. Set to `false` only if you want Tailor CV to hard-fail rather than use OpenRouter as backup. |
| `OPENROUTER_MODEL` | No | Optional configured OpenRouter model. Use this for a paid/reliable OpenRouter fallback instead of relying only on free models. |
| `OPENROUTER_USE_MODELS_ARRAY` | No | Sends a ranked fallback chain to OpenRouter in one request (default: `false`; the manual loop preserves provider/model attribution). |
| OpenRouter privacy controls | — | Hosted requests always require ZDR and deny providers marked as collecting data. This cannot be disabled by environment configuration. |
| `TOKEN_SECRET` | Yes | Secret for signing install tokens |
| `GROQ_MODEL` | No | Model name (default: `llama-3.3-70b-versatile`) |
| `RECIPE_PATH` | No | Path to custom recipe module (default: bundled `recipe/index.js`) |

### API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/ready` | GET | Deployment readiness check |
| `/api/register` | POST | Get install token (90-day expiry) |
| `/api/generate` | POST | Generate answer (structured payload preferred) |
| `/api/cv/upload` | POST | Extract text from PDF/DOCX/TXT file |
| `/api/jd/extract` | POST | Normalize pasted job-description text |
| `/api/cv/tailor` | POST | Generate a validated structured tailored CV |

The extension sends a **structured payload** to `/api/generate`:

```json
{
  "question": "Why do you want to join our team?",
  "length": "medium",
  "cvText": "...",
  "jobTitle": "Head of Support",
  "company": "Rootly",
  "jobDescription": "...",
  "requirements": ["3+ years experience...", "..."],
  "pageUrl": "https://...",
  "platform": "greenhouse"
}
```

The proxy's recipe module builds the LLM prompts server-side — the extension never sees or constructs the actual prompts.

The recipe classifies each question into one of these types and applies a tailored prompt strategy:

| Type | Examples | Strategy |
|------|----------|----------|
| `data_extraction` | Name, Email, LinkedIn URL | Extract exact value from CV |
| `short_factual` | Notice period, Start date | 1–2 sentence current-situation answer |
| `yes_no` | "Do you have X experience?" | Clear yes/no + 1 supporting sentence |
| `behavioral` | "Tell me about a time..." | STAR method, one specific story |
| `why_company` | "Why Anthropic?", "Why us?" | Company-specific opening, then CV evidence |
| `motivation` | "What interests you about this role?" | Career-direction reasoning, not enthusiasm |
| `strength_weakness` | "What's your greatest strength?" | Named + proven with CV evidence |
| `cover_letter` | "Cover letter", "Motivation letter" | Full structured letter |
| `general` | Everything else | Direct answer first, then supporting evidence |

## Local web app (optional)

The local web app is useful for development, testing, or running offline when paired with a local provider. It defaults to Ollama and binds to `127.0.0.1`. It does not implement extension install tokens or the compatible proxy protocol, and is not safe as a public Internet service without authentication, access controls, restrictive CORS, TLS, rate limits, and operational hardening.

### Option A: Ollama (local, private)

```bash
brew install ollama
ollama pull llama3.2
ollama serve

cd backend
npm install
npm run dev
```

Open `http://localhost:3001`

### Option B: Groq (cloud)

```bash
cd backend
cp .env.example .env
# edit .env → set LLM_PROVIDER=groq and GROQ_API_KEY=...

npm install
npm run dev
```

Open `http://localhost:3001`

### Supported providers

**Local:** Ollama, LM Studio, LocalAI

**Cloud:** Groq, Google Gemini, Mistral, Together AI, OpenAI

## Architecture

```
Chrome Extension
  → Render Proxy
    → deterministic pipeline stages
    → model router
    → Groq primary / local model / OpenRouter fallback
```

1. **Extension** extracts job context from the page (title, company, description, requirements)
2. **Extension** sends structured payload (question + CV + job context) to the proxy
3. **Proxy** authenticates via 90-day install token, cleans the question label, and builds a CV/JD evidence package
4. **Deterministic stages** classify the question, map CV evidence, score JD requirements, flag gaps, and build input grounding metadata
5. **Recipe** builds a tailored prompt server-side
6. **Model router** uses Groq by default, optional local OpenAI-compatible models for lightweight/private steps, and ranked OpenRouter fallback when configured
7. **Proxy and extension** expose provider trace, `inputGroundingReport`, and final-answer validation metadata where supported; the extension inserts the reviewed answer

These are pipeline stages, not autonomous agents. Optional embeddings rank evidence only; they do not turn a missing requirement into a supported claim. Final-answer grounding does not imply provider privacy.

Generated API responses include route metadata, `inputGroundingReport` (with a temporary `truthfulnessReport` compatibility alias), and output `validation` so clients can distinguish provider routing from claim checks.

DraftApply also includes compact domain packs for higher-risk role families. These packs help deterministic checks recognize when to require stronger evidence, ask for credentials or jurisdiction, preserve academic/publication detail, or avoid overclaiming in portfolio-first roles. They are refreshed through a scheduled GitHub workflow and reviewed as pull requests; generation never fetches live third-party datasets.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`render-proxy/README.md`](render-proxy/README.md) for the full provider and orchestration details.

## Testing

```bash
npm run test:static       # syntax/architecture + release metadata checks
npm run test:unit         # Vitest unit/static contract tests
npm test                  # both gates
npm run validate:domain-packs
npm run refresh:domain-packs
```

If Vitest fails before running tests with an `esbuild` service error, run `npm rebuild esbuild` once and retry. The static gate exists so contributors can still validate architecture on machines where native test dependencies are temporarily unhappy.

## Store listing assets

| Asset | Path |
|-------|------|
| Store icon (128x128) | `store-assets/store-icon-128.png` |
| Small promo (440x280) | `store-assets/small-promo-440x280.png` |
| Marquee (1400x560) | `store-assets/marquee-promo-1400x560.png` |
| Screenshots (1280x800) | `store-assets/screenshot-*.png` |

## Chrome Web Store release

Public Chrome users only receive updates after a new Chrome Web Store package is uploaded and reviewed.

```bash
npm run release:validate        # verify version/tag/changelog metadata
npm run release:chrome          # test + package only
npm run release:chrome:upload   # upload package to Chrome Web Store
npm run release:chrome:publish  # upload and submit for review
```

Before releasing, bump both `extension-ready/manifest.json` and `package.json` to the same version, update `CHANGELOG.md`, and commit the change. The release script stages a generated official-proxy build and creates `dist/draftapply-chrome-<version>.zip`. Existing release commands and flags remain valid. A custom package can be created with `--proxy-url=...`, but upload/publish refuses custom endpoints unless the maintainer deliberately adds `--allow-custom-proxy-upload` as a safety override.

For automated releases, set these GitHub Actions secrets:

- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`
- `CHROME_EXTENSION_ID`
- `CHROME_PUBLISHER_ID`

Creating a tag like `v2.3.1` runs:

- `.github/workflows/github-release.yml` — runs tests, packages the extension, creates a GitHub Release, and attaches the ZIP.
- `.github/workflows/chrome-web-store-release.yml` — packages the extension and submits it for Chrome Web Store review when Chrome Web Store secrets are configured.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| DraftApply buttons not appearing | Click the extension icon → **Activate on this page** |
| Embedded form (iframe) modal not visible | Modal automatically relays to the parent page — reload the page if it doesn't appear |
| "Not found in CV" for LinkedIn / GitHub | Re-upload your CV — the extractor now captures hyperlinked URLs (not just visible text) |
| Notice period / availability answer too long | Re-generate — these questions now use a short factual prompt (1–2 sentences) |
| "Why [Company]?" answer feels generic | Ensure job context is detected (green badge) — the answer opens with company specifics from the JD |
| Loading spinner with no feedback | Status message now updates every few seconds ("Connecting to AI service…", "Service may be waking up…") |
| Context menu missing | Reload the extension at `chrome://extensions` |
| Ollama not responding (local) | Run `ollama serve` in a terminal |
| Proxy cold start / first request slow | Free Render tier sleeps after inactivity — first request may take ~30s; subsequent ones are fast |

## License

This project is fully open source under the [MIT License](LICENSE).
