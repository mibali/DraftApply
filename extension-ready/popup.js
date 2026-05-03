/**
 * DraftApply Popup Script
 * 
 * Handles CV management and backend status display
 * No API key configuration needed - backend handles LLM
 */

document.addEventListener('DOMContentLoaded', async () => {
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
    // Tailor view
    mainView:           document.getElementById('main-view'),
    tailorView:         document.getElementById('tailor-view'),
    tailorBackBtn:      document.getElementById('tailor-back-btn'),
    tailorJd:           document.getElementById('tailor-jd'),
    tailorJobTitle:     document.getElementById('tailor-job-title'),
    tailorCompany:      document.getElementById('tailor-company'),
    tailorGenerateBtn:  document.getElementById('tailor-generate-btn'),
    tailorLoading:      document.getElementById('tailor-loading'),
    tailorResults:      document.getElementById('tailor-results'),
    matchScore:         document.getElementById('match-score'),
    matchStrong:        document.getElementById('match-strong'),
    matchStrongChips:   document.getElementById('match-strong-chips'),
    matchMissing:       document.getElementById('match-missing'),
    matchMissingChips:  document.getElementById('match-missing-chips'),
    tailorWarningsBox:  document.getElementById('tailor-warnings-box'),
    tailorOutput:       document.getElementById('tailor-output'),
    tailorCopyBtn:      document.getElementById('tailor-copy-btn'),
    tailorPdfBtn:       document.getElementById('tailor-pdf-btn'),
    tailorRedoBtn:      document.getElementById('tailor-redo-btn'),
    tailorMessage:      document.getElementById('tailor-message'),
  };

  let proxyUrl = null; // Will be set by checkProxy()

  // Load saved state
  await loadState();
  await checkProxy();
  await checkPageStatus();

  // Event listeners
  elements.saveCvBtn.addEventListener('click', saveCV);
  elements.changeCvBtn.addEventListener('click', showCVInput);

  // Activate on this page
  if (elements.activateBtn) {
    elements.activateBtn.addEventListener('click', activateOnPage);
  }

  // Tailor CV
  elements.tailorOpenBtn.addEventListener('click', openTailorView);
  elements.tailorBackBtn.addEventListener('click', closeTailorView);
  elements.tailorGenerateBtn.addEventListener('click', runTailorCV);
  elements.tailorRedoBtn.addEventListener('click', runTailorCV);
  elements.tailorCopyBtn.addEventListener('click', copyTailoredCV);
  elements.tailorPdfBtn.addEventListener('click', downloadAsPdf);

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

  async function loadState() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CV' });
    
    if (response.cvText) {
      showCVLoaded(response.cvText);
    }
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
    const validTypes = ['application/pdf', 'application/msword', 
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'];
    
    if (!validTypes.includes(file.type) && !file.name.match(/\.(pdf|docx?|txt)$/i)) {
      showMessage('Please upload a PDF, DOCX, or TXT file', 'error');
      return;
    }

    elements.uploadArea.classList.add('has-file');
    elements.uploadArea.querySelector('.upload-text').textContent = file.name;
    elements.uploadArea.querySelector('.upload-hint').textContent = 'Extracting text...';

    try {
      const text = await extractTextFromFile(file);
      elements.cvText.value = text;
      elements.uploadArea.querySelector('.upload-hint').textContent = 'Text extracted - click Save CV';
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
      // Proxy check may have failed when the popup first opened (cold start).
      // Retry once before giving up — the service may now be awake.
      await checkProxy();
      if (!proxyUrl) {
        throw new Error('Proxy not available. Please wait a few seconds and try again.');
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      // For PDF/DOCX, send to proxy for extraction (server-side parsing)
      const formData = new FormData();
      formData.append('cv', file);

      // Use the shared token from background (cached, mutex-protected).
      // Never call /api/register directly from popup — it bypasses caching
      // and mints a fresh orphaned token on every upload.
      const tokenResult = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
      const token = tokenResult?.token;
      if (!token) throw new Error(tokenResult?.error || 'Could not get proxy token');

      const response = await fetch(`${proxyUrl}/api/cv/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
        signal: controller.signal
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

    await chrome.runtime.sendMessage({ type: 'SAVE_CV', cvText: text });
    showCVLoaded(text);
    showMessage('CV saved successfully');
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
    elements.message.textContent = text;
    elements.message.className = 'message' + (type === 'error' ? ' error' : '');
    elements.message.hidden = false;
    
    setTimeout(() => {
      elements.message.hidden = true;
    }, 4000);
  }

  /**
   * Check if DraftApply is active on the current page.
   */
  async function checkPageStatus() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'CHECK_PAGE_ACTIVE' });
      if (result?.active) {
        setPageActive();
      } else {
        setPageInactive();
      }
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
    elements.activateBtn.textContent = 'Activating...';

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

  function openTailorView() {
    elements.mainView.hidden = true;
    elements.tailorView.hidden = false;
    // Reset results from any previous run
    elements.tailorResults.hidden = true;
    elements.tailorLoading.hidden = true;
    elements.tailorMessage.hidden = true;
    elements.tailorGenerateBtn.disabled = false;
    elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
  }

  function closeTailorView() {
    elements.tailorView.hidden = true;
    elements.mainView.hidden = false;
  }

  async function runTailorCV() {
    const jd = elements.tailorJd.value.trim();
    if (jd.length < 50) {
      showTailorMessage('Please paste a job description (at least a few lines)', 'error');
      return;
    }

    elements.tailorGenerateBtn.disabled = true;
    elements.tailorGenerateBtn.textContent = 'Generating…';
    elements.tailorLoading.hidden = false;
    elements.tailorResults.hidden = true;
    elements.tailorMessage.hidden = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'TAILOR_CV',
        jobDescription: jd,
        jobTitle: elements.tailorJobTitle.value.trim(),
        company:  elements.tailorCompany.value.trim(),
      });

      if (result?.error) {
        showTailorMessage(result.error, 'error');
        return;
      }

      displayTailorResults(result);
    } catch (e) {
      showTailorMessage('Something went wrong: ' + e.message, 'error');
    } finally {
      elements.tailorLoading.hidden = true;
      elements.tailorGenerateBtn.disabled = false;
      elements.tailorGenerateBtn.textContent = 'Generate Tailored CV';
    }
  }

  function displayTailorResults(result) {
    const { tailoredCvText, matchReport, warnings } = result;

    // Score
    const score = matchReport?.score ?? null;
    elements.matchScore.textContent = score != null ? `${score}%` : '–';
    elements.matchScore.className = 'match-score-badge' +
      (score >= 70 ? ' score-high' : score >= 40 ? ' score-mid' : ' score-low');

    // Strong matches
    const strong = matchReport?.strongMatches || [];
    if (strong.length > 0) {
      elements.matchStrongChips.innerHTML = strong
        .map(s => `<span class="match-chip match-chip-strong">${esc(s)}</span>`)
        .join('');
      elements.matchStrong.hidden = false;
    } else {
      elements.matchStrong.hidden = true;
    }

    // Missing requirements
    const missing = matchReport?.unsupportedRequirements || [];
    if (missing.length > 0) {
      elements.matchMissingChips.innerHTML = missing
        .map(s => `<span class="match-chip match-chip-missing">${esc(s)}</span>`)
        .join('');
      elements.matchMissing.hidden = false;
    } else {
      elements.matchMissing.hidden = true;
    }

    // Validation warnings
    if (warnings?.length > 0) {
      elements.tailorWarningsBox.textContent = warnings.map(w => `⚠ ${w}`).join('\n');
      elements.tailorWarningsBox.hidden = false;
    } else {
      elements.tailorWarningsBox.hidden = true;
    }

    // Tailored CV text
    elements.tailorOutput.value = tailoredCvText || '';
    elements.tailorResults.hidden = false;

    // Scroll results into view
    elements.tailorResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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
    // Store CV text temporarily so the export page can read it
    await chrome.storage.local.set({ tailoredCvExport: text });
    // Open the export page — user clicks "Save as PDF" in the print dialog
    chrome.tabs.create({ url: chrome.runtime.getURL('cv-export.html') });
  }

  function showTailorMessage(text, type = 'success') {
    elements.tailorMessage.textContent = text;
    elements.tailorMessage.className = 'message' + (type === 'error' ? ' error' : '');
    elements.tailorMessage.hidden = false;
    setTimeout(() => { elements.tailorMessage.hidden = true; }, 5000);
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

});
