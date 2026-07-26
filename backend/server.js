/**
 * DraftApply Backend API Server
 * 
 * Supports multiple FREE LLM providers:
 * 
 * CLOUD (free tiers):
 * - Groq
 * - Google Gemini
 * - Mistral
 * - Together AI
 * - OpenAI (paid)
 *
 * LOCAL (no API key, fully private):
 * - Ollama
 * - LM Studio
 * - LocalAI
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  PROVIDERS,
  resolveProvider,
  getProviderConfig,
  generate,
  stream,
  checkProvider,
  generateWithFallback,
  buildFallbackChain
} from './llm-providers.js';
import { CVParser } from '../shared/cv-parser.js';
import { PromptBuilder } from '../shared/prompt-builder.js';
import { JDParser } from '../shared/jd-parser.js';
import { CVTailor } from '../shared/cv-tailor.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CV_TEXT = 100_000;
const MAX_JD_TEXT = 60_000;
const MAX_EXTRACTED_TEXT = 100_000;

// Offline-first default. Select a cloud provider explicitly with LLM_PROVIDER.
const PROVIDER_NAME = resolveProvider(process.env);
const PROVIDER_CONFIG = getProviderConfig(PROVIDER_NAME, process.env);

// Build fallback chain for reliability
const FALLBACK_CHAIN = buildFallbackChain(process.env);
const USE_FALLBACK = process.env.USE_FALLBACK !== 'false';

export function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
}
if (!isLoopbackHost(HOST) && process.env.ALLOW_UNSAFE_REMOTE_BIND !== 'true') {
  throw new Error('Refusing non-loopback HOST. Set ALLOW_UNSAFE_REMOTE_BIND=true only on a trusted network.');
}

console.log(`LLM Provider: ${PROVIDER_CONFIG.name} (${PROVIDER_CONFIG.model})`);
if (USE_FALLBACK && FALLBACK_CHAIN.length > 1) {
  console.log(`Fallback chain: ${FALLBACK_CHAIN.map(p => p.name).join(' → ')}`);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  req.requestAbort = new AbortController();
  req.deadlineAt = Date.now() + (Number(process.env.REQUEST_TIMEOUT_MS) || 60_000);
  const abort = () => req.requestAbort.abort(new Error('Client disconnected'));
  const deadline = setTimeout(
    () => req.requestAbort.abort(new Error('Request deadline exceeded')),
    Math.max(1, req.deadlineAt - Date.now())
  );
  req.once('aborted', abort);
  res.once('close', () => {
    clearTimeout(deadline);
    if (!res.writableEnded) abort();
  });
  next();
});

// File upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, DOCX, TXT'));
    }
  }
});

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    provider: PROVIDER_CONFIG.name,
    model: PROVIDER_CONFIG.model,
    type: PROVIDERS[PROVIDER_NAME].type
  });
});

/**
 * List available providers
 */
app.get('/api/providers', (req, res) => {
  const providers = Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    name: p.name,
    type: p.type,
    defaultModel: p.defaultModel,
    setupHint: p.setupHint,
    active: id === PROVIDER_NAME
  }));
  
  res.json({ providers, current: PROVIDER_NAME });
});

/**
 * Check LLM availability
 */
app.get('/api/llm-status', async (req, res) => {
  const status = await checkProvider(PROVIDER_NAME, PROVIDER_CONFIG, { signal: req.requestAbort.signal });
  
  res.json({
    ...status,
    provider: PROVIDER_NAME,
    providerName: PROVIDER_CONFIG.name,
    model: PROVIDER_CONFIG.model,
    type: PROVIDERS[PROVIDER_NAME].type
  });
});

/**
 * CV Upload and Parse endpoint
 */
app.post('/api/cv/upload', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let text = '';
    let linkAnnotations = [];
    const { mimetype, buffer } = req.file;
    const validMagic = mimetype === 'application/pdf'
      ? buffer.subarray(0, 5).toString() === '%PDF-'
      : mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ? buffer[0] === 0x50 && buffer[1] === 0x4b
        : !buffer.includes(0);
    if (!validMagic) return res.status(400).json({ error: 'File content does not match its declared type' });

    switch (mimetype) {
      case 'application/pdf':
        const pdfData = await pdfParse(buffer);
        text = pdfData.text;
        break;

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        const [docxResult, htmlResult] = await Promise.all([
          mammoth.extractRawText({ buffer }),
          mammoth.convertToHtml({ buffer })
        ]);
        text = docxResult.value;
        linkAnnotations = extractLinkAnnotationsFromHtml(htmlResult.value);
        break;

      case 'text/plain':
        text = buffer.toString('utf-8');
        break;

      default:
        return res.status(400).json({ error: 'Unsupported file type' });
    }

    text = text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length > MAX_EXTRACTED_TEXT) {
      return res.status(413).json({ error: 'Extracted CV text is too large' });
    }

    res.json({
      success: true,
      text,
      linkAnnotations,
      filename: req.file.originalname,
      size: req.file.size
    });

  } catch (error) {
    console.error('CV upload error:', error);
    res.status(500).json({ error: 'Failed to process CV file' });
  }
});

function extractLinkAnnotationsFromHtml(html = '') {
  const annotations = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(String(html || '')))) {
    const url = normaliseAnnotationUrl(decodeHtmlEntities(match[1]));
    const label = cleanAnnotationLabel(match[2]) || linkLabelFromUrl(url);
    if (!url || !label) continue;
    const key = `${label.toLowerCase()}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    annotations.push({ text: label, url });
  }
  return annotations.slice(0, 100);
}

function cleanAnnotationLabel(value = '') {
  return decodeHtmlEntities(String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, 120);
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normaliseAnnotationUrl(url = '') {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return '';
  return clean;
}

function linkLabelFromUrl(url = '') {
  const raw = String(url || '').trim();
  if (/linkedin\.com/i.test(raw)) return 'LinkedIn';
  if (/github\.com/i.test(raw)) return 'GitHub';
  if (/behance\.net/i.test(raw)) return 'Behance';
  if (/dribbble\.com/i.test(raw)) return 'Dribbble';
  if (/kaggle\.com/i.test(raw)) return 'Kaggle';
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch {
    return raw;
  }
}

/**
 * Answer Generation endpoint
 *
 * Accepts two payload formats:
 *
 * 1. Pre-built prompts (web app):
 *    { systemPrompt, userPrompt, temperature?, stream?, llmConfig? }
 *
 * 2. Structured payload (extension) — prompts built server-side:
 *    { question, cvText, length?, jobTitle?, company?, jobDescription?,
 *      requirements?, platform?, llmConfig? }
 *
 * Both formats accept optional `llmConfig: { provider, apiKey, model? }`
 * to use a user-supplied LLM. BYOK requests never fall back to another provider.
 */
app.post('/api/generate', async (req, res) => {
  try {
    let { systemPrompt, userPrompt, temperature, stream: useStream, llmConfig } = req.body;

    // ── Extension structured payload → build prompts server-side ──────────
    if (!systemPrompt && req.body.question && req.body.cvText) {
      const { question, cvText, length, jobTitle, company, jobDescription, requirements, tone } = req.body;

      const cvParser = new CVParser();
      const cvData = cvParser.parse(cvText);

      const promptBuilder = new PromptBuilder();
      const built = promptBuilder.buildPrompt(cvData, question, length || 'medium', {
        jobTitle,
        company,
        jobDescription,
        requirements,
        tone
      });

      systemPrompt = built.systemPrompt;
      userPrompt = built.userPrompt;
    }

    if (!systemPrompt || !userPrompt) {
      return res.status(400).json({ error: 'Missing prompt data' });
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const options = { temperature: temperature || 0.7, signal: req.requestAbort.signal, deadlineAt: req.deadlineAt };

    // Resolve user-supplied provider config (if provided and valid)
    let userProviderName = null;
    let userProviderConfig = null;
    if (llmConfig?.provider && PROVIDERS[llmConfig.provider] &&
        (PROVIDERS[llmConfig.provider].type === 'local' || llmConfig.apiKey)) {
      userProviderName = llmConfig.provider;
      userProviderConfig = {
        ...PROVIDERS[llmConfig.provider],
        apiKey: llmConfig.apiKey,
        model: llmConfig.model || PROVIDERS[llmConfig.provider].defaultModel
      };
    }

    if (useStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-DraftApply-Provider', userProviderName || PROVIDER_NAME);
      res.write(`data: ${JSON.stringify({ provider: userProviderName || PROVIDER_NAME })}\n\n`);

      if (userProviderName && userProviderConfig) {
        await stream(userProviderName, userProviderConfig, messages, options, res);
        return;
      }
      await stream(PROVIDER_NAME, PROVIDER_CONFIG, messages, options, res);
    } else {
      if (userProviderName && userProviderConfig) {
        const result = await generate(userProviderName, userProviderConfig, messages, options);
        return res.json({ ...result, provider: userProviderName });
      }

      // Use server fallback chain
      let result;
      if (USE_FALLBACK && FALLBACK_CHAIN.length > 1) {
        result = await generateWithFallback(FALLBACK_CHAIN, messages, options);
      } else {
        result = await generate(PROVIDER_NAME, PROVIDER_CONFIG, messages, options);
        result.provider = PROVIDER_NAME;
      }
      res.json(result);
    }

  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({
      error: 'Failed to generate answer',
      ...(process.env.NODE_ENV === 'development' ? { details: error.message } : {})
    });
  }
});

/**
 * Job Description Extraction endpoint
 * Strips company blurb, benefits, and EEO boilerplate from a full job posting,
 * returning only responsibilities, required qualifications, and technical skills.
 */
app.post('/api/jd/extract', async (req, res) => {
  try {
    const { text, llmConfig } = req.body || {};

    if (!text || text.trim().length < 100) {
      return res.status(400).json({ error: 'text must be at least 100 characters' });
    }

    const normalizedText = text.trim();
    if (normalizedText.length > MAX_JD_TEXT) {
      return res.status(413).json({ error: 'Job posting is too large. Please paste a shorter posting.' });
    }

    const systemPrompt = `You are a job posting parser. Extract only the job-relevant content from a full job posting.

Return ONLY these sections (when present):
- Responsibilities / What you will do
- Required qualifications / Minimum requirements
- Preferred qualifications / Nice to have
- Required technical skills and tools

Remove completely:
- Company descriptions, mission statements, values, culture blurbs
- Benefits, compensation, equity, perks
- Equal opportunity / EEO statements
- Application instructions or "how to apply" sections
- "About us" or "Who we are" sections

Preserve the original bullet point structure and section headings. Output only the extracted content with no preamble, no commentary, and no markdown code fences.`;

    const userPrompt = `Extract the job requirements from this posting:\n\n${normalizedText}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const options = { temperature: 0.1, max_tokens: 2000, signal: req.requestAbort.signal, deadlineAt: req.deadlineAt };

    let userProviderName = null;
    let userProviderConfig = null;
    if (llmConfig?.provider && llmConfig?.apiKey && PROVIDERS[llmConfig.provider]) {
      userProviderName = llmConfig.provider;
      userProviderConfig = {
        ...PROVIDERS[llmConfig.provider],
        apiKey: llmConfig.apiKey,
        model: llmConfig.model || PROVIDERS[llmConfig.provider].defaultModel
      };
    }

    let result;
    if (userProviderName && userProviderConfig) {
      result = await generate(userProviderName, userProviderConfig, messages, options);
      result.provider = userProviderName;
    }

    if (!result) {
      if (USE_FALLBACK && FALLBACK_CHAIN.length > 1) {
        result = await generateWithFallback(FALLBACK_CHAIN, messages, options);
      } else {
        result = await generate(PROVIDER_NAME, PROVIDER_CONFIG, messages, options);
        result.provider = PROVIDER_NAME;
      }
    }

    const extractedText = result.answer?.trim();
    if (!extractedText) {
      return res.status(502).json({ error: 'No output from provider' });
    }

    res.json({ extractedText, provider: result.provider });
  } catch (error) {
    console.error('JD extract error:', error);
    res.status(500).json({ error: 'Failed to extract job description', ...(process.env.NODE_ENV === 'development' ? { details: error.message } : {}) });
  }
});

/**
 * Direct text-based CV input
 */
app.post('/api/cv/text', (req, res) => {
  const { text } = req.body;
  
  if (typeof text !== 'string' || text.trim().length < 50) {
    return res.status(400).json({ error: 'CV text too short or missing' });
  }
  if (text.length > MAX_CV_TEXT) {
    return res.status(413).json({ error: 'CV text is too large' });
  }

  res.json({
    success: true,
    text: text.trim(),
    size: text.length
  });
});

// Simple in-process JD enrichment cache (shared with tailor route)
const _backendJdCache = new Map();
const _backendJdCacheTtl = 20 * 60 * 1000;
function _backendJdCacheKey(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 4000);
}
async function _backendEnrichJd(jdParser, regexParsed, jdText, options) {
  const key = _backendJdCacheKey(jdText);
  const hit = _backendJdCache.get(key);
  if (hit && Date.now() < hit.exp) return { jdData: hit.data, source: 'cache' };

  const { systemPrompt: sp, userPrompt: up } = jdParser.buildLLMAnalysisPrompt(jdText);
  try {
    const result = await generateWithFallback(FALLBACK_CHAIN,
      [{ role: 'system', content: sp }, { role: 'user', content: up }],
      { ...options, temperature: 0.1, max_tokens: 900 }
    );
    const text = result?.answer?.trim();
    if (!text) return { jdData: regexParsed, source: 'regex' };
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { jdData: regexParsed, source: 'regex' };
    const enriched = jdParser.mergeWithLLMAnalysis(regexParsed, JSON.parse(m[0]));
    if (_backendJdCache.size >= 100) _backendJdCache.delete(_backendJdCache.keys().next().value);
    _backendJdCache.set(key, { data: enriched, exp: Date.now() + _backendJdCacheTtl });
    return { jdData: enriched, source: 'llm', provider: result.provider };
  } catch (err) {
    if (options.signal?.aborted) throw err;
    console.warn('[backend] JD LLM enrichment failed, using regex fallback:', err.message);
    return { jdData: regexParsed, source: 'regex' };
  }
}

app.post('/api/cv/analyze', async (req, res) => {
  try {
    const { cvText, jobTitle = '', company = '', jobDescription, confirmedSkills = [] } = req.body || {};

    if (!cvText || cvText.length < 100) {
      return res.status(400).json({ error: 'cvText must be at least 100 characters' });
    }
    if (!jobDescription || jobDescription.length < 50) {
      return res.status(400).json({ error: 'jobDescription must be at least 50 characters' });
    }
    if (typeof cvText !== 'string' || cvText.length > MAX_CV_TEXT ||
        typeof jobDescription !== 'string' || jobDescription.length > MAX_JD_TEXT) {
      return res.status(413).json({ error: 'CV or job description is too large' });
    }

    const jdParser = new JDParser();
    const [cvData, jdDataRegex] = await Promise.all([
      Promise.resolve(new CVParser().parse(cvText)),
      Promise.resolve(jdParser.parse(jobDescription, jobTitle, company)),
    ]);
    const { jdData, source: jdAnalysisSource, provider } =
      await _backendEnrichJd(jdParser, jdDataRegex, jobDescription, { signal: req.requestAbort.signal, deadlineAt: req.deadlineAt });

    const tailor = new CVTailor();
    const matchMap = tailor.buildMatchMap(cvData, jdData, confirmedSkills);

    res.json({
      matchReport: tailor.buildMatchSummary(matchMap),
      jobTitle: jdData.jobTitle,
      company: jdData.company,
      jdAnalysisSource,
      provider: provider || null,
    });
  } catch (error) {
    console.error('CV analyze error:', error);
    res.status(500).json({ error: 'Failed to analyze CV match', ...(process.env.NODE_ENV === 'development' ? { details: error.message } : {}) });
  }
});

/**
 * CV Tailoring endpoint
 */
app.post('/api/cv/tailor', async (req, res) => {
  try {
    const { cvText, jobTitle = '', company = '', jobDescription, confirmedSkills = [] } = req.body || {};

    if (!cvText || cvText.length < 100) {
      return res.status(400).json({ error: 'cvText must be at least 100 characters' });
    }
    if (!jobDescription || jobDescription.length < 50) {
      return res.status(400).json({ error: 'jobDescription must be at least 50 characters' });
    }
    if (typeof cvText !== 'string' || cvText.length > MAX_CV_TEXT ||
        typeof jobDescription !== 'string' || jobDescription.length > MAX_JD_TEXT) {
      return res.status(413).json({ error: 'CV or job description is too large' });
    }

    const jdParser = new JDParser();
    const [cvData, jdDataRegex] = await Promise.all([
      Promise.resolve(new CVParser().parse(cvText)),
      Promise.resolve(jdParser.parse(jobDescription, jobTitle, company)),
    ]);
    const { jdData, source: jdAnalysisSource } =
      await _backendEnrichJd(jdParser, jdDataRegex, jobDescription, { signal: req.requestAbort.signal, deadlineAt: req.deadlineAt });

    const tailor = new CVTailor();
    const matchMap = tailor.buildMatchMap(cvData, jdData, confirmedSkills);

    // Structured path (docs/structured-cv-generation.md), mirroring the
    // production route in render-proxy/server.js: model returns only mutable
    // JSON content against a locked skeleton; falls back to the legacy text
    // path when the output is unsalvageable.
    const structuredEnabled = !/^false$/i.test(process.env.STRUCTURED_CV_GENERATION || 'true');
    let tailoredCvText = '';
    let structuredCv = null;
    const generationMode = 'structured';
    let auditSkipped = false;
    let tailorProvider = null;

    if (!structuredEnabled) {
      return res.status(503).json({ error: 'Structured CV generation is disabled. DraftApply will not generate an ungrounded free-text CV.', code: 'structured_cv_generation_required' });
    }
    if (!Array.isArray(cvData.experience) || cvData.experience.length === 0) {
      return res.status(422).json({ error: 'No work-experience roles could be parsed from this CV. Review the CV formatting and try again.', code: 'cv_experience_parse_failed' });
    }
    {
      try {
        const structuredPrompt = tailor.buildStructuredTailoringPrompt(cvData, jdData, matchMap, { confirmedSkills });
        const structuredResult = await generateWithFallback(FALLBACK_CHAIN, [
          { role: 'system', content: structuredPrompt.systemPrompt },
          { role: 'user',   content: structuredPrompt.userPrompt   },
        ], { temperature: structuredPrompt.temperature, max_tokens: 2500, signal: req.requestAbort.signal, deadlineAt: req.deadlineAt });
        tailorProvider = structuredResult.provider;
        let content = tailor.validateStructuredContent(
          tailor.parseStructuredContent(structuredResult.answer),
          structuredPrompt.skeleton,
          { matchMap, confirmedSkills, cvData }
        );
        if (content) {
          auditSkipped = true;
          try {
            const auditPrompt = tailor.buildStructuredAuditPrompt(structuredPrompt.skeleton, content, matchMap);
            const auditResult = await generateWithFallback(FALLBACK_CHAIN, [
              { role: 'system', content: auditPrompt.systemPrompt },
              { role: 'user',   content: auditPrompt.userPrompt   },
            ], { temperature: auditPrompt.temperature, max_tokens: 2500, signal: req.requestAbort.signal, deadlineAt: req.deadlineAt });
            const audited = tailor.validateStructuredContent(
              tailor.parseStructuredContent(auditResult.answer),
              structuredPrompt.skeleton,
              { matchMap, confirmedSkills, cvData }
            );
            if (audited) {
              content = audited;
              auditSkipped = false;
              tailorProvider = auditResult.provider;
            }
          } catch (auditError) {
            if (req.requestAbort.signal.aborted) throw auditError;
            console.warn('[Structured audit] skipped:', auditError.message);
          }
          structuredCv = { skeleton: structuredPrompt.skeleton, content };
          tailoredCvText = tailor.renderTailoredCV(structuredPrompt.skeleton, content);
        } else {
          return res.status(502).json({ error: 'The provider did not return a grounded structured CV. Please try again.', code: 'structured_cv_output_invalid' });
        }
      } catch (e) {
        console.warn('[Structured generation] failed:', e.message);
        return res.status(502).json({ error: 'The provider did not return a grounded structured CV. Please try again.', code: 'structured_cv_output_invalid' });
      }
    }

    const warnings        = [
      ...tailor.validateTailoredCV(cvData, tailoredCvText),
      ...tailor.validateTailoringQuality(cvData, jdData, matchMap, tailoredCvText, confirmedSkills),
    ];
    const changedSections = tailor.detectChangedSections(cvText, tailoredCvText);
    const matchReport     = tailor.buildMatchSummary(matchMap);
    const recruiterReview = tailor.buildRecruiterReview(
      cvData,
      jdData,
      matchMap,
      tailoredCvText,
      warnings,
      confirmedSkills
    );

    const { missingKeywords: atsKeywordGaps, coverage: atsKeywordCoverage } =
      tailor.checkAtsKeywordCoverage(tailoredCvText, jdData);

    res.json({ tailoredCvText, structuredCv, generationMode, provider: tailorProvider, matchReport, recruiterReview, warnings, changedSections, auditSkipped, jdAnalysisSource, atsKeywordGaps, atsKeywordCoverage });
  } catch (error) {
    console.error('CV tailor error:', error);
    res.status(500).json({ error: 'Failed to tailor CV', ...(process.env.NODE_ENV === 'development' ? { details: error.message } : {}) });
  }
});

// Serve frontend + shared modules (works in dev too)
const FRONTEND_DIR = join(__dirname, '../frontend');
const SHARED_DIR = join(__dirname, '../shared');

app.use('/shared', express.static(SHARED_DIR));
app.use(express.static(FRONTEND_DIR));

// SPA fallback for non-API routes
app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
  res.sendFile(join(FRONTEND_DIR, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Invalid upload' });
  }
  res.status(500).json({ error: 'Internal server error', ...(process.env.NODE_ENV === 'development' ? { details: err.message } : {}) });
});

app.listen(PORT, HOST, () => {
  console.log(`\nDraftApply local web app running on http://${HOST}:${PORT}`);
  console.log(`\nUsing: ${PROVIDER_CONFIG.name} (${PROVIDER_CONFIG.model})`);
  console.log(`Type: ${PROVIDERS[PROVIDER_NAME].type === 'local' ? 'Local (no API key)' : 'Cloud'}`);
  console.log(`\nAPI endpoints:`);
  console.log(`  GET  /api/health      - Health check`);
  console.log(`  GET  /api/providers   - List available providers`);
  console.log(`  GET  /api/llm-status  - Check LLM availability`);
  console.log(`  POST /api/cv/upload   - Upload CV file`);
  console.log(`  POST /api/generate    - Generate answer`);
});

export default app;
