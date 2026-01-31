# DraftApply Privacy Policy (Chrome Extension)

## What we store

- **Your CV text**: stored locally in your browser using `chrome.storage.local`.
- **Install token**: stored locally in your browser to authenticate requests to the DraftApply proxy API.

## What we send over the network

When you click “Generate”:

- We send a request to the DraftApply proxy API at `https://draftapply.onrender.com`.
- The request includes the prompts needed to generate the answer (derived from your CV + the job page context + the question).
- The proxy forwards the request to the configured LLM provider (currently Groq) to generate the response.

When you upload a **PDF/DOCX** CV file for text extraction:

- The file is sent to the DraftApply proxy API for **in-memory** extraction and returned as text.

## What we do not do

- We do **not** sell your data.
- We do **not** embed API keys in the extension.
- We do **not** store your CV or generated answers on DraftApply servers.
- We do **not** use your data to train models.

## Data retention

- **Extension (local)**: CV data stays in your browser until you clear it in the extension UI.
- **DraftApply proxy (server)**: no database is used; the proxy processes requests and returns responses without persisting your CV or prompts.
- **LLM provider (Groq)**: configured with **Zero Data Retention (ZDR)** to prevent retention of inputs/outputs for inference. (You can verify this in Groq Console “Data Controls”.)

## Contact

If you ship publicly, add a support email/contact here.

