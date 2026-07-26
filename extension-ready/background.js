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

import { PROXY_URL } from './build-config.js';

// Answer requests are intentionally isolated from popup Tailor/analysis work:
// content-script CANCEL_ALL means "stop answers", not "stop everything".
const answerRequests = new Map(); // requestId -> AbortController
const dataRequests = new Map(); // requestId -> AbortController (register/analyse/tailor/extract)
let dataGeneration = 0;
let tailorMutation = Promise.resolve();
let tokenMutation = Promise.resolve();
const WORKER_INSTANCE_ID = globalThis.crypto?.randomUUID?.() || `worker_${Date.now()}_${Math.random()}`;

function currentGeneration(generation) {
  return generation === dataGeneration;
}

function registerController(registry, id, controller) {
  registry.set(id, controller);
  return () => {
    if (registry.get(id) === controller) registry.delete(id);
  };
}

function abortRegistry(registry) {
  for (const controller of registry.values()) {
    try { controller.abort(); } catch (_) {}
  }
  registry.clear();
}

function mutateTailorRecord(operation) {
  const result = tailorMutation.then(operation, operation);
  tailorMutation = result.catch(() => {});
  return result;
}

function mutateTokenRecord(operation) {
  const result = tokenMutation.then(operation, operation);
  tokenMutation = result.catch(() => {});
  return result;
}

function rateLimitError(response) {
  const retryAfter = parseRetryDelay(response.headers.get('Retry-After'));
  if (retryAfter) {
    return `Rate limit reached — you can try again in ${retryAfter}.`;
  }

  const resetHeader = response.headers.get('RateLimit-Reset') || response.headers.get('X-RateLimit-Reset');
  if (resetHeader) {
    const resetSec = Number(resetHeader);
    if (!isNaN(resetSec) && resetSec > 1e9) {
      const resetTime = new Date(resetSec * 1000);
      const hh = resetTime.getHours().toString().padStart(2, '0');
      const mm = resetTime.getMinutes().toString().padStart(2, '0');
      return `Rate limit reached — you can try again at ${hh}:${mm}.`;
    }
    if (!isNaN(resetSec) && resetSec > 0) {
      return `Rate limit reached — you can try again in ${formatRetryDelay(resetSec * 1000)}.`;
    }
  }
  return 'Rate limit reached — please try again in up to 60 minutes.';
}

function parseRetryDelay(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return formatRetryDelay(seconds * 1000);

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return formatRetryDelay(Math.max(0, dateMs - Date.now()));

  return '';
}

function formatRetryDelay(ms) {
  const totalSeconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0
      ? `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${seconds === 1 ? '' : 's'}`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0
    ? `${hours} hour${hours === 1 ? '' : 's'} ${remainderMinutes} minute${remainderMinutes === 1 ? '' : 's'}`
    : `${hours} hour${hours === 1 ? '' : 's'}`;
}

async function responseErrorMessage(response, fallback = `Error ${response?.status || ''}`.trim()) {
  const body = await response.clone().json().catch(() => ({}));
  if (response.status === 429) return rateLimitError(response);
  // Provider traces and implementation details are not public UI. Preserve
  // only deliberately actionable, bounded messages from the API.
  if (typeof body?.error === 'string' && body.error.length <= 180
      && /(?:rate limit|try again|CV|job description|unauthori[sz]ed|sign in|required)/i.test(body.error)) {
    return body.error;
  }
  if (response.status === 401 || response.status === 403) return 'Your DraftApply session expired. Please try again.';
  if (response.status >= 500) return 'DraftApply could not complete this request. Please try again.';
  return fallback || 'DraftApply could not complete this request. Please try again.';
}

const TAILOR_JOB_KEY = 'tailorCvJob';
async function failWorkerOwnedTailorJob() {
  return mutateTailorRecord(async () => {
    const generation = dataGeneration;
    const stored = await chrome.storage.local.get(TAILOR_JOB_KEY);
    const job = stored?.[TAILOR_JOB_KEY];
    if (!currentGeneration(generation) || job?.status !== 'running' || job.workerInstanceId === WORKER_INSTANCE_ID) return;
    // Re-read immediately before writing: startup inspection must never replace
    // a job that was created while the first storage read was pending.
    const latest = (await chrome.storage.local.get(TAILOR_JOB_KEY))?.[TAILOR_JOB_KEY];
    if (!currentGeneration(generation) || latest?.id !== job.id || latest?.workerInstanceId !== job.workerInstanceId) return;
    await chrome.storage.local.set({ [TAILOR_JOB_KEY]: {
      ...latest,
      status: 'error',
      error: 'Generation was interrupted when DraftApply restarted. Please generate again.',
      completedAt: new Date().toISOString(),
    } });
  });
}

// Executed on every service-worker incarnation. A `running` record belongs to
// the previous incarnation: fetch/AbortController state cannot survive MV3
// worker loss, so report interruption instead of pretending it can resume.
failWorkerOwnedTailorJob().catch(() => {});

async function setTailorJobIfCurrent(jobId, generation, nextState) {
  return mutateTailorRecord(async () => {
    if (!currentGeneration(generation)) return false;
    const stored = await chrome.storage.local.get(TAILOR_JOB_KEY);
    if (!currentGeneration(generation) || stored?.[TAILOR_JOB_KEY]?.id !== jobId) return false;
    await chrome.storage.local.set({ [TAILOR_JOB_KEY]: nextState });
    return true;
  });
}

async function getProxyUrl() {
  return PROXY_URL;
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

async function setInstallToken(token, expiresAt, generation) {
  return mutateTokenRecord(async () => {
    if (!currentGeneration(generation)) throw new DOMException('Deleted', 'AbortError');
    await chrome.storage.local.set({ installToken: token, installTokenExpiresAt: expiresAt || null });
    if (!currentGeneration(generation)) {
      const stored = await chrome.storage.local.get('installToken');
      if (stored.installToken === token) await chrome.storage.local.remove(['installToken', 'installTokenExpiresAt']);
      throw new DOMException('Deleted', 'AbortError');
    }
  });
}

async function clearInstallTokenIfCurrent(staleToken, generation) {
  return mutateTokenRecord(async () => {
    if (!currentGeneration(generation)) return false;
    const stored = await chrome.storage.local.get('installToken');
    if (!currentGeneration(generation) || stored.installToken !== staleToken) return false;
    await chrome.storage.local.remove(['installToken', 'installTokenExpiresAt']);
    return true;
  });
}

// Mutex: if a registration is already in-flight, queue up behind it rather than
// firing a second concurrent request (which could cause a duplicate-token race).
let _tokenRefreshPromise = null;

async function ensureInstallToken(proxyUrl, generation = dataGeneration) {
  if (!currentGeneration(generation)) throw new DOMException('Deleted', 'AbortError');
  const result = await getInstallToken();
  const existing = result?.token ?? null;
  const expiring = result?.expiring ?? false;

  if (existing && !expiring) return existing;

  // Re-use an in-flight registration if one is already running
  if (_tokenRefreshPromise) return _tokenRefreshPromise;

  const controller = new AbortController();
  const unregister = registerController(dataRequests, `register:${generation}`, controller);
  const refreshPromise = (async () => {
    try {
      const response = await fetch(`${proxyUrl}/api/register`, { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error(`Register failed (${response.status})`);
      const data = await response.json().catch(() => ({}));
      if (!data.token) throw new Error('Register failed (no token)');
      await setInstallToken(data.token, data.expiresAt, generation);
      return data.token;
    } catch (e) {
      if (existing && currentGeneration(generation)) {
        // Re-registration failed but old token still valid — use it
        console.warn('[DraftApply] Token refresh failed, using existing token:', e.message);
        return existing;
      }
      throw e;
    } finally {
      unregister();
      if (_tokenRefreshPromise === refreshPromise) _tokenRefreshPromise = null;
    }
  })();
  _tokenRefreshPromise = refreshPromise;

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

function urlWithoutHash(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
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

  const currentUrl = urlWithoutHash(url || pageContext.url);
  const sourceUrl = urlWithoutHash(draft.sourceUrl);
  if (currentUrl && sourceUrl && currentUrl === sourceUrl) return true;

  // Preserve the common flow: paste JD on the source page, click through in
  // the same tab to an ATS form where title/company/JD are no longer visible.
  // Same host alone is deliberately not enough: refreshing or moving between
  // different jobs on the same ATS/company site must not inherit stale context.
  const currentHost = urlHost(url || pageContext.url);
  const sourceHost = urlHost(draft.sourceUrl);
  const movedToDifferentHost = currentHost && sourceHost && currentHost !== sourceHost;
  if (movedToDifferentHost && draft.sourceTabId != null && tabId != null && draft.sourceTabId === tabId && isFreshDraft(draft)) {
    return true;
  }

  // Legacy drafts did not store source metadata; only use them when identity
  // matched above, never as a blind global fallback.
  return false;
}

function isTailorJobRelevant(job, context = {}) {
  if (!job || !['running', 'done', 'error'].includes(job.status)) return false;
  return isTailorDraftRelevant(job, context);
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

chrome.runtime.onStartup.addListener(() => {
  failWorkerOwnedTailorJob().catch(() => {});
});

// Create context menu on install/update (idempotent)
chrome.runtime.onInstalled.addListener(() => {
  failWorkerOwnedTailorJob().catch(() => {});

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
    const controller = answerRequests.get(message.requestId);
    if (controller) {
      controller.abort();
      answerRequests.delete(message.requestId);
      sendResponse({ cancelled: true });
    } else {
      sendResponse({ cancelled: false });
    }
    return true;
  }

  if (message.type === 'CANCEL_ALL') {
    abortRegistry(answerRequests);
    sendResponse({ cancelled: true });
    return true;
  }

  if (message.type === 'GET_TOKEN') {
    // Returns the cached/refreshed install token via the shared ensureInstallToken path.
    // Popup uses this for CV upload so we don't mint a fresh token on every file.
    getProxyUrl()
      .then(async proxyUrl => ({ token: await ensureInstallToken(proxyUrl), proxyUrl }))
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'GET_CV') {
    chrome.storage.local.get(['cvText', 'cvLinkAnnotations', 'applicationFacts'], (result) => {
      sendResponse({
        cvText: result.cvText || null,
        linkAnnotations: Array.isArray(result.cvLinkAnnotations) ? result.cvLinkAnnotations : [],
        applicationFacts: result.applicationFacts || {},
      });
    });
    return true;
  }

  if (message.type === 'SAVE_CV') {
    const generation = dataGeneration;
    mutateTailorRecord(async () => {
      if (!currentGeneration(generation)) return false;
      await chrome.storage.local.set({
        cvText: message.cvText,
        cvLinkAnnotations: Array.isArray(message.linkAnnotations) ? message.linkAnnotations : [],
        userProfileLinks: String(message.userProfileLinks || ''),
        applicationFacts: message.applicationFacts && typeof message.applicationFacts === 'object'
          ? message.applicationFacts : {},
      });
      return currentGeneration(generation);
    }).then(success => sendResponse({ success })).catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'CLEAR_CV') {
    const generation = dataGeneration;
    mutateTailorRecord(async () => {
      if (!currentGeneration(generation)) return false;
      await chrome.storage.local.remove(['cvText', 'cvLinkAnnotations']);
      return currentGeneration(generation);
    }).then(success => sendResponse({ success })).catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'CANCEL_TAILOR_JOB') {
    mutateTailorRecord(async () => {
      const stored = await chrome.storage.local.get(TAILOR_JOB_KEY);
      const job = stored?.[TAILOR_JOB_KEY];
      if (!job || (message.jobId && message.jobId !== job.id)) return false;
      try { dataRequests.get(job.id)?.abort(); } catch (_) {}
      dataRequests.delete(job.id);
      await chrome.storage.local.remove(TAILOR_JOB_KEY);
      return true;
    }).then(cancelled => sendResponse({ cancelled })).catch(() => sendResponse({ cancelled: false }));
    return true;
  }

  if (message.type === 'DELETE_ALL_USER_DATA') {
    // Advance synchronously, before aborting or awaiting storage. Every async
    // continuation captured the old generation and is now forbidden to write.
    dataGeneration++;
    abortRegistry(answerRequests);
    abortRegistry(dataRequests);
    _tokenRefreshPromise = null;
    // The full clear participates in both queues. Registrations that started
    // before deletion fail their generation check; newer registrations queue
    // behind the clear and cannot have their token erased by it.
    mutateTokenRecord(() => mutateTailorRecord(() => chrome.storage.local.clear()))
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'TAILOR_CV') {
    (async () => {
      const generation = dataGeneration;
      const jobId = `tailor_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const idempotencyKey = message.idempotencyKey || `tailor:${jobId}`;
      const jobSnapshot = {
        id: jobId,
        workerInstanceId: WORKER_INSTANCE_ID,
        status: 'running',
        startedAt: new Date().toISOString(),
        jobDescription: message.jobDescription || '',
        jobTitle: message.jobTitle || '',
        company: message.company || '',
        confirmedSkills: message.confirmedSkills || [],
        sourceTabId: message.source?.sourceTabId ?? null,
        sourceUrl: message.source?.sourceUrl || '',
        sourceHost: message.source?.sourceHost || '',
        sourcePageTitle: message.source?.sourcePageTitle || '',
        sourceJobTitle: message.source?.sourceJobTitle || '',
        sourceCompany: message.source?.sourceCompany || '',
        sourceSavedAt: message.source?.sourceSavedAt || new Date().toISOString(),
      };

      // Phase 1: validate inputs and save running state.
      // Respond immediately so the popup can start polling storage — the SW
      // may be killed before sendResponse fires on long jobs, which causes the
      // popup's sendMessage Promise to hang indefinitely.
      let cvText;
      try {
        const stored = await chrome.storage.local.get('cvText');
        cvText = stored.cvText;
        if (!cvText) { sendResponse({ error: 'No CV loaded — please save your CV first' }); return; }
        await mutateTailorRecord(async () => {
          if (!currentGeneration(generation)) throw new DOMException('Deleted', 'AbortError');
          await chrome.storage.local.set({ [TAILOR_JOB_KEY]: jobSnapshot });
        });
      } catch (e) {
        sendResponse({ error: e.message });
        return;
      }
      sendResponse({ started: true, jobId });

      // Phase 2: run the job. The message channel is closed; popup polls storage.
      const controller = new AbortController();
      const unregister = registerController(dataRequests, jobId, controller);
      const timeout = setTimeout(() => controller.abort(), 360000);
      const keepAlive = setInterval(() => chrome.storage.local.get('_sw_keepalive'), 20000);
      try {
        const proxyUrl = await getProxyUrl();
        let token = await ensureInstallToken(proxyUrl, generation);

        let response = await fetch(`${proxyUrl}/api/cv/tailor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
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
          await clearInstallTokenIfCurrent(token, generation);
          token = await ensureInstallToken(proxyUrl, generation);
          response = await fetch(`${proxyUrl}/api/cv/tailor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
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

        if (!response.ok) {
          throw new Error(await responseErrorMessage(response));
        }

        const data = await response.json();
        await setTailorJobIfCurrent(jobId, generation, {
          ...jobSnapshot,
          status: 'done',
          result: data,
          completedAt: new Date().toISOString(),
        });
      } catch (e) {
        const error = e?.name === 'AbortError' ? 'Timed out — please try again' : e.message;
        await setTailorJobIfCurrent(jobId, generation, {
          ...jobSnapshot,
          status: 'error',
          error,
          completedAt: new Date().toISOString(),
        }).catch(() => {});
      } finally {
        clearTimeout(timeout);
        clearInterval(keepAlive);
        unregister();
      }
    })();
    return true;
  }

  if (message.type === 'EXTRACT_JD') {
    (async () => {
      const generation = dataGeneration;
      const requestId = `extract_${Date.now()}_${Math.random()}`;
      const controller = new AbortController();
      const unregister = registerController(dataRequests, requestId, controller);
      try {
        const proxyUrl = await getProxyUrl();
        let token = await ensureInstallToken(proxyUrl, generation);
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
            await clearInstallTokenIfCurrent(token, generation);
            token = await ensureInstallToken(proxyUrl, generation);
            response = await doRequest();
          }
          if (!response.ok) {
            throw new Error(await responseErrorMessage(response));
          }
          const data = await response.json();
          if (currentGeneration(generation)) sendResponse({ success: true, extractedText: data.extractedText });
        } finally {
          clearTimeout(timeout);
        }
      } catch (e) {
        if (e?.name === 'AbortError') sendResponse({ error: 'Extraction timed out' });
        else sendResponse({ error: e.message });
      } finally { unregister(); }
    })();
    return true;
  }

  if (message.type === 'ANALYZE_CV_MATCH') {
    (async () => {
      const generation = dataGeneration;
      const requestId = `analyse_${Date.now()}_${Math.random()}`;
      const controller = new AbortController();
      const unregister = registerController(dataRequests, requestId, controller);
      try {
        const { cvText } = await chrome.storage.local.get('cvText');
        if (!cvText) { sendResponse({ error: 'No CV loaded — please save your CV first' }); return; }

        const proxyUrl = await getProxyUrl();
        let token = await ensureInstallToken(proxyUrl, generation);
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
            await clearInstallTokenIfCurrent(token, generation);
            token = await ensureInstallToken(proxyUrl, generation);
            response = await fetch(`${proxyUrl}/api/cv/analyze`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              signal: controller.signal,
              body,
            });
          }

          if (!response.ok) {
            throw new Error(await responseErrorMessage(response));
          }

          const data = await response.json();
          if (currentGeneration(generation)) sendResponse({ success: true, ...data });
        } finally {
          clearTimeout(timeout);
          clearInterval(keepAlive);
        }
      } catch (e) {
        if (e?.name === 'AbortError') sendResponse({ error: 'Analysis timed out — please try again' });
        else sendResponse({ error: e.message });
      } finally { unregister(); }
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

  if (message.type === 'GET_TAILOR_JOB_FOR_ACTIVE_PAGE') {
    (async () => {
      const snapshot = await getActiveTabSnapshot();
      const { tailorCvJob } = await chrome.storage.local.get(TAILOR_JOB_KEY);
      const relevant = snapshot && isTailorJobRelevant(tailorCvJob, {
        pageContext: snapshot.pageContext || {},
        url: snapshot.url,
        tabId: snapshot.tabId,
      });
      sendResponse({ job: relevant ? tailorCvJob : null, snapshot });
    })().catch(error => sendResponse({ job: null, error: error.message }));
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
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ success: true });
      });
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
      }, { frameId: message.targetFrameId }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('Relay to iframe failed:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse(response?.success ? { success: true } : { success: false, error: response?.error || 'Iframe did not confirm insert' });
      });
      return true;
    }
    sendResponse({ success: false, error: 'Missing iframe target' });
    return;
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
 * Streaming API call: relay SSE chunks to the content script tab.
 * Chunks are forwarded via chrome.tabs.sendMessage as STREAM_CHUNK messages.
 */
async function handleStreamingAPICall(payload, requestId, tabId, frameId) {
  const generation = dataGeneration;
  const proxyUrl = await getProxyUrl();
  const controller = new AbortController();
  const effectiveRequestId = requestId || `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const unregister = registerController(answerRequests, effectiveRequestId, controller);

  const timeout = setTimeout(() => controller.abort(), 120000);

  // MV3 service workers can be terminated after ~30s of inactivity.
  // Touching chrome.storage every 20s keeps the SW alive during long streams.
  const keepAlive = setInterval(() => chrome.storage.local.get('_sw_keepalive'), 20000);

  const enrichedPayload = { ...payload, stream: true };
  const idempotencyKey = `answer:${effectiveRequestId}`;

  try {
    let token = await ensureInstallToken(proxyUrl, generation);

    const doRequest = () => fetch(`${proxyUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey
      },
      signal: controller.signal,
      body: JSON.stringify(enrichedPayload)
    });

    let response = await doRequest();

    if (response.status === 401) {
      await clearInstallTokenIfCurrent(token, generation);
      token = await ensureInstallToken(proxyUrl, generation);
      response = await doRequest();
    }

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, `Proxy error: ${response.status}`));
    }

    const provider = response.headers.get('X-DraftApply-Provider');
    const model = response.headers.get('X-DraftApply-Model');
    const fallbackFrom = response.headers.get('X-DraftApply-Fallback-From');
    const workflow = response.headers.get('X-DraftApply-Workflow');
    const agentChain = response.headers.get('X-DraftApply-Agent-Chain');
    if (provider || fallbackFrom) {
      chrome.tabs.sendMessage(tabId, {
        type: 'STREAM_META',
        requestId: effectiveRequestId,
        provider,
        model,
        fallbackFrom,
        workflow,
        agentChain
      }, { frameId }).catch(() => {});
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedFinal = false;
    let receivedError = false;
    const consumeEvent = (event) => {
      const data = event.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n').trim();
      if (!data || data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        if (json.draftapplyMeta) {
          chrome.tabs.sendMessage(tabId, { type: 'STREAM_META', requestId: effectiveRequestId, ...json.draftapplyMeta }, { frameId }).catch(() => {});
          return;
        }
        if (json.draftapplyFinal) {
          receivedFinal = true;
          chrome.tabs.sendMessage(tabId, { type: 'STREAM_FINAL', requestId: effectiveRequestId, ...json.draftapplyFinal }, { frameId }).catch(() => {});
          return;
        }
        if (json.draftapplyError) {
          receivedError = true;
          chrome.tabs.sendMessage(tabId, {
            type: 'STREAM_ERROR', requestId: effectiveRequestId,
            error: json.draftapplyError.error || 'Answer generation failed.',
            code: json.draftapplyError.code,
          }, { frameId }).catch(() => {});
        }
        // Provider deltas are deliberately ignored: only the validated final
        // event is usable application-answer output.
      } catch (_) { /* malformed or incomplete provider event */ }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      chrome.tabs.sendMessage(tabId, {
        type: 'STREAM_PROGRESS', requestId: effectiveRequestId,
      }, { frameId }).catch(() => {});
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      events.forEach(consumeEvent);
    }
    buffer += decoder.decode(); // flush a split UTF-8 sequence
    if (buffer.trim()) consumeEvent(buffer); // final unterminated event

    if (!receivedFinal && !receivedError) chrome.tabs.sendMessage(tabId, {
      type: 'STREAM_ERROR', requestId: effectiveRequestId,
      error: 'The connection ended before the answer was verified. Please generate again.',
      code: 'incomplete_response',
    }, { frameId }).catch(() => {});

    chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', requestId: effectiveRequestId }, { frameId }).catch(() => {});

  } catch (e) {
    if (e?.name === 'AbortError') {
      // Cancelled — notify so the promise bridge resolves cleanly
      chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', requestId: effectiveRequestId }, { frameId }).catch(() => {});
      return;
    }
    throw e;
  } finally {
    clearInterval(keepAlive);
    clearTimeout(timeout);
    unregister();
  }
}

/**
 * Make API call to proxy for answer generation.
 * If the user has configured a custom LLM provider in chrome.storage,
 * it is forwarded to the proxy as `llmConfig` so the proxy uses it
 * (and falls back to the default Groq key if it fails).
 */
async function handleAPICall(payload, requestId) {
  const generation = dataGeneration;
  const proxyUrl = await getProxyUrl();
  const controller = new AbortController();
  const effectiveRequestId = requestId || `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const unregister = registerController(answerRequests, effectiveRequestId, controller);

  // Hard timeout so the UI never spins forever
  const timeout = setTimeout(() => controller.abort(), 120000);

  const enrichedPayload = payload;
  const idempotencyKey = `answer:${effectiveRequestId}`;

  try {
    let token = await ensureInstallToken(proxyUrl, generation);

    const doRequest = async () =>
      fetch(`${proxyUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey
        },
        signal: controller.signal,
        body: JSON.stringify(enrichedPayload)
      });

    let response = await doRequest();

    if (response.status === 401) {
      // Token expired/revoked → re-register once and retry
      await clearInstallTokenIfCurrent(token, generation);
      token = await ensureInstallToken(proxyUrl, generation);
      response = await doRequest();
    }

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, `Proxy error: ${response.status}`));
    }

    return await response.json();
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error('Cancelled');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
    unregister();
  }
}
