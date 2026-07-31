import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { createWorker } from 'tesseract.js';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { extractAnnotationLabel, extractLinkAnnotationsFromHtml, linkLabelFromUrl } from './link-annotations.js';

export const CV_MIME_TYPES = Object.freeze({
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  TXT: 'text/plain',
});

export const OCR_LIMITS = Object.freeze({ maxPages: 5, maxDimension: 2400, scale: 2, timeoutMs: 45_000 });

export class CvExtractionError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'CvExtractionError';
    this.code = code;
    this.status = status;
  }
}

function normalize(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function meaningful(text) {
  return normalize(text).replace(/[^\p{L}\p{N}]/gu, '').length >= 20;
}

async function parsePdf(buffer) {
  const collectedLinks = [];
  let result;
  try {
    result = await pdfParse(buffer, { pagerender: async page => {
      const content = await page.getTextContent();
      try {
        for (const annotation of await page.getAnnotations()) {
          const url = annotation.url || annotation.unsafeUrl;
          if (url) collectedLinks.push({ url, label: extractAnnotationLabel(annotation.rect, content.items) });
        }
      } catch { /* Link annotations are optional. */ }
      let lastY;
      return content.items.map(item => {
        const prefix = lastY === undefined || lastY === item.transform[5] ? '' : '\n';
        lastY = item.transform[5];
        return prefix + item.str;
      }).join('');
    }});
  } catch {
    try {
      result = await pdfParse(buffer);
    } catch {
      throw new CvExtractionError('pdf_unreadable', 'This PDF could not be read. It may be corrupted or password-protected. Export a new PDF or DOCX, or paste your CV text.');
    }
  }
  const byUrl = new Map();
  for (const { url, label } of collectedLinks) if (!byUrl.has(url)) byUrl.set(url, label);
  return {
    text: result.text,
    pageCount: result.numpages,
    linkAnnotations: [...byUrl].map(([url, label]) => ({ text: label || linkLabelFromUrl(url), url })),
  };
}

export async function ocrPdf({ buffer, pageCount, signal, limits = OCR_LIMITS, runtime = {} }) {
  if (pageCount > limits.maxPages) {
    throw new CvExtractionError('ocr_page_limit', `This scanned PDF has ${pageCount} pages; OCR is limited to ${limits.maxPages}. Upload a text-based PDF/DOCX or paste your CV text.`);
  }
  if (signal?.aborted) throw new CvExtractionError('ocr_cancelled', 'OCR was cancelled. Please try again.');
  globalThis.DOMMatrix ||= DOMMatrix;
  globalThis.ImageData ||= ImageData;
  globalThis.Path2D ||= Path2D;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new CvExtractionError('ocr_timeout', 'OCR took too long. Try a text-based PDF/DOCX, split the file, or paste your CV text.')), limits.timeoutMs); });
  let cancelListener;
  const cancelled = new Promise((_, reject) => {
    cancelListener = () => reject(new CvExtractionError('ocr_cancelled', 'OCR was cancelled. Please try again.'));
    signal?.addEventListener('abort', cancelListener, { once: true });
  });
  const bounded = promise => Promise.race([promise, timeout, cancelled]);
  const langPath = join(dirname(fileURLToPath(import.meta.url)), 'node_modules/@tesseract.js-data/eng/4.0.0_best_int');
  let worker;
  let pdf;
  let loadingTask;
  let finished = false;
  const cleanupBound = task => Promise.race([Promise.resolve(task).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
  try {
    const pdfjs = runtime.pdfjs || await bounded(import('pdfjs-dist/legacy/build/pdf.mjs'));
    loadingTask = runtime.pdf ? null : pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true });
    pdf = runtime.pdf || await bounded(loadingTask.promise);
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > limits.maxPages) {
      throw new CvExtractionError('ocr_page_limit', `OCR is limited to ${limits.maxPages} pages. Upload a text-based PDF/DOCX or paste your CV text.`);
    }
    const workerPromise = (runtime.createWorker || createWorker)('eng', 1, { langPath, gzip: true, cacheMethod: 'none' });
    workerPromise.then(created => {
      worker = created;
      if (finished) cleanupBound(created.terminate());
    }).catch(() => {});
    worker = await bounded(workerPromise);
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      if (signal?.aborted) throw new CvExtractionError('ocr_cancelled', 'OCR was cancelled. Please try again.');
      const page = await bounded(pdf.getPage(number));
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(limits.scale, limits.maxDimension / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await bounded(page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise);
        const result = await bounded(worker.recognize(canvas.toBuffer('image/png')));
        pages.push(result.data.text);
      } finally {
        page.cleanup();
      }
    }
    return normalize(pages.join('\n\n'));
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelListener);
    await cleanupBound(worker?.terminate());
    await cleanupBound(pdf?.destroy() || loadingTask?.destroy());
  }
}

async function withinExtractionDeadline(promise, { signal, deadlineAt }) {
  if (signal?.aborted) throw new CvExtractionError('cv_parse_cancelled', 'File extraction was cancelled. Please try again.');
  const remaining = Math.max(1, deadlineAt - Date.now());
  let timer;
  let abort;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CvExtractionError('cv_parse_timeout', 'File extraction took too long. Try a smaller text-based PDF/DOCX or paste your CV text.')), remaining);
  });
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new CvExtractionError('cv_parse_cancelled', 'File extraction was cancelled. Please try again.'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout, cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function extractCvFile(file, options = {}) {
  const { buffer, mimetype, filename = '' } = file || {};
  const maxChars = options.maxChars ?? 60_000;
  const deadlineAt = Date.now() + (options.timeoutMs ?? OCR_LIMITS.timeoutMs);
  if (!Buffer.isBuffer(buffer)) throw new CvExtractionError('invalid_cv_file', 'No valid CV file was provided.', 400);
  if (/\.doc$/i.test(filename) || mimetype === 'application/msword') {
    throw new CvExtractionError('legacy_doc_unsupported', 'Legacy .doc files are not supported. Re-save as .docx or PDF, or paste your CV text.', 400);
  }
  const pdfMagic = buffer.subarray(0, 5).toString() === '%PDF-';
  const zipMagic = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const extension = filename.toLowerCase().match(/\.(pdf|docx|txt)$/)?.[1] || '';
  const genericMime = !mimetype || mimetype === 'application/octet-stream';
  const inferredMime = genericMime && extension === 'pdf' && pdfMagic ? CV_MIME_TYPES.PDF
    : genericMime && extension === 'docx' && zipMagic ? CV_MIME_TYPES.DOCX
      : mimetype;
  const extensionMatches = (extension === 'pdf' && inferredMime === CV_MIME_TYPES.PDF && pdfMagic)
    || (extension === 'docx' && inferredMime === CV_MIME_TYPES.DOCX && zipMagic)
    || (extension === 'txt' && inferredMime === CV_MIME_TYPES.TXT);
  if (!extensionMatches || !Object.values(CV_MIME_TYPES).includes(inferredMime)) {
    throw new CvExtractionError('invalid_cv_file', 'Unsupported or invalid file. Upload a PDF, DOCX, or TXT file.', 400);
  }
  const detectedMime = inferredMime;
  let text = '';
  let linkAnnotations = [];
  let pageCount = 0;
  let ocrPageCount = 0;
  let extractionMethod = 'text';
  if (detectedMime === CV_MIME_TYPES.PDF) {
    const parsed = await withinExtractionDeadline((options.parsePdf || parsePdf)(buffer), { signal: options.signal, deadlineAt });
    ({ text, linkAnnotations, pageCount } = parsed);
    if (!meaningful(text)) {
      extractionMethod = 'ocr';
      const limits = options.ocrLimits || OCR_LIMITS;
      text = await withinExtractionDeadline((options.ocr || ocrPdf)({
        buffer, pageCount, signal: options.signal,
        limits: { ...limits, timeoutMs: Math.min(limits.timeoutMs, Math.max(1, deadlineAt - Date.now())) },
      }), { signal: options.signal, deadlineAt });
      ocrPageCount = pageCount;
    } else extractionMethod = 'pdf-text';
  } else if (detectedMime === CV_MIME_TYPES.DOCX) {
    try {
      const [raw, html] = await withinExtractionDeadline(
        Promise.all([mammoth.extractRawText({ buffer }), mammoth.convertToHtml({ buffer })]),
        { signal: options.signal, deadlineAt },
      );
      text = raw.value;
      linkAnnotations = extractLinkAnnotationsFromHtml(html.value);
      extractionMethod = 'docx';
    } catch (error) {
      if (error instanceof CvExtractionError) throw error;
      throw new CvExtractionError('docx_unreadable', 'This Word file could not be read. Re-save it as .docx or PDF, or paste your CV text.');
    }
  } else {
    text = buffer.toString('utf8');
    extractionMethod = 'txt';
  }
  text = normalize(text);
  if (!text) throw new CvExtractionError('no_cv_text', 'No text could be recovered. Try a clearer scan, a text-based PDF/DOCX, or paste your CV text.');
  if (text.length > maxChars) throw new CvExtractionError('cv_too_large_for_complete_context', 'Extracted CV text is too large.', 413);
  return { text, linkAnnotations, extractionMethod, pageCount, ocrPageCount };
}
