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

const DEFAULT_PROXY_URL = 'https://draftapply.onrender.com';

async function getProxyUrl() {
  return DEFAULT_PROXY_URL;
}

async function getInstallToken() {
  const { installToken, installTokenExpiresAt } = await chrome.storage.local.get([
    'installToken',
    'installTokenExpiresAt'
  ]);
  if (typeof installToken !== 'string' || !installToken) return null;
  if (typeof installTokenExpiresAt === 'number' && Date.now() > installTokenExpiresAt - 24 * 60 * 60 * 1000) {
    // refresh if expiring within 24h
    return null;
  }
  return installToken;
}

async function setInstallToken(token, expiresAt) {
  await chrome.storage.local.set({ installToken: token, installTokenExpiresAt: expiresAt || null });
}

async function clearInstallToken() {
  await chrome.storage.local.remove(['installToken', 'installTokenExpiresAt']);
}

async function ensureInstallToken(proxyUrl) {
  const existing = await getInstallToken();
  if (existing) return existing;

  const response = await fetch(`${proxyUrl}/api/register`, { method: 'POST' });
  if (!response.ok) throw new Error(`Register failed (${response.status})`);
  const data = await response.json().catch(() => ({}));
  if (!data.token) throw new Error('Register failed (no token)');
  await setInstallToken(data.token, data.expiresAt);
  return data.token;
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
      files: ['page-extractor.js', 'content.js']
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

  if (message.type === 'CHECK_PROXY') {
    checkProxy()
      .then(sendResponse)
      .catch(error => sendResponse({ available: false, error: error.message }));
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
      
      // Ensure the main frame (frameId 0) has the content script
      try {
        await chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, files: ['content.css'] });
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['page-extractor.js', 'content.js'] });
      } catch {
        // May already be injected — that's fine
      }
      
      // Brief delay for content script to initialize
      await new Promise(r => setTimeout(r, 300));
      
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

/**
 * Make API call to proxy for answer generation
 */
async function handleAPICall(payload, requestId) {
  const proxyUrl = await getProxyUrl();
  const controller = new AbortController();
  const effectiveRequestId = requestId || `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  pendingRequests.set(effectiveRequestId, controller);

  // Hard timeout so the UI never spins forever
  const timeout = setTimeout(() => controller.abort(), 120000);

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
        body: JSON.stringify(payload)
      });

    let response = await doRequest();
    if (response.status === 401) {
      // Token expired/revoked → re-register once and retry
      await clearInstallToken();
      token = await ensureInstallToken(proxyUrl);
      response = await doRequest();
    }

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
