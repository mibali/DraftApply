/**
 * DraftApply Popup Script
 *
 * Handles CV management and backend status display.
 * No API key configuration needed — backend handles LLM.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Hide logo images that fail to load (CSP-safe — no inline onerror attribute)
  document.querySelectorAll('.da-popup-logo-img').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });
  const TAILOR_DRAFT_KEY = 'tailorCvDraft';
  const TAILOR_JOB_KEY = 'tailorCvJob';
  const TAILOR_JOB_POLL_INTERVAL_MS = 1500;
  const TAILOR_JOB_MAX_POLL_MS = 3 * 60 * 1000;

  const elements = {
    cvStatusDot:     document.getElementById('cv-status-dot'),
    cvStatusText:    document.getElementById('cv-status-text'),
    proxyStatusDot:  document.getElementById('proxy-status-dot'),
    proxyStatusText: document.getElementById('proxy-status-text'),
    cvInputSection:  document.getElementById('cv-input-section'),
    cvLoadedSection: document.getElementById('cv-loaded-section'),
    cvText:          document.getElementById('cv-text'),
    cvPreview:       document.getElementById('cv-preview'),
    saveCvBtn:       document.getElementById('save-cv-btn'),
    changeCvBtn:     document.getElementById('change-cv-btn'),
    message:         document.getElementById('message'),
    uploadArea:      document.getElementById('upload-area'),
    cvFile:          document.getElementById('cv-file'),
    pageStatusDot:   document.getElementById('page-status-dot'),
    pageStatusText:  document.getElementById('page-status-text'),
    activateBtn:     document.getElementById('activate-btn'),
    tailorOpenBtn:   document.getElementById('tailor-open-btn'),
    statsCard:       document.getElementById('stats-card'),
    statsToggle:     document.getElementById('stats-toggle'),
    statsSummary:    document.getElementById('stats-summary'),
    statsDetails:    document.getElementById('stats-details'),
    statsAnswers:    document.getElementById('stats-answers'),
    statsExports:    document.getElementById('stats-exports'),
    statsTailored:   document.getElementById('stats-tailored'),
    statsSaved:      document.getElementById('stats-saved'),
    statsWeek:       document.getElementById('stats-week'),
    statsStreak:     document.getElementById('stats-streak'),
    statsTopAction:  document.getElementById('stats-top-action'),
    statsResetBtn:   document.getElementById('stats-reset-btn'),
    // Tailor view
    mainView:              document.getElementById('main-view'),
    tailorView:            document.getElementById('tailor-view'),
    tailorBackBtn:         document.getElementById('tailor-back-btn'),
    tailorJd:              document.getElementById('tailor-jd'),
    tailorJobTitle:        document.getElementById('tailor-job-title'),
    tailorCompany:         document.getElementById('tailor-company'),
    tailorAnalyzeBtn:      document.getElementById('tailor-analyze-btn'),
    tailorReanalyzeBtn:    document.getElementById('tailor-reanalyze-btn'),
    tailorGenerateBtn:     document.getElementById('tailor-generate-btn'),
    tailorLoading:         document.getElementById('tailor-loading'),
    tailorLoadingText:     document.getElementById('tailor-loading-text'),
    tailorLoadingSub:      document.getElementById('tailor-loading-sub'),
    tailorResults:         document.getElementById('tailor-results'),
    matchScore:            document.getElementById('match-score'),
    matchStrong:           document.getElementById('match-strong'),
    matchStrongChips:      document.getElementById('match-strong-chips'),
    matchConfirmed:        document.getElementById('match-confirmed'),
    matchConfirmedChips:   document.getElementById('match-confirmed-chips'),
    matchAllClear:         document.getElementById('match-all-clear'),
    matchMissing:          document.getElementById('match-missing'),
    matchMissingChips:     document.getElementById('match-missing-chips'),
    matchDomain:           document.getElementById('match-domain'),
    matchDomainChips:      document.getElementById('match-domain-chips'),
    tailorWarningsBox:     document.getElementById('tailor-warnings-box'),
    tailorOutputWrap:      document.getElementById('tailor-output-wrap'),
    tailorOutput:          document.getElementById('tailor-output'),
    tailorActionRow:       document.getElementById('tailor-action-row'),
    tailorCopyBtn:         document.getElementById('tailor-copy-btn'),
    tailorPdfBtn:          document.getElementById('tailor-pdf-btn'),
    tailorRedoBtn:         document.getElementById('tailor-redo-btn'),
    tailorMessage:         document.getElementById('tailor-message'),
    // Step indicators
    stepPaste:    document.getElementById('step-paste'),
    stepReview:   document.getElementById('step-review'),
    stepGenerate: document.getElementById('step-generate'),
    stepExport:   document.getElementById('step-export'),
  };

  let proxyUrl = null;

  // Stale-response guard: incremented on every new analyze call.
  // If the value changes while a request is in flight, the response is discarded.
  let analyzeToken = 0;
  let tailorToken = 0;
  let savingDraftTimer = null;
  let tailorJobPollTimer = null;
  let tailorJobPollStartedAt = 0;
  let statsResetTimer = null;
  let messageTimer = null;
  let tailorMessageTimer = null;
  let activeTabSnapshot = null;

  // ── Event listeners ──────────────────────────────────────────────────────

  elements.saveCvBtn.addEventListener('click', saveCV);
  elements.changeCvBtn.addEventListener('click', showCVInput);

  if (elements.activateBtn) {
    elements.activateBtn.addEventListener('click', activateOnPage);
  }

  elements.tailorOpenBtn.addEventListener('click', openTailorView);
  elements.tailorBackBtn.addEventListener('click', closeTailorView);
  elements.tailorAnalyzeBtn.addEventListener('click', runAnalyzeCV);
  elements.tailorReanalyzeBtn.addEventListener('click', runAnalyzeCV);
  elements.tailorGenerateBtn.addEventListener('click', runTailorCV);
  elements.tailorRedoBtn.addEventListener('click', runTailorCV);
  elements.tailorCopyBtn.addEventListener('click', copyTailoredCV);
  elements.tailorPdfBtn.addEventListener('click', downloadAsPdf);
  elements.statsToggle.addEventListener('click', toggleStatsCard);
  elements.statsResetBtn.addEventListener('click', resetStatsWithConfirm);

  // Reset analysis when JD inputs change
  elements.tailorJd.addEventListener('input', handleTailorDraftInput);
  elements.tailorJobTitle.addEventListener('input', handleTailorDraftInput);
  elements.tailorCompany.addEventListener('input', handleTailorDraftInput);

  // File upload handling
  elements.uploadArea.addEventListener('click', () => elements.cvFile.click());
  elements.cvFile.addEventListener('change', handleFileSelect);

  elements.uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.uploadArea.classList.add('dragover');
  });

  elements.uploadArea.addEventListener('dragleave', () => {
    elements.uploadArea.classList.remove('dragover');
  });

  elements.uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  });

  // Load saved state after binding handlers so the popup never feels dead while
  // proxy/page checks are warming up.
  await Promise.allSettled([
    loadState(),
    checkProxy(),
    checkPageStatus(),
    restoreTailorDraft(),
    refreshStatsUI(),
  ]);

  // ── CV management ─────────────────────────────────────────────────────────

  async function loadState() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CV' });
    if (response.cvText) showCVLoaded(response.cvText);
  }

  async function refreshStatsUI() {
    const helper = window.DraftApplyStats;
    if (!helper) return;

    const stats = await helper.read();
    const summary = helper.summarize(stats);
    elements.statsSummary.textContent = summary.summaryText;
    elements.statsAnswers.textContent = String(summary.answersInserted);
    elements.statsExports.textContent = String(summary.cvExports);
    elements.statsTailored.textContent = String(summary.cvsTailored);
    elements.statsSaved.textContent = summary.timeSavedLabel;
    elements.statsWeek.textContent = String(summary.thisWeekCount);
    elements.statsStreak.textContent = `${summary.assistStreakDays} ${summary.assistStreakDays === 1 ? 'day' : 'days'}`;
    elements.statsTopAction.textContent = summary.topActionLabel;
  }

  function toggleStatsCard() {
    const expanded = elements.statsDetails.hidden;
    elements.statsDetails.hidden = !expanded;
    elements.statsToggle.setAttribute('aria-expanded', String(expanded));
    elements.statsCard.classList.toggle('expanded', expanded);
  }

  async function resetStatsWithConfirm() {
    if (elements.statsResetBtn.dataset.confirming === 'true') {
      clearTimeout(statsResetTimer);
      elements.statsResetBtn.dataset.confirming = 'false';
      elements.statsResetBtn.textContent = 'Reset stats';
      await window.DraftApplyStats?.reset?.();
      await refreshStatsUI();
      return;
    }

    elements.statsResetBtn.dataset.confirming = 'true';
    elements.statsResetBtn.textContent = 'Confirm reset';
    clearTimeout(statsResetTimer);
    statsResetTimer = setTimeout(() => {
      elements.statsResetBtn.dataset.confirming = 'false';
      elements.statsResetBtn.textContent = 'Reset stats';
    }, 4000);
  }

  async function checkProxy() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'CHECK_PROXY' });
      if (status && !status.error) {
        elements.proxyStatusDot.classList.add('ready');
        elements.proxyStatusText.textContent = `Proxy: ${status.provider || 'Online'}`;
        proxyUrl = status.proxyUrl;
      } else {
        elements.proxyStatusDot.classList.add('error');
        elements.proxyStatusText.textContent = 'Proxy: Offline';
        showMessage(status?.hint || 'Proxy not reachable', 'error');
      }
    } catch (e) {
      elements.proxyStatusDot.classList.add('error');
      elements.proxyStatusText.textContent = 'Proxy: Offline';
      showMessage('Proxy not reachable. Check Render deploy + URL.', 'error');
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) processFile(file);
  }

  async function processFile(file) {
    const validTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];

    if (!validTypes.includes(file.type) && !file.name.match(/\.(pdf|docx?|txt)$/i)) {
      showMessage('Please upload a PDF, DOCX, or TXT file', 'error');
      return;
    }

    elements.uploadArea.classList.add('has-file');
    elements.uploadArea.querySelector('.upload-text').textContent = file.name;
    elements.uploadArea.querySelector('.upload-hint').textContent = 'Extracting text…';

    try {
      const text = await extractTextFromFile(file);
      elements.cvText.value = text;
      elements.uploadArea.querySelector('.upload-hint').textContent = 'Text extracted — click Save CV';
      showMessage('File loaded. Review and click Save CV.');
    } catch (err) {
      elements.uploadArea.classList.remove('has-file');
      elements.uploadArea.querySelector('.upload-text').innerHTML = 'Drop file or <span class="upload-link">browse</span>';
      elements.uploadArea.querySelector('.upload-hint').textContent = 'PDF, DOCX, or TXT';
      showMessage('Could not extract text: ' + err.message, 'error');
    }
  }

  async function extractTextFromFile(file) {
    if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
      return await file.text();
    }

    if (!proxyUrl) {
      await checkProxy();
      if (!proxyUrl) {
        throw new Error('Proxy not available. Please wait a few seconds and try again.');
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const formData = new FormData();
      formData.append('cv', file);

      const tokenResult = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
      const token = tokenResult?.token;
      if (!token) throw new Error(tokenResult?.error || 'Could not get proxy token');

      const response = await fetch(`${proxyUrl}/api/cv/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Extraction failed');
      }

      const result = await response.json();
      return result.text;
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new Error('Timed out — the service may be starting up. Please try again in a few seconds.');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function saveCV() {
    const text = elements.cvText.value.trim();
    if (text.length < 50) {
      showMessage('Please enter more CV content', 'error');
      return;
    }
    elements.saveCvBtn.disabled = true;
    elements.saveCvBtn.textContent = 'Saving…';
    try {
      const previous = await chrome.runtime.sendMessage({ type: 'GET_CV' }).catch(() => ({}));
      const cvChanged = Boolean(previous?.cvText && previous.cvText !== text);
      await chrome.runtime.sendMessage({ type: 'SAVE_CV', cvText: text });
      if (cvChanged) await resetTailorStateForCvChange();
      showCVLoaded(text);
      showMessage(cvChanged ? 'CV saved. Re-analyze any saved JD before generating a new tailored CV.' : 'CV saved successfully');
    } finally {
      elements.saveCvBtn.disabled = false;
      elements.saveCvBtn.textContent = 'Save CV';
    }
  }

  async function resetTailorStateForCvChange() {
    analyzeToken++;
    tailorToken++;
    stopTailorJobPolling();
    await chrome.storage.local.remove(TAILOR_JOB_KEY).catch?.(() => {});
    elements.tailorOutput.value = '';
    elements.tailorOutputWrap.hidden = true;
    elements.tailorActionRow.hidden = true;
    elements.tailorWarningsBox.hidden = true;
    elements.tailorResults.hidden = true;
    elements.tailorAnalyzeBtn.hidden = false;
    elements.tailorAnalyzeBtn.disabled = false;
    elements.tailorAnalyzeBtn.textContent = 'Analyze JD';
    elements.tailorReanalyzeBtn.style.display = 'none';
    elements.tailorGenerateBtn.hidden = true;
    elements.tailorGenerateBtn.disabled = false;
    elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
    setStep('paste');
  }

  function showCVLoaded(text) {
    elements.cvInputSection.hidden = true;
    elements.cvLoadedSection.hidden = false;
    elements.cvStatusDot.classList.add('ready');
    elements.cvStatusText.textContent = 'CV ready';
    elements.cvPreview.textContent = `Saved (${text.length.toLocaleString()} characters)`;
    elements.tailorOpenBtn.hidden = false;
  }

  async function showCVInput() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CV' }).catch(() => ({}));
    elements.cvInputSection.hidden = false;
    elements.cvLoadedSection.hidden = true;
    if (response?.cvText) {
      elements.cvStatusDot.classList.add('ready');
      elements.cvStatusText.textContent = 'Editing CV';
      elements.cvText.value = response.cvText;
    } else {
      elements.cvStatusDot.classList.remove('ready');
      elements.cvStatusText.textContent = 'No CV';
      elements.cvText.value = '';
    }
    elements.tailorOpenBtn.hidden = true;
  }

  function showMessage(text, type = 'success') {
    clearTimeout(messageTimer);
    elements.message.textContent = text;
    elements.message.className = 'message' + (type === 'error' ? ' error' : '');
    elements.message.hidden = false;
    messageTimer = setTimeout(() => { elements.message.hidden = true; }, 4000);
  }

  async function checkPageStatus() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'CHECK_PAGE_ACTIVE' });
      if (result?.active) setPageActive();
      else setPageInactive();
    } catch {
      setPageInactive();
    }
  }

  function setPageActive() {
    elements.pageStatusDot.classList.add('ready');
    elements.pageStatusDot.classList.remove('error');
    elements.pageStatusText.textContent = 'DraftApply is active';
    elements.activateBtn.hidden = true;
  }

  function setPageInactive() {
    elements.pageStatusDot.classList.remove('ready');
    elements.pageStatusText.textContent = 'Not active on this page';
    elements.activateBtn.hidden = false;
  }

  async function activateOnPage() {
    elements.activateBtn.disabled = true;
    elements.activateBtn.textContent = 'Activating…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ACTIVATE_PAGE' });
      if (result?.success) {
        setPageActive();
        showMessage('DraftApply activated on this page');
      } else {
        elements.activateBtn.disabled = false;
        elements.activateBtn.textContent = 'Activate on this page';
        showMessage(result?.error || 'Could not activate on this page', 'error');
      }
    } catch (err) {
      elements.activateBtn.disabled = false;
      elements.activateBtn.textContent = 'Activate on this page';
      showMessage('Could not activate: ' + err.message, 'error');
    }
  }

  // ── Tailor CV flow ────────────────────────────────────────────────────────

  async function openTailorView() {
    analyzeToken++; // discard any in-flight response from a previous session
    stopTailorJobPolling();
    elements.mainView.hidden = true;
    elements.tailorView.hidden = false;
    elements.tailorResults.hidden = true;
    elements.tailorLoading.hidden = true;
    elements.tailorMessage.hidden = true;
    elements.tailorAnalyzeBtn.hidden = false;
    elements.tailorAnalyzeBtn.disabled = false;
    elements.tailorAnalyzeBtn.textContent = 'Analyze JD';
    elements.tailorReanalyzeBtn.style.display = 'none';
    elements.tailorGenerateBtn.hidden = true;
    elements.tailorGenerateBtn.disabled = false;
    elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
    setStep('paste');
    await restoreTailorDraft({ restoreJob: true });
  }

  function closeTailorView() {
    stopTailorJobPolling();
    elements.tailorView.hidden = true;
    elements.mainView.hidden = false;
    elements.tailorWarningsBox.hidden = true;
    elements.tailorMessage.hidden = true;
  }

  async function restoreTailorDraft(options = {}) {
    try {
      const [draftResult, jobResult] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_TAILOR_DRAFT_FOR_ACTIVE_PAGE' }).catch(() => null),
        chrome.runtime.sendMessage({ type: 'GET_TAILOR_JOB_FOR_ACTIVE_PAGE' }).catch(() => null),
      ]);
      const draft = draftResult?.draft;
      if (draftResult?.snapshot) activeTabSnapshot = draftResult.snapshot;
      if (jobResult?.snapshot) activeTabSnapshot = jobResult.snapshot;
      const job = jobResult?.job;

      if (draft) {
        elements.tailorJd.value = draft.jobDescription || '';
        elements.tailorJobTitle.value = draft.jobTitle || '';
        elements.tailorCompany.value = draft.company || '';
      }

      if (options.restoreJob && job) {
        restoreTailorJob(job);
      }
    } catch (e) {
      // Draft restore is best-effort; the main popup must still load.
    }
  }

  function restoreTailorJob(job) {
    if (!job || !['running', 'done', 'error'].includes(job.status)) return;

    elements.tailorJd.value = job.jobDescription || elements.tailorJd.value;
    elements.tailorJobTitle.value = job.jobTitle || elements.tailorJobTitle.value;
    elements.tailorCompany.value = job.company || elements.tailorCompany.value;

    if (job.status === 'running') {
      elements.tailorAnalyzeBtn.hidden = true;
      elements.tailorReanalyzeBtn.style.display = 'none';
      elements.tailorGenerateBtn.hidden = false;
      elements.tailorGenerateBtn.disabled = true;
      elements.tailorGenerateBtn.textContent = 'Generating…';
      elements.tailorLoading.hidden = false;
      elements.tailorLoadingText.textContent = 'Tailoring your CV…';
      elements.tailorLoadingSub.textContent = 'You can close this popup — DraftApply will restore the result here.';
      elements.tailorResults.hidden = true;
      setStep('generate');
      startTailorJobPolling(job.id);
      return;
    }

    stopTailorJobPolling();
    elements.tailorLoading.hidden = true;
    elements.tailorGenerateBtn.disabled = false;
    elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';

    if (job.status === 'done' && job.result) {
      displayTailorResults(job.result);
      showTailorMessage('Restored your generated CV.');
    } else if (job.status === 'error') {
      elements.tailorGenerateBtn.hidden = false;
      showTailorMessage(job.error || 'Previous CV generation failed. Please try again.', 'error');
      setStep('generate');
    }
  }

  function startTailorJobPolling(jobId) {
    stopTailorJobPolling();
    tailorJobPollStartedAt = Date.now();
    tailorJobPollTimer = setInterval(async () => {
      try {
        if (Date.now() - tailorJobPollStartedAt > TAILOR_JOB_MAX_POLL_MS) {
          stopTailorJobPolling();
          await chrome.storage.local.remove(TAILOR_JOB_KEY).catch?.(() => {});
          elements.tailorLoading.hidden = true;
          elements.tailorGenerateBtn.hidden = false;
          elements.tailorGenerateBtn.disabled = false;
          elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
          showTailorMessage('CV generation is taking longer than expected. Please try again; no CV was changed.', 'error');
          setStep('generate');
          return;
        }
        const stored = await chrome.storage.local.get(TAILOR_JOB_KEY);
        const job = stored?.[TAILOR_JOB_KEY];
        if (!job || (jobId && job.id !== jobId)) return;
        if (job.status === 'done' || job.status === 'error') {
          restoreTailorJob(job);
        }
      } catch (e) {
        // Polling is best-effort; the user can reopen the popup to restore.
      }
    }, TAILOR_JOB_POLL_INTERVAL_MS);
  }

  function stopTailorJobPolling() {
    if (tailorJobPollTimer) clearInterval(tailorJobPollTimer);
    tailorJobPollTimer = null;
    tailorJobPollStartedAt = 0;
  }

  function handleTailorDraftInput() {
    resetTailorReview();
    scheduleTailorDraftSave();
  }

  function scheduleTailorDraftSave() {
    clearTimeout(savingDraftTimer);
    savingDraftTimer = setTimeout(saveTailorDraft, 250);
  }

  async function saveTailorDraft() {
    try {
      if (!activeTabSnapshot) {
        try {
          const result = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_SNAPSHOT' });
          activeTabSnapshot = result?.snapshot || null;
        } catch (_) {}
      }

      const draft = {
        jobDescription: elements.tailorJd.value,
        jobTitle: elements.tailorJobTitle.value,
        company: elements.tailorCompany.value,
        updatedAt: new Date().toISOString(),
      };

      Object.assign(draft, buildTailorSourceMetadata(draft.updatedAt));

      const hasContent = draft.jobDescription.trim() || draft.jobTitle.trim() || draft.company.trim();
      if (hasContent) {
        await chrome.storage.local.set({ [TAILOR_DRAFT_KEY]: draft });
      } else {
        await chrome.storage.local.remove(TAILOR_DRAFT_KEY);
      }
    } catch (e) {
      // Keep typing responsive even if storage is unavailable.
    }
  }

  function buildTailorSourceMetadata(savedAt = new Date().toISOString()) {
    if (!activeTabSnapshot) return {};
    return {
      sourceTabId: activeTabSnapshot.tabId,
      sourceUrl: activeTabSnapshot.url || '',
      sourceHost: (() => {
        try { return new URL(activeTabSnapshot.url || '').hostname.replace(/^www\./, '').toLowerCase(); }
        catch { return ''; }
      })(),
      sourcePageTitle: activeTabSnapshot.title || '',
      sourceJobTitle: activeTabSnapshot.pageContext?.jobTitle || '',
      sourceCompany: activeTabSnapshot.pageContext?.company || '',
      sourceSavedAt: savedAt,
    };
  }

  function resetTailorReview() {
    // Invalidate any in-flight analyze/tailor responses
    analyzeToken++;
    tailorToken++;

    elements.tailorAnalyzeBtn.hidden = false;
    elements.tailorAnalyzeBtn.disabled = false;
    elements.tailorAnalyzeBtn.textContent = 'Analyze JD';
    elements.tailorReanalyzeBtn.style.display = 'none';
    elements.tailorGenerateBtn.hidden = true;
    elements.tailorGenerateBtn.disabled = false;
    elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
    elements.tailorResults.hidden = true;
    elements.tailorOutputWrap.hidden = true;
    elements.tailorActionRow.hidden = true;
    elements.tailorWarningsBox.hidden = true;
    elements.tailorOutput.value = '';
    chrome.storage.local.remove(TAILOR_JOB_KEY).catch?.(() => {});
    setStep('paste');
  }

  async function runAnalyzeCV() {
    const rawJd = elements.tailorJd.value.trim();
    if (rawJd.length < 50) {
      showTailorMessage('Please paste a job description (at least a few lines)', 'error');
      return;
    }

    // Stamp this request so stale responses can be detected
    analyzeToken++;
    const myToken = analyzeToken;

    elements.tailorAnalyzeBtn.disabled = true;
    elements.tailorAnalyzeBtn.textContent = 'Analyzing…';
    elements.tailorReanalyzeBtn.disabled = true;
    elements.tailorReanalyzeBtn.style.display = 'none';
    elements.tailorLoading.hidden = false;
    elements.tailorResults.hidden = true;
    elements.tailorMessage.hidden = true;
    setStep('paste');

    // For full job postings, strip boilerplate before analyzing
    let jd = rawJd;
    if (rawJd.length > 500) {
      elements.tailorLoadingText.textContent = 'Extracting job requirements…';
      elements.tailorLoadingSub.textContent = 'Filtering out company blurb and boilerplate';
      try {
        const extracted = await chrome.runtime.sendMessage({ type: 'EXTRACT_JD', text: rawJd });
        if (myToken !== analyzeToken) return;
        if (extracted?.extractedText?.trim()) {
          jd = extracted.extractedText;
          elements.tailorJd.value = jd;
          await saveTailorDraft();
        }
      } catch {
        // Fall back to raw text silently
      }
    }

    elements.tailorLoadingText.textContent = 'Analyzing job description…';
    elements.tailorLoadingSub.textContent = 'Matching against your CV';

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ANALYZE_CV_MATCH',
        jobDescription: jd,
        jobTitle: elements.tailorJobTitle.value.trim(),
        company:  elements.tailorCompany.value.trim(),
      });

      // Discard if the JD was edited while this request was in flight
      if (myToken !== analyzeToken) return;

      if (result?.error) {
        showTailorMessage(result.error, 'error');
        return;
      }

      displayMatchReport(result.matchReport, { reviewMode: true, domainSuggestions: result.domainSuggestions || [] });
      await saveTailorDraft();
      elements.tailorAnalyzeBtn.hidden = true;
      elements.tailorReanalyzeBtn.style.display = 'block';
      elements.tailorGenerateBtn.hidden = false;
      elements.tailorOutputWrap.hidden = true;
      elements.tailorActionRow.hidden = true;
      elements.tailorOutput.value = '';
      elements.tailorResults.hidden = false;
      elements.tailorResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setStep('review');
    } catch (e) {
      if (myToken !== analyzeToken) return;
      showTailorMessage('Something went wrong: ' + e.message, 'error');
    } finally {
      if (myToken === analyzeToken) {
        elements.tailorLoading.hidden = true;
        elements.tailorAnalyzeBtn.disabled = false;
        elements.tailorAnalyzeBtn.textContent = 'Analyze JD';
        elements.tailorReanalyzeBtn.disabled = false;
      }
    }
  }

  async function runTailorCV() {
    const jd = elements.tailorJd.value.trim();
    if (jd.length < 50) {
      showTailorMessage('Please paste a job description (at least a few lines)', 'error');
      return;
    }

    elements.tailorGenerateBtn.disabled = true;
    elements.tailorGenerateBtn.textContent = 'Generating…';
    elements.tailorRedoBtn.disabled = true;
    elements.tailorLoading.hidden = false;
    elements.tailorLoadingText.textContent = 'Tailoring your CV…';
    elements.tailorLoadingSub.textContent = 'This takes 15–30 seconds';
    elements.tailorMessage.hidden = true;
    const confirmedSkills = getConfirmedMissingSkills();
    elements.tailorOutputWrap.hidden = true;
    elements.tailorActionRow.hidden = true;
    setStep('generate');
    tailorToken++;
    const myToken = tailorToken;

    try {
      if (!activeTabSnapshot) {
        const snapshotResult = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_SNAPSHOT' }).catch(() => null);
        activeTabSnapshot = snapshotResult?.snapshot || null;
      }
      const sourceSavedAt = new Date().toISOString();
      const result = await chrome.runtime.sendMessage({
        type: 'TAILOR_CV',
        jobDescription: jd,
        jobTitle: elements.tailorJobTitle.value.trim(),
        company:  elements.tailorCompany.value.trim(),
        confirmedSkills,
        source: buildTailorSourceMetadata(sourceSavedAt),
      });

      if (myToken !== tailorToken) return;

      if (result?.error) {
        showTailorMessage(result.error, 'error');
        return;
      }

      displayTailorResults(result);
      await saveTailorDraft();
      await window.DraftApplyStats?.track?.('cvsTailored');
      await refreshStatsUI();
    } catch (e) {
      if (myToken !== tailorToken) return;
      showTailorMessage('Something went wrong: ' + e.message, 'error');
    } finally {
      if (myToken === tailorToken) {
        elements.tailorLoading.hidden = true;
        elements.tailorGenerateBtn.disabled = false;
        elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
        elements.tailorRedoBtn.disabled = false;
      }
    }
  }

  function displayTailorResults(result) {
    const { tailoredCvText, matchReport, warnings, provider, fallbackFrom } = result;
    displayMatchReport(matchReport, { reviewMode: false, domainSuggestions: [] });

    const badge = document.getElementById('tailor-provider-badge');
    if (badge) {
      if (provider) {
        badge.textContent = fallbackFrom
          ? `${provider === 'openrouter' ? 'OpenRouter' : provider} fallback from ${fallbackFrom === 'groq' ? 'Groq' : fallbackFrom}`
          : (provider === 'openrouter' ? 'OpenRouter' : 'Groq');
        badge.style.background = provider === 'openrouter' ? '#fef3c7' : '#d1fae5';
        badge.style.color = provider === 'openrouter' ? '#92400e' : '#065f46';
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }

    if (warnings?.length > 0) {
      elements.tailorWarningsBox.innerHTML = formatTailorWarnings(warnings);
      elements.tailorWarningsBox.hidden = false;
    } else {
      elements.tailorWarningsBox.textContent = '';
      elements.tailorWarningsBox.hidden = true;
    }

    elements.tailorOutput.value = tailoredCvText || '';
    elements.tailorOutputWrap.hidden = false;
    elements.tailorActionRow.hidden = false;
    elements.tailorResults.hidden = false;
    elements.tailorGenerateBtn.hidden = true;

    elements.tailorResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStep('export');
  }

  function formatTailorWarnings(warnings = []) {
    // Sort warnings into three buckets for display
    const accuracy = [];   // locked fields changed, fabricated metrics
    const missing  = [];   // user-confirmed skills the LLM didn't add
    const quality  = [];   // formatting, unsupported claims, structural issues

    for (const w of warnings) {
      if (/^(Company name|Job title|Education institution|Email address|Phone number|LinkedIn|GitHub|Website|Twitter|Full name|New metric)/.test(w)) {
        accuracy.push(w);
      } else if (w.startsWith('User-confirmed skill was not included')) {
        const m = w.match(/: "(.+)"$/);
        missing.push(m ? m[1] : w);
      } else {
        quality.push(w);
      }
    }

    function humaniseAccuracy(w) {
      const val = (w.match(/: "(.+)"$/) || [])[1] || '';
      if (/^Company name/.test(w))        return `Check company name is still present: <strong>${esc(val)}</strong>`;
      if (/^Job title/.test(w))           return `Check job title is still present: <strong>${esc(val)}</strong>`;
      if (/^Education institution/.test(w)) return `Check institution name is still present: <strong>${esc(val)}</strong>`;
      if (/^New metric/.test(w))          return `New figure added — confirm it's accurate: <strong>${esc(val)}</strong>`;
      if (/^(Email|Phone|LinkedIn|GitHub|Website|Twitter|Full name)/.test(w)) {
        const label = w.split(' may ')[0];
        return `Check ${label.toLowerCase()} is still present: <strong>${esc(val)}</strong>`;
      }
      return esc(w);
    }

    function humaniseQuality(w) {
      if (/^Unsupported JD skill/.test(w)) {
        const val = (w.match(/: "(.+)"$/) || [])[1] || '';
        return `Not in your original CV — remove if you don't have this: <strong>${esc(val)}</strong>`;
      }
      if (/^Target job title may be missing/.test(w)) {
        const val = (w.match(/: "(.+)"$/) || [])[1] || '';
        return `Target role title missing from CV header: <strong>${esc(val)}</strong>`;
      }
      if (/^Core Competencies has only/.test(w)) {
        const n = (w.match(/only (\d+)/) || [])[1] || '';
        return `Core Competencies has only ${n} ${n === '1' ? 'category' : 'categories'} — aim for 5–7`;
      }
      if (/broken or wrapped/.test(w))   return 'Core Competencies has a line that wrapped or broke — edit into "Category: Skill, Skill" format';
      if (/business communication/.test(w)) return 'Replace "business communication skills" with a concise phrase e.g. Stakeholder Communication';
      if (/Additional Skills.*catch-all/.test(w)) return 'Remove the "Additional Skills" catch-all — put every skill inside a named category';
      if (/JD requirement prose/.test(w)) return 'Core Competencies may contain a long JD requirement sentence — replace with short skill phrases';
      if (/Core Competencies section may be missing/.test(w)) return 'Core Competencies section is missing from the CV';
      if (/Role focus line may be missing/.test(w)) {
        const val = (w.match(/"(.+)"$/) || [])[1] || '';
        return `Missing Focus: line under <strong>${esc(val)}</strong>`;
      }
      if (/under-positioned.*headline/.test(w)) return w.replace(/Solution Architect target may be under-positioned in the CV headline: "(.+)"/, 'Headline may not position you as a Solution Architect: <strong>$1</strong>');
      return esc(w);
    }

    const sections = [];

    if (accuracy.length > 0) {
      sections.push(`
        <div class="tw-group tw-group-accuracy">
          <div class="tw-group-label">Accuracy — check these are still correct</div>
          <ul class="tailor-warning-list">${accuracy.map(w => `<li>${humaniseAccuracy(w)}</li>`).join('')}</ul>
        </div>`);
    }

    if (missing.length > 0) {
      sections.push(`
        <div class="tw-group tw-group-missing">
          <div class="tw-group-label">Skills not added — add manually if relevant</div>
          <ul class="tailor-warning-list">${missing.map(s => `<li><strong>${esc(s)}</strong></li>`).join('')}</ul>
        </div>`);
    }

    if (quality.length > 0) {
      sections.push(`
        <div class="tw-group tw-group-quality">
          <div class="tw-group-label">Quality checks</div>
          <ul class="tailor-warning-list">${quality.map(w => `<li>${humaniseQuality(w)}</li>`).join('')}</ul>
        </div>`);
    }

    return `<div class="tailor-warning-title">Review before sending</div>${sections.join('')}`;
  }

  function displayMatchReport(matchReport, { reviewMode, domainSuggestions = [] } = {}) {
    const score = matchReport?.score ?? null;
    elements.matchScore.textContent = score != null ? `${score}%` : '–';
    elements.matchScore.className = 'match-score-badge' +
      (score >= 70 ? ' score-high' : score >= 40 ? ' score-mid' : ' score-low');

    const strong = matchReport?.strongMatches || [];
    if (strong.length > 0) {
      elements.matchStrongChips.innerHTML = strong
        .map(s => `<span class="match-chip match-chip-strong">${esc(s)}</span>`)
        .join('');
      elements.matchStrong.hidden = false;
    } else {
      elements.matchStrong.hidden = true;
    }

    const confirmed = matchReport?.confirmedAdditions || [];
    if (confirmed.length > 0) {
      elements.matchConfirmedChips.innerHTML = confirmed
        .map(s => `<span class="match-chip match-chip-confirmed">${esc(s)}</span>`)
        .join('');
      elements.matchConfirmed.hidden = false;
    } else {
      elements.matchConfirmed.hidden = true;
    }

    const missing = matchReport?.unsupportedRequirements || [];
    if (missing.length > 0) {
      if (reviewMode) {
        renderMissingSkillChecks(missing);
      } else {
        elements.matchMissingChips.innerHTML = missing
          .map(s => `<span class="match-chip match-chip-missing">${esc(s)}</span>`)
          .join('');
      }
      elements.matchMissing.hidden = false;
      elements.matchAllClear.hidden = true;
    } else {
      elements.matchMissing.hidden = true;
      // Show "all clear" only in review mode (before generation)
      elements.matchAllClear.hidden = !reviewMode;
    }

    // Domain suggestions — only shown in review mode with checkboxes
    if (reviewMode && domainSuggestions.length > 0) {
      elements.matchDomainChips.textContent = '';
      for (const tool of domainSuggestions) {
        const label = document.createElement('label');
        label.className = 'missing-skill-check';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = tool;
        checkbox.dataset.domainSkill = 'true';

        const text = document.createElement('span');
        text.textContent = tool;

        label.append(checkbox, text);
        elements.matchDomainChips.append(label);
      }
      elements.matchDomain.hidden = false;
    } else {
      elements.matchDomain.hidden = true;
    }
  }

  function renderMissingSkillChecks(missing) {
    elements.matchMissingChips.textContent = '';
    for (const skill of missing) {
      const label = document.createElement('label');
      label.className = 'missing-skill-check';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = skill;
      checkbox.dataset.missingSkill = 'true';

      const text = document.createElement('span');
      text.textContent = skill;

      label.append(checkbox, text);
      elements.matchMissingChips.append(label);
    }
  }

  function getConfirmedMissingSkills() {
    const fromMissing = Array.from(
      elements.matchMissingChips.querySelectorAll('input[data-missing-skill="true"]:checked')
    );
    const fromDomain = Array.from(
      elements.matchDomainChips.querySelectorAll('input[data-domain-skill="true"]:checked')
    );
    return [...fromMissing, ...fromDomain].map(input => input.value).filter(Boolean);
  }

  // ── Step indicator ────────────────────────────────────────────────────────

  function setStep(name) {
    const order = ['paste', 'review', 'generate', 'export'];
    const stepEls = {
      paste:    elements.stepPaste,
      review:   elements.stepReview,
      generate: elements.stepGenerate,
      export:   elements.stepExport,
    };
    const activeIdx = order.indexOf(name);
    order.forEach((step, idx) => {
      const el = stepEls[step];
      if (!el) return;
      el.classList.remove('active', 'done');
      if (idx < activeIdx)       el.classList.add('done');
      else if (idx === activeIdx) el.classList.add('active');
    });
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function copyTailoredCV() {
    const text = elements.tailorOutput.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const orig = elements.tailorCopyBtn.textContent;
      elements.tailorCopyBtn.textContent = 'Copied!';
      setTimeout(() => { elements.tailorCopyBtn.textContent = orig; }, 1800);
    } catch {
      showTailorMessage('Could not copy — try selecting the text manually', 'error');
    }
  }

  async function downloadAsPdf() {
    const text = elements.tailorOutput.value;
    if (!text) return;
    try {
      // Fetch the original CV to extract contact URLs that the LLM may have
      // stripped from the tailored text (e.g. writing "LinkedIn" without the URL).
      // These are stored as a fallback so cv-export.js can re-link profile labels.
      let contactUrls = {};
      try {
        const cvResp = await chrome.runtime.sendMessage({ type: 'GET_CV' });
        contactUrls = extractCvContactUrls(cvResp?.cvText || '');
      } catch { /* non-fatal */ }

      await chrome.storage.local.set({ tailoredCvExport: text, tailoredCvContactUrls: contactUrls });
      await chrome.tabs.create({ url: chrome.runtime.getURL('cv-export.html') });
      await window.DraftApplyStats?.track?.('cvExports');
      await refreshStatsUI();
    } catch (e) {
      showTailorMessage('Could not open the export page. Please try again.', 'error');
    }
  }

  function extractCvContactUrls(text) {
    const ensure = (u) => u ? (u.startsWith('http') ? u : 'https://' + u) : '';
    const li  = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i);
    const gh  = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i);
    const tw  = text.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[\w-]+\/?/i);
    const web = text.match(
      /(?<!@)\b(?:(?:https?:\/\/|www\.)?(?!(?:www\.)?(?:linkedin|github|twitter|x)\.com\b)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?)/i
    );
    return {
      linkedin:  ensure(li?.[0]),
      github:    ensure(gh?.[0]),
      twitter:   ensure(tw?.[0]),
      website:   ensure(web?.[0]),
    };
  }

  function showTailorMessage(text, type = 'success') {
    clearTimeout(tailorMessageTimer);
    elements.tailorMessage.textContent = text;
    elements.tailorMessage.className = 'message' + (type === 'error' ? ' error' : '');
    elements.tailorMessage.hidden = false;
    tailorMessageTimer = setTimeout(() => { elements.tailorMessage.hidden = true; }, 5000);
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

});
