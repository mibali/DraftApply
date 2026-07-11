/**
 * DraftApply Content Script
 * 
 * Runs on job application pages to:
 * - Auto-extract job description from the page
 * - Detect form fields and textareas
 * - Show answer generation UI
 * - Insert generated answers
 * 
 * The extension automatically uses the CV + page context
 * to generate highly tailored answers.
 */

class DraftApplyExtension {
  constructor() {
    this.modal = null;
    this.currentField = null;
    this.lastFocusedField = null;
    this.pageExtractor = new PageExtractor();
    this.pageContext = null;
    this.lastAnswer = null;
    this.lastQuestion = null;
    this.observer = null;
    this._streamResolvers = new Map(); // requestId -> { resolve, reject }
    this._prefetchCache = new WeakMap(); // field -> { status, question, answer, promise }
    this._prefetchByQuestion = new Map(); // context-aware question key -> answer (survives React re-renders)
    this._buttonMap = new WeakMap();    // field -> overlay button
    this._observedRoots = new WeakSet(); // Document/ShadowRoot roots watched for new fields
    this._prefetchTimer = null;
    this._prefetchField = null;
    this._contextRefreshTimer = null;
    this._pageContextKey = null;
    this._lastChunkTime = 0; // epoch ms; updated on each STREAM_CHUNK for watchdog
    this.answerValidation = null;
    this.answerValidationRequestId = null;
    this.answerUserEdited = false;
    this.reviewAcknowledged = false;

    this.init();
  }

  createDraftApplyIconImg(sizePx = 20) {
    const img = document.createElement('img');
    img.className = 'da-icon';
    img.alt = 'DraftApply';
    img.width = sizePx;
    img.height = sizePx;
    img.style.pointerEvents = 'none'; // Clicks pass through to parent button
    try {
      img.src = chrome.runtime.getURL('icons/icon128.png');
    } catch {
      // Context invalidated (extension reloaded) — onerror will swap in the SVG fallback
      img.src = '';
    }
    img.decoding = 'async';
    img.loading = 'eager';
    img.onerror = () => {
      // Fallback: inline SVG if image can't load (e.g. cross-origin iframe)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', sizePx);
      svg.setAttribute('height', sizePx);
      svg.setAttribute('viewBox', '0 0 32 32');
      svg.setAttribute('fill', 'none');
      svg.className.baseVal = 'da-icon';
      svg.style.pointerEvents = 'none';
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', '32');
      rect.setAttribute('height', '32');
      rect.setAttribute('rx', '6');
      rect.setAttribute('fill', '#2563eb');
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', '16');
      text.setAttribute('y', '22');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'white');
      text.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');
      text.setAttribute('font-size', '14');
      text.setAttribute('font-weight', '700');
      text.textContent = 'DA';
      svg.appendChild(rect);
      svg.appendChild(text);
      img.replaceWith(svg);
    };
    return img;
  }

  // getCvContext is now handled server-side by the recipe module.

  init() {
    this.extractPageContext();
    this.createModal();
    this.listenForMessages();
    this.observeFormFields();
    this.showPageContextIndicator();
    this.installSpaNavigationWatchers();
    
    // Re-extract context and re-scan fields after delay (for SPAs that load content async)
    setTimeout(() => {
      try { if (!chrome.runtime?.id) return; } catch { return; }
      this.extractPageContext();
      this.updateContextBadge();
    }, 2000);
    // Some pages render fields late; force a second scan
    setTimeout(() => {
      try { if (!chrome.runtime?.id) return; } catch { return; }
      if (this._rescanFields) this._rescanFields();
    }, 1500);
    
    // Re-extract on SPA navigation — stored so destroy() can remove it
    this._onPopState = () => {
      try { if (!chrome.runtime?.id) return; } catch { return; }
      this.clearSessionForNavigation();
      this.scheduleContextRefresh('popstate', 100);
    };
    window.addEventListener('popstate', this._onPopState);

    this._onDraftApplyNavigation = () => {
      try { if (!chrome.runtime?.id) return; } catch { return; }
      this.clearSessionForNavigation();
      this.scheduleContextRefresh('history', 250);
    };
    window.addEventListener('draftapply:navigation', this._onDraftApplyNavigation);

    this._onStorageChanged = (changes, areaName) => {
      if (areaName === 'local' && changes.tailorCvDraft) this.clearAnswerCaches();
    };
    chrome.storage?.onChanged?.addListener(this._onStorageChanged);
  }

  destroy() {
    this.observer?.disconnect();
    this.modal?.remove();
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    if (this._onPopState) window.removeEventListener('popstate', this._onPopState);
    if (this._onDraftApplyNavigation) window.removeEventListener('draftapply:navigation', this._onDraftApplyNavigation);
    if (this._onStorageChanged) chrome.storage?.onChanged?.removeListener(this._onStorageChanged);
    if (this._contextRefreshTimer) clearTimeout(this._contextRefreshTimer);
    // Clean up overlay buttons
    document.querySelectorAll('.da-field-btn-overlay').forEach(btn => btn.remove());
    document.querySelectorAll('#draftapply-indicator').forEach(el => el.remove());
  }

  /**
   * Extract job context from the current page
   */
  extractPageContext() {
    try {
      const ctx = this.pageExtractor.extract();
      if (ctx) this.setPageContext(ctx);
    } catch (e) {
      console.warn('[DraftApply] Failed to extract page context:', e);
      if (this.pageContext?.url && this.pageContext.url !== window.location.href) {
        this.setPageContext({
          url: window.location.href,
          platform: this.pageContext.platform || 'generic',
          jobTitle: '',
          company: '',
          jobDescription: '',
          contextQuality: 'none',
          requirements: [],
          extractedAt: new Date().toISOString()
        });
      }
    }
  }

  setPageContext(ctx) {
    const nextKey = this.contextCacheKey(ctx);
    const changed = this._pageContextKey && nextKey !== this._pageContextKey;
    this.pageContext = ctx;
    this._pageContextKey = nextKey;
    if (changed) this.clearAnswerCaches();
  }

  contextCacheKey(ctx = this.pageContext || {}) {
    const contextText = ctx.sectionedJobContext || ctx.jobDescription || ctx.fullPageText || '';
    const parts = [
      ctx.url || window.location.href,
      ctx.jobTitle || '',
      ctx.company || '',
      ctx.contextQuality || '',
      this.hashText(contextText)
    ];
    return parts.join('|');
  }

  hashText(text) {
    const value = String(text || '').slice(0, 12000);
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) + hash) + value.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  answerCacheKey(question, ctx = this.pageContext || {}) {
    return `${this.contextCacheKey(ctx)}::${String(question || '').trim().toLowerCase()}`;
  }

  clearAnswerCaches() {
    this._prefetchCache = new WeakMap();
    this._prefetchByQuestion.clear();
    document.querySelectorAll('.da-field-btn-overlay.da-btn-ready,.da-field-btn-overlay.da-btn-prefetching')
      .forEach(btn => btn.classList.remove('da-btn-ready', 'da-btn-prefetching'));
  }

  clearSessionForNavigation() {
    this.clearAnswerCaches();
    this._iframeSourceFrameId = null;
    this.currentField = null;
    this.lastFocusedField = null;
  }

  scheduleContextRefresh(_reason = 'change', delay = 900) {
    clearTimeout(this._contextRefreshTimer);
    this._contextRefreshTimer = setTimeout(() => {
      try { if (!chrome.runtime?.id) return; } catch { return; }
      this.extractPageContext();
      this.updateContextBadge();
    }, delay);
  }

  installSpaNavigationWatchers() {
    if (window.__draftapplyHistoryPatched) return;
    window.__draftapplyHistoryPatched = true;

    const notify = () => {
      setTimeout(() => window.dispatchEvent(new Event('draftapply:navigation')), 0);
    };

    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    }
    window.addEventListener('hashchange', notify);
  }

  /**
   * Show a small indicator that DraftApply has detected job context
   */
  showPageContextIndicator() {
    const quality = this.pageContext?.contextQuality;
    if (quality !== 'structured' && quality !== 'heuristic') return;

    const indicator = document.createElement('div');
    indicator.id = 'draftapply-indicator';
    // Avoid innerHTML: page content is untrusted
    const content = document.createElement('div');
    content.className = 'da-indicator-content';

    const icon = this.createDraftApplyIconImg(18);
    icon.classList.add('da-indicator-icon');

    const text = document.createElement('span');
    text.className = 'da-indicator-text';
    text.textContent = 'DraftApply ready';

    const meta = document.createElement('span');
    meta.className = 'da-indicator-meta';
    meta.textContent = this.pageContext.jobTitle || 'Job detected';

    content.append(icon, text, meta);
    indicator.appendChild(content);
    if (!document.body) return;
    document.body.appendChild(indicator);

    // Auto-hide after 5 seconds
    setTimeout(() => {
      indicator.classList.add('da-fade-out');
      setTimeout(() => indicator.remove(), 500);
    }, 5000);
  }

  createModal() {
    const modal = document.createElement('div');
    modal.id = 'draftapply-modal';
    modal.innerHTML = `
      <div class="da-modal-content">
        <div class="da-modal-header">
          <img class="da-modal-logo" src="${chrome.runtime.getURL('icons/icon128.png')}" alt="">
          <span class="da-header-name">DraftApply</span>
          <span class="da-context-badge" id="da-context-badge">No context</span>
          <span class="da-model-badge" id="da-model-badge" hidden></span>
          <button class="da-modal-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="da-modal-body">
          <div class="da-context-info" id="da-context-info"></div>
          <div class="da-jd-paste-area" id="da-jd-paste-area" hidden>
            <textarea class="da-jd-input" id="da-jd-input" rows="4" placeholder="Paste the full job posting here — we'll extract the relevant requirements…"></textarea>
            <div class="da-jd-paste-actions">
              <button type="button" class="da-btn da-btn-jd-use" id="da-jd-confirm">Use this JD</button>
              <button type="button" class="da-btn da-btn-jd-cancel" id="da-jd-cancel">Cancel</button>
            </div>
          </div>
          <div class="da-question-label">Question <span class="da-question-hint">(editable)</span></div>
          <textarea class="da-question-preview" id="da-question-preview" rows="2" spellcheck="false"></textarea>
          <div class="da-answer-label">Generated Answer <span id="da-char-hint" class="da-char-hint"></span></div>
          <textarea class="da-answer-output" id="da-answer-output" placeholder="Your answer will appear here. You can edit it before inserting."></textarea>
          <div id="da-char-counter" class="da-char-counter" hidden></div>
          <div id="da-agent-insights" class="da-agent-insights" hidden></div>
          <input type="hidden" id="da-length-select" value="medium">
          <input type="hidden" id="da-tone-select" value="natural">
        </div>
        <div class="da-modal-actions">
          <div class="da-controls-row">
            <div class="da-control-group">
              <span class="da-control-label">Length</span>
              <div class="da-length-pills" id="da-length-pills" role="group" aria-label="Answer length">
                <button type="button" class="da-length-pill" data-value="short">Short</button>
                <button type="button" class="da-length-pill da-pill-active" data-value="medium">Medium</button>
                <button type="button" class="da-length-pill" data-value="long">Long</button>
              </div>
            </div>
            <div class="da-control-group">
              <span class="da-control-label">Tone</span>
              <div class="da-tone-pills" id="da-tone-pills" role="group" aria-label="Answer tone">
                <button type="button" class="da-tone-pill" data-value="formal">Formal</button>
                <button type="button" class="da-tone-pill da-pill-active" data-value="natural">Natural</button>
                <button type="button" class="da-tone-pill" data-value="direct">Direct</button>
              </div>
            </div>
          </div>
          <div class="da-modal-actions-row">
            <button class="da-btn da-btn-regenerate" id="da-btn-regenerate">Regenerate</button>
            <button class="da-btn da-btn-copy" id="da-btn-copy">Copy</button>
            <button class="da-btn da-btn-insert" id="da-btn-insert" disabled>Insert Answer</button>
          </div>
        </div>
        <div class="da-loading" id="da-loading" hidden role="status" aria-label="Generating answer">
          <div class="da-spinner"></div>
          <span id="da-loading-text">Generating answer…</span>
          <button class="da-btn da-btn-stop" id="da-btn-stop" type="button">Stop</button>
        </div>
      </div>
    `;
    
    modal.style.display = 'none';
    this.modal = modal;

    // Hide logo if icon fails to load (CSP-safe alternative to onerror attribute)
    const logoImg = modal.querySelector('.da-modal-logo');
    if (logoImg) logoImg.addEventListener('error', () => { logoImg.style.display = 'none'; });

    // Bind events first (they persist even if modal is detached from DOM)
    const bindModalAction = (selector, handler) => {
      const el = modal.querySelector(selector);
      if (!el) return;
      el.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        handler(event);
      };
    };

    bindModalAction('.da-modal-close', () => this.hideModal());
    bindModalAction('#da-btn-insert', (event) => this.insertAnswer(event));
    bindModalAction('#da-btn-regenerate', () => this.regenerate());
    bindModalAction('#da-btn-copy', () => this.copyAnswer());
    bindModalAction('#da-btn-stop', () => this.cancelGeneration());
    bindModalAction('#da-jd-confirm', () => this._confirmJdPaste());
    bindModalAction('#da-jd-cancel', () => this._cancelJdPaste());
    modal.querySelector('#da-length-pills').onclick = (e) => {
      const pill = e.target.closest('.da-length-pill');
      if (!pill) return;
      modal.querySelectorAll('.da-length-pill').forEach(p => p.classList.remove('da-pill-active'));
      pill.classList.add('da-pill-active');
      modal.querySelector('#da-length-select').value = pill.dataset.value;
    };

    modal.querySelector('#da-tone-pills').onclick = (e) => {
      const pill = e.target.closest('.da-tone-pill');
      if (!pill) return;
      modal.querySelectorAll('.da-tone-pill').forEach(p => p.classList.remove('da-pill-active'));
      pill.classList.add('da-pill-active');
      modal.querySelector('#da-tone-select').value = pill.dataset.value;
    };

    // Live character counter — only active when field has a maxLength
    modal.querySelector('#da-answer-output').addEventListener('input', () => {
      if (this.answerValidation) {
        this.answerUserEdited = true;
        this.answerValidation = null;
        this.reviewAcknowledged = false;
        this.lastAnswer = null;
        const insertButton = this.modal?.querySelector?.('#da-btn-insert');
        if (insertButton) {
          insertButton.disabled = true;
          insertButton.textContent = 'Regenerate to Validate';
        }
      }
      this._updateCharCounter();
    });
    
    modal.onclick = (e) => {
      if (e.target === modal) this.hideModal();
    };

    // Stop events from bubbling OUT of the modal to page-level handlers.
    // Do not use capture listeners here: capture-phase stopPropagation on an
    // ancestor prevents button clicks from reaching their own handlers.
    const modalContent = modal.querySelector('.da-modal-content');
    const stopPageEvent = (e) => e.stopPropagation();
    for (const eventName of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) {
      modalContent.addEventListener(eventName, stopPageEvent);
    }

    // Stop keydown/focusin from bubbling to page handlers (e.g. ATS close-on-key).
    // ESC is handled here; all other keys already fired on our textarea first.
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideModal();
      e.stopPropagation();
    });
    modal.addEventListener('focusin', stopPageEvent);
    modal.addEventListener('focusout', stopPageEvent);

    // Fallback document-level ESC handler (catches Escape when focus is outside modal)
    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && modal.style.display !== 'none') {
        this.hideModal();
      }
    };
    document.addEventListener('keydown', this._onKeyDown);

    // Append to DOM (may be re-attached later if React removes it)
    if (document.body) {
      document.body.appendChild(modal);
    }

    // Update context badge
    this.updateContextBadge();
  }

  updateContextBadge() {
    if (!this.modal) return;
    const badge = this.modal.querySelector('#da-context-badge');
    const info = this.modal.querySelector('#da-context-info');
    
    const quality = this.pageContext?.contextQuality;
    const hasRealContext = quality === 'structured' || quality === 'heuristic';
    const hasNoisyContext = quality === 'fullpage';

    if (hasRealContext) {
      badge.textContent = '✓ Job context detected';
      badge.className = 'da-context-badge da-badge-success';
      info.className = 'da-context-info';

      // Avoid innerHTML: page content is untrusted
      info.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = this.pageContext.jobTitle || 'Job';
      info.appendChild(strong);

      if (this.pageContext.company) {
        info.appendChild(document.createTextNode(' at ' + this.pageContext.company));
      }

      const meta = document.createElement('span');
      meta.className = 'da-context-meta';
      const reqCount = this.pageContext.requirements?.length ?? 0;
      const jdLen = Math.round((this.pageContext.jobDescription?.length ?? 0) / 100) * 100;
      meta.textContent = `${reqCount} requirements detected • ${jdLen}+ chars`;
      info.appendChild(meta);
    } else if (hasNoisyContext) {
      badge.textContent = '⚠ Partial context';
      badge.className = 'da-context-badge da-badge-warning';
      info.className = 'da-context-info da-context-warning';
      info.replaceChildren();
      const warnMsg = document.createElement('span');
      warnMsg.textContent = 'Job description not found — answers may not be tailored to this role.';
      const pasteBtn = document.createElement('button');
      pasteBtn.type = 'button';
      pasteBtn.className = 'da-paste-jd-btn';
      pasteBtn.textContent = 'Paste JD';
      pasteBtn.onclick = () => this._showJdPasteArea();
      info.append(warnMsg, document.createTextNode(' '), pasteBtn);
    } else {
      badge.textContent = 'No context';
      badge.className = 'da-context-badge';
      info.className = 'da-context-info da-context-none';
      info.replaceChildren();
      const noneMsg = document.createElement('span');
      noneMsg.textContent = 'No job description detected — open the job listing tab first, or ';
      const pasteBtn2 = document.createElement('button');
      pasteBtn2.type = 'button';
      pasteBtn2.className = 'da-paste-jd-btn da-paste-jd-btn-muted';
      pasteBtn2.textContent = 'paste JD manually';
      pasteBtn2.onclick = () => this._showJdPasteArea();
      info.append(noneMsg, pasteBtn2);
    }
  }

  listenForMessages() {
    const fieldSelector = this.fieldSelector();

    // Track last focused field for context menu insert
    document.addEventListener('focusin', (e) => {
      const field = this.fieldFromEvent(e, fieldSelector);
      if (field && !field.closest?.('#draftapply-modal')) {
        this.lastFocusedField = field;
      }
    }, true);

    // Also track on right-click
    document.addEventListener('contextmenu', (e) => {
      const field = this.fieldFromEvent(e, fieldSelector);
      if (field && !field.closest('#draftapply-modal')) {
        this.lastFocusedField = field;
      }
    }, true);

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'PING') {
        sendResponse({ pong: true });
        return;
      }

      if (message.type === 'GENERATE_ANSWER') {
        // Set currentField from lastFocusedField if not already set
        if (!this.currentField && this.lastFocusedField) {
          this.currentField = this.lastFocusedField;
        }
        this.handleGenerateRequest(message.question);
      }
      
      // Parent frame receives this from background when an iframe relays a generate request
      if (message.type === 'GENERATE_FROM_IFRAME') {
        // Only handle in the top frame
        if (window !== window.top) return;
        // Merge iframe context: only replace parent's context if the iframe's
        // context is better quality. The parent's page often has richer
        // structured data than the embedded form iframe.
        if (message.iframePageContext) {
          const parentQuality = this.pageContext?.contextQuality;
          const iframeQuality = message.iframePageContext?.contextQuality;
          const parentIsGood = parentQuality === 'structured' || parentQuality === 'heuristic';
          const iframeIsGood = iframeQuality === 'structured' || iframeQuality === 'heuristic';
          if (!parentIsGood || (iframeIsGood && iframeQuality === 'structured' && parentQuality !== 'structured')) {
            this.pageContext = message.iframePageContext;
            this.updateContextBadge();
          }
        }
        this._iframeSourceFrameId = message.sourceFrameId;
        this.showModal(message.question);
        this.generateAnswer(message.question);
      }
      
      // Iframe receives this when the parent frame's user clicks "Insert Answer"
      if (message.type === 'INSERT_FROM_PARENT') {
        if (window === window.top) return; // Only handle in iframes
        (async () => {
          const target = this.currentField || this.lastFocusedField;
          if (!target?.isConnected) {
            sendResponse({ success: false, error: 'Target field no longer exists' });
            return;
          }
          try {
            const inserted = await this.writeAnswerToTarget(target, message.answer);
            if (!inserted) {
              sendResponse({ success: false, error: 'Field rejected inserted value' });
              return;
            }
            this.showNotification('Answer inserted!');
            globalThis.DraftApplyStats?.track?.('answersInserted')?.catch?.(() => {});
            sendResponse({ success: true });
          } catch (e) {
            console.warn('[DraftApply] Insert from parent failed:', e);
            sendResponse({ success: false, error: e?.message || 'Insert failed' });
          }
        })();
        return true;
      }
      
      if (message.type === 'SHOW_NOTIFICATION') {
        this.showNotification(message.message);
      }

      if (message.type === 'GET_PAGE_CONTEXT') {
        sendResponse(this.pageContext);
      }

      if (message.type === 'STREAM_CHUNK') {
        // Capability-v2 providers never expose unvalidated answer deltas.
        return;
      }

      if (message.type === 'STREAM_META') {
        if (this.currentRequestId === message.requestId) {
          this._lastChunkTime = Date.now();
          this.renderModelBadge(message);
          this._showFallbackNotice(message);
          this.renderAgentInsights(message.agentInsights || message);
        }
        return;
      }

      if (message.type === 'STREAM_PROGRESS') {
        if (this.currentRequestId === message.requestId) this._lastChunkTime = Date.now();
        return;
      }

      if (message.type === 'STREAM_DONE') {
        const resolver = this._streamResolvers.get(message.requestId);
        if (resolver) {
          resolver.resolve();
          this._streamResolvers.delete(message.requestId);
        }
        return;
      }

      if (message.type === 'STREAM_FINAL') {
        if (this.currentRequestId !== message.requestId) return;
        this._lastChunkTime = Date.now();
        const output = this.modal?.querySelector?.('#da-answer-output');
        if (output && typeof message.answer === 'string') output.value = message.answer;
        this._setAnswerValidation(message.validation, message.requestId);
        this.renderModelBadge(message);
        this.renderAgentInsights(message.pipelineInsights || message.agentInsights || message);
        this._updateCharCounter();
        return;
      }

      if (message.type === 'STREAM_ERROR') {
        const resolver = this._streamResolvers.get(message.requestId);
        if (resolver) {
          resolver.reject(new Error(message.error || 'Stream error'));
          this._streamResolvers.delete(message.requestId);
        }
        return;
      }
    });
  }

  observeFormFields() {
    // Use overlay buttons instead of wrapping fields (avoids breaking React)
    const buttonMap = this._buttonMap; // lifted to class so prefetch can reference it

    const BTN_SIZE = 36;
    const BTN_INSET = 6;
    
    // Use fixed positioning — more reliable inside iframes and scrollable containers
    const positionButton = (field, btn) => {
      const rect = field.getBoundingClientRect();
      btn.style.top = `${rect.top + BTN_INSET}px`;
      btn.style.left = `${rect.right - BTN_SIZE - BTN_INSET}px`;
    };

    const addButtons = () => {
      // chrome.runtime itself throws when the extension context is invalidated,
      // so we can't use it as a plain expression — must catch.
      let ctxOk;
      try { ctxOk = !!chrome.runtime?.id; } catch { ctxOk = false; }
      if (!ctxOk) {
        // Context is dead — disconnect the observer so this never fires again.
        try { this.observer?.disconnect(); } catch {}
        return;
      }
      if (!document.body) return; // Not ready yet (iframe still loading)
      this.observeAllRoots(debouncedAddButtons);

      const fields = this.querySelectorAllDeep(this.fieldSelector());
      
      fields.forEach(field => {
        // Skip if already has button or is too small/hidden
        if (buttonMap.has(field)) return;
        if (field.tagName === 'INPUT' && field.offsetWidth < 100) return;
        if (field.type === 'hidden') return;
        // Use getBoundingClientRect instead of offsetParent — offsetParent is null for
        // elements inside position:fixed containers (e.g. SmartRecruiters apply modal),
        // which would incorrectly hide all buttons on those pages.
        const _fieldRect = field.getBoundingClientRect();
        if (_fieldRect.width === 0 && _fieldRect.height === 0) return;
        // Never attach overlay buttons to our own modal elements
        if (field.closest('#draftapply-modal')) return;
        
        const btn = document.createElement('button');
        btn.className = 'da-field-btn-overlay';
        btn.replaceChildren(this.createDraftApplyIconImg(20));
        btn.title = 'Generate answer with DraftApply';
        btn.type = 'button';
        btn.tabIndex = -1; // Focusable (fixes macOS relatedTarget) but not in tab order
        
        // Track whether a click is in progress to prevent premature hiding
        let clickPending = false;
        
        // Use mousedown — fires before blur, avoids race with hide timer
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault(); // Prevent field from losing focus prematurely
          e.stopPropagation();
          clickPending = true;
        });
        
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          clickPending = false;
          this.currentField = field;
          // maxLength is -1 when unset; treat anything <= 0 as "no limit"
          this.currentFieldMaxLength = (field.maxLength > 0) ? field.maxLength : null;

          const label = this.findFieldLabel(field);
          const fieldHint = field.name || field.id || field.placeholder || null;
          const question = (label || fieldHint || 'Please describe your relevant experience and background').slice(0, 500);

          // Use prefetch cache if answer is ready for the same question.
          // Check WeakMap first (same element), then the question-keyed Map as
          // fallback for React re-renders that replaced the DOM element.
          const cacheKey = this.answerCacheKey(question);
          const cached = this._prefetchCache.get(field);
          const cachedResult = (cached?.status === 'ready' && cached.question === question && cached.cacheKey === cacheKey)
            ? cached.result
            : this._prefetchByQuestion.get(cacheKey);
          if (cachedResult?.answer) {
            this.showModal(question);
            const output = this.modal.querySelector('#da-answer-output');
            output.value = cachedResult.answer;
            this._setAnswerValidation(cachedResult.validation, null);
            this.lastQuestion = question;
            // Remove ready indicator from button
            btn.classList.remove('da-btn-ready');
            this._prefetchCache.delete(field);
            this._prefetchByQuestion.delete(cacheKey);
            return;
          }

          // If prefetch is still in-flight for the same question, show modal and let
          // it fill in automatically once the promise resolves (falls through to normal
          // generateAnswer which will race or the prefetch completes in background).
          this.handleGenerateRequest(question);
        });
        
        document.body.appendChild(btn);
        buttonMap.set(field, btn);
        btn._draftapplyField = field; // Store reference for orphan cleanup
        
        // Show button only when field is focused or hovered
        const showBtn = () => {
          positionButton(field, btn);
          btn.classList.add('da-btn-visible');
        };
        const hideBtn = () => {
          // Don't hide while a click is in progress or the field is still focused
          if (clickPending) return;
          if (document.activeElement === field) return;
          btn.classList.remove('da-btn-visible');
        };
        
        field.addEventListener('focus', () => {
          showBtn();
        });
        field.addEventListener('mouseenter', showBtn);
        field.addEventListener('blur', (e) => {
          // Don't hide if focus moved to the button
          if (e.relatedTarget === btn) return;
          setTimeout(hideBtn, 400);
        });
        field.addEventListener('mouseleave', (e) => {
          if (document.activeElement === field) return;
          setTimeout(hideBtn, 400);
        });
        // Keep button visible while hovering/interacting with it
        btn.addEventListener('mouseenter', showBtn);
        btn.addEventListener('mouseleave', () => {
          if (document.activeElement !== field) {
            setTimeout(hideBtn, 400);
          }
        });
      });
      
      // Clean up orphaned buttons (check if their field is still connected)
      document.querySelectorAll('.da-field-btn-overlay').forEach(btn => {
        if (!btn._draftapplyField || !btn._draftapplyField.isConnected) {
          btn.remove();
        }
      });
    };

    // Debounce to avoid excessive calls
    let debounceTimer;
    const debouncedAddButtons = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        addButtons();
        this.scheduleContextRefresh('mutation', 900);
      }, 150);
    };

    // Reposition visible buttons on scroll/resize (don't re-scan DOM)
    const repositionVisible = () => {
      document.querySelectorAll('.da-field-btn-overlay.da-btn-visible').forEach(btn => {
        if (btn._draftapplyField?.isConnected) {
          positionButton(btn._draftapplyField, btn);
        }
      });
    };

    addButtons();

    // Expose for delayed re-scan from init()
    this._rescanFields = addButtons;

    this.observer = new MutationObserver(debouncedAddButtons);
    this.observeAllRoots(debouncedAddButtons);
    
    // Reposition on scroll/resize (lightweight — only moves visible buttons)
    window.addEventListener('scroll', repositionVisible, { passive: true });
    window.addEventListener('resize', repositionVisible, { passive: true });
  }

  fieldSelector() {
    return 'textarea,' +
      'input:not([type]),' +
      'input[type="text"],input[type="email"],input[type="tel"],input[type="search"],input[type="url"],' +
      '[contenteditable="true"],[role="textbox"]';
  }

  fieldFromEvent(event, selector = this.fieldSelector()) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.(selector)) return node;
      const closest = node.closest?.(selector);
      if (closest) return closest;
    }
    return null;
  }

  getOpenRoots(root = document, seen = new Set()) {
    if (!root || seen.has(root)) return [];
    seen.add(root);

    const roots = [root];
    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of elements) {
      if (el.shadowRoot) {
        roots.push(...this.getOpenRoots(el.shadowRoot, seen));
      }
    }
    return roots;
  }

  querySelectorAllDeep(selector) {
    const results = [];
    for (const root of this.getOpenRoots()) {
      try {
        results.push(...root.querySelectorAll(selector));
      } catch (e) {
        // Ignore malformed selectors in hostile pages; callers use constants.
      }
    }
    return [...new Set(results)];
  }

  observeAllRoots(callback) {
    if (!this.observer || !document.body) return;

    for (const root of this.getOpenRoots()) {
      if (this._observedRoots.has(root)) continue;
      try {
        const target = root === document ? document.body : root;
        this.observer.observe(target, { childList: true, subtree: true });
        this._observedRoots.add(root);
      } catch (e) {
        // Some detached roots cannot be observed.
      }
    }
  }

  // ── Field constraint helpers ─────────────────────────────────────────────

  _inferLengthFromField(field) {
    if (!field) return null;
    const maxLen = (field.maxLength > 0) ? field.maxLength : null;
    const isSingleLine = field.tagName === 'INPUT';
    if (isSingleLine) return 'short';
    if (maxLen && maxLen <= 250) return 'short';
    if (maxLen && maxLen <= 700) return 'medium';
    return null; // no constraint — don't override user's selection
  }

  _setLengthPill(length) {
    const modal = this.modal;
    if (!modal) return;
    modal.querySelectorAll('.da-length-pill').forEach(p => p.classList.remove('da-pill-active'));
    const pill = modal.querySelector(`.da-length-pill[data-value="${length}"]`);
    if (pill) pill.classList.add('da-pill-active');
    modal.querySelector('#da-length-select').value = length;
  }

  _applyCharLimit(text) {
    const maxLen = this.currentFieldMaxLength;
    if (!maxLen || !text || text.length <= maxLen) return text;
    // Try to end at a sentence boundary within the limit
    const cut = text.slice(0, maxLen);
    const sentenceEnd = cut.search(/[.!?][^.!?]*$/);
    if (sentenceEnd > maxLen * 0.6) return text.slice(0, sentenceEnd + 1).trim();
    // Fall back to last word boundary
    const wordEnd = cut.lastIndexOf(' ');
    return (wordEnd > maxLen * 0.7 ? cut.slice(0, wordEnd) : cut).trim();
  }

  _updateCharCounter() {
    const maxLen = this.currentFieldMaxLength;
    const counter = this.modal?.querySelector('#da-char-counter');
    const outputEl = this.modal?.querySelector('#da-answer-output');
    if (!counter) return;
    if (!maxLen) {
      counter.hidden = true;
      outputEl?.classList.remove('da-char-over');
      return;
    }
    const text = outputEl?.value || '';
    const count = text.length;
    const over = count > maxLen;
    counter.hidden = false;
    counter.textContent = `${count} / ${maxLen} characters`;
    counter.className = over ? 'da-char-counter da-char-over' : 'da-char-counter';
    outputEl?.classList.toggle('da-char-over', over);
  }

  findFieldLabel(field) {
    const root = field.getRootNode?.() || document;
    const cleanText = (text) => String(text || '')
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const labelTextWithoutControls = (el) => {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll?.('input,textarea,select,button,script,style').forEach(node => node.remove());
      return cleanText(clone.textContent);
    };

    // 1. Explicit <label for="...">
    if (field.id) {
      try {
        const label = root.querySelector?.(`label[for="${CSS.escape(field.id)}"]`);
        const text = labelTextWithoutControls(label) || cleanText(label?.textContent);
        if (text) return text;
      } catch (e) {
        const label = root.querySelector?.(`label[for="${field.id}"]`);
        const text = labelTextWithoutControls(label) || cleanText(label?.textContent);
        if (text) return text;
      }
    }

    // 2. aria-label attribute
    const ariaLabel = field.getAttribute('aria-label');
    if (ariaLabel) return cleanText(ariaLabel);

    // 3. aria-labelledby (may be space-separated list of ids)
    const labelledBy = field.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map(id => {
          if (root.getElementById) return root.getElementById(id)?.textContent?.trim();
          return root.querySelector?.(`#${CSS.escape(id)}`)?.textContent?.trim()
            || document.getElementById(id)?.textContent?.trim();
        })
        .filter(Boolean);
      if (parts.length) return cleanText(parts.join(' '));
    }

    // 4. title attribute
    if (field.title) return cleanText(field.title);

    // 5. Wrapping label, common on Ashby/Greenhouse/Lever-style forms.
    // Use only the text outside form controls so the user's typed value is not
    // accidentally treated as the question.
    const wrappingLabel = field.closest?.('label');
    if (wrappingLabel && !wrappingLabel.closest?.('#draftapply-modal')) {
      const text = labelTextWithoutControls(wrappingLabel);
      if (text && text.length < 200) return text;
    }

    // 6. Walk up DOM ancestry — look for label/heading text before the input
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
    const isGoodText = (t) => t && t.length > 2 && t.length < 400;

    let ancestor = field.parentElement;
    for (let depth = 0; depth < 10 && ancestor; depth++, ancestor = ancestor.parentElement) {
      // 6a. Explicit <label> or <legend> anywhere in the ancestor (not wrapping the field).
      // Only use if there is exactly ONE such element in this ancestor — multiple labels
      // in a shared container (e.g. LinkedIn/GitHub/Portfolio all under one div) would
      // otherwise always return the first (LinkedIn) label for every field.
      for (const tag of ['label', 'legend']) {
        const els = ancestor.querySelectorAll(tag);
        if (els.length === 1 && !els[0].contains(field)) {
          const t = labelTextWithoutControls(els[0]) || cleanText(els[0].textContent);
          if (isGoodText(t)) return t;
        }
      }

      // 6b. Look at DOM siblings that come BEFORE the field's branch in this ancestor
      const children = Array.from(ancestor.children);
      // Find which child contains (or is) the field
      const branchIdx = children.findIndex(c => c === field || c.contains(field));
      if (branchIdx > 0) {
        // Walk backwards through earlier siblings looking for label-like text
        for (let i = branchIdx - 1; i >= 0; i--) {
          const sib = children[i];
          if (SKIP_TAGS.has(sib.tagName)) continue;
          // Prefer explicit label/heading elements
          const heading = sib.querySelector('label, legend, h1, h2, h3, h4, h5, h6, p, strong, b') || sib;
          const t = labelTextWithoutControls(heading) || cleanText(heading.textContent);
          if (isGoodText(t) && !SKIP_TAGS.has(heading.tagName)) return t;
        }
      }

      // 6c. Any heading/strong element within this ancestor (not the field itself).
      // Cap at 200 chars to avoid returning full paragraph sentences as a "label".
      // Only use this broad fallback when the ancestor owns a single field; in
      // repeated URL groups a shared ancestor often contains labels like
      // LinkedIn/GitHub/Portfolio, and querySelector would always return the
      // first one for every input.
      const fieldsInAncestor = ancestor.querySelectorAll?.(this.fieldSelector())?.length ?? 0;
      if (fieldsInAncestor > 1) continue;
      const heading = ancestor.querySelector('h1,h2,h3,h4,h5,h6,legend,strong,b,p,[class*="label" i],[class*="question" i],[class*="heading" i],[class*="title" i]');
      if (heading && !heading.contains(field)) {
        const t = labelTextWithoutControls(heading) || cleanText(heading.textContent);
        if (isGoodText(t) && t.length <= 200) return t;
      }

      // Stop climbing if we've reached a major landmark
      if (ancestor.matches('form, main, [role="main"], body')) break;
    }

    return null;
  }

  /**
   * Silently prefetch an answer for a field so it can be shown instantly on click.
   * Uses the same structured payload as generateAnswer but non-streaming.
   */
  _jobDescriptionForPayload(ctx = this.pageContext || {}) {
    const isReliableContext = ctx.contextQuality === 'structured' || ctx.contextQuality === 'heuristic';
    if (!isReliableContext) return undefined;
    return ctx.sectionedJobContext || ctx.jobDescription || undefined;
  }

  async _jobContextForPayload(ctx = this.pageContext || {}) {
    const jobDescription = this._jobDescriptionForPayload(ctx);
    if (jobDescription) {
      return {
        jobTitle: ctx.jobTitle || undefined,
        company: ctx.company || undefined,
        jobDescription,
        requirements: (ctx.requirements?.length > 0) ? ctx.requirements : undefined,
      };
    }

    try {
      const { draft: tailorCvDraft } = await chrome.runtime.sendMessage({
        type: 'GET_TAILOR_DRAFT_FOR_PAGE',
        pageContext: ctx,
        url: window.location.href,
      });
      const draftJobDescription = tailorCvDraft?.jobDescription?.trim();
      if (!draftJobDescription) {
        return {
          jobTitle: ctx.jobTitle || undefined,
          company: ctx.company || undefined,
          jobDescription: undefined,
          requirements: undefined,
        };
      }

      return {
        jobTitle: ctx.jobTitle || tailorCvDraft.jobTitle?.trim() || undefined,
        company: ctx.company || tailorCvDraft.company?.trim() || undefined,
        jobDescription: draftJobDescription,
        requirements: undefined,
      };
    } catch (_) {
      return {
        jobTitle: ctx.jobTitle || undefined,
        company: ctx.company || undefined,
        jobDescription: undefined,
        requirements: undefined,
      };
    }
  }

  async _startPrefetch(field) {
    const label = this.findFieldLabel(field);
    const fieldHint = field.name || field.id || field.placeholder || null;
    const question = (label || fieldHint || 'Please describe your relevant experience and background').slice(0, 500);

    let cvResponse;
    try {
      cvResponse = await chrome.runtime.sendMessage({ type: 'GET_CV' });
    } catch (e) { return; }
    if (!cvResponse?.cvText) return;

    const btn = this._buttonMap.get(field);
    const ctx = this.pageContext || {};
    const cacheKey = this.answerCacheKey(question, ctx);
    const jobContextForPayload = await this._jobContextForPayload(ctx);
    const fieldMaxLen = (field.maxLength > 0) ? field.maxLength : null;
    const payload = {
      question,
      length: this._inferLengthFromField(field) || 'medium',
      tone:   'natural',
      cvText:         cvResponse.cvText,
      jobTitle:       jobContextForPayload.jobTitle,
      company:        jobContextForPayload.company,
      jobDescription: jobContextForPayload.jobDescription,
      requirements:   jobContextForPayload.requirements,
      maxChars:       fieldMaxLen || undefined,
    };

    const cacheEntry = { status: 'loading', question, cacheKey, result: null };
    this._prefetchCache.set(field, cacheEntry);
    if (btn?.isConnected) btn.classList.add('da-btn-prefetching');

    try {
      const result = await chrome.runtime.sendMessage({ type: 'CALL_API', requestId: null, payload });
      if (cacheKey !== this.answerCacheKey(question)) {
        cacheEntry.status = 'stale';
        if (btn?.isConnected) btn.classList.remove('da-btn-prefetching', 'da-btn-ready');
        return;
      }
      const answer = result?.answer || result?.text || result?.content || null;
      cacheEntry.result = answer ? { ...result, answer } : null;
      cacheEntry.status = answer && ['pass', 'review'].includes(result?.validation?.status) ? 'ready' : 'error';
      // Also store by question string so re-rendered React fields can still hit the cache.
      // Cap at 20 entries (LRU-evict oldest) to prevent unbounded memory growth.
      if (cacheEntry.status === 'ready') {
        this._prefetchByQuestion.set(cacheKey, cacheEntry.result);
        if (this._prefetchByQuestion.size > 20) {
          this._prefetchByQuestion.delete(this._prefetchByQuestion.keys().next().value);
        }
      }
      if (btn?.isConnected) {
        btn.classList.remove('da-btn-prefetching');
        if (cacheEntry.status === 'ready') btn.classList.add('da-btn-ready');
      }
    } catch (e) {
      cacheEntry.status = 'error';
      if (btn?.isConnected) btn.classList.remove('da-btn-prefetching');
    }
  }

  async handleGenerateRequest(question) {
    if (!this.modal) {
      console.warn('[DraftApply] Modal not ready — cannot generate.');
      return;
    }
    
    // If running inside an iframe, relay to the parent frame for modal display
    // (modals inside iframes are often invisible due to viewport clipping)
    if (window !== window.top) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'RELAY_GENERATE_TO_PARENT',
          question,
          pageContext: this.pageContext
        });
        if (!response?.success) {
          this.showNotification('Could not open DraftApply from this embedded form. Try activating it from the main page.', 'error');
        }
      } catch (e) {
        this.showNotification('Could not open DraftApply from this embedded form. Try activating it from the main page.', 'error');
      }
      return;
    }
    
    this._iframeSourceFrameId = null;
    this.showModal(question);
    await this.generateAnswer(question);
  }

  showModal(question) {
    const modal = this.modal;
    // Re-attach if React hydration or page re-render removed it from DOM
    if (!modal.isConnected) {
      document.body.appendChild(modal);
    }
    modal.querySelector('#da-question-preview').value = question;
    modal.querySelector('#da-answer-output').value = '';
    modal.querySelector('#da-loading').hidden = true;
    // Always hide the JD paste area when opening for a field
    const jdPasteArea = modal.querySelector('#da-jd-paste-area');
    if (jdPasteArea) jdPasteArea.hidden = true;

    // Auto-select length based on field constraints
    const autoLength = this._inferLengthFromField(this.currentField);
    if (autoLength) this._setLengthPill(autoLength);

    // Show/hide char limit hint and counter
    const maxLen = this.currentFieldMaxLength;
    const charHint = modal.querySelector('#da-char-hint');
    if (charHint) charHint.textContent = maxLen ? `· limit: ${maxLen} chars` : '';
    const counter = modal.querySelector('#da-char-counter');
    if (counter) counter.hidden = !maxLen;
    this._updateCharCounter();
    // Force-show with max-priority inline styles to override any page CSS
    modal.setAttribute('style',
      'display:flex !important;position:fixed !important;' +
      'top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;' +
      'z-index:2147483647 !important;background:rgba(0,0,0,0.6) !important;' +
      'align-items:center !important;justify-content:center !important;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important;' +
      'backdrop-filter:blur(4px) !important;visibility:visible !important;' +
      'opacity:1 !important;pointer-events:auto !important;'
    );

    // Move focus into the modal so keyboard users can interact immediately
    setTimeout(() => modal.querySelector('#da-question-preview')?.focus(), 60);
  }

  hideModal() {
    // If a generation is in-flight, cancel it to avoid "infinite spinner" behavior.
    this.cancelGeneration({ silent: true });
    this._iframeSourceFrameId = null;
    if (this.modal) this.modal.setAttribute('style', 'display:none !important;');
  }

  async generateAnswer(question) {
    if (this.currentRequestId) {
      await this.cancelGeneration({ silent: true });
    }

    const loading = this.modal.querySelector('#da-loading');
    const output = this.modal.querySelector('#da-answer-output');
    const length = this.modal.querySelector('#da-length-select').value;
    const tone = this.modal.querySelector('#da-tone-select').value || 'natural';
    const stopBtn = this.modal.querySelector('#da-btn-stop');
    const statusEl = this.modal.querySelector('#da-loading-text');

    this.lastQuestion = question;
    loading.hidden = false;
    stopBtn.disabled = false;
    output.value = '';
    this._setAnswerValidation(null, null);
    this.renderAgentInsights(null);
    this.renderModelBadge(null);
    if (statusEl) statusEl.textContent = 'Generating answer...';

    const startTime = Date.now();
    const statusTimer = setInterval(() => {
      if (loading.hidden) { clearInterval(statusTimer); return; }
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 30 && statusEl) statusEl.textContent = 'Still working — service may be waking up...';
      else if (elapsed > 15 && statusEl) statusEl.textContent = 'This is taking longer than usual...';
      else if (elapsed > 5 && statusEl) statusEl.textContent = 'Connecting to AI service...';
    }, 2000);

    // Hoist requestId and timeoutId so finally can access them regardless of where a throw occurs.
    let requestId;
    let timeoutId;
    let noActivityWatchdog;

    try {
      const cvResponse = await chrome.runtime.sendMessage({ type: 'GET_CV' });

      if (!cvResponse.cvText) {
        output.value = 'Please load your CV first. Click the DraftApply extension icon.';
        return;
      }

      const ctx = this.pageContext || {};
      // Prefer reliable page context, then fall back to the user's saved Tailor JD.
      const jobContextForPayload = await this._jobContextForPayload(ctx);
      const structuredPayload = {
        question,
        length,
        tone,
        cvText:         cvResponse.cvText,
        jobTitle:       jobContextForPayload.jobTitle,
        company:        jobContextForPayload.company,
        jobDescription: jobContextForPayload.jobDescription,
        requirements:   jobContextForPayload.requirements,
        pageUrl:        ctx.url || window.location.href,
        platform:       ctx.platform || undefined,
        maxChars:       this.currentFieldMaxLength || undefined,
      };

      requestId = globalThis.crypto?.randomUUID?.() ?? `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      this.currentRequestId = requestId;

      // Promise bridge: resolves/rejects when STREAM_DONE/STREAM_ERROR arrives
      const streamPromise = new Promise((resolve, reject) => {
        this._streamResolvers.set(requestId, { resolve, reject });
      });

      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const resolver = this._streamResolvers.get(requestId);
          if (resolver) {
            resolver.reject(new Error('Request timed out after 2 minutes'));
            this._streamResolvers.delete(requestId);
          }
        }, 120000);
      });

      const startResult = await chrome.runtime.sendMessage({
        type: 'CALL_API_STREAM',
        requestId,
        payload: structuredPayload
      });

      // If streaming failed to start (SW sleeping, Chrome version quirk, etc.)
      // fall back immediately to non-streaming rather than showing an error.
      if (!startResult?.started) {
        if (this.currentRequestId !== requestId) return;
        if (statusEl) statusEl.textContent = 'Generating answer...';
        loading.hidden = false; // re-show loading in case it was hidden
        const fallback = await chrome.runtime.sendMessage({
          type: 'CALL_API',
          requestId,
          payload: structuredPayload
        });
        if (this.currentRequestId !== requestId) return;
        if (fallback?.answer) {
          output.value = fallback.answer;
          this._setAnswerValidation(fallback.validation, requestId);
          this._updateCharCounter();
          this._showFallbackNotice(fallback);
          this.renderModelBadge(fallback);
          this.renderAgentInsights(fallback.agentInsights || fallback);
        } else if (fallback?.error) {
          output.value = `Error: ${fallback.error}`;
        } else {
          output.value = 'Error: No answer received. Please try again.';
        }
        return;
      }

      // No-activity watchdog: if the SW is terminated mid-stream, chunks stop
      // arriving but STREAM_DONE never fires. After 45s with no chunk, cancel
      // the stale stream and resolve the promise empty so the existing
      // CALL_API fallback path kicks in automatically.
      this._lastChunkTime = Date.now();
      noActivityWatchdog = setInterval(async () => {
        if (this.currentRequestId !== requestId) {
          clearInterval(noActivityWatchdog);
          return;
        }
        if (Date.now() - this._lastChunkTime > 45000) {
          clearInterval(noActivityWatchdog);
          try { await chrome.runtime.sendMessage({ type: 'CANCEL_API', requestId }); } catch (_) {}
          const resolver = this._streamResolvers.get(requestId);
          if (resolver) {
            resolver.resolve(); // empty resolve → output.value is '' → CALL_API fallback triggers
            this._streamResolvers.delete(requestId);
          }
        }
      }, 5000);

      // Wait for stream to finish — chunks arrive via STREAM_CHUNK messages
      await Promise.race([streamPromise, timeoutPromise]);
      clearInterval(noActivityWatchdog);

      if (this.currentRequestId !== requestId) return; // Stale — newer request took over

      const answer = output.value.trim();
      if (answer && this.answerValidation) {
        this._updateCharCounter();
      } else {
        // No chunks received — proxy may not support SSE or buffered the response.
        // Fall back to non-streaming CALL_API and display the result normally.
        const fallback = await chrome.runtime.sendMessage({
          type: 'CALL_API',
          requestId,
          payload: structuredPayload
        });

        if (this.currentRequestId !== requestId) return; // cancelled while falling back

        if (fallback?.answer) {
          output.value = fallback.answer;
          this._setAnswerValidation(fallback.validation, requestId);
          this._updateCharCounter();
          this._showFallbackNotice(fallback);
          this.renderModelBadge(fallback);
          this.renderAgentInsights(fallback.agentInsights || fallback);
        } else if (fallback?.error) {
          output.value = `Error: ${fallback.error}`;
        } else {
          output.value = 'Error: No answer received. Please try again.';
        }
      }

    } catch (error) {
      if (this.currentRequestId === requestId || !requestId) {
        if (error.message.includes('Extension context invalidated')) {
          output.value = 'Extension was updated. Please refresh this page.';
        } else if (error.message === 'Cancelled') {
          output.value = 'Cancelled.';
        } else {
          output.value = `Error: ${error.message}`;
        }
      }
    } finally {
      clearInterval(statusTimer);
      clearInterval(noActivityWatchdog);
      clearTimeout(timeoutId); // always cancel the 2-min timer, whether success, error, or cancel
      if (this._streamResolvers.has(requestId)) {
        this._streamResolvers.delete(requestId);
      }
      if (this.currentRequestId === requestId) {
        this.currentRequestId = null;
      }
      loading.hidden = true;
    }
  }

  async regenerate() {
    const question = this.modal.querySelector('#da-question-preview').value.trim();
    if (!question) return;
    await this.cancelGeneration({ silent: true });
    await this.generateAnswer(question);
  }

  _showFallbackNotice(result) {
    if (result?.provider === 'openrouter' && result?.fallbackFrom === 'groq') {
      const model = result.model ? `: ${result.model}` : '';
      this.showNotification(`Groq is busy, so DraftApply used OpenRouter fallback${model}.`);
    }
  }

  renderModelBadge(meta) {
    const badge = this.modal?.querySelector('#da-model-badge');
    if (!badge) return;
    const provider = meta?.provider || meta?.openRouterMetadata?.endpoints?.available?.find?.(item => item.selected)?.provider;
    const model = meta?.model || meta?.openRouterMetadata?.model || meta?.openRouterMetadata?.requested;
    const fallbackFrom = meta?.fallbackFrom;
    if (!provider && !model) {
      badge.hidden = true;
      badge.textContent = '';
      badge.className = 'da-model-badge';
      badge.removeAttribute('title');
      return;
    }

    const providerLabel = provider === 'openrouter'
      ? 'OpenRouter'
      : provider === 'groq'
        ? 'Groq'
        : provider === 'local-openai'
          ? 'Local'
          : provider || 'Model';
    const modelLabel = model ? this.shortModelName(model) : '';
    badge.textContent = modelLabel ? `${providerLabel}: ${modelLabel}` : providerLabel;
    badge.className = `da-model-badge ${provider === 'openrouter' || fallbackFrom ? 'da-model-badge-fallback' : ''}`;
    badge.title = [meta?.qualityModeReason, model].filter(Boolean).join('\n');
    badge.hidden = false;
  }

  shortModelName(model) {
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

  renderAgentInsights(insights) {
    const box = this.modal?.querySelector('#da-agent-insights');
    if (!box) return;

    const workflow = insights?.workflow;
    const stagesValue = insights?.pipelineStages || insights?.agentChain;
    const chain = Array.isArray(stagesValue)
      ? stagesValue
      : String(stagesValue || '').split('>').map(item => item.trim()).filter(Boolean);
    const evidence = Array.isArray(insights?.evidence) ? insights.evidence : [];
    const matched = Array.isArray(insights?.matchedRequirements) ? insights.matchedRequirements : [];
    const truth = insights?.truthfulness;
    const domainRisk = insights?.domainRisk || insights?.truthfulnessReport?.domainRisk;

    if (!workflow && evidence.length === 0 && matched.length === 0 && !truth && !domainRisk) {
      box.hidden = true;
      box.textContent = '';
      return;
    }

    const parts = [];
    const title = workflow === 'applicationAnswer' ? 'Answer workflow' : 'DraftApply workflow';
    const meta = [
      insights?.questionType ? this.escapeHtml(insights.questionType.replace(/_/g, ' ')) : null,
      chain.length ? `${chain.length} stages` : null,
    ].filter(Boolean).join(' · ');

    parts.push(`<div class="da-agent-title"><span>${title}</span>${meta ? `<small>${meta}</small>` : ''}</div>`);

    if (evidence.length > 0) {
      parts.push(`
        <div class="da-agent-section">
          <div class="da-agent-label">CV evidence used</div>
          <div class="da-agent-chips">
            ${evidence.map(item => `
              <span class="da-agent-chip" title="${this.escapeHtml(item.text || '')}">
                ${this.escapeHtml(item.label || item.type || 'Evidence')}
              </span>
            `).join('')}
          </div>
        </div>`);
    }

    if (matched.length > 0) {
      parts.push(`
        <div class="da-agent-section">
          <div class="da-agent-label">JD requirements checked</div>
          <div class="da-agent-chips">
            ${matched.map(item => `
              <span class="da-agent-chip ${item.supported ? 'da-agent-chip-ok' : 'da-agent-chip-muted'}">
                ${this.escapeHtml(item.requirement || '')}
              </span>
            `).join('')}
          </div>
        </div>`);
    }

    if (domainRisk?.detected) {
      const profile = domainRisk.primaryProfile?.label || 'Domain review';
      const prompts = Array.isArray(domainRisk.reviewPrompts) ? domainRisk.reviewPrompts : [];
      const warnings = Array.isArray(domainRisk.credentialWarnings) ? domainRisk.credentialWarnings : [];
      parts.push(`
        <div class="da-agent-section da-agent-domain">
          <div class="da-agent-label">Domain review</div>
          <div class="da-agent-domain-line">
            <strong>${this.escapeHtml(profile)}</strong>${domainRisk.primaryProfile?.riskLevel ? ` · ${this.escapeHtml(domainRisk.primaryProfile.riskLevel)}` : ''}
          </div>
          ${warnings.length > 0 ? `
            <div class="da-agent-chips">
              ${warnings.flatMap(item => item.missingCredentials || []).slice(0, 4).map(item => `
                <span class="da-agent-chip da-agent-chip-warn">${this.escapeHtml(item)}</span>
              `).join('')}
            </div>` : ''}
          ${prompts.length > 0 ? `
            <ul class="da-agent-domain-prompts">
              ${prompts.slice(0, 3).map(item => `<li>${this.escapeHtml(item)}</li>`).join('')}
            </ul>` : ''}
        </div>`);
    }

    if (truth) {
      parts.push(`
        <div class="da-agent-trust">
          Input grounding: ${Number(truth.allowedCount || 0)} supported claim${Number(truth.allowedCount || 0) === 1 ? '' : 's'}, ${Number(truth.unsupportedCount || 0)} unsupported requirement${Number(truth.unsupportedCount || 0) === 1 ? '' : 's'} excluded from prompt evidence.
        </div>`);
    }

    box.innerHTML = parts.join('');
    box.hidden = false;
  }

  escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async copyAnswer() {
    const output = this.modal?.querySelector?.('#da-answer-output');
    const text = output?.value?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const btn = this.modal.querySelector('#da-btn-copy');
      const orig = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch (e) {
      this.showNotification('Failed to copy to clipboard');
    }
  }

  async cancelGeneration(options = {}) {
    // Always stop the UI spinner immediately, even if we can't abort the backend call.
    const loading = this.modal?.querySelector?.('#da-loading');
    const output = this.modal?.querySelector?.('#da-answer-output');
    const stopBtn = this.modal?.querySelector?.('#da-btn-stop');

    if (stopBtn) stopBtn.disabled = true;
    if (loading) loading.hidden = true;
    if (output && !String(output.value || '').trim()) output.value = 'Cancelled.';

    const requestId = this.currentRequestId;
    this.currentRequestId = null;

    // Reject the stream promise so generateAnswer's await unblocks immediately
    const resolver = requestId && this._streamResolvers.get(requestId);
    if (resolver) {
      resolver.reject(new Error('Cancelled'));
      this._streamResolvers.delete(requestId);
    }

    // Best-effort abort the network request (may fail if background was reloaded)
    try {
      if (requestId) {
        await chrome.runtime.sendMessage({ type: 'CANCEL_API', requestId });
      } else {
        await chrome.runtime.sendMessage({ type: 'CANCEL_ALL' });
      }
    } catch (e) {
      // ignore
    }

    if (!options.silent) {
      this.showNotification('Cancelled generation.');
    }
  }

  async writeAnswerToTarget(target, answerToInsert) {
    if (!target?.isConnected || !answerToInsert) return false;

    const applyValue = () => {
      target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      target.focus?.();

      if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true' || target.getAttribute?.('role') === 'textbox') {
        this.setContentEditableValue(target, answerToInsert);
        this.dispatchInputEvents(target, answerToInsert);
        return;
      }

      if (typeof target.setSelectionRange === 'function') {
        try {
          target.setSelectionRange(0, target.value?.length ?? 0);
        } catch (e) {
          // Some inputs (e.g. type=number/date) can throw; ignore.
        }
      }

      this.setNativeValue(target, answerToInsert);
      this.dispatchInputEvents(target, answerToInsert);
    };

    applyValue();
    await new Promise(resolve => setTimeout(resolve, 75));
    if (this.targetHasInsertedAnswer(target, answerToInsert)) return true;

    // Some controlled React/Vue inputs briefly roll back after the first event.
    // A second write after the page has processed the first input event catches
    // that common race without hiding the modal prematurely.
    applyValue();
    await new Promise(resolve => setTimeout(resolve, 75));
    return this.targetHasInsertedAnswer(target, answerToInsert);
  }

  setContentEditableValue(target, value) {
    try {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.deleteContents();
      const textNode = document.createTextNode(value);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);

      const selection = window.getSelection?.();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch (e) {
      target.textContent = value;
    }
  }

  targetHasInsertedAnswer(target, expected) {
    if (!target?.isConnected) return false;
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const expectedNorm = normalize(expected);
    if (!expectedNorm) return false;

    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      return normalize(target.value) === expectedNorm;
    }

    if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true' || target.getAttribute?.('role') === 'textbox') {
      const actual = normalize(target.innerText || target.textContent || '');
      return actual === expectedNorm || actual.includes(expectedNorm);
    }

    return false;
  }

  getInsertionTarget() {
    const active = document.activeElement;
    const candidates = [
      this.currentField,
      this.lastFocusedField,
      active
    ].filter(Boolean);

    for (const el of candidates) {
      if (!el?.isConnected) continue;
      // Never target our own modal fields
      if (el.closest?.('#draftapply-modal')) continue;

      // Contenteditable or textbox-like
      if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('role') === 'textbox') {
        return el;
      }

      // Inputs/textareas (skip hidden/disabled/readonly)
      if (el instanceof HTMLTextAreaElement) {
        if (el.disabled || el.readOnly) continue;
        return el;
      }
      if (el instanceof HTMLInputElement) {
        if (el.type === 'hidden') continue;
        if (el.disabled || el.readOnly) continue;
        return el;
      }
    }

    return null;
  }

  dispatchInputEvents(target, value) {
    // Some frameworks (including some Greenhouse forms) listen to beforeinput/input/change.
    try {
      target.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: value
        })
      );
    } catch (e) {
      // Older browsers / some contexts: ignore
    }

    try {
      target.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value
        })
      );
    } catch (e) {
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }

    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  setNativeValue(el, value) {
    if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(el, value);
      return;
    }

    if (el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      try {
        setter?.call(el, value);
      } catch {
        // number/date/range inputs throw when value doesn't conform to their type
        el.value = value;
      }
      return;
    }
  }

  async insertAnswer(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();

    const raw = String(this.modal?.querySelector?.('#da-answer-output')?.value || '').trim();
    // Don't insert error/status messages that the UI writes into the textarea
    const current = (raw && !raw.startsWith('Error:') && raw !== 'Cancelled.') ? raw : '';
    const answerToInsert = current || this.lastAnswer;
    const insertBtn = this.modal?.querySelector?.('#da-btn-insert');

    if (!this.answerValidation || this.answerUserEdited || answerToInsert !== this.validatedAnswer || this.answerValidation.status === 'block') {
      this.showNotification('This answer is not grounded and cannot be inserted. You can edit, copy, or regenerate it.', 'error');
      return;
    }
    if (this.answerValidation.status === 'review' && !this.reviewAcknowledged) {
      const acknowledged = window.confirm('This answer contains facts DraftApply could not verify. Review it carefully. Insert anyway?');
      if (!acknowledged) return;
      this.reviewAcknowledged = true;
    }

    if (!answerToInsert) {
      this.showNotification('No answer to insert yet.', 'error');
      return;
    }

    if (insertBtn?.disabled) return;
    if (insertBtn) insertBtn.disabled = true;

    // If this modal is serving an iframe, relay the answer back to the iframe for insertion
    if (this._iframeSourceFrameId != null) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'RELAY_INSERT_TO_IFRAME',
          answer: answerToInsert,
          targetFrameId: this._iframeSourceFrameId
        });
        if (!response?.success) {
          this.showNotification('Could not insert into the embedded form. The answer is still here to copy.', 'error');
          return;
        }
        this.hideModal();
        this.showNotification('Answer inserted!');
        this._iframeSourceFrameId = null;
      } catch (e) {
        this.showNotification('Could not reach the embedded form. The answer is still here to copy.', 'error');
      } finally {
        if (insertBtn) insertBtn.disabled = false;
      }
      return;
    }

    const target = this.getInsertionTarget();

    if (!target) {
      // Field is no longer in the DOM (React re-render between Generate and Insert).
      // Copy to clipboard and tell the user explicitly so they aren't confused.
      navigator.clipboard.writeText(answerToInsert).catch(() => {});
      this.showNotification('Field no longer found — answer copied to clipboard instead.', 'error');
      if (insertBtn) insertBtn.disabled = false;
      return;
    }

    try {
      const inserted = await this.writeAnswerToTarget(target, answerToInsert);
      if (!inserted) {
        this.showNotification('The page rejected the insert. The answer is still here to copy or try again.', 'error');
        return;
      }

      this.currentField = target;
      this.hideModal();
      this.showNotification('Answer inserted!');
      globalThis.DraftApplyStats?.track?.('answersInserted')?.catch?.(() => {});
    } catch (e) {
      console.warn('[DraftApply] Insert failed:', e);
      this.showNotification('Could not insert into that field. Try clicking the field and typing once, then Insert again.', 'error');
    } finally {
      if (insertBtn) insertBtn.disabled = false;
    }
  }

  _setAnswerValidation(validation, requestId) {
    if (requestId && this.currentRequestId && requestId !== this.currentRequestId) return;
    this.answerValidation = validation || null;
    this.validatedAnswer = validation
      ? String(this.modal?.querySelector?.('#da-answer-output')?.value || '').trim()
      : null;
    this.answerValidationRequestId = requestId;
    this.answerUserEdited = false;
    this.reviewAcknowledged = false;
    const button = this.modal?.querySelector?.('#da-btn-insert');
    if (!button) return;
    const status = validation?.status;
    const hasAnswer = Boolean(this.modal?.querySelector?.('#da-answer-output')?.value?.trim());
    button.disabled = !hasAnswer || !['pass', 'review'].includes(status);
    button.textContent = status === 'review' ? 'Review & Insert' : status === 'block' ? 'Insertion Blocked' : 'Insert Answer';
    this.lastAnswer = status === 'pass' || status === 'review'
      ? String(this.modal?.querySelector?.('#da-answer-output')?.value || '')
      : null;
  }

  async copyToClipboard() {
    const output = this.modal?.querySelector?.('#da-answer-output');
    const text = output?.value?.trim() || this.lastAnswer;
    try {
      await navigator.clipboard.writeText(text);
      this.showNotification('Copied to clipboard! Paste with Ctrl+V / Cmd+V');
    } catch (e) {
      this.showNotification('Could not copy. Please select and copy the text manually.', 'error');
    }
  }

  _showJdPasteArea() {
    const area = this.modal?.querySelector('#da-jd-paste-area');
    const input = this.modal?.querySelector('#da-jd-input');
    if (!area) return;
    area.hidden = false;
    input.value = '';
    setTimeout(() => input.focus(), 50);
  }

  _confirmJdPaste() {
    const area = this.modal?.querySelector('#da-jd-paste-area');
    const input = this.modal?.querySelector('#da-jd-input');
    if (!area || !input) return;
    const text = input.value.trim();
    if (!text) return;
    const nextContext = { ...(this.pageContext || {}) };
    nextContext.url = nextContext.url || window.location.href;
    nextContext.jobDescription = text;
    if (this.pageExtractor?.classifyContextSections) {
      nextContext.contextSections = this.pageExtractor.classifyContextSections(text);
      nextContext.sectionedJobContext = this.pageExtractor.buildSectionedContextText(
        nextContext.contextSections,
        text
      );
      nextContext.contextConfidence = this.pageExtractor.scoreContextSections(
        nextContext.contextSections,
        'heuristic'
      );
    }
    nextContext.contextQuality = 'heuristic';
    this.setPageContext(nextContext);
    area.hidden = true;
    this.updateContextBadge();
  }

  _cancelJdPaste() {
    const area = this.modal?.querySelector('#da-jd-paste-area');
    if (area) area.hidden = true;
  }

  showNotification(message, type = 'success') {
    const notif = document.createElement('div');
    notif.className = `da-notification ${type === 'error' ? 'da-notification-error' : ''}`;
    notif.textContent = message;
    document.body.appendChild(notif);
    
    setTimeout(() => {
      notif.classList.add('da-fade-out');
      setTimeout(() => notif.remove(), 500);
    }, 3000);
  }

  // ── Prompt building is now handled server-side by the recipe module. ──
  // The extension sends structured inputs (question, cvText, job context)
  // to the proxy, which builds the prompts using the loaded recipe.
}

// Singleton guard - prevent duplicate instances on SPA navigation or extension reload
function initDraftApply() {
  if (window.__draftapplyInstance) {
    window.__draftapplyInstance.destroy();
  }
  window.__draftapplyInstance = new DraftApplyExtension();
}

// Clean up on page unload
window.addEventListener('pagehide', () => {
  window.__draftapplyInstance?.destroy();
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDraftApply);
} else {
  initDraftApply();
}
