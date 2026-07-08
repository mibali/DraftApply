# Contributing to DraftApply

DraftApply is a plain JavaScript Chrome extension plus Node/Express proxy. Keep changes small, privacy-aware, and easy to verify.

## Local Checks

Run the dependency-light gate first:

```bash
npm run test:static
```

Run the full unit/static contract suite:

```bash
npm run test:unit
```

Run both:

```bash
npm test
```

If Vitest exits before running tests with an `esbuild` service error, rebuild the native package once:

```bash
npm rebuild esbuild
```

Then retry `npm run test:unit`.

## Extension Smoke Test

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load `extension-ready/` as an unpacked extension.
4. Save a CV in the popup.
5. Test one application-answer flow on any form field.
6. Test Tailor CV by pasting a JD, analyzing it, and generating a CV.

Before release, confirm:

- No secrets or `.env` files are committed.
- `npm test` passes.
- `npm run release:validate` passes.
- The answer modal shows provider/model cues.
- Tailor CV shows match, truthfulness, and provider/model cues.

## Architecture Expectations

- The extension should stay prompt-thin. Prompt building belongs in `render-proxy/` and shared modules.
- CV text is stored locally in `chrome.storage.local`; do not persist CVs server-side.
- Workflow agents in `shared/agent-workflows.js` are deterministic orchestration stages, not separate hosted LLM calls.
- OpenRouter free models are best-effort fallback. Do not make free routing the only recommended production path.
- Generated API responses should preserve `qualityMode`, `qualityModeReason`, and `truthfulnessReport`.

## Privacy Expectations

- Never log CV text, job descriptions, prompts, generated answers, API keys, or install tokens.
- Keep `TOKEN_SECRET`, `GROQ_API_KEY`, and `OPENROUTER_API_KEY` in environment variables only.
- Any new provider must make its data-retention behavior clear in docs and UI metadata.
