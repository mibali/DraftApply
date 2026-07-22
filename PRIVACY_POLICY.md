# DraftApply Privacy Policy (Official Chrome Extension)

This policy describes the checked-in official extension configured for `https://draftapply.onrender.com`. Self-hosted deployments and the separate local web app are operated under their operator's practices. See the [privacy/provider matrix](docs/privacy-provider-matrix.md).

## What we store

- **Your CV text**: stored locally in your browser using `chrome.storage.local`.
- **Install token**: stored locally in your browser to authenticate requests to the DraftApply proxy API.

## What we send over the network

When you click “Generate”:

- We send a request to the DraftApply proxy API at `https://draftapply.onrender.com`.
- The request includes the prompts needed to generate the answer (derived from your CV + the job page context + the question).
- The proxy forwards the request to Groq, or when enabled and needed, to OpenRouter and a downstream model provider. Responses include provider-route metadata where the protocol permits.

When you upload a **PDF/DOCX** CV file for text extraction:

- The file is sent to the DraftApply proxy API for **in-memory** extraction and returned as text.

## What we do not do

- We do **not** sell your data.
- We do **not** embed API keys in the extension.
- We do **not** store your CV or generated answers on DraftApply servers.
- DraftApply does **not** train models on your data. Provider retention and training treatment are governed by the provider account, route, and current terms; review the matrix and provider controls.

## Data retention

- **Extension (local)**: CV data stays in your browser until you clear it in the extension UI.
- **DraftApply proxy (server)**: application code does not intentionally persist CVs, prompts, or answers. Hosting, security, and quota infrastructure can retain operational metadata.
- **LLM route**: the official operator must enable and verify Groq account ZDR. OpenRouter requests require ZDR/data-collection restrictions by default, but OpenRouter and the selected downstream provider remain separate processors. Source code cannot prove an account-level setting is enabled.

Grounding reports and final answer validation reduce unsupported claims; they are not privacy or retention controls.

## Contact

A public Chrome Web Store release is blocked until the publisher adds a monitored support contact here and in the store listing. No contact address is present in repository metadata, so none is invented in this policy.
