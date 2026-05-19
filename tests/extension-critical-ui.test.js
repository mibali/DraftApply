import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const contentJs = fs.readFileSync(new URL('../extension-ready/content.js', import.meta.url), 'utf8');
const pageExtractorJs = fs.readFileSync(new URL('../extension-ready/page-extractor.js', import.meta.url), 'utf8');

describe('extension critical modal behavior', () => {
  it('does not block modal button target handlers with capture-phase propagation stops', () => {
    expect(contentJs).toContain("modal.querySelector('#da-btn-insert').onclick = () => this.insertAnswer()");
    expect(contentJs).toContain("modal.querySelector('#da-jd-confirm').onclick = () => this._confirmJdPaste()");
    expect(contentJs).not.toContain("modalContent.addEventListener(eventName, stopPageEvent, true)");
    expect(contentJs).not.toContain("modal.addEventListener('focusin', stopPageEvent, true)");
    expect(contentJs).not.toContain("modal.addEventListener('focusout', stopPageEvent, true)");
  });

  it('promotes visible generic job posting text to heuristic context', () => {
    expect(pageExtractorJs).toContain('isLikelyJobPostingText');
    expect(pageExtractorJs).toContain("contextQuality: this.isLikelyJobPostingText(capped) ? 'heuristic' : 'fullpage'");
    expect(pageExtractorJs).toContain('this role requires');
    expect(pageExtractorJs).toContain('your responsibilities');
  });

  it('sends classified page context to answer generation when available', () => {
    expect(pageExtractorJs).toContain('classifyContextSections');
    expect(pageExtractorJs).toContain('sectionedJobContext');
    expect(contentJs).toContain('return ctx.sectionedJobContext || ctx.jobDescription || undefined');
    expect(contentJs).toContain('this.pageContext.sectionedJobContext = this.pageExtractor.buildSectionedContextText');
  });
});
