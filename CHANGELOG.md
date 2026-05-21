# Changelog

All notable user-facing changes to DraftApply are documented here.

This project uses version tags in the form `vX.Y.Z`. The Chrome extension
version in `extension-ready/manifest.json` and the root `package.json` version
must match the release tag.

## [Unreleased]

- Added a role-profile career-positioning engine so CV tailoring and answer generation reason about role credibility, not only keyword overlap.
- Added role-profile integrity tests to prevent duplicate aliases, conflicting title mappings, and repeated skill categories.
- Added role-aware answer prompts with credibility rubrics for target roles.
- Added daily role-profile expansion and monthly salary-benchmark refresh automations.
- Hardened Tailor CV output quality for Solution Architect-style roles, Core Competencies formatting, provider fallback labels, and stale JD handling.

