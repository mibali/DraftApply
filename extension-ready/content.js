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
    this._buttonMap = new WeakMap();    // field -> overlay button
    this._prefetchTimer = null;
    this._prefetchField = null;

    this.init();
  }

  createDraftApplyIconImg(sizePx = 20) {
    const img = document.createElement('img');
    img.className = 'da-icon';
    img.alt = 'DraftApply';
    img.width = sizePx;
    img.height = sizePx;
    img.style.pointerEvents = 'none'; // Clicks pass through to parent button
    img.src = chrome.runtime.getURL('icons/icon128.png');
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
      rect.setAttribute('fill', '#7c3aed');
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
    
    // Re-extract context and re-scan fields after delay (for SPAs that load content async)
    setTimeout(() => {
      this.extractPageContext();
      this.updateContextBadge();
    }, 2000);
    // Some pages render fields late; force a second scan
    setTimeout(() => {
      if (this._rescanFields) this._rescanFields();
    }, 1500);
    
    // Re-extract on SPA navigation
    window.addEventListener('popstate', () => {
      this.extractPageContext();
      this.updateContextBadge();
    });
  }

  destroy() {
    this.observer?.disconnect();
    this.modal?.remove();
    // Clean up overlay buttons
    document.querySelectorAll('.da-field-btn-overlay').forEach(btn => btn.remove());
    document.querySelectorAll('#draftapply-indicator').forEach(el => el.remove());
  }

  /**
   * Extract job context from the current page
   */
  extractPageContext() {
    try {
      this.pageContext = this.pageExtractor.extract();
    } catch (e) {
      console.warn('[DraftApply] Failed to extract page context:', e);
      this.pageContext = null;
    }
  }

  /**
   * Show a small indicator that DraftApply has detected job context
   */
  showPageContextIndicator() {
    if (!this.pageContext?.jobDescription) return;

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
          <img class="da-modal-logo" src="${chrome.runtime.getURL('icons/icon128.png')}" alt="" onerror="this.style.display='none'">
          <span class="da-header-name">DraftApply</span>
          <span class="da-context-badge" id="da-context-badge">No context</span>
          <button class="da-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="da-modal-body">
          <div class="da-context-info" id="da-context-info"></div>
          <div class="da-question-label">Question <span class="da-question-hint">(editable)</span></div>
          <textarea class="da-question-preview" id="da-question-preview" rows="2" spellcheck="false"></textarea>
          <div class="da-answer-label">Generated Answer</div>
          <textarea class="da-answer-output" id="da-answer-output" placeholder="Your answer will appear here. You can edit it before inserting."></textarea>
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
            <input type="hidden" id="da-length-select" value="medium">
            <input type="hidden" id="da-tone-select" value="natural">
            <div class="da-modal-actions-row">
              <button class="da-btn da-btn-regenerate" id="da-btn-regenerate">↺ Regenerate</button>
              <button class="da-btn da-btn-copy" id="da-btn-copy">⎘ Copy</button>
              <button class="da-btn da-btn-insert" id="da-btn-insert">Insert Answer</button>
            </div>
          </div>
        </div>
        <div class="da-loading" id="da-loading" hidden>
          <div class="da-spinner"></div>
          <span id="da-loading-text">Generating answer…</span>
          <button class="da-btn da-btn-stop" id="da-btn-stop" type="button">Stop</button>
        </div>
      </div>
    `;
    
    modal.style.display = 'none';
    this.modal = modal;

    // Bind events first (they persist even if modal is detached from DOM)
    modal.querySelector('.da-modal-close').onclick = () => this.hideModal();
    modal.querySelector('#da-btn-insert').onclick = () => this.insertAnswer();
    modal.querySelector('#da-btn-regenerate').onclick = () => this.regenerate();
    modal.querySelector('#da-btn-copy').onclick = () => this.copyAnswer();
    modal.querySelector('#da-btn-stop').onclick = () => this.cancelGeneration();
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
    
    modal.onclick = (e) => {
      if (e.target === modal) this.hideModal();
    };

    // ESC to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display !== 'none') {
        this.hideModal();
      }
    });

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
    
    if (this.pageContext?.jobDescription) {
      badge.textContent = '✓ Job context detected';
      badge.classList.add('da-badge-success');

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
      meta.textContent = `${this.pageContext.requirements.length} requirements detected • ${Math.round(this.pageContext.jobDescription.length / 100) * 100}+ chars`;
      info.appendChild(meta);
    } else {
      badge.textContent = 'No job context';
      badge.classList.remove('da-badge-success');
      info.textContent = 'Could not detect job description on this page.';
    }
  }

  listenForMessages() {
    const fieldSelector =
      'textarea,' +
      'input:not([type]),' +
      'input[type="text"],input[type="email"],input[type="tel"],input[type="search"],input[type="url"],' +
      'input[type="number"],' +
      '[contenteditable="true"],[role="textbox"]';

    // Track last focused field for context menu insert
    document.addEventListener('focusin', (e) => {
      if (e.target.matches(fieldSelector) && !e.target.closest('#draftapply-modal')) {
        this.lastFocusedField = e.target;
      }
    });

    // Also track on right-click
    document.addEventListener('contextmenu', (e) => {
      const field = e.target.closest(fieldSelector);
      if (field && !field.closest('#draftapply-modal')) {
        this.lastFocusedField = field;
      }
    });

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
        // Use the iframe's page context (it has the job description)
        if (message.iframePageContext) {
          this.pageContext = message.iframePageContext;
          this.updateContextBadge();
        }
        this._iframeSourceFrameId = message.sourceFrameId;
        this.showModal(message.question);
        this.generateAnswer(message.question);
      }
      
      // Iframe receives this when the parent frame's user clicks "Insert Answer"
      if (message.type === 'INSERT_FROM_PARENT') {
        if (window === window.top) return; // Only handle in iframes
        const target = this.currentField || this.lastFocusedField;
        if (target?.isConnected) {
          try {
            target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
            target.focus?.();
            this.setNativeValue(target, message.answer);
            this.dispatchInputEvents(target, message.answer);
            this.showNotification('Answer inserted!');
          } catch (e) {
            console.warn('[DraftApply] Insert from parent failed:', e);
          }
        }
      }
      
      if (message.type === 'SHOW_NOTIFICATION') {
        this.showNotification(message.message);
      }

      if (message.type === 'GET_PAGE_CONTEXT') {
        sendResponse(this.pageContext);
      }

      if (message.type === 'STREAM_CHUNK') {
        if (this.currentRequestId === message.requestId) {
          const output = this.modal?.querySelector?.('#da-answer-output');
          if (output) {
            // Hide loading overlay on first chunk so text is visible as it streams
            const loading = this.modal?.querySelector?.('#da-loading');
            if (loading && !loading.hidden) loading.hidden = true;
            output.value += message.chunk;
            output.scrollTop = output.scrollHeight;
          }
        }
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
      if (!document.body) return; // Not ready yet (iframe still loading)

      const fields = document.querySelectorAll(
        'textarea,' +
        'input:not([type]),' +
        'input[type="text"],input[type="email"],input[type="tel"],input[type="search"],input[type="url"],' +
        'input[type="number"],' +
        '[contenteditable="true"],[role="textbox"]'
      );
      
      fields.forEach(field => {
        // Skip if already has button or is too small/hidden
        if (buttonMap.has(field)) return;
        if (field.tagName === 'INPUT' && field.offsetWidth < 100) return;
        if (field.type === 'hidden' || !field.offsetParent) return;
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

          const label = this.findFieldLabel(field);
          const fieldHint = field.name || field.id || field.placeholder || null;
          const question = label || fieldHint || 'Please describe your relevant experience and background';

          // Use prefetch cache if answer is ready for the same question
          const cached = this._prefetchCache.get(field);
          if (cached?.status === 'ready' && cached.question === question) {
            this.showModal(question);
            const output = this.modal.querySelector('#da-answer-output');
            output.value = cached.answer;
            this.lastAnswer = cached.answer;
            this.lastQuestion = question;
            // Remove ready indicator from button
            btn.classList.remove('da-btn-ready');
            this._prefetchCache.delete(field);
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
          // Don't hide while a click is in progress
          if (clickPending) return;
          btn.classList.remove('da-btn-visible');
        };
        
        field.addEventListener('focus', () => {
          showBtn();
          // Prefetch: debounce 600ms then silently generate answer in background
          clearTimeout(this._prefetchTimer);
          this._prefetchField = field;
          this._prefetchTimer = setTimeout(() => {
            if (this._prefetchField === field && !this._prefetchCache.has(field)) {
              this._startPrefetch(field);
            }
          }, 600);
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
      debounceTimer = setTimeout(addButtons, 150);
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
    if (document.body) {
      this.observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
    
    // Reposition on scroll/resize (lightweight — only moves visible buttons)
    window.addEventListener('scroll', repositionVisible, { passive: true });
    window.addEventListener('resize', repositionVisible, { passive: true });
  }

  findFieldLabel(field) {
    // 1. Explicit <label for="...">
    if (field.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) return label.textContent.trim();
      } catch (e) {
        const label = document.querySelector(`label[for="${field.id}"]`);
        if (label) return label.textContent.trim();
      }
    }

    // 2. aria-label attribute
    const ariaLabel = field.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    // 3. aria-labelledby (may be space-separated list of ids)
    const labelledBy = field.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    // 4. title attribute
    if (field.title) return field.title;

    // 5. Walk up DOM ancestry — look for label/heading text before the input
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
    const isGoodText = (t) => t && t.length > 2 && t.length < 400;

    let ancestor = field.parentElement;
    for (let depth = 0; depth < 10 && ancestor; depth++, ancestor = ancestor.parentElement) {
      // 5a. Explicit <label> or <legend> anywhere in the ancestor (not wrapping the field)
      for (const tag of ['label', 'legend']) {
        const el = ancestor.querySelector(tag);
        if (el && !el.contains(field)) {
          const t = el.textContent.trim();
          if (isGoodText(t)) return t;
        }
      }

      // 5b. Look at DOM siblings that come BEFORE the field's branch in this ancestor
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
          const t = heading.textContent.trim();
          if (isGoodText(t) && !SKIP_TAGS.has(heading.tagName)) return t;
        }
      }

      // 5c. Any heading/strong element within this ancestor (not the field itself)
      const heading = ancestor.querySelector('h1,h2,h3,h4,h5,h6,legend,strong,b,p,[class*="label" i],[class*="question" i],[class*="heading" i],[class*="title" i]');
      if (heading && !heading.contains(field)) {
        const t = heading.textContent.trim();
        if (isGoodText(t)) return t;
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
  async _startPrefetch(field) {
    const label = this.findFieldLabel(field);
    const fieldHint = field.name || field.id || field.placeholder || null;
    const question = label || fieldHint || 'Please describe your relevant experience and background';

    let cvResponse;
    try {
      cvResponse = await chrome.runtime.sendMessage({ type: 'GET_CV' });
    } catch (e) { return; }
    if (!cvResponse?.cvText) return;

    const btn = this._buttonMap.get(field);
    const ctx = this.pageContext || {};
    const payload = {
      question,
      length: 'medium',
      tone:   'natural',
      cvText:         cvResponse.cvText,
      jobTitle:       ctx.jobTitle || undefined,
      company:        ctx.company || undefined,
      jobDescription: ctx.jobDescription || ctx.fullPageText || undefined,
      requirements:   (ctx.requirements?.length > 0) ? ctx.requirements : undefined,
    };

    const cacheEntry = { status: 'loading', question, answer: null };
    this._prefetchCache.set(field, cacheEntry);
    if (btn?.isConnected) btn.classList.add('da-btn-prefetching');

    try {
      const result = await chrome.runtime.sendMessage({ type: 'CALL_API', requestId: null, payload });
      cacheEntry.answer = result?.answer || result?.text || result?.content || null;
      cacheEntry.status = cacheEntry.answer ? 'ready' : 'error';
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
      chrome.runtime.sendMessage({
        type: 'RELAY_GENERATE_TO_PARENT',
        question,
        pageContext: this.pageContext
      });
      return;
    }
    
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
  }

  hideModal() {
    // If a generation is in-flight, cancel it to avoid "infinite spinner" behavior.
    this.cancelGeneration({ silent: true });
    if (this.modal) this.modal.setAttribute('style', 'display:none !important;');
  }

  async generateAnswer(question) {
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

    try {
      const cvResponse = await chrome.runtime.sendMessage({ type: 'GET_CV' });

      if (!cvResponse.cvText) {
        output.value = 'Please load your CV first. Click the DraftApply extension icon.';
        return;
      }

      const ctx = this.pageContext || {};
      const structuredPayload = {
        question,
        length,
        tone,
        cvText:         cvResponse.cvText,
        jobTitle:       ctx.jobTitle || undefined,
        company:        ctx.company || undefined,
        jobDescription: ctx.jobDescription || ctx.fullPageText || undefined,
        requirements:   (ctx.requirements && ctx.requirements.length > 0) ? ctx.requirements : undefined,
        pageUrl:        ctx.url || window.location.href,
        platform:       ctx.platform || undefined,
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

      let startResult = await chrome.runtime.sendMessage({
        type: 'CALL_API_STREAM',
        requestId,
        payload: structuredPayload
      });

      // If SW was sleeping it can return undefined on the first wake — retry once.
      if (!startResult) {
        await new Promise(r => setTimeout(r, 400));
        startResult = await chrome.runtime.sendMessage({
          type: 'CALL_API_STREAM',
          requestId,
          payload: structuredPayload
        });
      }

      if (!startResult?.started) {
        throw new Error(startResult?.error || 'Failed to start generation');
      }

      // Wait for stream to finish — chunks arrive via STREAM_CHUNK messages
      await Promise.race([streamPromise, timeoutPromise]);

      if (this.currentRequestId !== requestId) return; // Stale — newer request took over

      const answer = output.value.trim();
      if (answer) {
        this.lastAnswer = answer;
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
          this.lastAnswer = fallback.answer;
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
    await this.generateAnswer(question);
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
      setter?.call(el, value);
      return;
    }
  }

  insertAnswer() {
    const current = String(this.modal?.querySelector?.('#da-answer-output')?.value || '').trim();
    const answerToInsert = current || this.lastAnswer;

    if (!answerToInsert) {
      this.showNotification('No answer to insert yet.', 'error');
      return;
    }

    // If this modal is serving an iframe, relay the answer back to the iframe for insertion
    if (this._iframeSourceFrameId != null) {
      chrome.runtime.sendMessage({
        type: 'RELAY_INSERT_TO_IFRAME',
        answer: answerToInsert,
        targetFrameId: this._iframeSourceFrameId
      });
      this.hideModal();
      this.showNotification('Answer inserted!');
      this._iframeSourceFrameId = null;
      return;
    }

    const target = this.getInsertionTarget();

    if (!target) {
      // Fallback: copy to clipboard
      this.copyToClipboard();
      return;
    }

    try {
      // Ensure focus/visibility
      target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      target.focus?.();

      // Contenteditable
      if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true' || target.getAttribute?.('role') === 'textbox') {
        // Prefer execCommand if available (works on many rich text editors)
        if (typeof document.execCommand === 'function') {
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, answerToInsert);
        } else {
          target.textContent = answerToInsert;
        }

        this.dispatchInputEvents(target, answerToInsert);
      } else {
        // Inputs/Textareas (React/Vue/Angular friendly)
        // Prefer selecting all first (helps on some controlled inputs)
        if (typeof target.setSelectionRange === 'function') {
          try {
            target.setSelectionRange(0, target.value?.length ?? 0);
          } catch (e) {
            // Some inputs (e.g. type=number) can throw; ignore.
          }
        }

        this.setNativeValue(target, answerToInsert);
        this.dispatchInputEvents(target, answerToInsert);
      }

      this.currentField = target;
      this.hideModal();
      this.showNotification('Answer inserted!');
    } catch (e) {
      console.warn('[DraftApply] Insert failed:', e);
      this.showNotification('Could not insert into that field. Try clicking the field and typing once, then Insert again.', 'error');
    }
  }

  async copyToClipboard() {
    const output = this.modal?.querySelector?.('#da-answer-output');
    const text = output?.value?.trim() || this.lastAnswer;
    try {
      await navigator.clipboard.writeText(text);
      this.hideModal();
      this.showNotification('Copied to clipboard! Paste with Ctrl+V / Cmd+V');
    } catch (e) {
      this.showNotification('Could not copy. Please select and copy the text manually.', 'error');
    }
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
