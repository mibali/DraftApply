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
    expect(contentJs).toContain('this._prefetchByQuestion.set(cacheKey, cacheEntry.result)');
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

  it('clears transient Tailor state on extension reload without deleting saved CV data', () => {
    expect(backgroundJs).toContain('const TRANSIENT_TAILOR_STORAGE_KEYS');
    expect(backgroundJs).toContain("'tailorCvDraft'");
    expect(backgroundJs).toContain("'tailoredCvExport'");
    expect(backgroundJs).toContain('clearTransientTailorState();');
    expect(backgroundJs).toContain('chrome.runtime.onInstalled.addListener');
    expect(backgroundJs).toContain('chrome.runtime.onStartup.addListener');

    const keysStart = backgroundJs.indexOf('const TRANSIENT_TAILOR_STORAGE_KEYS');
    const keysEnd = backgroundJs.indexOf('];', keysStart);
    const keyBlock = backgroundJs.slice(keysStart, keysEnd);
    expect(keyBlock).not.toContain("'cvText'");
    expect(keyBlock).not.toContain("'installToken'");
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
    expect(backgroundJs).toContain('buffer.split(/\\r?\\n\\r?\\n/)');
    expect(backgroundJs).toContain('buffer += decoder.decode()');
    expect(backgroundJs).toContain('if (buffer.trim()) consumeEvent(buffer)');
    expect(backgroundJs).toContain("type: 'STREAM_FINAL'");
    expect(backgroundJs).toContain("type: 'STREAM_PROGRESS'");
    expect(backgroundJs).not.toContain("type: 'STREAM_CHUNK', requestId: effectiveRequestId");
  });

  it('gates only ungrounded model output, with the state shown as a badge instead of button labels', () => {
    expect(contentJs).toContain('id="da-btn-insert" disabled');
    expect(contentJs).toContain("if (message.type === 'STREAM_FINAL')");
    expect(contentJs).toContain('if (this.currentRequestId !== message.requestId) return');
    // Grounded and review-state answers insert directly; ungrounded output is
    // stopped at click time with a plain explanation.
    expect(contentJs).toContain("modelStatus !== 'pass' && modelStatus !== 'review'");
    expect(contentJs).toContain('could not verify from your CV');
    // No alarming persistent button states; validation lives in the badge.
    expect(contentJs).not.toContain('Review Required');
    expect(contentJs).not.toContain('Insertion Blocked');
    expect(contentJs).toContain('_renderVerifyBadge');
    expect(contentJs).toContain('Checked against your CV');
  });

  it('keeps provider fallback invisible to the user while metadata still flows for telemetry', () => {
    expect(backgroundJs).toContain("response.headers.get('X-DraftApply-Model')");
    expect(backgroundJs).toContain("type: 'STREAM_META'");
    expect(contentJs).toContain("if (message.type === 'STREAM_META')");
    // No provider/model names in any user-facing notification.
    expect(contentJs).not.toContain('OpenRouter fallback');
    expect(contentJs).not.toContain('Groq is busy');
  });

  it('keeps provider/model internals out of the modal header', () => {
    expect(contentJs).toContain('renderModelBadge');
    // The badge element stays for layout compatibility but is always hidden.
    expect(contentJs).not.toContain('this.shortModelName(model)');
    expect(contentJs).not.toContain("providerLabel: modelLabel");
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

  it('keeps supporting detail behind collapsed disclosures with no internal vocabulary', () => {
    expect(contentJs).toContain('id="da-agent-insights"');
    expect(contentJs).toContain('renderAgentInsights');
    expect(contentJs).toContain('<details class="da-agent-details">');
    expect(popupHtml).toContain('id="tailor-agent-insights"');
    expect(popupJs).toContain('renderTailorAgentInsights');
    expect(popupJs).toContain('agent-insights-details');
    // Internal vocabulary and duplicate lists stay out of the UI.
    for (const phrase of ['stages</', ' agents', 'retrieval active', 'Input grounding', 'held back</']) {
      expect(contentJs).not.toContain(phrase);
      expect(popupJs).not.toContain(phrase);
    }
  });

  it('renders domain review cues from proxy metadata without replacing agent insights', () => {
    expect(contentJs).toContain('Domain review');
    expect(contentJs).toContain('domainRisk');
    expect(contentCss).toContain('da-agent-domain');
    expect(contentCss).toContain('da-agent-chip-warn');
    expect(popupJs).toContain('agent-domain-review');
    expect(popupHtml).toContain('agent-domain-prompts');
  });
});

describe('answer generation uses full CV facts and respects user authorship', () => {
  it('merges CV hyperlink annotations into the answer payload so URLs hidden behind link text are answerable', () => {
    expect(contentJs).toContain('_cvTextWithLinks(cvResponse)');
    expect(contentJs).toMatch(/cvText:\s+this\._cvTextWithLinks\(cvResponse\)/);
    // No payload site may bypass the merge and send bare stored text.
    expect(contentJs).not.toMatch(/cvText:\s+cvResponse\.cvText\b/);
  });

  it('lets the user insert their own edited answer, gated only by the field character limit', () => {
    expect(contentJs).toContain('const isUserEdit = this.answerUserEdited && Boolean(current)');
    expect(contentJs).toContain("insertButton.textContent = overLimit ? 'Over Character Limit' : 'Insert (Your Edit)'");
    // The old behavior forced regeneration after any manual edit.
    expect(contentJs).not.toContain("'Regenerate to Validate'");
  });
});

describe('job-description context disclosure', () => {
  it('labels full, saved, partial, and missing JD context explicitly', () => {
    expect(contentJs).toContain("'✓ Full JD (saved)'");
    expect(contentJs).toContain("'✓ Full JD (pasted)'");
    expect(contentJs).toContain("'✓ Detected JD'");
    expect(contentJs).toContain("badge.textContent = '⚠ Partial JD'");
    expect(contentJs).toContain("badge.textContent = 'No JD'");
    expect(contentJs).toContain("contextQuality: 'saved'");
    expect(contentJs).toContain("jdContextQuality: jobContextForPayload.contextQuality || 'none'");
  });

  it('requires a JD for narrative answers while allowing factual CV fields', () => {
    expect(contentJs).toContain('_questionNeedsJobContext(question');
    expect(contentJs).toContain('A job description is required for a tailored answer');
    expect(contentJs).toMatch(/linkedin\|github\|gitlab\|portfolio/);
  });
});

describe('user-entered profile links', () => {
  it('popup saves manual profile URLs into the link-annotation channel answers consume', () => {
    expect(popupHtml).toContain('id="profile-links"');
    expect(popupJs).toContain("profileLinks:    document.getElementById('profile-links')");
    expect(popupJs).toContain('function parseProfileLinks(raw)');
    // Manual links take precedence and are stored for future sessions.
    expect(popupJs).toContain('...manualLinks,');
    expect(popupJs).toContain("chrome.storage.local.set({ userProfileLinks: profileLinksRaw })");
    // Restored into the input on popup load.
    expect(popupJs).toContain("chrome.storage.local.get('userProfileLinks')");
  });
});
