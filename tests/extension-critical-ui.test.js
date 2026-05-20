import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const contentJs = fs.readFileSync(new URL('../extension-ready/content.js', import.meta.url), 'utf8');
const pageExtractorJs = fs.readFileSync(new URL('../extension-ready/page-extractor.js', import.meta.url), 'utf8');
const popupJs = fs.readFileSync(new URL('../extension-ready/popup.js', import.meta.url), 'utf8');
const backgroundJs = fs.readFileSync(new URL('../extension-ready/background.js', import.meta.url), 'utf8');

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
    expect(contentJs).toContain('nextContext.sectionedJobContext = this.pageExtractor.buildSectionedContextText');
  });

  it('keeps answer prefetch caches scoped to the active job context', () => {
    expect(contentJs).toContain('answerCacheKey(question');
    expect(contentJs).toContain('cached.question === question && cached.cacheKey === cacheKey');
    expect(contentJs).toContain('this._prefetchByQuestion.get(cacheKey)');
    expect(contentJs).toContain('this._prefetchByQuestion.set(cacheKey, cacheEntry.answer)');
    expect(contentJs).toContain("cacheEntry.status = 'stale'");
  });

  it('refreshes page context on SPA navigation and DOM mutations', () => {
    expect(contentJs).toContain('installSpaNavigationWatchers');
    expect(contentJs).toContain("history[method] = function patchedHistoryMethod");
    expect(contentJs).toContain("window.addEventListener('draftapply:navigation'");
    expect(contentJs).toContain("this.scheduleContextRefresh('mutation'");
  });

  it('scopes Tailor JD fallback to the active job page instead of using a global stale draft', () => {
    expect(popupJs).toContain("GET_TAILOR_DRAFT_FOR_ACTIVE_PAGE");
    expect(popupJs).toContain('draft.sourceUrl');
    expect(popupJs).toContain('draft.sourceTabId');
    expect(contentJs).toContain("GET_TAILOR_DRAFT_FOR_PAGE");
    expect(contentJs).not.toContain("chrome.storage.local.get('tailorCvDraft')");
    expect(backgroundJs).toContain('function isTailorDraftRelevant');
    expect(backgroundJs).toContain('hasSameJobIdentity');
    expect(backgroundJs).toContain('Legacy drafts did not store source metadata');
  });
});
