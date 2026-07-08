import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const contentJs = fs.readFileSync(new URL('../extension-ready/content.js', import.meta.url), 'utf8');
const contentCss = fs.readFileSync(new URL('../extension-ready/content.css', import.meta.url), 'utf8');
const pageExtractorJs = fs.readFileSync(new URL('../extension-ready/page-extractor.js', import.meta.url), 'utf8');
const popupHtml = fs.readFileSync(new URL('../extension-ready/popup.html', import.meta.url), 'utf8');
const popupJs = fs.readFileSync(new URL('../extension-ready/popup.js', import.meta.url), 'utf8');
const backgroundJs = fs.readFileSync(new URL('../extension-ready/background.js', import.meta.url), 'utf8');

describe('extension critical modal behavior', () => {
  it('does not block modal button target handlers with capture-phase propagation stops', () => {
    expect(contentJs).toContain("bindModalAction('#da-btn-insert', (event) => this.insertAnswer(event))");
    expect(contentJs).toContain("bindModalAction('#da-jd-confirm', () => this._confirmJdPaste())");
    expect(contentJs).not.toContain("modalContent.addEventListener(eventName, stopPageEvent, true)");
    expect(contentJs).not.toContain("modal.addEventListener('focusin', stopPageEvent, true)");
    expect(contentJs).not.toContain("modal.addEventListener('focusout', stopPageEvent, true)");
  });

  it('keeps the modal open when a page rejects an insert instead of failing silently', () => {
    expect(contentJs).toContain('async writeAnswerToTarget(target, answerToInsert)');
    expect(contentJs).toContain('Some controlled React/Vue inputs briefly roll back after the first event');
    expect(contentJs).toContain('const inserted = await this.writeAnswerToTarget(target, answerToInsert)');
    expect(contentJs).toContain('The page rejected the insert. The answer is still here to copy or try again.');
    expect(contentJs).toContain('Could not insert into the embedded form. The answer is still here to copy.');
  });

  it('does not let stale iframe targets or overlapping requests leak across modal sessions', () => {
    expect(contentJs).toContain('this._iframeSourceFrameId = null;');
    expect(contentJs).toContain('if (this.currentRequestId) {');
    expect(contentJs).toContain('await this.cancelGeneration({ silent: true });');
    expect(contentJs).toContain('clearSessionForNavigation()');
    expect(contentJs).toContain('this.clearAnswerCaches();');
  });

  it('uses target-scoped contenteditable insertion and keeps copy non-destructive', () => {
    expect(contentJs).toContain('setContentEditableValue(target, value)');
    expect(contentJs).toContain('range.selectNodeContents(target)');
    expect(contentJs).not.toContain("document.execCommand('selectAll'");
    expect(contentJs).not.toContain('this.hideModal();\n      this.showNotification(\'Copied to clipboard!');
  });

  it('surfaces iframe relay failures instead of silently doing nothing', () => {
    expect(contentJs).toContain("type: 'RELAY_GENERATE_TO_PARENT'");
    expect(contentJs).toContain('Could not open DraftApply from this embedded form');
    expect(backgroundJs).toContain('Relay to main frame failed');
    expect(backgroundJs).toContain('sendResponse({ success: false, error: chrome.runtime.lastError.message })');
  });

  it('does not bypass answer quality checks for prefetches', () => {
    expect(contentJs).not.toContain('skipEvaluation: true');
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
    expect(popupJs).toContain('buildTailorSourceMetadata');
    expect(popupJs).toContain('sourceUrl: activeTabSnapshot.url');
    expect(popupJs).toContain('sourceTabId: activeTabSnapshot.tabId');
    expect(contentJs).toContain("GET_TAILOR_DRAFT_FOR_PAGE");
    expect(contentJs).not.toContain("chrome.storage.local.get('tailorCvDraft')");
    expect(backgroundJs).toContain('function isTailorDraftRelevant');
    expect(backgroundJs).toContain('hasSameJobIdentity');
    expect(backgroundJs).toContain('currentUrl && sourceUrl && currentUrl === sourceUrl');
    expect(backgroundJs).toContain('movedToDifferentHost');
    expect(backgroundJs).toContain('Same host alone is deliberately not enough');
    expect(backgroundJs).toContain('Legacy drafts did not store source metadata');
  });

  it('scopes restored Tailor CV jobs to the active job page', () => {
    expect(popupJs).toContain('GET_TAILOR_JOB_FOR_ACTIVE_PAGE');
    expect(popupJs).toContain('buildTailorSourceMetadata');
    expect(popupJs).toContain('source: buildTailorSourceMetadata');
    expect(backgroundJs).toContain('function isTailorJobRelevant');
    expect(backgroundJs).toContain('isTailorDraftRelevant(job, context)');
    expect(backgroundJs).toContain("message.type === 'GET_TAILOR_JOB_FOR_ACTIVE_PAGE'");
    expect(backgroundJs).toContain('await chrome.storage.local.remove(TAILOR_JOB_KEY)');
  });

  it('preserves specific proxy/provider error messages instead of replacing all 429s', () => {
    expect(backgroundJs).toContain('async function responseErrorMessage');
    expect(backgroundJs).toContain('if (body?.error) return body.error');
    expect(backgroundJs).toContain('if (response.status === 429) return rateLimitError(response)');
    expect(backgroundJs).toContain("response.headers.get('Retry-After')");
    expect(backgroundJs).toContain('function formatRetryDelay');
    expect(backgroundJs).toContain('you can try again in ${formatRetryDelay');
    expect(backgroundJs).not.toContain('if (response.status === 429) throw new Error(rateLimitError(response))');
  });

  it('buffers SSE stream fragments across network chunk boundaries', () => {
    expect(backgroundJs).toContain("let buffer = ''");
    expect(backgroundJs).toContain("buffer += decoder.decode(value, { stream: true })");
    expect(backgroundJs).toContain("const lines = buffer.split('\\n')");
    expect(backgroundJs).toContain('buffer = lines.pop()');
    expect(backgroundJs).toContain('json.choices?.[0]?.delta?.content');
  });

  it('shows the exact OpenRouter model when answer generation falls back from Groq', () => {
    expect(backgroundJs).toContain("response.headers.get('X-DraftApply-Model')");
    expect(backgroundJs).toContain("type: 'STREAM_META'");
    expect(contentJs).toContain("if (message.type === 'STREAM_META')");
    expect(contentJs).toContain('const model = result.model ? `: ${result.model}` :');
    expect(contentJs).toContain('DraftApply used OpenRouter fallback${model}.');
  });

  it('renders a compact model badge for generated answer output', () => {
    expect(contentJs).toContain('id="da-model-badge"');
    expect(contentJs).toContain('renderModelBadge');
    expect(contentJs).toContain('this.shortModelName(model)');
    expect(contentJs).toContain('qualityModeReason');
    expect(contentCss).toContain('.da-model-badge');
    expect(contentCss).toContain('.da-model-badge-fallback');
  });

  it('accepts both legacy unsupportedRequirements and API-contract missingSkills in Tailor CV reports', () => {
    expect(popupJs).toContain('function normalizeMissingSkills');
    expect(popupJs).toContain('matchReport.unsupportedRequirements');
    expect(popupJs).toContain('matchReport.missingSkills');
    expect(popupJs).toContain("item?.skill || item?.requirement || item?.name");
  });

  it('passes through workflow metadata from streamed proxy responses without changing modal behavior', () => {
    expect(backgroundJs).toContain("response.headers.get('X-DraftApply-Workflow')");
    expect(backgroundJs).toContain("response.headers.get('X-DraftApply-Agent-Chain')");
    expect(backgroundJs).toContain('json.draftapplyMeta');
    expect(backgroundJs).toContain('workflow,');
    expect(backgroundJs).toContain('agentChain');
  });

  it('renders stage-3 architecture insights only when proxy metadata is available', () => {
    expect(contentJs).toContain('id="da-agent-insights"');
    expect(contentJs).toContain('renderAgentInsights');
    expect(contentJs).toContain('CV evidence used');
    expect(popupHtml).toContain('id="tailor-agent-insights"');
    expect(popupJs).toContain('renderTailorAgentInsights');
    expect(popupJs).toContain('Supported keywords');
    expect(popupJs).toContain('retrieval.status');
  });
});
