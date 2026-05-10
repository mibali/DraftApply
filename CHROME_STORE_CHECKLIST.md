# Chrome Web Store checklist (DraftApply)

## Before you upload

- [ ] Set final extension name, description, and version in `extension-ready/manifest.json`
- [ ] Ensure **no secrets** are bundled in the extension
- [ ] Confirm `host_permissions` are minimal and required
- [ ] Confirm `web_accessible_resources` are minimal and required
- [ ] Verify the proxy URL is correct (`extension-ready/background.js`)
- [ ] Confirm proxy is deployed and healthy: `GET https://draftapply.onrender.com/api/health`

## Required docs

- [ ] Privacy policy (see `PRIVACY_POLICY.md`)
- [ ] Support contact email
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
