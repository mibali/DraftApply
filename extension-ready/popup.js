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
  const TAILOR_JOB_MAX_POLL_MS = 7 * 60 * 1000;
  const TAILOR_FALLBACK_HINT_MS = 10 * 1000;
  let pendingCvLinkAnnotations = [];

  const elements = {
    cvStatusDot:     document.getElementById('cv-status-dot'),
    cvStatusText:    document.getElementById('cv-status-text'),
    proxyStatusDot:  document.getElementById('proxy-status-dot'),
    proxyStatusText: document.getElementById('proxy-status-text'),
    cvInputSection:  document.getElementById('cv-input-section'),
    cvLoadedSection: document.getElementById('cv-loaded-section'),
    cvText:          document.getElementById('cv-text'),
    profileLinks:    document.getElementById('profile-links'),
    factNotice:      document.getElementById('fact-notice'),
    factAvailability: document.getElementById('fact-availability'),
    factWorkAuth:    document.getElementById('fact-work-auth'),
    factRelocation:  document.getElementById('fact-relocation'),
    factSalary:      document.getElementById('fact-salary'),
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
    deleteDataBtn:   document.getElementById('delete-data-btn'),
    // Tailor view
    mainView:              document.getElementById('main-view'),
    tailorView:            document.getElementById('tailor-view'),
    tailorBackBtn:         document.getElementById('tailor-back-btn'),
    tailorJd:              document.getElementById('tailor-jd'),
    tailorJobTitle:        document.getElementById('tailor-job-title'),
    tailorCompany:         document.getElementById('tailor-company'),
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
    tailorAgentInsights:   document.getElementById('tailor-agent-insights'),
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

  let tailorToken = 0;
  let savingDraftTimer = null;
  let tailorJobPollTimer = null;
  let tailorJobPollStartedAt = 0;
  let tailorLoadingFallbackTimer = null;
  let statsResetTimer = null;
  let messageTimer = null;
  let tailorMessageTimer = null;
  let activeTabSnapshot = null;
  let tailorAccuracyBlocked = false;
  let blockedTailorText = null;
  let popupDataGeneration = 0;
  let uploadController = null;
  let uploadGeneration = 0;
  let currentCvFingerprint = '';
  let activeTailoredDocument = null;
  let reviewedTextDesired = null;
  let reviewedTextSavePromise = Promise.resolve(null);

  // ── Event listeners ──────────────────────────────────────────────────────

  elements.saveCvBtn.addEventListener('click', saveCV);
  elements.changeCvBtn.addEventListener('click', showCVInput);

  if (elements.activateBtn) {
    elements.activateBtn.addEventListener('click', activateOnPage);
  }

  elements.tailorOpenBtn.addEventListener('click', openTailorView);
  elements.tailorBackBtn.addEventListener('click', closeTailorView);
  elements.tailorGenerateBtn.addEventListener('click', runTailorCV);
  elements.tailorRedoBtn.addEventListener('click', runTailorCV);
  elements.tailorCopyBtn.addEventListener('click', copyTailoredCV);
  elements.tailorPdfBtn.addEventListener('click', downloadAsPdf);
  elements.statsToggle.addEventListener('click', toggleStatsCard);
  elements.statsResetBtn.addEventListener('click', resetStatsWithConfirm);
  elements.deleteDataBtn.addEventListener('click', deleteAllUserData);
  elements.tailorOutput.addEventListener('input', () => {
    if (blockedTailorText !== null) {
      tailorAccuracyBlocked = elements.tailorOutput.value === blockedTailorText;
      elements.tailorCopyBtn.disabled = tailorAccuracyBlocked;
      elements.tailorPdfBtn.disabled = tailorAccuracyBlocked;
      if (!tailorAccuracyBlocked) showTailorMessage('Your edit is now treated as your own CV text. Check it before exporting.');
    }
    scheduleReviewedTextSave();
  });
  elements.tailorOutput.addEventListener('blur', () => flushReviewedTextSave().catch(() => {}));

  // Reset analysis when JD inputs change
  elements.tailorJd.addEventListener('input', handleTailorDraftInput);
  elements.tailorJobTitle.addEventListener('input', handleTailorDraftInput);
  elements.tailorCompany.addEventListener('input', handleTailorDraftInput);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushReviewedTextSave().catch(() => {});
  });
  window.addEventListener('pagehide', () => flushReviewedTextSave().catch(() => {}));

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

  async function deleteAllUserData() {
    if (!confirm('Delete all DraftApply data on this browser? This cannot be undone.')) return;
    popupDataGeneration++;
    tailorToken++;
    uploadController?.abort();
    uploadController = null;
    clearTimeout(savingDraftTimer);
    savingDraftTimer = null;
    stopTailorJobPolling();
    stopTailorLoadingHint();
    const result = await chrome.runtime.sendMessage({ type: 'DELETE_ALL_USER_DATA' }).catch(() => null);
    if (!result?.success) {
      showMessage('Could not delete your data. Please try again.');
      return;
    }
    pendingCvLinkAnnotations = [];
    activeTabSnapshot = null;
    activeTailoredDocument = null;
    reviewedTextDesired = null;
    reviewedTextSavePromise = Promise.resolve(null);
    tailorAccuracyBlocked = false;
    blockedTailorText = null;
    elements.cvText.value = '';
    if (elements.profileLinks) elements.profileLinks.value = '';
    for (const fact of [elements.factNotice, elements.factAvailability, elements.factWorkAuth, elements.factRelocation, elements.factSalary]) {
      if (fact) fact.value = '';
    }
    elements.cvFile.value = '';
    elements.uploadArea.classList.remove('has-file', 'dragover');
    elements.uploadArea.querySelector('.upload-text').innerHTML = 'Drop file or <span class="upload-link">browse</span>';
    elements.uploadArea.querySelector('.upload-hint').textContent = 'PDF, DOCX, or TXT';
    elements.tailorJd.value = '';
    elements.tailorJobTitle.value = '';
    elements.tailorCompany.value = '';
    elements.tailorOutput.value = '';
    elements.mainView.hidden = false;
    elements.tailorView.hidden = true;
    await resetTailorStateForCvChange();
    await showCVInput();
    await refreshStatsUI();
    showMessage('All DraftApply data was deleted from this browser.');
  }

  // ── CV management ─────────────────────────────────────────────────────────

  async function loadState() {
    const generation = popupDataGeneration;
    const response = await chrome.runtime.sendMessage({ type: 'GET_CV' });
    if (generation !== popupDataGeneration) return;
    currentCvFingerprint = textFingerprint(response.cvText);
    if (response.cvText) showCVLoaded(response.cvText);
    try {
      const { userProfileLinks, applicationFacts } = await chrome.storage.local.get(['userProfileLinks', 'applicationFacts']);
      if (generation !== popupDataGeneration) return;
      if (elements.profileLinks && userProfileLinks) elements.profileLinks.value = userProfileLinks;
      const facts = applicationFacts || {};
      if (elements.factNotice) elements.factNotice.value = facts.notice || '';
      if (elements.factAvailability) elements.factAvailability.value = facts.availability || '';
      if (elements.factWorkAuth) elements.factWorkAuth.value = facts.workAuthorization || '';
      if (elements.factRelocation) elements.factRelocation.value = facts.relocation || '';
      if (elements.factSalary) elements.factSalary.value = facts.salary || '';
    } catch { /* first run */ }
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
        elements.proxyStatusText.textContent = `Proxy: ${providerLabel(status.provider || 'online')}${status.model ? ` · ${shortModelName(status.model)}` : ''}`;
        elements.proxyStatusText.title = [
          status.qualityMode ? `${qualityModeLabel(status.qualityMode)}: ${status.qualityModeReason || ''}` : '',
          status.modelRouter?.applicationAnswer?.reason || status.model || '',
        ].filter(Boolean).join('\n');
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
    const generation = popupDataGeneration;
    const myUploadGeneration = ++uploadGeneration;
    if (/\.doc$/i.test(file.name) || file.type === 'application/msword') {
      showMessage('Legacy .doc files are not supported. Re-save as .docx or PDF, or paste your CV text.', 'error');
      return;
    }
    const validTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];

    if (!validTypes.includes(file.type) && !file.name.match(/\.(pdf|docx|txt)$/i)) {
      showMessage('Please upload a PDF, DOCX, or TXT file', 'error');
      return;
    }

    elements.uploadArea.classList.add('has-file');
    elements.uploadArea.querySelector('.upload-text').textContent = file.name;
    elements.uploadArea.querySelector('.upload-hint').textContent = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
      ? 'Extracting text… scanned PDFs may take longer'
      : 'Extracting text…';

    try {
      const extracted = await extractTextFromFile(file);
      if (generation !== popupDataGeneration || myUploadGeneration !== uploadGeneration) return;
      const text = typeof extracted === 'string' ? extracted : extracted?.text || '';
      pendingCvLinkAnnotations = Array.isArray(extracted?.linkAnnotations) ? extracted.linkAnnotations : [];
      elements.cvText.value = text;
      elements.uploadArea.querySelector('.upload-hint').textContent = 'Text extracted — click Save CV';
      showMessage('File loaded. Review and click Save CV.');
    } catch (err) {
      if (generation !== popupDataGeneration || myUploadGeneration !== uploadGeneration) return;
      elements.uploadArea.classList.remove('has-file');
      elements.uploadArea.querySelector('.upload-text').innerHTML = 'Drop file or <span class="upload-link">browse</span>';
      elements.uploadArea.querySelector('.upload-hint').textContent = 'PDF, DOCX, or TXT';
      showMessage('Could not extract text: ' + err.message, 'error');
    }
  }

  async function extractTextFromFile(file) {
    if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
      const text = await file.text();
      return { text, linkAnnotations: extractLinkAnnotationsFromText(text) };
    }

    if (!proxyUrl) {
      await checkProxy();
      if (!proxyUrl) {
        throw new Error('Proxy not available. Please wait a few seconds and try again.');
      }
    }

    const controller = new AbortController();
    uploadController?.abort();
    uploadController = controller;
    const timer = setTimeout(() => controller.abort(), 60000);

    try {
      const tokenResult = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
      let token = tokenResult?.token;
      if (!token) throw new Error(tokenResult?.error || 'Could not get proxy token');

      const upload = () => {
        // Multipart bodies are one-shot in some fetch implementations. Always
        // rebuild the body for an authentication retry.
        const formData = new FormData();
        formData.append('cv', file);
        return fetch(`${proxyUrl}/api/cv/upload`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
          body: formData, signal: controller.signal,
        });
      };
      let response = await upload();
      if (response.status === 401) {
        const refreshed = await chrome.runtime.sendMessage({ type: 'GET_TOKEN', forceRefresh: true, staleToken: token });
        token = refreshed?.token;
        if (!token) throw new Error(refreshed?.error || 'Could not refresh proxy token');
        response = await upload();
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Extraction failed');
      }

      const result = await response.json();
      return {
        text: result.text || '',
        linkAnnotations: Array.isArray(result.linkAnnotations) ? result.linkAnnotations : [],
      };
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new Error('Timed out while reading the file. For a scan, try fewer pages or a text-based PDF/DOCX; otherwise try again.');
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (uploadController === controller) uploadController = null;
    }
  }

  // Profile URLs the user typed in the popup. Many CVs carry "LinkedIn" as
  // styled text with the URL nowhere in the file (not even as a PDF link
  // annotation), so questions like "LinkedIn URL" honestly answered "Not
  // found in CV". User-entered URLs are authoritative and merge into the
  // same link-annotation channel answers already consume.
  function parseProfileLinks(raw) {
    return String(raw || '').split(/[,\s]+/).map(value => value.trim()).filter(Boolean)
      .map(value => (/^https?:\/\//i.test(value) ? value : `https://${value}`))
      .filter(value => { try { new URL(value); return true; } catch { return false; } })
      .slice(0, 10)
      .map(url => ({ text: linkLabelFromUrl(url), url }));
  }

  async function saveCV() {
    const generation = popupDataGeneration;
    const text = elements.cvText.value.trim();
    if (text.length < 50) {
      showMessage('Please enter more CV content', 'error');
      return;
    }
    elements.saveCvBtn.disabled = true;
    elements.saveCvBtn.textContent = 'Saving…';
    try {
      const previous = await chrome.runtime.sendMessage({ type: 'GET_CV' }).catch(() => ({}));
      if (generation !== popupDataGeneration) return;
      const cvChanged = Boolean(previous?.cvText && previous.cvText !== text);
      const extractedAnnotations = cvChanged || pendingCvLinkAnnotations.length > 0
        ? pendingCvLinkAnnotations
        : Array.isArray(previous?.linkAnnotations) ? previous.linkAnnotations : [];
      const profileLinksRaw = elements.profileLinks?.value?.trim() || '';
      const manualLinks = parseProfileLinks(profileLinksRaw);
      const seenUrls = new Set(manualLinks.map(a => a.url.toLowerCase()));
      const linkAnnotations = [
        ...manualLinks,
        ...extractedAnnotations.filter(a => !seenUrls.has(String(a?.url || '').toLowerCase())),
      ];
      const applicationFacts = {
        notice: elements.factNotice?.value?.trim() || '',
        availability: elements.factAvailability?.value?.trim() || '',
        workAuthorization: elements.factWorkAuth?.value?.trim() || '',
        relocation: elements.factRelocation?.value?.trim() || '',
        salary: elements.factSalary?.value?.trim() || '',
      };
      if (generation !== popupDataGeneration) return;
      const saved = await chrome.runtime.sendMessage({
        type: 'SAVE_CV', cvText: text, linkAnnotations,
        userProfileLinks: profileLinksRaw, applicationFacts,
      });
      if (!saved?.success) return;
      if (generation !== popupDataGeneration) return;
      pendingCvLinkAnnotations = linkAnnotations;
      currentCvFingerprint = textFingerprint(text);
      if (cvChanged) await resetTailorStateForCvChange({ invalidateDocument: true });
      showCVLoaded(text);
      showMessage(cvChanged ? 'CV saved. Re-analyze any saved JD before generating a new tailored CV.' : 'CV saved successfully');
    } finally {
      elements.saveCvBtn.disabled = false;
      elements.saveCvBtn.textContent = 'Save CV';
    }
  }

  async function resetTailorStateForCvChange({ invalidateDocument = false } = {}) {
    tailorToken++;
    stopTailorJobPolling();
    stopTailorLoadingHint();
    await chrome.runtime.sendMessage({ type: 'CANCEL_TAILOR_JOB' }).catch(() => {});
    if (invalidateDocument) await TailoredDocumentStore.clearActive().catch(() => {});
    activeTailoredDocument = null;
    reviewedTextDesired = null;
    reviewedTextSavePromise = Promise.resolve(null);
    lastStructuredCv = null;
    lastStructuredText = '';
    tailorAccuracyBlocked = false;
    blockedTailorText = null;
    elements.tailorOutput.value = '';
    elements.tailorOutputWrap.hidden = true;
    elements.tailorActionRow.hidden = true;
    elements.tailorWarningsBox.hidden = true;
    if (elements.tailorAgentInsights) {
      elements.tailorAgentInsights.hidden = true;
      elements.tailorAgentInsights.textContent = '';
    }
    elements.tailorResults.hidden = true;
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
    stopTailorJobPolling();
    stopTailorLoadingHint();
    elements.mainView.hidden = true;
    elements.tailorView.hidden = false;
    elements.tailorResults.hidden = true;
    elements.tailorLoading.hidden = true;
    elements.tailorMessage.hidden = true;
    elements.tailorGenerateBtn.hidden = false;
    elements.tailorGenerateBtn.disabled = false;
    elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
    setStep('paste');
    await restoreTailorDraft({ restoreJob: true });
  }

  function closeTailorView() {
    flushReviewedTextSave().catch(() => {});
    stopTailorJobPolling();
    stopTailorLoadingHint();
    elements.tailorView.hidden = true;
    elements.mainView.hidden = false;
    elements.tailorWarningsBox.hidden = true;
    elements.tailorMessage.hidden = true;
  }

  async function restoreTailorDraft(options = {}) {
    const generation = popupDataGeneration;
    try {
      const [draftResult, jobResult, cvResult] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_TAILOR_DRAFT_FOR_ACTIVE_PAGE' }).catch(() => null),
        chrome.runtime.sendMessage({ type: 'GET_TAILOR_JOB_FOR_ACTIVE_PAGE' }).catch(() => null),
        chrome.runtime.sendMessage({ type: 'GET_CV' }).catch(() => null),
      ]);
      if (generation !== popupDataGeneration) return;
      const draft = draftResult?.draft;
      if (draftResult?.snapshot) activeTabSnapshot = draftResult.snapshot;
      if (jobResult?.snapshot) activeTabSnapshot = jobResult.snapshot;
      const job = jobResult?.job;
      currentCvFingerprint = textFingerprint(cvResult?.cvText);

      if (draft) {
        elements.tailorJd.value = draft.jobDescription || '';
        elements.tailorJobTitle.value = draft.jobTitle || '';
        elements.tailorCompany.value = draft.company || '';
      }

      const document = await TailoredDocumentStore.loadActive();
      if (generation !== popupDataGeneration) return;
      const relevantDocument = document && tailoredDocumentMatchesPage(document, draft, activeTabSnapshot);
      activeTailoredDocument = relevantDocument ? document : null;
      if (options.restoreJob && relevantDocument) {
        restoreTailoredDocument(document);
        showTailorMessage('Restored your reviewed tailored CV.');
      } else if (options.restoreJob && job) {
        restoreTailorJob(job);
      }
    } catch (e) {
      // Draft restore is best-effort; the main popup must still load.
    }
  }

  async function restoreTailorJob(job, { inline = false } = {}) {
    if (!job || !['running', 'done', 'error'].includes(job.status)) return;

    const startedAt = Date.parse(job.startedAt || '');
    const jobAgeMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
    if (job.status === 'running' && jobAgeMs > TAILOR_JOB_MAX_POLL_MS) {
      stopTailorJobPolling();
      chrome.runtime.sendMessage({ type: 'CANCEL_TAILOR_JOB', jobId: job.id }).catch(() => {});
      elements.tailorLoading.hidden = true;
      elements.tailorGenerateBtn.hidden = false;
      elements.tailorGenerateBtn.disabled = false;
      elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
      elements.tailorRedoBtn.disabled = false;
      showTailorMessage('Previous CV generation timed out before DraftApply could finish. Please try again.', 'error');
      setStep('generate');
      return;
    }

    if (job.status === 'running') {
      elements.tailorJd.value = job.jobDescription || elements.tailorJd.value;
      elements.tailorJobTitle.value = job.jobTitle || elements.tailorJobTitle.value;
      elements.tailorCompany.value = job.company || elements.tailorCompany.value;
      startTailorLoadingHint(job.startedAt);
      elements.tailorGenerateBtn.hidden = false;
      elements.tailorGenerateBtn.disabled = true;
      elements.tailorGenerateBtn.textContent = 'Generating…';
      elements.tailorLoading.hidden = false;
      elements.tailorLoadingText.textContent = 'Tailoring your CV…';
      elements.tailorLoadingSub.textContent = tailorFallbackHintDue(job.startedAt)
        ? 'Provider is busy, retrying fallback models…'
        : 'You can close this popup — fallback may take a few minutes.';
      elements.tailorResults.hidden = true;
      setStep('generate');
      startTailorJobPolling(job.id, inline);
      return;
    }

    stopTailorJobPolling();
    stopTailorLoadingHint();
    elements.tailorLoading.hidden = true;
    elements.tailorGenerateBtn.disabled = false;
    elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
    elements.tailorRedoBtn.disabled = false;

    if (job.status === 'done' && job.result) {
      if (!tailorJobMatchesCurrent(job)) {
        elements.tailorGenerateBtn.hidden = false;
        setStep('paste');
        return;
      }
      const completionToken = tailorToken;
      await displayTailorResults(job.result, { sourceJob: job, expectedTailorToken: completionToken });
      if (completionToken !== tailorToken) return;
      if (inline) {
        saveTailorDraft();
        window.DraftApplyStats?.track?.('cvsTailored').catch?.(() => {});
        refreshStatsUI();
      } else {
        showTailorMessage('Restored your generated CV.');
      }
    } else if (job.status === 'error') {
      elements.tailorGenerateBtn.hidden = false;
      showTailorMessage(job.error || 'Previous CV generation failed. Please try again.', 'error');
      setStep('generate');
    }
  }

  function startTailorJobPolling(jobId, inline = false) {
    stopTailorJobPolling();
    const generation = popupDataGeneration;
    const reviewToken = tailorToken;
    tailorJobPollStartedAt = Date.now();
    tailorJobPollTimer = setInterval(async () => {
      try {
        const stored = await chrome.storage.local.get(TAILOR_JOB_KEY);
        if (generation !== popupDataGeneration || reviewToken !== tailorToken) return;
        const job = stored?.[TAILOR_JOB_KEY];
        const startedAt = Date.parse(job?.startedAt || '');
        const jobAgeMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Date.now() - tailorJobPollStartedAt;
        if (jobAgeMs > TAILOR_JOB_MAX_POLL_MS) {
          stopTailorJobPolling();
          stopTailorLoadingHint();
          await chrome.runtime.sendMessage({ type: 'CANCEL_TAILOR_JOB', jobId: job?.id }).catch(() => {});
          elements.tailorLoading.hidden = true;
          elements.tailorGenerateBtn.hidden = false;
          elements.tailorGenerateBtn.disabled = false;
          elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
          elements.tailorRedoBtn.disabled = false;
          showTailorMessage('CV generation is taking longer than expected. Please try again; no CV was changed.', 'error');
          setStep('generate');
          return;
        }
        if (!job || (jobId && job.id !== jobId)) return;
        if (job.status === 'done' || job.status === 'error') {
          if (reviewToken !== tailorToken) return;
          restoreTailorJob(job, { inline });
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

  function tailorFallbackHintDue(startedAt) {
    const startedMs = Date.parse(startedAt || '');
    return Number.isFinite(startedMs) && Date.now() - startedMs >= TAILOR_FALLBACK_HINT_MS;
  }

  function startTailorLoadingHint(startedAt = new Date().toISOString()) {
    stopTailorLoadingHint();
    const startedMs = Date.parse(startedAt || '');
    const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
    const delayMs = Math.max(0, TAILOR_FALLBACK_HINT_MS - elapsedMs);
    tailorLoadingFallbackTimer = setTimeout(() => {
      if (!elements.tailorLoading.hidden) {
        elements.tailorLoadingSub.textContent = 'Provider is busy, retrying fallback models…';
      }
      tailorLoadingFallbackTimer = null;
    }, delayMs);
  }

  function stopTailorLoadingHint() {
    if (tailorLoadingFallbackTimer) clearTimeout(tailorLoadingFallbackTimer);
    tailorLoadingFallbackTimer = null;
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
    const generation = popupDataGeneration;
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
      if (generation !== popupDataGeneration) return;
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

  function tailorJdFingerprint(value) {
    return textFingerprint(value);
  }

  function textFingerprint(value) {
    const text = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return text ? String(hash) : '';
  }

  function tailoredDocumentMatchesPage(document, draft, snapshot) {
    const source = document?.metadata?.source;
    if (!source) return false;
    const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!source.jdFingerprint || source.jdFingerprint !== tailorJdFingerprint(draft?.jobDescription)) return false;
    if (!source.cvFingerprint || source.cvFingerprint !== currentCvFingerprint) return false;
    const currentUrl = draft?.sourceUrl || snapshot?.url || '';
    if (source.sourceUrl && currentUrl && source.sourceUrl !== currentUrl) return false;
    const currentTitle = draft?.jobTitle || snapshot?.pageContext?.jobTitle || '';
    const currentCompany = draft?.company || snapshot?.pageContext?.company || '';
    if (source.jobTitle && currentTitle && normalize(source.jobTitle) !== normalize(currentTitle)) return false;
    if (source.company && currentCompany && normalize(source.company) !== normalize(currentCompany)) return false;
    return Boolean(source.sourceUrl && currentUrl && source.sourceUrl === currentUrl)
      || Boolean(source.jobTitle && currentTitle && normalize(source.jobTitle) === normalize(currentTitle));
  }

  function resetTailorReview() {
    // Invalidate any in-flight tailor response.
    tailorToken++;
    stopTailorJobPolling();

    elements.tailorGenerateBtn.hidden = false;
    elements.tailorGenerateBtn.disabled = false;
    elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
    elements.tailorResults.hidden = true;
    elements.tailorOutputWrap.hidden = true;
    elements.tailorActionRow.hidden = true;
    elements.tailorWarningsBox.hidden = true;
    elements.tailorOutput.value = '';
    chrome.runtime.sendMessage({ type: 'CANCEL_TAILOR_JOB' }).catch(() => {});
    setStep('paste');
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
    elements.tailorLoadingSub.textContent = 'This can take a few minutes if DraftApply needs fallback';
    startTailorLoadingHint();
    elements.tailorMessage.hidden = true;
    const confirmedSkills = getConfirmedMissingSkills();
    elements.tailorOutputWrap.hidden = true;
    elements.tailorActionRow.hidden = true;
    setStep('generate');
    stopTailorJobPolling();
    await chrome.runtime.sendMessage({ type: 'CANCEL_TAILOR_JOB' }).catch(() => {});
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

      // Background responded immediately — poll storage for the actual result.
      if (result?.started) {
        startTailorJobPolling(result.jobId, true);
        return;
      }

      await displayTailorResults(result);
      await saveTailorDraft();
      await window.DraftApplyStats?.track?.('cvsTailored');
      await refreshStatsUI();
    } catch (e) {
      if (myToken !== tailorToken) return;
      showTailorMessage('Something went wrong: ' + e.message, 'error');
    } finally {
      // Don't hide the spinner if storage polling is now responsible for the UI.
      if (myToken === tailorToken && !tailorJobPollTimer) {
        stopTailorLoadingHint();
        elements.tailorLoading.hidden = true;
        elements.tailorGenerateBtn.disabled = false;
        elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
        elements.tailorRedoBtn.disabled = false;
      }
    }
  }

  // Structured payload from the last generation (docs/structured-cv-generation.md).
  // Passed to the export page so it can render HTML directly from structure
  // instead of re-parsing text - but only while the textarea still matches
  // the rendered text (a user edit invalidates the structured copy).
  let lastStructuredCv = null;
  let lastStructuredText = '';

  function tailorJobMatchesCurrent(job) {
    return Boolean(job?.sourceCvFingerprint)
      && job.sourceCvFingerprint === currentCvFingerprint
      && job.jdFingerprint === tailorJdFingerprint(elements.tailorJd.value);
  }

  async function displayTailorResults(result, { persist = true, sourceJob = null, expectedTailorToken = tailorToken } = {}) {
    const tailoredCvText = result.renderedText || result.tailoredCvText;
    const matchReport = result.analysis?.matchReport || result.matchReport;
    const warnings = result.analysis?.warnings || result.warnings;
    const { provider, fallbackFrom, model } = result;
    const blockedTextFingerprint = result.blockedTextFingerprint
      || (shouldBlockTailorExport({ warnings }) ? textFingerprint(tailoredCvText) : '');
    tailorAccuracyBlocked = shouldBlockTailorExport({ warnings })
      && (!result.audit?.edited || textFingerprint(tailoredCvText) === blockedTextFingerprint);
    blockedTailorText = tailorAccuracyBlocked ? (tailoredCvText || '') : null;
    lastStructuredCv = result.skeleton && result.content
      ? { skeleton: result.skeleton, content: result.content }
      : result.structuredCv || null;
    lastStructuredText = tailoredCvText || '';
    if (persist && lastStructuredCv && tailoredCvText) {
      const document = TailoredDocumentStore.create(result, {
        contactUrls: {},
        linkAnnotations: [],
        source: {
          ...buildTailorSourceMetadata(),
          jobTitle: sourceJob?.jobTitle || elements.tailorJobTitle.value.trim(),
          company: sourceJob?.company || elements.tailorCompany.value.trim(),
          jdFingerprint: sourceJob?.jdFingerprint || tailorJdFingerprint(elements.tailorJd.value),
          cvFingerprint: sourceJob?.sourceCvFingerprint || currentCvFingerprint,
        },
        review: {
          analysis: result.analysis || null,
          matchReport: result.matchReport || null,
          warnings: result.warnings || null,
          agentInsights: result.agentInsights || null,
          provider: result.provider || null,
          fallbackFrom: result.fallbackFrom || null,
          model: result.model || null,
          recoveryNotice: result.recoveryNotice || null,
          blockedTextFingerprint,
        },
      });
      elements.tailorOutput.disabled = true;
      elements.tailorCopyBtn.disabled = true;
      elements.tailorPdfBtn.disabled = true;
      try {
        const saved = await TailoredDocumentStore.saveNew(document);
        if (expectedTailorToken !== tailorToken || (sourceJob && !tailorJobMatchesCurrent(sourceJob))) {
          await TailoredDocumentStore.clearActive(saved.documentId, saved.revision).catch(() => {});
          return;
        }
        activeTailoredDocument = saved;
        reviewedTextDesired = saved.renderedText;
      } catch {
        showTailorMessage('Could not save this tailored CV. Keep the popup open and try again.', 'error');
        return;
      } finally {
        elements.tailorOutput.disabled = false;
      }
    }
    displayMatchReport(matchReport, { reviewMode: false, domainSuggestions: [] });
    renderTailorAgentInsights(result.analysis?.agentInsights || result.agentInsights || result);

    const badge = document.getElementById('tailor-provider-badge');
    if (badge) {
      if (provider) {
        const label = providerLabel(provider);
        const modelLabel = shortModelName(model);
        badge.textContent = fallbackFrom
          ? `${label} fallback${modelLabel ? `: ${modelLabel}` : ''}`
          : `${label}${modelLabel ? `: ${modelLabel}` : ''}`;
        badge.title = fallbackFrom
          ? `Fallback from ${providerLabel(fallbackFrom)}. Model: ${model || 'unknown'}`
          : `Model: ${model || 'unknown'}`;
        badge.style.background = provider === 'openrouter' ? '#fef3c7' : '#d1fae5';
        badge.style.color = provider === 'openrouter' ? '#92400e' : '#065f46';
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }

    const auditBadge = document.getElementById('tailor-audit-badge');
    if (auditBadge) {
      auditBadge.textContent = result.audit?.recovered ? 'Original content safely retained' : '';
      auditBadge.style.display = result.audit?.recovered ? 'inline-block' : 'none';
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
    elements.tailorCopyBtn.disabled = tailorAccuracyBlocked || !activeTailoredDocument;
    elements.tailorPdfBtn.disabled = tailorAccuracyBlocked || !activeTailoredDocument;
    elements.tailorResults.hidden = false;
    elements.tailorGenerateBtn.hidden = true;

    elements.tailorResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStep('export');
  }

  function restoreTailoredDocument(document) {
    const review = document.metadata?.review || {};
    displayTailorResults({
      ...review,
      blockedTextFingerprint: review.blockedTextFingerprint || '',
      schemaVersion: document.schemaVersion,
      skeleton: document.skeleton,
      content: document.content,
      renderedText: document.renderedText,
      audit: document.audit,
    }, { persist: false });
    reviewedTextDesired = document.renderedText;
  }

  function scheduleReviewedTextSave() {
    reviewedTextDesired = elements.tailorOutput.value;
    queueReviewedTextSave().catch(() => {});
  }

  function queueReviewedTextSave() {
    const generation = popupDataGeneration;
    reviewedTextSavePromise = reviewedTextSavePromise.catch(() => null).then(async () => {
      while (generation === popupDataGeneration) {
        const current = activeTailoredDocument;
        const desired = reviewedTextDesired;
        if (!current || desired == null || current.renderedText === desired) return current;
        const saved = await TailoredDocumentStore.saveReviewedText(
          current.documentId,
          current.revision,
          desired,
        );
        if (generation !== popupDataGeneration) return null;
        if (saved) {
          activeTailoredDocument = saved;
          continue;
        }
        const latest = await TailoredDocumentStore.loadActive();
        if (!latest || latest.documentId !== current.documentId) return null;
        activeTailoredDocument = latest;
      }
      return null;
    });
    return reviewedTextSavePromise;
  }

  async function flushReviewedTextSave() {
    reviewedTextDesired = elements.tailorOutput.value;
    return queueReviewedTextSave();
  }

  function formatTailorWarnings(warnings = []) {
    warnings = (Array.isArray(warnings) ? warnings : []).filter(w => !isParserArtefactWarning(w));
    if (warnings.length === 0) return '';

    // Sort warnings into three buckets for display
    const accuracy = [];   // locked fields changed, fabricated metrics
    const missing  = [];   // user-confirmed skills the LLM didn't add
    const quality  = [];   // formatting, unsupported claims, structural issues

    for (const w of warnings) {
      if (isAccuracyWarning(w)) {
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

    // Accuracy items (a changed company name, an invented figure) demand the
    // user's attention and stay visible. Structural quality signals are for
    // the curious - collapsed behind "More checks".
    const primary = [];
    const secondary = [];

    if (accuracy.length > 0) {
      primary.push(`
        <div class="tw-group tw-group-accuracy">
          <div class="tw-group-label">Accuracy — check these are still correct</div>
          <ul class="tailor-warning-list">${accuracy.map(w => `<li>${humaniseAccuracy(w)}</li>`).join('')}</ul>
        </div>`);
    }

    if (missing.length > 0) {
      secondary.push(`
        <div class="tw-group tw-group-missing">
          <div class="tw-group-label">Skills not added — add manually if relevant</div>
          <ul class="tailor-warning-list">${missing.map(s => `<li><strong>${esc(s)}</strong></li>`).join('')}</ul>
        </div>`);
    }

    if (quality.length > 0) {
      secondary.push(`
        <div class="tw-group tw-group-quality">
          <div class="tw-group-label">Quality checks</div>
          <ul class="tailor-warning-list">${quality.map(w => `<li>${humaniseQuality(w)}</li>`).join('')}</ul>
        </div>`);
    }

    if (primary.length === 0 && secondary.length === 0) return '';
    const secondaryBlock = secondary.length > 0
      ? `<details class="tw-details"><summary class="agent-insights-summary">More checks</summary>${secondary.join('')}</details>`
      : '';
    return `<div class="tailor-warning-title">Review before sending</div>${primary.join('')}${secondaryBlock}`;
  }

  function isAccuracyWarning(warning) {
    return /^(Company name|Job title|Employment|Education|Education institution|Email address|Phone number|LinkedIn|GitHub|Website|Twitter|Full name|New metric|Unsupported JD skill)/i.test(String(warning || ''));
  }

  function isUnsafeTailorWarning(warning) {
    return /^(?:Company name|Job title|Employment|Education|Education institution|Email address|Phone number|LinkedIn|GitHub|Website|Twitter|Full name|New metric|Unsupported JD skill)|without original CV evidence|evidence from the original CV is not visible|not read credibly|under-positioned|implementation-only|skills rather than supported experience|High-risk/i.test(String(warning || ''));
  }

  function shouldBlockTailorExport({ warnings = [] } = {}) {
    return Array.isArray(warnings) && warnings.some(isUnsafeTailorWarning);
  }

  function isParserArtefactWarning(warning) {
    const val = (String(warning || '').match(/: "(.+)"$/) || [])[1] || '';
    if (!val || val.length > 80) return false;
    const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
    const place = '(?:UK|United Kingdom|England|Scotland|Wales|Ireland|Nigeria|USA|United States|Canada|Germany|France|Remote|London|Birmingham|Manchester|Lagos|Abuja)';
    return new RegExp(`\\b${place}${month}\\b|,\\s*\\b${place}\\s*${month}\\b`, 'i').test(val);
  }

  function displayMatchReport(matchReport, { reviewMode, domainSuggestions = [] } = {}) {
    const score = matchReport?.score ?? null;
    elements.matchScore.textContent = score != null
      ? `Before tailoring, your original CV directly supported ${score}% of the job requirements identified.`
      : 'Original CV evidence unavailable.';

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

    const missing = normalizeMissingSkills(matchReport);
    if (missing.length > 0) {
      // Informational only. The tick-to-confirm flow let unvetted JD phrases
      // flow into the CV's competencies; missing skills are now simply shown
      // so the user knows the gap, and the tailored CV never claims them.
      elements.matchMissingChips.innerHTML = missing
        .map(s => `<span class="match-chip match-chip-missing">${esc(s)}</span>`)
        .join('');
      elements.matchMissing.hidden = false;
      elements.matchAllClear.hidden = true;
    } else {
      elements.matchMissing.hidden = true;
      // Show "all clear" only in review mode (before generation)
      elements.matchAllClear.hidden = !reviewMode;
    }

    // Domain-suggestion confirmations retired along with the tick-to-confirm
    // flow: suggested tools the CV cannot evidence stay out of the CV.
    elements.matchDomain.hidden = true;
  }

  function renderTailorAgentInsights(insights = {}) {
    const box = elements.tailorAgentInsights;
    if (!box) return;

    const workflow = insights.workflow;
    const chain = Array.isArray(insights.agentChain) ? insights.agentChain : [];
    const gap = insights.gapAnalysis || {};
    const keywords = insights.keywordOptimisation || {};
    const ats = insights.atsFormatting || {};
    const truth = insights.truthfulness || {};
    const retrieval = insights.evidenceRetrieval || {};
    const domainRisk = insights.domainRisk || insights.truthfulnessReport?.domainRisk || {};
    const missing = Array.isArray(gap.missingRequirements) ? gap.missingRequirements : [];
    const transferable = Array.isArray(gap.transferableRequirements) ? gap.transferableRequirements : [];
    const supported = Array.isArray(keywords.supportedKeywords) ? keywords.supportedKeywords : [];
    const risky = Array.isArray(keywords.riskyKeywords) ? keywords.riskyKeywords : [];
    const visibleEvidence = Array.isArray(ats.requiredVisibleEvidence) ? ats.requiredVisibleEvidence : [];
    const supportedKeys = new Set(supported.map(value => normaliseInsightValue(value)).filter(Boolean));
    const visibleEvidenceOnly = visibleEvidence.filter(value => {
      const key = normaliseInsightValue(value);
      return key && !supportedKeys.has(key);
    });

    if (!workflow && missing.length === 0 && transferable.length === 0 && supported.length === 0 && risky.length === 0 && visibleEvidence.length === 0 && !domainRisk.detected) {
      box.hidden = true;
      box.textContent = '';
      return;
    }

    // Supporting detail only: the match report above already tells the user
    // what matched and what's missing. No workflow/agent/retrieval vocabulary,
    // no duplicate matched-skills list — the remaining groups fold into one
    // collapsed disclosure.
    const sections = [];

    if (transferable.length > 0) {
      sections.push(renderInsightChipGroup('Adjacent experience (framed carefully, never claimed)', transferable, 'agent-chip-info'));
    }

    if (risky.length > 0) {
      sections.push(renderInsightChipGroup('Left out — not evidenced in your CV', risky, 'agent-chip-warn'));
    }

    if (domainRisk.detected) {
      const profile = domainRisk.primaryProfile?.label || 'Domain review';
      const prompts = Array.isArray(domainRisk.reviewPrompts) ? domainRisk.reviewPrompts : [];
      const credentialWarnings = Array.isArray(domainRisk.credentialWarnings) ? domainRisk.credentialWarnings : [];
      sections.push(`
        <div class="agent-insights-group agent-domain-review">
          <div class="agent-insights-label">Domain review</div>
          <div class="agent-domain-title">${esc(profile)}${domainRisk.primaryProfile?.riskLevel ? ` · ${esc(domainRisk.primaryProfile.riskLevel)}` : ''}</div>
          ${credentialWarnings.length > 0 ? `
            <div class="agent-insights-chips">
              ${credentialWarnings.flatMap(item => item.missingCredentials || []).slice(0, 6).map(value => `<span class="agent-chip agent-chip-warn">${esc(value)}</span>`).join('')}
            </div>` : ''}
          ${prompts.length > 0 ? `<ul class="agent-domain-prompts">${prompts.slice(0, 3).map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : ''}
        </div>`);
    }

    if (visibleEvidenceOnly.length > 0) {
      sections.push(renderInsightChipGroup('Additional ATS evidence to keep visible', visibleEvidenceOnly, 'agent-chip-info'));
    }

    if (sections.length === 0) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.innerHTML = `
      <details class="agent-insights-details">
        <summary class="agent-insights-summary">Details</summary>
        ${sections.join('')}
      </details>`;
    box.hidden = false;
  }

  function renderInsightChipGroup(label, values, chipClass = '') {
    return `
      <div class="agent-insights-group">
        <div class="agent-insights-label">${esc(label)}</div>
        <div class="agent-insights-chips">
          ${values.slice(0, 10).map(value => `<span class="agent-chip ${chipClass}">${esc(value)}</span>`).join('')}
        </div>
      </div>`;
  }

  function normaliseInsightValue(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
  }

  function normalizeMissingSkills(matchReport = {}) {
    const source = Array.isArray(matchReport.unsupportedRequirements) && matchReport.unsupportedRequirements.length > 0
      ? matchReport.unsupportedRequirements
      : Array.isArray(matchReport.missingSkills)
        ? matchReport.missingSkills
        : [];

    return source
      .map(item => typeof item === 'string' ? item : item?.skill || item?.requirement || item?.name)
      .map(item => String(item || '').trim())
      // The checkbox is an attestation by the candidate. Only offer concise,
      // atomic skills for confirmation; never ask a user to attest to a whole
      // JD sentence or a bundled list of requirements.
      .filter(item => item && item.length <= 64)
      .filter(item => item.split(/\s+/).length <= 4)
      .filter(item => !/[,;\n]|\s(?:\/|\||&)\s|\s\b(?:and|or)\b\s/i.test(item))
      .filter(item => !/\b(?:years?\s+of\s+experience|experience\s+(?:with|in)|ability\s+to|production\s+experience|required|preferred)\b/i.test(item))
      .filter(item => !/^(?:must|should|build|develop|manage|deliver|own|responsible|proven)\b/i.test(item));
  }

  function providerLabel(provider = '') {
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'groq') return 'Groq';
    if (provider === 'local-openai') return 'Local';
    if (provider === 'local-openai-embeddings') return 'Local embeddings';
    return provider || 'Model';
  }

  function qualityModeLabel(mode = '') {
    if (mode === 'hosted_primary') return 'Hosted primary';
    if (mode === 'hosted_primary_with_openrouter_fallback') return 'Hosted primary + fallback';
    if (mode === 'local_private') return 'Local private';
    if (mode === 'configured_openrouter') return 'Configured OpenRouter';
    if (mode === 'openrouter_fallback') return 'OpenRouter fallback';
    if (mode === 'best_effort_free_fallback') return 'Best-effort free fallback';
    if (mode === 'deterministic_local') return 'Deterministic local';
    return mode || 'Quality mode';
  }

  function shortModelName(model = '') {
    const raw = String(model || '').trim();
    if (!raw) return '';
    return raw
      .replace(/^openrouter\//, '')
      .replace(/:free$/, ' free')
      .split('/')
      .slice(-1)[0]
      .replace(/-/g, ' ')
      .slice(0, 34);
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
    if (tailorAccuracyBlocked) {
      showTailorMessage('Resolve the accuracy warnings or edit the CV before copying.', 'error');
      return;
    }
    const text = elements.tailorOutput.value;
    if (!text) return;
    try {
      const saved = await flushReviewedTextSave();
      if (!saved) throw new Error('Could not save reviewed text');
      await navigator.clipboard.writeText(text);
      const orig = elements.tailorCopyBtn.textContent;
      elements.tailorCopyBtn.textContent = 'Copied!';
      setTimeout(() => { elements.tailorCopyBtn.textContent = orig; }, 1800);
    } catch {
      showTailorMessage('Could not copy — try selecting the text manually', 'error');
    }
  }

  async function downloadAsPdf() {
    if (tailorAccuracyBlocked) {
      showTailorMessage('Resolve the accuracy warnings or edit the CV before exporting.', 'error');
      return;
    }
    const text = elements.tailorOutput.value;
    if (!text) return;
    const generation = popupDataGeneration;
    try {
      // Fetch the original CV to extract contact URLs that the LLM may have
      // stripped from the tailored text (e.g. writing "LinkedIn" without the URL).
      // These are stored as a fallback so cv-export.js can re-link profile labels.
      let contactUrls = {};
      let linkAnnotations = [];
      try {
        const cvResp = await chrome.runtime.sendMessage({ type: 'GET_CV' });
        contactUrls = extractCvContactUrls(stripAutoLinksTrailer(cvResp?.cvText || ''));
        linkAnnotations = Array.isArray(cvResp?.linkAnnotations) ? cvResp.linkAnnotations : [];
      } catch { /* non-fatal */ }

      if (generation !== popupDataGeneration) return;

      let document = await flushReviewedTextSave();
      if (!document) throw new Error('The reviewed CV changed elsewhere. Reopen it before exporting.');
      if (Object.keys(contactUrls).length || linkAnnotations.length) {
        document = await TailoredDocumentStore.saveRevision(document.documentId, document.revision, {
          metadata: { ...document.metadata, contactUrls, linkAnnotations },
        });
        if (!document) throw new Error('The tailored CV changed elsewhere.');
      }
      activeTailoredDocument = document;
      if (generation !== popupDataGeneration) return;
      const query = new URLSearchParams({ documentId: document.documentId, revision: String(document.revision) });
      await chrome.tabs.create({ url: `${chrome.runtime.getURL('cv-export.html')}?${query}` });
      await window.DraftApplyStats?.track?.('cvExports');
      await refreshStatsUI();
    } catch (e) {
      showTailorMessage('Could not open the export page. Please try again.', 'error');
    }
  }

  // "Links:" is CV-upload's own trailer collecting every hyperlink
  // annotation in the source file (including reference links inside body
  // bullets - a blog post, a book, a conference page), not just the
  // candidate's own profile links. Only stripped when every line after it
  // is a bare URL, so a genuine human-authored "Links" section is untouched.
  function stripAutoLinksTrailer(text) {
    const raw = String(text || '');
    const match = raw.match(/\n{1,3}Links:[ \t]*\n([\s\S]*)$/i);
    if (!match) return raw;
    const trailerLines = match[1].split('\n').map(line => line.trim()).filter(Boolean);
    if (trailerLines.length === 0 || !trailerLines.every(line => /^https?:\/\/\S+$/i.test(line))) return raw;
    return raw.slice(0, match.index).replace(/\s+$/, '');
  }

  function extractCvContactUrls(text) {
    const ensure = (u) => u ? (u.startsWith('http') ? u : 'https://' + u) : '';
    // Scoped to the header: a profile-link regex matched against the whole
    // document can pick up an unrelated reference link from further down
    // the CV and misreport it as the candidate's own LinkedIn/GitHub/site.
    const headerText = text.split('\n').slice(0, 20).join('\n');
    const li  = headerText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i);
    const gh  = headerText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i);
    const tw  = headerText.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[\w-]+\/?/i);
    const web = headerText.match(
      /(?<!@)\b(?:(?:https?:\/\/|www\.)?(?!(?:www\.)?(?:linkedin|github|twitter|x)\.com\b)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?)/i
    );
    return {
      linkedin:  ensure(li?.[0]),
      github:    ensure(gh?.[0]),
      twitter:   ensure(tw?.[0]),
      website:   ensure(web?.[0]),
    };
  }

  function extractLinkAnnotationsFromText(text) {
    const urls = String(text || '').match(/https?:\/\/[^\s<>"')]+/gi) || [];
    const seen = new Set();
    return urls.map(url => {
      const clean = url.replace(/[).,;:!?]+$/, '');
      const label = linkLabelFromUrl(clean);
      return { text: label, url: clean };
    }).filter(item => {
      const key = `${String(item.text || '').toLowerCase()}|${item.url}`;
      if (!item.text || !item.url || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 100);
  }

  function linkLabelFromUrl(url = '') {
    const raw = String(url || '').trim();
    if (/linkedin\.com/i.test(raw)) return 'LinkedIn';
    if (/github\.com/i.test(raw)) return 'GitHub';
    if (/gitlab\.com/i.test(raw)) return 'GitLab';
    if (/stackoverflow\.com/i.test(raw)) return 'Stack Overflow';
    if (/behance\.net/i.test(raw)) return 'Behance';
    if (/dribbble\.com/i.test(raw)) return 'Dribbble';
    if (/kaggle\.com/i.test(raw)) return 'Kaggle';
    try {
      return new URL(raw).hostname.replace(/^www\./i, '');
    } catch {
      return raw;
    }
  }

  function showTailorMessage(text, type = 'success') {
    clearTimeout(tailorMessageTimer);
    elements.tailorMessage.textContent = text;
    elements.tailorMessage.className = 'message' + (type === 'error' ? ' error' : '');
    elements.tailorMessage.hidden = false;
    // Errors stay visible until the user acts (clicks Generate again).
    // Success messages auto-hide after 5 s.
    if (type !== 'error') {
      tailorMessageTimer = setTimeout(() => { elements.tailorMessage.hidden = true; }, 5000);
    }
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

});
