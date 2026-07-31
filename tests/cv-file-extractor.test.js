import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'fs/promises';
import { createCanvas } from '../render-proxy/node_modules/@napi-rs/canvas/index.js';
import { extractCvFile, CvExtractionError, ocrPdf } from '../render-proxy/cv-file-extractor.js';

const PDF = 'application/pdf';

function imagePdf(lines) {
  const canvas = createCanvas(1000, 600);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'black';
  context.font = 'bold 52px sans-serif';
  lines.forEach((line, index) => context.fillText(line, 60, 100 + index * 90));
  const jpeg = canvas.toBuffer('image/jpeg');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1000 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
    '<< /Length 31 >>\nstream\nq 500 0 0 300 0 0 cm /Im0 Do Q\nendstream',
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref = length;
  chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(chunks);
}

describe('CV file extraction contract', () => {
  it('keeps selectable PDF text on the fast path', async () => {
    const ocr = vi.fn();
    const result = await extractCvFile({ buffer: Buffer.from('%PDF-placeholder'), mimetype: PDF, filename: 'cv.pdf' }, {
      parsePdf: async () => ({ text: 'Jane Example\nSenior Engineer with extensive systems experience', pageCount: 1, linkAnnotations: [] }), ocr,
    });
    expect(result.extractionMethod).toBe('pdf-text');
    expect(ocr).not.toHaveBeenCalled();
  });

  it('does not OCR a PDF that failed parsing', async () => {
    const ocr = vi.fn();
    await expect(extractCvFile({ buffer: Buffer.from('%PDF-broken'), mimetype: PDF, filename: 'bad.pdf' }, {
      parsePdf: async () => { throw new CvExtractionError('pdf_unreadable', 'bad'); }, ocr,
    })).rejects.toMatchObject({ code: 'pdf_unreadable' });
    expect(ocr).not.toHaveBeenCalled();
  });

  it('bounds parsing before OCR and observes request cancellation', async () => {
    const never = () => new Promise(() => {});
    await expect(extractCvFile({ buffer: Buffer.from('%PDF-slow'), mimetype: PDF, filename: 'slow.pdf' }, {
      parsePdf: never, timeoutMs: 5,
    })).rejects.toMatchObject({ code: 'cv_parse_timeout' });

    const controller = new AbortController();
    const extraction = extractCvFile({ buffer: Buffer.from('%PDF-cancel'), mimetype: PDF, filename: 'cancel.pdf' }, {
      parsePdf: never, signal: controller.signal, timeoutMs: 1000,
    });
    controller.abort();
    await expect(extraction).rejects.toMatchObject({ code: 'cv_parse_cancelled' });
  });

  it('rejects legacy DOC locally and normalizes TXT', async () => {
    await expect(extractCvFile({ buffer: Buffer.from('legacy'), mimetype: 'application/msword', filename: 'cv.doc' }))
      .rejects.toMatchObject({ code: 'legacy_doc_unsupported' });
    await expect(extractCvFile({ buffer: Buffer.from('Jane\r\n\r\n\r\nEngineer'), mimetype: 'text/plain', filename: 'cv.txt' }))
      .resolves.toMatchObject({ text: 'Jane\n\nEngineer', extractionMethod: 'txt' });
  });

  it('keeps normal DOCX extraction working', async () => {
    const buffer = await readFile(new URL('../render-proxy/node_modules/mammoth/test/test-data/single-paragraph.docx', import.meta.url));
    const result = await extractCvFile({
      buffer, mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'cv.docx',
    });
    expect(result.extractionMethod).toBe('docx');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('accepts generic MIME only when PDF/DOCX extension and magic agree', async () => {
    await expect(extractCvFile({
      buffer: Buffer.from('%PDF-placeholder'), mimetype: 'application/octet-stream', filename: 'cv.pdf',
    }, { parsePdf: async () => ({ text: 'Jane Example senior engineer with substantial experience', pageCount: 1, linkAnnotations: [] }) }))
      .resolves.toMatchObject({ extractionMethod: 'pdf-text' });

    const docx = await readFile(new URL('../render-proxy/node_modules/mammoth/test/test-data/single-paragraph.docx', import.meta.url));
    await expect(extractCvFile({ buffer: docx, mimetype: '', filename: 'cv.docx' }))
      .resolves.toMatchObject({ extractionMethod: 'docx' });
    await expect(extractCvFile({ buffer: Buffer.from('not a pdf'), mimetype: '', filename: 'cv.pdf' }))
      .rejects.toMatchObject({ code: 'invalid_cv_file' });
    await expect(extractCvFile({ buffer: Buffer.from('%PDF-fake'), mimetype: 'application/octet-stream', filename: 'cv.docx' }))
      .rejects.toMatchObject({ code: 'invalid_cv_file' });
  });

  it('rejects declared MIME, filename, and magic mismatches', async () => {
    await expect(extractCvFile({ buffer: Buffer.from('%PDF-fake'), mimetype: PDF, filename: 'cv.docx' }))
      .rejects.toMatchObject({ code: 'invalid_cv_file' });
  });

  it('terminates the OCR worker and PDF when the wall-time bound expires', async () => {
    const terminate = vi.fn(async () => {});
    const destroy = vi.fn(async () => {});
    const pdf = {
      numPages: 1,
      destroy,
      getPage: async () => ({
        getViewport: ({ scale }) => ({ width: 100 * scale, height: 100 * scale }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: vi.fn(),
      }),
    };
    const worker = { terminate, recognize: () => new Promise(() => {}) };
    await expect(ocrPdf({
      buffer: Buffer.from('%PDF-'), pageCount: 1, limits: { maxPages: 5, maxDimension: 100, scale: 1, timeoutMs: 5 },
      runtime: { pdf, createWorker: async () => worker },
    })).rejects.toMatchObject({ code: 'ocr_timeout' });
    expect(terminate).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('runs real local OCR on a one-page scanned PDF', async () => {
    const started = Date.now();
    const result = await extractCvFile({ buffer: imagePdf(['JANE EXAMPLE', 'EXPERIENCE', 'SENIOR ENGINEER']), mimetype: PDF, filename: 'scan.pdf' });
    expect(result.text).toMatch(/JANE EXAMPLE/i);
    expect(result.text).toMatch(/EXPERIENCE/i);
    expect(result).toMatchObject({ extractionMethod: 'ocr', pageCount: 1, ocrPageCount: 1 });
    expect(Date.now() - started).toBeLessThan(45_000);
  }, 50_000);
});
