# Chrome Web Store checklist (DraftApply)

## Before you upload

- [ ] Set final extension name, description, and version in `extension-ready/manifest.json`
- [ ] Ensure **no secrets** are bundled in the extension
- [ ] Confirm `host_permissions` are minimal and required
- [ ] Confirm `web_accessible_resources` are minimal and required
- [ ] Verify the generated build's proxy origin and `host_permissions` match the intended official origin (do not point it at `backend/`)
- [ ] Confirm proxy is deployed and healthy: `GET https://draftapply.onrender.com/api/health`
- [ ] Record every possible model route, including OpenRouter and its downstream providers, in disclosures
- [ ] Verify Groq account Data Controls/ZDR in the provider console; do not infer this from source or environment flags
- [ ] Verify OpenRouter ZDR/data-collection routing and downstream-provider eligibility, if fallback is enabled
- [ ] Provision Redis durable quotas for production and confirm startup fails closed without it
- [ ] Test `inputGroundingReport`, final-answer validation, `providerTrace`, and final-provider disclosure on primary and fallback routes

## Required docs

- [ ] Privacy policy (see `PRIVACY_POLICY.md`)
- [ ] Add and monitor a real support contact in the privacy policy and store listing (release blocker; none is present in repository metadata)
- [ ] Screenshots + short demo video/GIF

## Testing

- [ ] Load CV (paste + file upload)
- [ ] Generate on at least: Greenhouse, Lever, Workday (or your top 2–3)
- [ ] Insert works for input + textarea
- [ ] Stop/Cancel works
- [ ] Copy fallback works

## Packaging

- [ ] Bump `extension-ready/manifest.json` version before every public release
- [ ] Run `npm run release:chrome` to test and create `dist/draftapply-chrome-<version>.zip`
- [ ] Upload manually, or run `npm run release:chrome:upload` with Chrome Web Store API credentials
- [ ] Submit manually, or run `npm run release:chrome:publish` to upload and submit for review

## Automated release secrets

Set these as GitHub Actions secrets before using `.github/workflows/chrome-web-store-release.yml`:

- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`
- `CHROME_EXTENSION_ID`
- `CHROME_PUBLISHER_ID`
