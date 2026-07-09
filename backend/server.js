/**
 * DraftApply Backend API Server
 * 
 * Supports multiple FREE LLM providers:
 * 
 * CLOUD (free tiers):
 * - Groq (default — fast & generous)
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

// Get current provider configuration — default is Groq
const PROVIDER_NAME = process.env.LLM_PROVIDER || 'groq';
const PROVIDER_CONFIG = getProviderConfig(PROVIDER_NAME, process.env);

// Build fallback chain for reliability
const FALLBACK_CHAIN = buildFallbackChain(process.env);
const USE_FALLBACK = process.env.USE_FALLBACK !== 'false'; // Enable by default

console.log(`LLM Provider: ${PROVIDER_CONFIG.name} (${PROVIDER_CONFIG.model})`);
if (USE_FALLBACK && FALLBACK_CHAIN.length > 1) {
  console.log(`Fallback chain: ${FALLBACK_CHAIN.map(p => p.name).join(' → ')}`);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
  const status = await checkProvider(PROVIDER_NAME, PROVIDER_CONFIG);
  
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
 * to use a user-supplied LLM. Falls back to server default (Groq) on failure.
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

    const options = { temperature: temperature || 0.7 };

    // Resolve user-supplied provider config (if provided and valid)
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

    if (useStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Try user's provider first, then fall back to server default
      if (userProviderName && userProviderConfig) {
        try {
          await stream(userProviderName, userProviderConfig, messages, options, res);
          return;
        } catch (e) {
          if (res.writableEnded) return; // already started streaming, can't recover
          console.warn(`[Stream] User provider ${userProviderName} failed:`, e.message);
        }
      }
      await stream(PROVIDER_NAME, PROVIDER_CONFIG, messages, options, res);
    } else {
      // Try user's provider first
      if (userProviderName && userProviderConfig) {
        try {
          const result = await generate(userProviderName, userProviderConfig, messages, options);
          return res.json({ ...result, provider: userProviderName });
        } catch (e) {
          console.warn(`[Generate] User provider ${userProviderName} failed, falling back:`, e.message);
        }
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
      details: error.message,
      hint: 'Check that GROQ_API_KEY is set, or configure a provider in the UI'
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
    if (normalizedText.length > 60000) {
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
    const options = { temperature: 0.1, max_tokens: 2000 };

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
      try {
        result = await generate(userProviderName, userProviderConfig, messages, options);
        result.provider = userProviderName;
      } catch (e) {
        console.warn(`[JD Extract] User provider ${userProviderName} failed, falling back:`, e.message);
      }
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

    res.json({ extractedText });
  } catch (error) {
    console.error('JD extract error:', error);
    res.status(500).json({ error: 'Failed to extract job description', details: error.message });
  }
});

/**
 * Direct text-based CV input
 */
app.post('/api/cv/text', (req, res) => {
  const { text } = req.body;
  
  if (!text || text.trim().length < 50) {
    return res.status(400).json({ error: 'CV text too short or missing' });
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
async function _backendEnrichJd(jdParser, regexParsed, jdText) {
  const key = _backendJdCacheKey(jdText);
  const hit = _backendJdCache.get(key);
  if (hit && Date.now() < hit.exp) return { jdData: hit.data, source: 'cache' };

  const { systemPrompt: sp, userPrompt: up } = jdParser.buildLLMAnalysisPrompt(jdText);
  try {
    const result = await generateWithFallback(FALLBACK_CHAIN,
      [{ role: 'system', content: sp }, { role: 'user', content: up }],
      { temperature: 0.1, max_tokens: 900 }
    );
    const text = result?.answer?.trim();
    if (!text) return { jdData: regexParsed, source: 'regex' };
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { jdData: regexParsed, source: 'regex' };
    const enriched = jdParser.mergeWithLLMAnalysis(regexParsed, JSON.parse(m[0]));
    if (_backendJdCache.size >= 100) _backendJdCache.delete(_backendJdCache.keys().next().value);
    _backendJdCache.set(key, { data: enriched, exp: Date.now() + _backendJdCacheTtl });
    return { jdData: enriched, source: 'llm' };
  } catch (err) {
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

    const jdParser = new JDParser();
    const [cvData, jdDataRegex] = await Promise.all([
      Promise.resolve(new CVParser().parse(cvText)),
      Promise.resolve(jdParser.parse(jobDescription, jobTitle, company)),
    ]);
    const { jdData, source: jdAnalysisSource } =
      await _backendEnrichJd(jdParser, jdDataRegex, jobDescription);

    const tailor = new CVTailor();
    const matchMap = tailor.buildMatchMap(cvData, jdData, confirmedSkills);

    res.json({
      matchReport: tailor.buildMatchSummary(matchMap),
      jobTitle: jdData.jobTitle,
      company: jdData.company,
      jdAnalysisSource,
    });
  } catch (error) {
    console.error('CV analyze error:', error);
    res.status(500).json({ error: 'Failed to analyze CV match', details: error.message });
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

    const jdParser = new JDParser();
    const [cvData, jdDataRegex] = await Promise.all([
      Promise.resolve(new CVParser().parse(cvText)),
      Promise.resolve(jdParser.parse(jobDescription, jobTitle, company)),
    ]);
    const { jdData, source: jdAnalysisSource } =
      await _backendEnrichJd(jdParser, jdDataRegex, jobDescription);

    const tailor = new CVTailor();
    const matchMap = tailor.buildMatchMap(cvData, jdData, confirmedSkills);

    const { systemPrompt, userPrompt } = tailor.buildTailoringPrompt(cvData, jdData, matchMap);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   }
    ];

    const result = await generateWithFallback(FALLBACK_CHAIN, messages, {
      temperature: 0.3,
      // Kept in sync with render-proxy/server.js's production tailor route -
      // CVs with many roles push the regenerated text close to the old 4000
      // token cap, risking a mid-sentence cutoff that drops trailing content.
      max_tokens: 6000
    });

    let tailoredCvText = tailor.finalizeTailoredCV(result.answer, {
      cvData,
      jdData,
      matchMap,
      confirmedSkills,
    });
    if (!tailoredCvText?.trim()) {
      return res.status(502).json({ error: 'No output from provider' });
    }

    let auditSkipped = false;
    try {
      const { systemPrompt: auditSystemPrompt, userPrompt: auditUserPrompt, temperature: auditTemperature } =
        tailor.buildTailoredCvAuditPrompt(cvData, jdData, matchMap, tailoredCvText, confirmedSkills);
      const auditResult = await generateWithFallback(FALLBACK_CHAIN, [
        { role: 'system', content: auditSystemPrompt },
        { role: 'user',   content: auditUserPrompt },
      ], { temperature: auditTemperature, max_tokens: 6500 });
      const auditedText = auditResult.answer;
      if (auditedText?.trim() && tailor.isValidCvOutput(auditedText)) {
        const finalizedAudit = tailor.finalizeTailoredCV(auditedText, {
          cvData,
          jdData,
          matchMap,
          confirmedSkills,
        });
        if (finalizedAudit?.trim()) tailoredCvText = finalizedAudit;
        else auditSkipped = true;
      } else {
        auditSkipped = true;
        if (auditedText?.trim()) {
          console.warn('[DraftApply] Audit output rejected: response does not look like a CV');
        }
      }
    } catch (e) {
      auditSkipped = true;
      console.warn('[Tailored CV audit] LLM verification failed, using deterministic cleanup only:', e.message);
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

    res.json({ tailoredCvText, matchReport, recruiterReview, warnings, changedSections, auditSkipped, jdAnalysisSource, atsKeywordGaps, atsKeywordCoverage });
  } catch (error) {
    console.error('CV tailor error:', error);
    res.status(500).json({ error: 'Failed to tailor CV', details: error.message });
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
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\nDraftApply server running on http://localhost:${PORT}`);
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
