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

  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/dbe99d5f-16cc-4ee2-a0f8-9d35438d6c11',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:handleAPICall',message:'Payload sent to proxy',data:{question:payload.question,length:payload.length,hasCvText:!!payload.cvText,cvTextLen:payload.cvText?.length,hasJobDesc:!!payload.jobDescription,hasRequirements:!!payload.requirements,payloadKeys:Object.keys(payload)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C,D'})}).catch(()=>{});
  // #endregion

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
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/dbe99d5f-16cc-4ee2-a0f8-9d35438d6c11',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:handleAPICall:error',message:'Proxy returned error',data:{status:response.status,error:error},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      const msg = error.error || `Proxy error: ${response.status}`;
      throw new Error(msg);
    }

    const result = await response.json();
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/dbe99d5f-16cc-4ee2-a0f8-9d35438d6c11',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:handleAPICall:success',message:'Proxy response received',data:{answerLen:result.answer?.length,answerPreview:result.answer?.slice(0,120),provider:result.provider,model:result.model},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
    // #endregion
    return result;
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
