# DraftApply Domain Packs

Domain packs are compact, reviewable knowledge snapshots for professions where generic CV/JD matching is risky or incomplete.

They help DraftApply identify when to be stricter about credentials, local licensing, portfolio evidence, academic outputs, safety-critical claims, and sparse job descriptions.

## Files

- `sources.json` lists official upstream sources, refresh cadence, licensing, and attribution requirements.
- `domain-pack.snapshot.json` is the runtime-safe compact snapshot.
- `refresh.js` contains deterministic refresh and validation helpers.
- `raw/` is the optional local location for official source exports. Raw files are not committed by default.

## Refresh Flow

```bash
npm run refresh:domain-packs
npm run validate:domain-packs
```

The scheduled GitHub workflow runs monthly with `DOMAIN_PACK_FETCH_REMOTE=true`. It monitors official source pages, records compact checksums/metadata in the snapshot, validates the result, and opens a pull request only when the compact snapshot changes. Runtime generation never fetches live third-party data, which keeps the extension/proxy fast, private, and reproducible.

## Source Policy

- Prefer official, openly licensed public datasets.
- Keep attribution and license text in `sources.json`.
- Add `expectedRawFiles[].downloadUrl` only for stable official export URLs. Otherwise the workflow monitors the official landing page for review signals.
- Do not commit large raw exports unless maintainers explicitly decide the repository should vendor them.
- Review generated changes before merge, especially for regulated or credential-heavy domains.
