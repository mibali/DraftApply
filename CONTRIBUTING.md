# Contributing to DraftApply

DraftApply is a plain JavaScript Chrome extension plus Node/Express proxy. Keep changes small, privacy-aware, and easy to verify.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For vulnerabilities, use the private process in [SECURITY.md](SECURITY.md), not a public issue.

## Proposing a change

1. Search existing issues and pull requests first.
2. Open an issue for behavior changes or large fixes so maintainers can confirm scope before substantial work.
3. Create a focused branch and keep unrelated refactors out of the pull request.
4. Explain user impact, privacy/security implications, and the checks you ran. Add regression coverage for fixes.

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

Validate or refresh the domain knowledge snapshot:

```bash
npm run validate:domain-packs
npm run refresh:domain-packs
```

If Vitest exits before running tests with an `esbuild` service error, rebuild the native package once:

```bash
npm rebuild esbuild
```

Then retry `npm run test:unit`.

## Extension Smoke Test

1. Run `npm install && npm run build:extension`.
2. Open `chrome://extensions` and enable Developer mode.
3. Load `dist/extension/` as an unpacked extension.
4. Save a CV in the popup.
5. Test one application-answer flow on any form field.
6. Test Tailor CV by pasting a JD, generating a CV, reviewing it, and downloading DOCX.

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
- Domain knowledge updates should go through `shared/domain-packs/sources.json`, `shared/domain-packs/domain-pack.snapshot.json`, and the refresh/validation scripts. Do not add live third-party dataset fetching to runtime generation paths.

## Privacy Expectations

- Never log CV text, job descriptions, prompts, generated answers, API keys, or install tokens.
- Keep `TOKEN_SECRET`, `GROQ_API_KEY`, and `OPENROUTER_API_KEY` in environment variables only.
- Any new provider must make its data-retention behavior clear in docs and UI metadata.
