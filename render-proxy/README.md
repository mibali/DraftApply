# DraftApply Render Proxy (Token-gated)

This service keeps your **Groq API key server-side** and exposes a small HTTPS API for the DraftApply Chrome extension.

## Endpoints

- `GET /api/health`
- `POST /api/register` → returns `{ token, expiresAt }`
- `POST /api/generate` (requires `Authorization: Bearer <token>`)
- `POST /api/cv/upload` (requires token; multipart field name `cv`)

## Environment variables (Render dashboard)

- `GROQ_API_KEY` (required)
- `TOKEN_SECRET` (required; random long string)
- `GROQ_MODEL` (optional; default `llama-3.3-70b-versatile`)

## Deploy on Render (quick)

1. Push this repo to GitHub
2. Render → New → Web Service → connect repo
3. Root directory: `render-proxy`
4. Build command: `npm install`
5. Start command: `npm start`
6. Add env vars above

