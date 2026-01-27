/**
 * DraftApply Backend API Server
 * 
 * Supports multiple FREE LLM providers:
 * 
 * LOCAL (no API key, fully private):
 * - Ollama (default)
 * - LM Studio
 * - LocalAI
 * 
 * CLOUD (free tiers):
 * - Groq (recommended - fast & generous)
 * - Google Gemini
 * - Mistral
 * - Together AI
 * - OpenAI (paid)
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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Get current provider configuration
const PROVIDER_NAME = process.env.LLM_PROVIDER || 'ollama';
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
    const { mimetype, buffer } = req.file;

    switch (mimetype) {
      case 'application/pdf':
        const pdfData = await pdfParse(buffer);
        text = pdfData.text;
        break;

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        const docxResult = await mammoth.extractRawText({ buffer });
        text = docxResult.value;
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
      filename: req.file.originalname,
      size: req.file.size
    });

  } catch (error) {
    console.error('CV upload error:', error);
    res.status(500).json({ error: 'Failed to process CV file' });
  }
});

/**
 * Answer Generation endpoint
 */
app.post('/api/generate', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, temperature, stream: useStream } = req.body;

    if (!systemPrompt || !userPrompt) {
      return res.status(400).json({ error: 'Missing prompt data' });
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const options = { temperature: temperature || 0.7 };

    if (useStream) {
      // Streaming doesn't support fallback yet - uses primary provider
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      await stream(PROVIDER_NAME, PROVIDER_CONFIG, messages, options, res);
    } else {
      // Use fallback chain for non-streaming requests
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
      hint: 'Check that at least one LLM provider is running (Ollama, or set GROQ_API_KEY/GEMINI_API_KEY)'
    });
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
  console.log(`  GET  /api/health     - Health check`);
  console.log(`  GET  /api/providers  - List available providers`);
  console.log(`  GET  /api/llm-status - Check LLM availability`);
  console.log(`  POST /api/cv/upload  - Upload CV file`);
  console.log(`  POST /api/generate   - Generate answer`);
});

export default app;
