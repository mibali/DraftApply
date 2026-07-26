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
    expect(backgroundJs).not.toMatch(/GET_TAILOR_JOB_FOR_ACTIVE_PAGE[\s\S]{0,900}remove\(TAILOR_JOB_KEY\)/);
  });

  it('isolates answer cancellation while deliberate deletion cancels every request family', () => {
    expect(backgroundJs).toContain('const answerRequests = new Map()');
    expect(backgroundJs).toContain('const dataRequests = new Map()');
    expect(backgroundJs).toMatch(/message\.type === 'CANCEL_ALL'[\s\S]{0,160}abortRegistry\(answerRequests\)/);
    expect(backgroundJs).toMatch(/message\.type === 'DELETE_ALL_USER_DATA'[\s\S]{0,500}abortRegistry\(answerRequests\)[\s\S]{0,200}abortRegistry\(dataRequests\)/);
  });

  it('prevents delete races and stale 401s from restoring or clearing newer tokens/data', () => {
    expect(backgroundJs).toContain('let dataGeneration = 0');
    expect(backgroundJs).toContain('dataGeneration++;');
    expect(backgroundJs).toContain('function mutateTokenRecord(operation)');
    expect(backgroundJs).toMatch(/setInstallToken[\s\S]{0,200}mutateTokenRecord/);
    expect(backgroundJs).toMatch(/clearInstallTokenIfCurrent[\s\S]{0,200}mutateTokenRecord/);
    expect(backgroundJs).toContain('clearInstallTokenIfCurrent(staleToken, generation)');
    expect(backgroundJs).toContain('stored.installToken !== staleToken');
    expect(backgroundJs).toMatch(/DELETE_ALL_USER_DATA[\s\S]{0,600}mutateTokenRecord\(\(\) => mutateTailorRecord/);
    expect(backgroundJs).toContain("registerController(dataRequests, `register:${generation}`");
    expect(backgroundJs).toContain('registerController(dataRequests, requestId, controller)');
    expect(backgroundJs).toContain('setTailorJobIfCurrent(jobId, generation');
    expect(backgroundJs).toMatch(/message\.type === 'SAVE_CV'[\s\S]{0,900}mutateTailorRecord/);
    expect(popupJs).not.toContain('chrome.storage.local.set({ userProfileLinks: profileLinksRaw })');
  });

  it('serializes Tailor ownership changes and never deletes a job for an unrelated page lookup', () => {
    expect(backgroundJs).toContain('function mutateTailorRecord(operation)');
    expect(backgroundJs).toContain('latest?.id !== job.id');
    expect(backgroundJs).toContain('stored?.[TAILOR_JOB_KEY]?.id !== jobId');
    expect(backgroundJs).not.toMatch(/GET_TAILOR_JOB_FOR_ACTIVE_PAGE[\s\S]{0,900}remove\(TAILOR_JOB_KEY\)/);
    expect(backgroundJs).toContain("message.type === 'CANCEL_TAILOR_JOB'");
    expect(popupJs).not.toContain('chrome.storage.local.remove(TAILOR_JOB_KEY)');
  });

  it('clears answer caches and modal data when any answer input is deleted', () => {
    expect(contentJs).toContain("['cvText', 'cvLinkAnnotations', 'applicationFacts']");
    expect(contentJs).toContain('clearSensitiveAnswerState()');
    expect(contentJs).toContain('this.lastAnswer = null');
    expect(contentJs).toContain("display:none !important;");
  });

  it('exports benign gaps but blocks unsafe or unaudited text until it is genuinely edited', () => {
    expect(popupJs).toContain('shouldBlockTailorExport({ warnings, auditSkipped })');
    expect(popupJs).not.toContain('normalizeMissingSkills(matchReport).length > 0');
    expect(popupJs).toContain('Boolean(auditSkipped)');
    expect(popupJs).toContain('warnings.some(isUnsafeTailorWarning)');
    expect(popupJs).toContain('blockedTailorText = tailorAccuracyBlocked');
    expect(popupJs).toContain('elements.tailorOutput.value === blockedTailorText');
  });

  it('fails worker-owned running Tailor jobs on restart without deleting saved CV data', () => {
    expect(backgroundJs).toContain('failWorkerOwnedTailorJob().catch');
    expect(backgroundJs).toContain('previous incarnation');
    expect(backgroundJs).toContain('chrome.runtime.onInstalled.addListener');
    expect(backgroundJs).toContain('chrome.runtime.onStartup.addListener');
    expect(backgroundJs).not.toContain('clearTransientTailorState');
  });

  it('preserves specific proxy/provider error messages instead of replacing all 429s', () => {
    expect(backgroundJs).toContain('async function responseErrorMessage');
    expect(backgroundJs).toContain("body.error.length <= 180");
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

  it('gates every non-passing model answer while preserving explicit user editing', () => {
    expect(contentJs).toContain('id="da-btn-insert" disabled');
    expect(contentJs).toContain("if (message.type === 'STREAM_FINAL')");
    expect(contentJs).toContain('if (this.currentRequestId !== message.requestId) return');
    expect(contentJs).toContain("modelStatus !== 'pass'");
    expect(contentJs).toContain("button.disabled = !hasAnswer || status !== 'pass'");
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
    expect(contentJs).toContain('this.answerUserEdited = Boolean(text && text !== this.validatedAnswer)');
    expect(contentJs).toContain("this.answerUserEdited ? 'Insert (Your Edit)' : 'Insert Answer'");
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
    expect(popupJs).toContain('userProfileLinks: profileLinksRaw, applicationFacts');
    expect(backgroundJs).toContain('userProfileLinks: String(message.userProfileLinks');
    // Restored into the input on popup load.
    expect(popupJs).toContain("chrome.storage.local.get(['userProfileLinks', 'applicationFacts'])");
  });
});
