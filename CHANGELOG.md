# Changelog

All notable user-facing changes to DraftApply are documented here.

This project uses version tags in the form `vX.Y.Z`. The Chrome extension
version in `extension-ready/manifest.json` and the root `package.json` version
must match the release tag.

## [Unreleased]

## [2.5.1] - 2026-07-26

### Reliability and safety

- Hardened hosted proxy request deadlines, cancellation, admission control,
  idempotency, provider fallback, and response validation so misbehaving
  requests fail closed with bounded resource usage instead of hanging or
  falling through to unsafe defaults.
- Extension answer insertion, token handling, deletion, Tailor CV requests,
  and other request-lifecycle mutations are now serialized so overlapping
  actions can no longer race each other.
- Hardened local-provider privacy defaults, BYOK key isolation, structured
  CV generation, and disconnect handling.
- Further improvements to grounding accuracy, contact extraction, release
  reproducibility, and dependency security.

### Documentation and process

- Added issue/PR templates, a Code of Conduct, Contributing guide, Security
  policy, and Privacy Policy for the open-source project.
- Added Dependabot configuration and a scheduled domain-packs refresh workflow.

## [2.5.0] - 2026-07-22

### Tailored CV generation

- Replaced free-text CV rewriting with structured generation: a locked skeleton
  (companies, dates, titles, education, contact details) holds every fact the
  model must not touch, and the model returns only mutable JSON content
  (summary, competencies, per-role focus/bullets). Eliminates an entire class
  of formatting corruption — split dates, duplicated company lines, misplaced
  Focus lines, scrambled education — by construction rather than repair.
- Fixed CV parsing to stop dropping roles, names, and bullet tails on
  duplicated PDF text layers, em-dash ("Company — Location") headers, and
  hard-wrapped bullet continuations.
- The CV's own labelled skill categories and auxiliary sections (Technical
  Leadership, Publications, Achievements) now transfer into the tailored CV
  and PDF export instead of collapsing into a single generic catch-all or
  being silently dropped.
- Tailored summaries are now genuinely rewritten for the target role instead
  of falling back to a verbatim copy of the original whenever the model's
  citations were imperfect.
- Fixed a PDF-upload defect where every hyperlink in the source document
  (not just the candidate's own profile links) was appended as a raw link
  list, polluting the Education section and misattributing unrelated
  reference links as the candidate's LinkedIn/GitHub/portfolio.
- PDF hyperlinks in Achievements/Projects bullets now link their actual
  descriptive text (recovered from the link's position in the source PDF)
  instead of only ever working for header contact links.
- CV upload failures now return a specific, actionable reason (scanned/
  password-protected PDF, corrupt DOCX, unsupported format) instead of a
  generic error, with a safe fallback parse path so link extraction failures
  never cost the whole upload.
- Fixed PDF export so a page break no longer leaves content flush against
  the physical top of the next page.

### Matching and answer accuracy

- JD requirements phrased as alternatives ("such as X, Y, or Z") are now
  scored by whether the candidate has any one of them, instead of being
  penalised for lacking every alternative.
- Fixed a negation-detection false positive that was rejecting truthful,
  grounded content.
- Application answers now route short factual questions (location,
  availability, notice period) to concise, direct responses instead of a
  full CV-evidence narrative.
- Users can now save profile URLs directly (for CVs whose file never
  contains a real link) and insert their own edited answers without being
  blocked by the grounding gate, which now applies only to unedited model
  output.

### Reliability and safety

- Added Redis-backed, fail-closed request/token/spend quotas per install,
  with default limits raised to realistic levels for normal usage and
  denials that now name the specific limit that was hit.
- Hardened proxy admission control, request deadlines, and provider
  routing/fallback between Groq and OpenRouter.
- Added an optional lightweight local model router and a live-benchmarked
  embedding model for CV/JD evidence retrieval.

### Interface

- Simplified the answer and CV-tailoring UI: removed internal
  workflow/agent/model vocabulary, replaced alarming "Review Required" /
  "Insertion Blocked" button states with a compact verification badge, and
  moved supporting detail behind collapsed disclosures.

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
