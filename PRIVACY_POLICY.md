# DraftApply Privacy Policy (Official Chrome Extension)

This policy describes the checked-in official extension configured for `https://draftapply.onrender.com`. Self-hosted deployments and the separate local web app are operated under their operator's practices. See the [privacy/provider matrix](docs/privacy-provider-matrix.md).

## What we store

- **Your CV text**: stored locally in your browser using `chrome.storage.local`.
- **CV links and application facts**: profile URLs and optional facts such as notice period, availability, work authorization, relocation, and salary preferences, stored locally to answer factual fields accurately.
- **Tailoring state and output**: pasted job context, in-progress job metadata, tailored CV drafts, and temporary export data, stored locally so the popup and export page can complete the workflow.
- **Productivity counters**: local counts of answers inserted and CVs tailored/exported. DraftApply includes no analytics or tracking service.
- **Install token and expiry**: stored locally to authenticate requests to the DraftApply proxy API. This pseudonymous token identifies an installation to the proxy's authentication and quota controls.

## What we send over the network

When you generate an answer or tailor a CV:

- We send a request to the DraftApply proxy API at `https://draftapply.onrender.com`.
- The request includes the content needed for that action: CV text, job-page or pasted job context, the question, and any confirmed facts or skills you supplied.
- The proxy forwards the request to Groq, or when enabled and needed, to OpenRouter and a downstream model provider. Responses include provider-route metadata where the protocol permits.

When you upload a **PDF/DOCX** CV file for text extraction:

- The file is sent to the DraftApply proxy API for **in-memory** extraction and returned as text.
- If a PDF contains no usable selectable text, bounded OCR runs inside the DraftApply proxy process. The file is not sent to a separate OCR provider and is not stored by the proxy application.

## What we do not do

- We do **not** sell your data.
- We do **not** embed API keys in the extension.
- We do **not** store your CV or generated answers on DraftApply servers.
- DraftApply does **not** train models on your data. Provider retention and training treatment are governed by the provider account, route, and current terms; review the matrix and provider controls.

## Data retention

- **Extension (local)**: data stays in `chrome.storage.local` until you remove the extension, clear its site/extension data in Chrome, or choose **Delete all local data** in the popup. That command cancels active DraftApply work and clears all extension-local CV, fact, token, draft, export, and productivity data. **Clear CV** removes only the saved CV and its extracted links.
- **DraftApply proxy (server)**: application code does not intentionally persist CVs, prompts, or answers. Hosting, security, and quota infrastructure can retain operational metadata.
- **LLM route**: the official operator must enable and verify Groq account ZDR. OpenRouter requests require ZDR/data-collection restrictions by default, but OpenRouter and the selected downstream provider remain separate processors. Source code cannot prove an account-level setting is enabled.

## Security and deletion limitations

Network traffic uses HTTPS. Local data is protected by Chrome's extension storage and the security of your browser profile and device; DraftApply does not add separate at-rest encryption. Deleting local data does not retroactively erase information already processed under an infrastructure or model provider's retention policy. For provider and operator responsibilities, see the [privacy/provider matrix](docs/privacy-provider-matrix.md).

Grounding reports and final answer validation reduce unsupported claims; they are not privacy or retention controls.

## Contact

A public Chrome Web Store release is blocked until the publisher adds a monitored support contact here and in the store listing. No contact address is present in repository metadata, so none is invented in this policy.
