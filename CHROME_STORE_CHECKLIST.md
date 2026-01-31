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

- [ ] Zip the `extension-ready/` folder contents (not the parent folder)
- [ ] Upload to Chrome Web Store

