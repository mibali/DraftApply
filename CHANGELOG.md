# Changelog

All notable user-facing changes to DraftApply are documented here.

This project uses version tags in the form `vX.Y.Z`. The Chrome extension
version in `extension-ready/manifest.json` and the root `package.json` version
must match the release tag.

## [Unreleased]

- Clarified privacy responsibilities across official, self-hosted, local, Groq, and OpenRouter routes.
- Made the local web app default to Ollama and trusted-loopback binding (`127.0.0.1`).

## [2.4.0] - 2026-05-21

- Added a role-profile career-positioning engine so CV tailoring and answer generation reason about role credibility, not only keyword overlap.
- Added role-profile integrity tests to prevent duplicate aliases, conflicting title mappings, and repeated skill categories.
- Added role-aware answer prompts with credibility rubrics for target roles.
- Added daily role-profile expansion and monthly salary-benchmark refresh automations.
- Hardened Tailor CV output quality for Solution Architect-style roles, Core Competencies formatting, provider fallback labels, and stale JD handling.
- Improved CV parsing for common real-world experience layouts, including same-line title/company/date headers and company/date headers followed by title.
- Added controlled semantic evidence matching for Tailor CV so equivalent phrasing such as Postgres/PostgreSQL and client presentations/technical demos can support role credibility without extra LLM calls.
- Expanded product, marketing, customer success, sales, finance, HR, and operations tool vocabulary for non-tech job descriptions.
- Added the official-source salary benchmark service foundation and safer salary prompts that do not claim live official data before a snapshot exists.
- Enabled Tailor CV OpenRouter fallback by default when OpenRouter is configured, with an explicit `OPENROUTER_TAILOR_FALLBACK=false` opt-out.
