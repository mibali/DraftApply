/**
 * DraftApply Background Service Worker
 * 
 * Handles:
 * - Context menu creation
 * - Message passing between popup, content script, and backend API
 * - CV storage management
 * 
 * ARCHITECTURE:
 * - Calls a hosted proxy API (Render) which holds Groq API key server-side
 * - No user API key needed; extension registers for a token
 * - CV stored locally in chrome.storage
 */

const pendingRequests = new Map(); // requestId -> AbortController

function rateLimitError(response) {
  const resetHeader = response.headers.get('RateLimit-Reset') || response.headers.get('X-RateLimit-Reset');
  if (resetHeader) {
    const resetSec = Number(resetHeader);
    if (!isNaN(resetSec) && resetSec > 1e9) {
      const resetTime = new Date(resetSec * 1000);
      const hh = resetTime.getHours().toString().padStart(2, '0');
      const mm = resetTime.getMinutes().toString().padStart(2, '0');
      return `Rate limit reached — you can try again at ${hh}:${mm}.`;
    }
  }
  return 'Rate limit reached — please try again in up to 60 minutes.';
}

const DEFAULT_PROXY_URL = 'https://draftapply.onrender.com';
const TAILOR_JOB_KEY = 'tailorCvJob';

async function setTailorJobIfCurrent(jobId, nextState) {
  const stored = await chrome.storage.local.get(TAILOR_JOB_KEY);
  if (stored?.[TAILOR_JOB_KEY]?.id !== jobId) return false;
  await chrome.storage.local.set({ [TAILOR_JOB_KEY]: nextState });
  return true;
}

async function getProxyUrl() {
  return DEFAULT_PROXY_URL;
}

async function getInstallToken() {
  const { installToken, installTokenExpiresAt } = await chrome.storage.local.get([
    'installToken',
    'installTokenExpiresAt'
  ]);
  if (typeof installToken !== 'string' || !installToken) return null;

  const now = Date.now();
  const isExpired = typeof installTokenExpiresAt === 'number' && now > installTokenExpiresAt;
  const isExpiring = !isExpired && typeof installTokenExpiresAt === 'number'
    && now > installTokenExpiresAt - 24 * 60 * 60 * 1000;

  if (isExpired) return null; // truly expired, must re-register
  return { token: installToken, expiring: isExpiring };
}

async function setInstallToken(token, expiresAt) {
  await chrome.storage.local.set({ installToken: token, installTokenExpiresAt: expiresAt || null });
}

async function clearInstallToken() {
  await chrome.storage.local.remove(['installToken', 'installTokenExpiresAt']);
}

// Mutex: if a registration is already in-flight, queue up behind it rather than
// firing a second concurrent request (which could cause a duplicate-token race).
let _tokenRefreshPromise = null;

async function ensureInstallToken(proxyUrl) {
  const result = await getInstallToken();
  const existing = result?.token ?? null;
  const expiring = result?.expiring ?? false;

  if (existing && !expiring) return existing;

  // Re-use an in-flight registration if one is already running
  if (_tokenRefreshPromise) return _tokenRefreshPromise;

  _tokenRefreshPromise = (async () => {
    try {
      const response = await fetch(`${proxyUrl}/api/register`, { method: 'POST' });
      if (!response.ok) throw new Error(`Register failed (${response.status})`);
      const data = await response.json().catch(() => ({}));
      if (!data.token) throw new Error('Register failed (no token)');
      await setInstallToken(data.token, data.expiresAt);
      return data.token;
    } catch (e) {
      if (existing) {
        // Re-registration failed but old token still valid — use it
        console.warn('[DraftApply] Token refresh failed, using existing token:', e.message);
        return existing;
      }
      throw e;
    } finally {
      _tokenRefreshPromise = null;
    }
  })();

  return _tokenRefreshPromise;
}

/**
 * Ensure the content script is injected into a tab.
 * On known ATS sites the manifest auto-injects; on any other page
 * we use chrome.scripting (requires 'activeTab' + 'scripting' permissions).
 */
async function ensureContentScriptInjected(tabId) {
  try {
    // Ping the content script to see if it's already there
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (response?.pong) return; // already injected in main frame
  } catch {
    // No listener → content script not present, inject it
  }

  try {
    // Inject into all frames so DraftApply works inside ATS iframes
    // (e.g. Greenhouse form embedded on a company careers page)
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ['content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['stats.js', 'page-extractor.js', 'content.js']
    });
  } catch (err) {
    console.warn('Could not inject content script:', err.message);
    throw new Error('Cannot activate DraftApply on this page.');
  }
}

/**
 * Auto-inject on company career pages that embed ATS forms
 * (e.g. lattice.com/job?gh_jid=..., stripe.com/jobs/..., etc.)
 */
const ATS_URL_PATTERNS = [
  /[?&]gh_jid=/,           // Greenhouse embedded (e.g. lattice.com/job?gh_jid=...)
  /\/jobs?\//i,             // Generic /job/ or /jobs/ paths on company sites
  /\/careers?\//i,          // Generic /career/ or /careers/ paths
  /\/apply\//i,             // Apply pages
];

function normalizeDraftMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(ltd|limited|inc|llc|plc|corp|corporation|company|co)\b/g, '')
    .trim();
}

function urlHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function hasSameJobIdentity(draft = {}, pageContext = {}) {
  const draftTitle = normalizeDraftMatchText(draft.jobTitle);
  const pageTitle = normalizeDraftMatchText(pageContext.jobTitle);
  const draftCompany = normalizeDraftMatchText(draft.company);
  const pageCompany = normalizeDraftMatchText(pageContext.company);

  const titleMatches = draftTitle && pageTitle && (draftTitle.includes(pageTitle) || pageTitle.includes(draftTitle));
  const companyMatches = draftCompany && pageCompany && (draftCompany.includes(pageCompany) || pageCompany.includes(draftCompany));

  if (draftTitle && pageTitle && !titleMatches) return false;
  if (draftCompany && pageCompany && !companyMatches) return false;

  // Company alone is too broad: one employer can have many open roles.
  // Use it only as a mismatch guard above; a positive identity match needs
  // the role title, source host, or fresh same-tab navigation fallback.
  return Boolean(titleMatches);
}

function isFreshDraft(draft = {}, maxAgeMs = 30 * 60 * 1000) {
  const updated = Date.parse(draft.updatedAt || '');
  return Number.isFinite(updated) && Date.now() - updated <= maxAgeMs;
}

function isTailorDraftRelevant(draft, { pageContext = {}, url = '', tabId = null } = {}) {
  if (!draft?.jobDescription?.trim()) return false;

  const pageHasIdentity = Boolean(pageContext.jobTitle || pageContext.company);
  if (pageHasIdentity) return hasSameJobIdentity(draft, pageContext);

  const currentHost = urlHost(url || pageContext.url);
  const sourceHost = urlHost(draft.sourceUrl);
  if (currentHost && sourceHost && currentHost === sourceHost) return true;

  // Preserve the common flow: paste JD on the source page, click through in
  // the same tab to an ATS form where title/company/JD are no longer visible.
  if (draft.sourceTabId != null && tabId != null && draft.sourceTabId === tabId && isFreshDraft(draft)) {
    return true;
  }

  // Legacy drafts did not store source metadata; only use them when identity
  // matched above, never as a blind global fallback.
  return false;
}

async function getActiveTabSnapshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;

  let pageContext = null;
  try {
    pageContext = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT' }, { frameId: 0 });
  } catch {
    // Content script may not be active on the page yet; URL metadata is enough
    // to scope newly saved drafts to the page where the popup was opened.
  }

  return {
    tabId: tab.id,
    url: tab.url || pageContext?.url || '',
    title: tab.title || '',
    pageContext,
  };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  // Skip if it's already a known ATS domain (content script auto-injects)
  const knownDomains = [
    'indeed.com', 'otta.com', 'hiringcafe.com', 'greenhouse.io',
    'lever.co', 'workable.com', 'linkedin.com', 'ashbyhq.com',
    'breezy.hr', 'smartrecruiters.com', 'icims.com',
    'myworkdayjobs.com', 'taleo.net', 'jobvite.com',
    'glassdoor.com', 'glassdoor.co.uk'
  ];
  try {
    const host = new URL(tab.url).hostname;
    if (knownDomains.some(d => host.includes(d))) return;
  } catch { return; }

  // Check if URL matches ATS embed patterns
  if (!ATS_URL_PATTERNS.some(re => re.test(tab.url))) return;

  try {
    await ensureContentScriptInjected(tabId);
  } catch {
    // Not injectable (e.g. chrome:// pages) — ignore
  }
});

// Create context menu on install/update (idempotent)
chrome.runtime.onInstalled.addListener(() => {
  // On extension reload/update, Chrome may keep old menu items.
  // Ensure we don't throw "duplicate id" by removing first.
  chrome.contextMenus.remove('draftapply', () => {
    // Ignore "not found" errors
    void chrome.runtime.lastError;

    chrome.contextMenus.create(
      {
        id: 'draftapply',
        title: 'DraftApply - Answer using my CV',
        contexts: ['selection']
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('contextMenus.create failed:', chrome.runtime.lastError.message);
        }
      }
    );
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'draftapply' && info.selectionText) {
    // Guard: ensure valid tab
    if (!tab?.id) return;
    
    const { cvText } = await chrome.storage.local.get('cvText');
    
    if (!cvText) {
      // Try to inject first so the notification can be shown
      try { await ensureContentScriptInjected(tab.id); } catch {}
      chrome.tabs.sendMessage(tab.id, {
        type: 'SHOW_NOTIFICATION',
        message: 'Please load your CV first (click the extension icon)'
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('sendMessage failed:', chrome.runtime.lastError.message);
        }
      });
      return;
    }

    // Ensure content script is present (injects on-demand for non-listed sites)
    try {
      await ensureContentScriptInjected(tab.id);
    } catch (err) {
      console.warn('Cannot inject on this page:', err.message);
      return;
    }

    // Cap selection length to prevent huge prompts
    const question = info.selectionText.trim().slice(0, 1000);
    
    chrome.tabs.sendMessage(tab.id, {
      type: 'GENERATE_ANSWER',
      question
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('sendMessage failed:', chrome.runtime.lastError.message);
      }
    });
  }
});

// Handle messages from popup and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CALL_API') {
    handleAPICall(message.payload, message.requestId)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === 'CALL_API_STREAM') {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    if (!tabId) {
      sendResponse({ error: 'No tab context' });
      return;
    }
    sendResponse({ started: true }); // Acknowledge immediately
    handleStreamingAPICall(message.payload, message.requestId, tabId, frameId)
      .catch(err => {
        try {
          chrome.tabs.sendMessage(tabId, {
            type: 'STREAM_ERROR',
            requestId: message.requestId,
            error: err.message
          }, { frameId });
        } catch (e) {}
      });
    return true; // Keep channel open — ensures sendResponse is delivered reliably
  }

  if (message.type === 'CANCEL_API') {
    const controller = pendingRequests.get(message.requestId);
    if (controller) {
      controller.abort();
      pendingRequests.delete(message.requestId);
      sendResponse({ cancelled: true });
    } else {
      sendResponse({ cancelled: false });
    }
    return true;
  }

  if (message.type === 'CANCEL_ALL') {
    for (const [id, controller] of pendingRequests.entries()) {
      try {
        controller.abort();
      } catch (e) {}
      pendingRequests.delete(id);
    }
    sendResponse({ cancelled: true });
    return true;
  }

  if (message.type === 'GET_TOKEN') {
    // Returns the cached/refreshed install token via the shared ensureInstallToken path.
    // Popup uses this for CV upload so we don't mint a fresh token on every file.
    getProxyUrl()
      .then(proxyUrl => ensureInstallToken(proxyUrl))
      .then(token => sendResponse({ token, proxyUrl: DEFAULT_PROXY_URL }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'GET_CV') {
    chrome.storage.local.get('cvText', (result) => {
      sendResponse({ cvText: result.cvText || null });
    });
    return true;
  }

  if (message.type === 'SAVE_CV') {
    chrome.storage.local.set({ cvText: message.cvText }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'CLEAR_CV') {
    chrome.storage.local.remove('cvText', () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'TAILOR_CV') {
    (async () => {
      const jobId = `tailor_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const jobSnapshot = {
        id: jobId,
        status: 'running',
        startedAt: new Date().toISOString(),
        jobDescription: message.jobDescription || '',
        jobTitle: message.jobTitle || '',
        company: message.company || '',
        confirmedSkills: message.confirmedSkills || [],
      };
      try {
        const { cvText } = await chrome.storage.local.get('cvText');
        if (!cvText) { sendResponse({ error: 'No CV loaded — please save your CV first' }); return; }
        await chrome.storage.local.set({ [TAILOR_JOB_KEY]: jobSnapshot });

        const proxyUrl = await getProxyUrl();
        let token = await ensureInstallToken(proxyUrl);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        const keepAlive = setInterval(() => chrome.storage.local.get('_sw_keepalive'), 20000);

        try {
          let response = await fetch(`${proxyUrl}/api/cv/tailor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            signal: controller.signal,
            body: JSON.stringify({
              cvText,
              jobDescription: message.jobDescription,
              jobTitle: message.jobTitle || '',
              company:  message.company  || '',
              confirmedSkills: message.confirmedSkills || [],
            }),
          });

          if (response.status === 401) {
            await clearInstallToken();
            token = await ensureInstallToken(proxyUrl);
            response = await fetch(`${proxyUrl}/api/cv/tailor`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              signal: controller.signal,
              body: JSON.stringify({
                cvText,
                jobDescription: message.jobDescription,
                jobTitle: message.jobTitle || '',
                company: message.company || '',
                confirmedSkills: message.confirmedSkills || [],
              }),
            });
          }

          if (response.status === 429) throw new Error(rateLimitError(response));
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Error ${response.status}`);
          }

          const data = await response.json();
          await setTailorJobIfCurrent(jobId, {
            ...jobSnapshot,
            status: 'done',
            result: data,
            completedAt: new Date().toISOString(),
          });
          sendResponse({ success: true, ...data });
        } finally {
          clearTimeout(timeout);
          clearInterval(keepAlive);
        }
      } catch (e) {
        const error = e?.name === 'AbortError' ? 'Timed out — please try again' : e.message;
        await setTailorJobIfCurrent(jobId, {
            ...jobSnapshot,
            status: 'error',
            error,
            completedAt: new Date().toISOString(),
        });
        sendResponse({ error });
      }
    })();
    return true;
  }

  if (message.type === 'EXTRACT_JD') {
    (async () => {
      try {
        const proxyUrl = await getProxyUrl();
        let token = await ensureInstallToken(proxyUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const doRequest = () => fetch(`${proxyUrl}/api/jd/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          signal: controller.signal,
          body: JSON.stringify({ text: message.text }),
        });

        try {
          let response = await doRequest();
          if (response.status === 401) {
            await clearInstallToken();
            token = await ensureInstallToken(proxyUrl);
            response = await doRequest();
          }
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Error ${response.status}`);
          }
          const data = await response.json();
          sendResponse({ success: true, extractedText: data.extractedText });
        } finally {
          clearTimeout(timeout);
        }
      } catch (e) {
        if (e?.name === 'AbortError') sendResponse({ error: 'Extraction timed out' });
        else sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'ANALYZE_CV_MATCH') {
    (async () => {
      try {
        const { cvText } = await chrome.storage.local.get('cvText');
        if (!cvText) { sendResponse({ error: 'No CV loaded — please save your CV first' }); return; }

        const proxyUrl = await getProxyUrl();
        let token = await ensureInstallToken(proxyUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        const keepAlive = setInterval(() => chrome.storage.local.get('_sw_keepalive'), 20000);

        try {
          const body = JSON.stringify({
            cvText,
            jobDescription: message.jobDescription,
            jobTitle: message.jobTitle || '',
            company: message.company || '',
            confirmedSkills: message.confirmedSkills || [],
          });

          let response = await fetch(`${proxyUrl}/api/cv/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            signal: controller.signal,
            body,
          });

          if (response.status === 401) {
            await clearInstallToken();
            token = await ensureInstallToken(proxyUrl);
            response = await fetch(`${proxyUrl}/api/cv/analyze`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              signal: controller.signal,
              body,
            });
          }

          if (response.status === 429) throw new Error(rateLimitError(response));
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Error ${response.status}`);
          }

          const data = await response.json();
          sendResponse({ success: true, ...data });
        } finally {
          clearTimeout(timeout);
          clearInterval(keepAlive);
        }
      } catch (e) {
        if (e?.name === 'AbortError') sendResponse({ error: 'Analysis timed out — please try again' });
        else sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'CHECK_PROXY') {
    checkProxy()
      .then(sendResponse)
      .catch(error => sendResponse({ available: false, error: error.message }));
    return true;
  }

  if (message.type === 'GET_ACTIVE_TAB_SNAPSHOT') {
    getActiveTabSnapshot()
      .then(snapshot => sendResponse({ snapshot }))
      .catch(error => sendResponse({ snapshot: null, error: error.message }));
    return true;
  }

  if (message.type === 'GET_TAILOR_DRAFT_FOR_ACTIVE_PAGE') {
    (async () => {
      const snapshot = await getActiveTabSnapshot();
      const { tailorCvDraft } = await chrome.storage.local.get('tailorCvDraft');
      const relevant = snapshot && isTailorDraftRelevant(tailorCvDraft, {
        pageContext: snapshot.pageContext || {},
        url: snapshot.url,
        tabId: snapshot.tabId,
      });
      sendResponse({ draft: relevant ? tailorCvDraft : null, snapshot });
    })().catch(error => sendResponse({ draft: null, error: error.message }));
    return true;
  }

  if (message.type === 'GET_TAILOR_DRAFT_FOR_PAGE') {
    (async () => {
      const { tailorCvDraft } = await chrome.storage.local.get('tailorCvDraft');
      const relevant = isTailorDraftRelevant(tailorCvDraft, {
        pageContext: message.pageContext || {},
        url: message.url || sender.url || '',
        tabId: sender.tab?.id ?? null,
      });
      sendResponse({ draft: relevant ? tailorCvDraft : null });
    })().catch(error => sendResponse({ draft: null, error: error.message }));
    return true;
  }

  if (message.type === 'ACTIVATE_PAGE') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          sendResponse({ success: false, error: 'No active tab' });
          return;
        }
        await ensureContentScriptInjected(tab.id);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Relay: iframe content script asks us to show the modal in the parent frame
  if (message.type === 'RELAY_GENERATE_TO_PARENT') {
    (async () => {
      const tabId = sender.tab?.id;
      const sourceFrameId = sender.frameId;
      if (!tabId) { sendResponse({ success: false }); return; }
      
      // Ensure the main frame (frameId 0) has the content script.
      // PING first — executeScript doesn't throw when already injected, it re-runs
      // the script, which destroys the active instance and resets all state.
      let mainFrameReady = false;
      try {
        const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 });
        mainFrameReady = !!pong?.pong;
      } catch { /* not injected yet */ }

      if (!mainFrameReady) {
        try {
          await chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, files: ['content.css'] });
          await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['stats.js', 'page-extractor.js', 'content.js'] });
        } catch { /* restricted page */ }
        // Brief delay for content script to initialize after fresh injection
        await new Promise(r => setTimeout(r, 300));
      }
      
      // Forward to the main frame
      chrome.tabs.sendMessage(tabId, {
        type: 'GENERATE_FROM_IFRAME',
        question: message.question,
        iframePageContext: message.pageContext,
        sourceFrameId
      }, { frameId: 0 }, () => {
        if (chrome.runtime.lastError) {
          console.warn('Relay to main frame failed:', chrome.runtime.lastError.message);
        }
      });
      sendResponse({ success: true });
    })();
    return true;
  }

  // Relay: parent frame sends generated answer back to the iframe for insertion
  if (message.type === 'RELAY_INSERT_TO_IFRAME') {
    const tabId = sender.tab?.id;
    if (tabId && message.targetFrameId != null) {
      chrome.tabs.sendMessage(tabId, {
        type: 'INSERT_FROM_PARENT',
        answer: message.answer
      }, { frameId: message.targetFrameId }, () => {
        if (chrome.runtime.lastError) {
          console.warn('Relay to iframe failed:', chrome.runtime.lastError.message);
        }
      });
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'CHECK_PAGE_ACTIVE') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          sendResponse({ active: false });
          return;
        }
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
        sendResponse({ active: !!response?.pong });
      } catch {
        sendResponse({ active: false });
      }
    })();
    return true;
  }
});

/**
 * Check if proxy is available
 */
async function checkProxy() {
  const proxyUrl = await getProxyUrl();
  const response = await fetch(`${proxyUrl}/api/health`);
  if (!response.ok) throw new Error('Proxy not responding');
  const data = await response.json().catch(() => ({}));
  return { available: true, ...data, proxyUrl };
}

async function withRetry(fn, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (e?.name === 'AbortError') throw e; // don't retry cancellations
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

/**
 * Streaming API call: relay SSE chunks to the content script tab.
 * Chunks are forwarded via chrome.tabs.sendMessage as STREAM_CHUNK messages.
 */
async function handleStreamingAPICall(payload, requestId, tabId, frameId) {
  const proxyUrl = await getProxyUrl();
  const controller = new AbortController();
  const effectiveRequestId = requestId || `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  pendingRequests.set(effectiveRequestId, controller);

  const timeout = setTimeout(() => controller.abort(), 120000);

  // MV3 service workers can be terminated after ~30s of inactivity.
  // Touching chrome.storage every 20s keeps the SW alive during long streams.
  const keepAlive = setInterval(() => chrome.storage.local.get('_sw_keepalive'), 20000);

  const enrichedPayload = { ...payload, stream: true };

  try {
    let token = await ensureInstallToken(proxyUrl);

    const doRequest = () => fetch(`${proxyUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal,
      body: JSON.stringify(enrichedPayload)
    });

    let response = await doRequest();

    if (response.status === 401) {
      await clearInstallToken();
      token = await ensureInstallToken(proxyUrl);
      response = await doRequest();
    }

    if (response.status === 429) throw new Error(rateLimitError(response));
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Proxy error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const sendChunk = (chunk) => {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', requestId: effectiveRequestId, chunk }, { frameId });
      } catch (e) {}
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep last incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          // OpenAI-compatible format
          const chunk = json.choices?.[0]?.delta?.content;
          if (chunk) sendChunk(chunk);
        } catch (e) {
          // Non-JSON line — skip
        }
      }
    }

    try {
      chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', requestId: effectiveRequestId }, { frameId });
    } catch (e) {}

  } catch (e) {
    if (e?.name === 'AbortError') {
      // Cancelled — notify so the promise bridge resolves cleanly
      try {
        chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', requestId: effectiveRequestId }, { frameId });
      } catch (_) {}
      return;
    }
    throw e;
  } finally {
    clearInterval(keepAlive);
    clearTimeout(timeout);
    pendingRequests.delete(effectiveRequestId);
  }
}

/**
 * Make API call to proxy for answer generation.
 * If the user has configured a custom LLM provider in chrome.storage,
 * it is forwarded to the proxy as `llmConfig` so the proxy uses it
 * (and falls back to the default Groq key if it fails).
 */
async function handleAPICall(payload, requestId) {
  const proxyUrl = await getProxyUrl();
  const controller = new AbortController();
  const effectiveRequestId = requestId || `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  pendingRequests.set(effectiveRequestId, controller);

  // Hard timeout so the UI never spins forever
  const timeout = setTimeout(() => controller.abort(), 120000);

  const enrichedPayload = payload;

  try {
    let token = await ensureInstallToken(proxyUrl);

    const doRequest = async () =>
      fetch(`${proxyUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal,
        body: JSON.stringify(enrichedPayload)
      });

    let response = await withRetry(async () => {
      const r = await doRequest();
      if (r.status >= 500) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `Proxy error: ${r.status}`);
      }
      return r;
    });

    if (response.status === 401) {
      // Token expired/revoked → re-register once and retry
      await clearInstallToken();
      token = await ensureInstallToken(proxyUrl);
      response = await doRequest();
    }

    if (response.status === 429) throw new Error(rateLimitError(response));
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const msg = error.error || `Proxy error: ${response.status}`;
      throw new Error(msg);
    }

    return await response.json();
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error('Cancelled');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
    pendingRequests.delete(effectiveRequestId);
  }
}
