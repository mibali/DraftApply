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
import { CVParser } from '../shared/cv-parser.js';
import { JDParser } from '../shared/jd-parser.js';
import { CVTailor } from '../shared/cv-tailor.js';

const PORT = Number(process.env.PORT || 10000);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const TOKEN_SECRET = process.env.TOKEN_SECRET;

// Recipe module – default is the bundled open-source recipe. Set RECIPE_PATH to override.
const RECIPE_PATH = process.env.RECIPE_PATH || './recipe/index.js';
let recipe;
try {
  const absPath = resolve(RECIPE_PATH);
  recipe = await import(pathToFileURL(absPath).href);
  console.log(`Recipe loaded from ${RECIPE_PATH}`);
} catch (err) {
  console.error(`Failed to load recipe from ${RECIPE_PATH}: ${err.message}`);
  console.error('Falling back to bundled recipe.');
  recipe = await import('./recipe/index.js');
}

if (!GROQ_API_KEY || !TOKEN_SECRET) {
  console.error('Missing required env vars: GROQ_API_KEY and TOKEN_SECRET must be set. Exiting.');
  process.exit(1);
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
  const expectedBuf = Buffer.from(expectedSig);
  const actualBuf = Buffer.from(sigB64);
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: 'sig' };
  }

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

// ---------------------------------------------------------------------------
// Deterministic CV fact extraction
// For simple data fields (email, phone, LinkedIn, name, etc.) we skip the LLM
// entirely and extract the value directly from the CV text with regexes.
// Falls back to the LLM if nothing is found.
// ---------------------------------------------------------------------------

function extractNameFromCV(cvText) {
  const lines = (cvText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const titleRe = /\b(engineer|developer|manager|designer|analyst|director|lead|head\s+of|vp|chief|intern|consultant|architect|specialist|officer|coordinator|executive)\b/i;
  const metaRe  = /\b(resume|curriculum\s*vitae|cv|portfolio|profile)\b/i;
  for (const line of lines.slice(0, 5)) {
    if (line.length < 50 && /^[A-Z]/.test(line) && !/[@:/\d]/.test(line) && !titleRe.test(line) && !metaRe.test(line)) {
      return line;
    }
  }
  return null;
}

// Each entry: [questionPattern, extractorFn(cvText) → string|null]
const DETERMINISTIC_EXTRACTORS = [
  [/^e-?mail(\s*address)?$/i, cv => {
    const m = cv.match(/[\w.+'-]+@[\w-]+\.[\w.]+/);
    return m?.[0] ?? null;
  }],
  [/^(phone|mobile|cell(phone)?|telephone)(\s*(number))?$/i, cv => {
    // Match international (+XX ...) or common 10-digit formats
    const m = cv.match(/(?:\+\d[\d\s\-.()]{6,18}\d|\b\d{3}[\s\-.]\d{3}[\s\-.]\d{4}\b)/);
    return m ? m[0].trim() : null;
  }],
  [/^linkedin(\s*(url|link|profile|page))?$/i, cv => {
    const m = cv.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w\-_%]+\/?/i);
    return m?.[0] ?? null;
  }],
  [/^github(\s*(url|link|profile|page))?$/i, cv => {
    const m = cv.match(/https?:\/\/(?:www\.)?github\.com\/[\w\-]+\/?/i);
    return m?.[0] ?? null;
  }],
  [/^(portfolio|personal\s*website?|personal\s*site|blog)(\s*(url|link))?$/i, cv => {
    // Any URL that isn't LinkedIn/GitHub/Twitter
    const m = cv.match(/https?:\/\/(?!(?:www\.)?(?:linkedin|github|twitter|x)\.com)[\w\-._~:/?#%@!$&'()*+,;=]+/i);
    return m ? m[0].replace(/[.,;:)]+$/, '') : null;
  }],
  [/^(twitter|x\.com|x)(\s*(handle|url|link|profile))?$/i, cv => {
    const m = cv.match(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[\w_]+/i)
           ?? cv.match(/@[\w_]{2,30}/);
    return m?.[0] ?? null;
  }],
  [/^(full\s*)?name$/i, cv => extractNameFromCV(cv)],
  [/^first\s*name$/i, cv => {
    const n = extractNameFromCV(cv);
    return n ? n.split(/\s+/)[0] : null;
  }],
  [/^(last|sur|family)\s*name$/i, cv => {
    const n = extractNameFromCV(cv);
    if (!n) return null;
    const parts = n.split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : null;
  }],
];

function tryDeterministicExtract(cleanedQuestion, cvText) {
  for (const [pattern, extractor] of DETERMINISTIC_EXTRACTORS) {
    if (pattern.test(cleanedQuestion)) {
      try {
        const result = extractor(cvText || '');
        if (result?.trim()) return result.trim();
      } catch { /* ignore extractor errors, fall through to LLM */ }
    }
  }
  return null;
}

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

  let systemPrompt, userPrompt, temperature, maxTokens;

  // Detect payload format:
  //   Structured (new): body.question exists  →  run through recipe
  //   Legacy:           body.systemPrompt + body.userPrompt  →  pass through
  if (typeof body.question === 'string' && body.question.length > 0) {
    // ── Structured payload → recipe builds the prompts ──
    if (typeof body.cvText !== 'string' || body.cvText.length < 50) {
      return res.status(400).json({ error: 'Missing or empty cvText' });
    }
    // Clean the question label (strip *, :, "Please enter your...", etc.)
    const cleanedQuestion = cleanFieldLabel(body.question);
    if (!cleanedQuestion) {
      return res.status(400).json({ error: 'Question is empty after cleaning' });
    }

    // Short-circuit: plain data fields (name, email, phone, LinkedIn, etc.)
    // can be answered directly from the CV without calling the LLM.
    const deterministicAnswer = tryDeterministicExtract(cleanedQuestion, body.cvText);
    if (deterministicAnswer) {
      return res.json({ answer: deterministicAnswer, provider: 'deterministic' });
    }

    try {
      const result = recipe.buildPrompts({
        question:       cleanedQuestion,
        length:         body.length || 'medium',
        tone:           body.tone || 'natural',
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
      maxTokens    = typeof result.maxTokens === 'number' ? result.maxTokens : undefined;
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

  const useStream = body.stream === true;
  const groqController = new AbortController();
  const groqTimeout = setTimeout(() => groqController.abort(), 60000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      signal: groqController.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        stream: useStream,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[DraftApply] Groq error ${response.status}:`, text.slice(0, 400));
      const status = response.status === 429 ? 429 : 502;
      return res.status(status).json({ error: status === 429 ? 'Rate limit reached — please try again shortly.' : 'Service temporarily unavailable.' });
    }

    if (useStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Forward raw SSE bytes from Groq directly to the client.
          // The background service worker parses OpenAI-compatible SSE, so no
          // transformation is needed — just pass it through.
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        res.end();
      }
      return;
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content;
    if (!answer?.trim()) return res.status(502).json({ error: 'No answer from provider' });

    res.json({ answer, provider: 'groq', model: GROQ_MODEL });
  } catch (e) {
    if (e?.name === 'AbortError') {
      return res.status(504).json({ error: 'AI service timed out. Please try again.' });
    }
    console.error('[DraftApply] Generate error:', e.message);
    return res.status(500).json({ error: 'Failed to generate answer.' });
  } finally {
    clearTimeout(groqTimeout);
  }
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
      // Extract text AND hyperlink annotations (e.g. LinkedIn URL hidden behind hyperlinked text)
      const collectedUrls = [];
      const pdfData = await pdfParse(buffer, {
        pagerender: async function(pageData) {
          try {
            const annotations = await pageData.getAnnotations();
            for (const ann of annotations) {
              const url = ann.url || ann.unsafeUrl;
              if (url) collectedUrls.push(url);
            }
          } catch (_) { /* annotations unavailable, ignore */ }
          // Standard text rendering (matches pdf-parse default)
          const textContent = await pageData.getTextContent();
          let lastY = '';
          let pageText = '';
          for (const item of textContent.items) {
            if (lastY === item.transform[5] || !lastY) {
              pageText += item.str;
            } else {
              pageText += '\n' + item.str;
            }
            lastY = item.transform[5];
          }
          return pageText;
        }
      });
      text = pdfData.text;
      if (collectedUrls.length > 0) {
        const uniqueUrls = [...new Set(collectedUrls)];
        text += '\n\nLinks:\n' + uniqueUrls.join('\n');
      }
    } else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // Extract text + hyperlink URLs (e.g. LinkedIn linked behind display text)
      const [rawResult, htmlResult] = await Promise.all([
        mammoth.extractRawText({ buffer }),
        mammoth.convertToHtml({ buffer })
      ]);
      text = rawResult.value;
      const hrefMatches = htmlResult.value.match(/href="([^"]+)"/g) || [];
      const docxUrls = [...new Set(
        hrefMatches
          .map(m => m.slice(6, -1))
          .filter(u => /^https?:\/\//.test(u))
      )];
      if (docxUrls.length > 0) {
        text += '\n\nLinks:\n' + docxUrls.join('\n');
      }
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

/**
 * Ask the LLM to suggest tools commonly used in a given role that are not
 * already present in the JD. Designed to be fired as a non-blocking Promise
 * that runs in parallel with the sync match analysis.
 *
 * Returns an array of tool name strings, or null on any failure.
 */
async function fetchLLMDomainSuggestions(jobTitle, jdTools) {
  if (!jobTitle || !GROQ_API_KEY) return null;

  const toolList = (jdTools || []).slice(0, 25).join(', ') || 'none specified';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: 'You are a technical hiring expert. Respond only with valid JSON — no markdown, no explanation.',
          },
          {
            role: 'user',
            content: `Job title: ${jobTitle}\nTechnologies already in the job description: ${toolList}\n\nList up to 10 additional tools, frameworks, or technologies that are commonly expected or genuinely valued for this exact role type but are NOT in the list above. Focus on what a hiring manager for this role would realistically look for.\n\nOutput a JSON array of strings only, e.g.: ["Tool1", "Tool2"]`,
          },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const text = (data?.choices?.[0]?.message?.content || '').trim();
    if (!text) return null;

    // Extract JSON array even if the model wraps it in backticks
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter(t => typeof t === 'string' && t.trim().length > 0)
      .map(t => t.trim())
      .slice(0, 10);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

app.post('/api/cv/analyze', authRequired, generateLimiter, async (req, res) => {
  const { cvText, jobTitle = '', company = '', jobDescription, confirmedSkills = [] } = req.body || {};

  if (!cvText || cvText.length < 100) {
    return res.status(400).json({ error: 'cvText must be at least 100 characters' });
  }
  if (!jobDescription || jobDescription.length < 50) {
    return res.status(400).json({ error: 'jobDescription must be at least 50 characters' });
  }

  try {
    const cvData = new CVParser().parse(cvText);
    const jdData = new JDParser().parse(jobDescription, jobTitle, company);
    const tailor  = new CVTailor();

    // Fire LLM domain call immediately so it runs in parallel with sync work below
    const llmSuggestionsPromise = fetchLLMDomainSuggestions(jdData.jobTitle, jdData.tools);

    // Sync work (fast — no LLM involved)
    const matchMap        = tailor.buildMatchMap(cvData, jdData, confirmedSkills);
    const staticFallback  = tailor.suggestDomainSkills(jdData, cvData);

    // Await the LLM domain call (already running in parallel)
    const llmRaw = await llmSuggestionsPromise.catch(() => null);

    // Filter LLM suggestions against what's already in the JD or CV
    let domainSuggestions = staticFallback;
    if (llmRaw?.length > 0) {
      const inJd = new Set([
        ...(jdData.tools          || []).map(t => t.toLowerCase()),
        ...(jdData.requiredSkills  || []).map(s => s.toLowerCase()),
        ...(jdData.preferredSkills || []).map(s => s.toLowerCase()),
      ]);
      const cvLower = cvText.toLowerCase();

      const filtered = llmRaw.filter(tool => {
        const low = tool.toLowerCase();
        // Skip if tool (or any 4+ char word of it) already appears in the JD
        if (inJd.has(low)) return false;
        if (low.split(/\s+/).some(w => w.length >= 4 && inJd.has(w))) return false;
        // Skip if already in the candidate's CV
        if (cvLower.includes(low)) return false;
        return true;
      });

      if (filtered.length > 0) domainSuggestions = filtered;
    }

    return res.json({
      matchReport: tailor.buildMatchSummary(matchMap),
      jobTitle: jdData.jobTitle,
      company:  jdData.company,
      domainSuggestions,
    });
  } catch (e) {
    console.error('[DraftApply] Analyze error:', e.message);
    return res.status(500).json({ error: 'Failed to analyze CV match.' });
  }
});

app.post('/api/cv/tailor', authRequired, generateLimiter, async (req, res) => {
  const { cvText, jobTitle = '', company = '', jobDescription, confirmedSkills = [] } = req.body || {};

  if (!cvText || cvText.length < 100) {
    return res.status(400).json({ error: 'cvText must be at least 100 characters' });
  }
  if (!jobDescription || jobDescription.length < 50) {
    return res.status(400).json({ error: 'jobDescription must be at least 50 characters' });
  }

  const cvData   = new CVParser().parse(cvText);
  const jdData   = new JDParser().parse(jobDescription, jobTitle, company);
  const tailor   = new CVTailor();
  const matchMap = tailor.buildMatchMap(cvData, jdData, confirmedSkills);
  const { systemPrompt, userPrompt } = tailor.buildTailoringPrompt(cvData, jdData, matchMap);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.3,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[DraftApply] Groq tailor error ${response.status}:`, text.slice(0, 400));
      const status = response.status === 429 ? 429 : 502;
      return res.status(status).json({
        error: status === 429
          ? 'Rate limit reached — please try again shortly.'
          : 'Service temporarily unavailable.'
      });
    }

    const data = await response.json();
    const tailoredCvText = tailor.removeTailoringMetaPhrases(
      tailor.enforceTargetHeadline(data?.choices?.[0]?.message?.content, jdData.jobTitle),
      jdData.company
    );
    if (!tailoredCvText?.trim()) {
      return res.status(502).json({ error: 'No output from provider' });
    }

    const warnings        = tailor.validateTailoredCV(cvData, tailoredCvText);
    const changedSections = tailor.detectChangedSections(cvText, tailoredCvText);
    const matchReport     = tailor.buildMatchSummary(matchMap);

    res.json({ tailoredCvText, matchReport, warnings, changedSections });
  } catch (e) {
    if (e?.name === 'AbortError') {
      return res.status(504).json({ error: 'AI service timed out. Please try again.' });
    }
    console.error('[DraftApply] Tailor error:', e.message);
    return res.status(500).json({ error: 'Failed to tailor CV.' });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(PORT, () => {
  console.log(`DraftApply Render proxy listening on :${PORT}`);
});
