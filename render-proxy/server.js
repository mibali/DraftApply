import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const PORT = Number(process.env.PORT || 10000);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const TOKEN_SECRET = process.env.TOKEN_SECRET;

// Recipe module – override with RECIPE_PATH env var to plug in a private recipe.
// Falls back to the bundled example recipe.
const RECIPE_PATH = process.env.RECIPE_PATH || './recipe/index.js';
let recipe;
try {
  const absPath = resolve(RECIPE_PATH);
  recipe = await import(pathToFileURL(absPath).href);
  console.log(`Recipe loaded from ${RECIPE_PATH}`);
} catch (err) {
  console.error(`Failed to load recipe from ${RECIPE_PATH}: ${err.message}`);
  console.error('Falling back to built-in example recipe.');
  recipe = await import('./recipe/index.js');
}

if (!GROQ_API_KEY) {
  // Avoid printing secrets; just a clear startup error
  console.error('Missing GROQ_API_KEY env var.');
}
if (!TOKEN_SECRET) {
  console.error('Missing TOKEN_SECRET env var.');
}

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signToken(payloadObj) {
  const payloadB64 = base64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest();
  return `${payloadB64}.${base64url(sig)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'format' };
  const [payloadB64, sigB64] = parts;
  const expectedSig = base64url(crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest());
  if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sigB64))) return { ok: false, reason: 'sig' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'expired' };
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return { ok: false, reason: 'iat' };
  if (typeof payload.jti !== 'string' || payload.jti.length < 8) return { ok: false, reason: 'jti' };

  return { ok: true, payload };
}

function getBearerToken(req) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const t = getBearerToken(req) || 'no-token';
    return `${t}:${req.ip}`;
  }
});

function authRequired(req, res, next) {
  if (!TOKEN_SECRET) return res.status(500).json({ error: 'Server misconfigured' });
  const t = getBearerToken(req);
  const v = verifyToken(t);
  if (!v.ok) return res.status(401).json({ error: 'Unauthorized', reason: v.reason });
  req.installToken = v.payload;
  next();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, provider: 'groq', model: GROQ_MODEL });
});

app.post('/api/register', registerLimiter, (req, res) => {
  if (!TOKEN_SECRET) return res.status(500).json({ error: 'Server misconfigured' });

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60 * 24 * 90; // 90 days
  const payload = {
    ver: 1,
    iat: now,
    exp,
    jti: crypto.randomBytes(16).toString('hex')
  };

  const token = signToken(payload);
  res.json({ token, expiresAt: exp * 1000 });
});

/**
 * Strip common form-field artifacts (*, :, ?) so recipe patterns match cleanly.
 * This runs engine-side so every recipe benefits without duplicating the logic.
 */
function cleanFieldLabel(raw) {
  return (raw || '')
    .trim()
    .replace(/[*:?\u2217\u2731]+$/g, '')   // trailing *, :, ?, unicode asterisks
    .replace(/^(please\s+(enter|provide|input|type|specify)\s+(your\s+)?)/i, '')
    .replace(/^(enter\s+(your\s+)?)/i, '')
    .replace(/^(your\s+)/i, '')
    .trim();
}

app.post('/api/generate', authRequired, generateLimiter, async (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Server misconfigured' });

  const body = req.body || {};

  let systemPrompt, userPrompt, temperature;

  // Detect payload format:
  //   Structured (new): body.question exists  →  run through recipe
  //   Legacy:           body.systemPrompt + body.userPrompt  →  pass through
  if (typeof body.question === 'string' && body.question.length > 0) {
    // ── Structured payload → recipe builds the prompts ──
    if (typeof body.cvText !== 'string' || body.cvText.length < 5) {
      return res.status(400).json({ error: 'Missing or empty cvText' });
    }
    // Clean the question label (strip *, :, "Please enter your...", etc.)
    const cleanedQuestion = cleanFieldLabel(body.question);
    try {
      const result = recipe.buildPrompts({
        question:       cleanedQuestion,
        length:         body.length || 'medium',
        cvText:         body.cvText,
        jobTitle:       body.jobTitle || undefined,
        company:        body.company || undefined,
        jobDescription: body.jobDescription || undefined,
        requirements:   Array.isArray(body.requirements) ? body.requirements : undefined,
        pageUrl:        body.pageUrl || undefined,
        platform:       body.platform || undefined,
      });
      systemPrompt = result.systemPrompt;
      userPrompt   = result.userPrompt;
      temperature  = typeof result.temperature === 'number' ? result.temperature : 0.7;
    } catch (err) {
      return res.status(500).json({ error: 'Recipe error', details: String(err.message).slice(0, 200) });
    }
  } else if (typeof body.systemPrompt === 'string' && typeof body.userPrompt === 'string') {
    // ── Legacy raw prompt payload (backward-compat) ──
    systemPrompt = body.systemPrompt;
    userPrompt   = body.userPrompt;
    temperature  = typeof body.temperature === 'number' ? body.temperature : 0.7;
  } else {
    return res.status(400).json({ error: 'Missing prompt data. Send either structured (question + cvText) or legacy (systemPrompt + userPrompt).' });
  }

  // Validate prompt sizes
  if (typeof systemPrompt !== 'string' || systemPrompt.length < 10) {
    return res.status(400).json({ error: 'System prompt too short' });
  }
  if (typeof userPrompt !== 'string' || userPrompt.length < 10) {
    return res.status(400).json({ error: 'User prompt too short' });
  }
  if (systemPrompt.length > 30000 || userPrompt.length > 120000) {
    return res.status(413).json({ error: 'Prompt too large' });
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return res.status(502).json({ error: 'Upstream error', status: response.status, details: text.slice(0, 400) });
  }

  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) return res.status(502).json({ error: 'No answer from provider' });

  res.json({ answer, provider: 'groq', model: GROQ_MODEL });
});

// Optional: keep file upload UX working (PDF/DOCX/TXT)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/api/cv/upload', authRequired, generateLimiter, upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const buffer = req.file.buffer;
    const mimetype = req.file.mimetype;

    let text = '';
    if (mimetype === 'application/pdf') {
      const pdfData = await pdfParse(buffer);
      text = pdfData.text;
    } else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const docxResult = await mammoth.extractRawText({ buffer });
      text = docxResult.value;
    } else if (mimetype === 'text/plain') {
      text = buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    text = String(text)
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    res.json({
      success: true,
      text,
      filename: req.file.originalname,
      size: req.file.size
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to process CV file' });
  }
});

app.listen(PORT, () => {
  console.log(`DraftApply Render proxy listening on :${PORT}`);
});

