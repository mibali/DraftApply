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
| `extension-ready/` | **Chrome extension** (recommended) — no API keys needed |
| `render-proxy/` | **Hosted proxy** (Render) — holds the Groq API key server-side |
| `backend/` + `frontend/` | **Local web app** (optional) — multi-provider LLM support |
| `store-assets/` | Chrome Web Store listing assets |

## Chrome extension

The extension calls the hosted proxy at `https://draftapply.onrender.com`. No user API keys required.

### Install (unpacked)

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension-ready/` folder

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

See [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md). In short:

- **CV is stored locally** in your browser (`chrome.storage.local`) — never sent to DraftApply servers for storage
- **No generated answers are stored** on any server
- The LLM provider (Groq) is configured with **Zero Data Retention (ZDR)** — prompts and responses are not retained for training or logging

## Hosted proxy (Render)

The proxy is the open-source **engine** that handles authentication, rate limiting, CV file extraction, and LLM calls. The default **recipe** (`recipe/index.js`) is included in the repo and covers data extraction, cover letters, "why company" questions, and full-CV context; you can override it with `RECIPE_PATH` if needed.

See [`render-proxy/README.md`](render-proxy/README.md) for the full API contract, recipe interface, and deployment steps.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | Yes | Groq API key |
| `TOKEN_SECRET` | Yes | Secret for signing install tokens |
| `GROQ_MODEL` | No | Model name (default: `llama-3.3-70b-versatile`) |
| `RECIPE_PATH` | No | Path to custom recipe module (default: bundled `recipe/index.js`) |

### API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/register` | POST | Get install token (90-day expiry) |
| `/api/generate` | POST | Generate answer (structured payload preferred) |
| `/api/cv/upload` | POST | Extract text from PDF/DOCX/TXT file |

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

The local web app is useful for development, testing, or running fully offline.

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
┌─────────────────────┐     ┌──────────────────────┐     ┌───────────┐
│  Chrome Extension    │────▶│  Render Proxy Engine  │────▶│  Groq API │
│  (extension-ready/)  │◀────│  (render-proxy/)      │◀────│  (ZDR)    │
└─────────────────────┘     └──────────────────────┘     └───────────┘
        │                            │
        ▼                            ▼
  CV stored locally          Recipe module builds
  in chrome.storage          prompts server-side
```

1. **Extension** extracts job context from the page (title, company, description, requirements)
2. **Extension** sends structured payload (question + CV + job context) to the proxy
3. **Proxy** authenticates via 90-day install token, cleans the question label, passes to recipe
4. **Recipe** classifies the question type and builds a tailored prompt (9 distinct strategies)
5. **Proxy** calls Groq API with a 60s timeout and returns the answer
6. **Extension** shows progressive status messages while waiting, then displays the answer in a modal
7. **Extension** inserts the answer into the form field using framework-compatible native events (React/Vue/Angular safe)

## Store listing assets

| Asset | Path |
|-------|------|
| Store icon (128x128) | `store-assets/store-icon-128.png` |
| Small promo (440x280) | `store-assets/small-promo-440x280.png` |
| Marquee (1400x560) | `store-assets/marquee-promo-1400x560.png` |
| Screenshots (1280x800) | `store-assets/screenshot-*.png` |

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
