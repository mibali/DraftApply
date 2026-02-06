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
    this.activeRequestId = null;
    this.lastAnswer = null;
    this.lastQuestion = null;
    this.observer = null;
    
    this.init();
  }

  createDraftApplyIconImg(sizePx = 20) {
    const img = document.createElement('img');
    img.className = 'da-icon';
    img.alt = 'DraftApply';
    img.width = sizePx;
    img.height = sizePx;
    // Prefer high-res asset and size down for crispness
    img.src = chrome.runtime.getURL('icons/icon128.png');
    img.decoding = 'async';
    img.loading = 'eager';
    img.onerror = () => {
      // Fallback if icons are blocked/unavailable
      const fallback = document.createElement('span');
      fallback.className = 'da-icon-fallback';
      fallback.textContent = 'DA';
      img.replaceWith(fallback);
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
      console.log('[DraftApply] Page context extracted:', this.pageExtractor.getSummary());
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
          <span>DraftApply</span>
          <span class="da-context-badge" id="da-context-badge">No context</span>
          <button class="da-modal-close">&times;</button>
        </div>
        <div class="da-modal-body">
          <div class="da-context-info" id="da-context-info"></div>
          <div class="da-question-label">Question:</div>
          <div class="da-question-preview" id="da-question-preview"></div>
          <div class="da-answer-label">Generated Answer:</div>
          <textarea class="da-answer-output" id="da-answer-output" placeholder="Your answer will appear here. You can edit it before inserting."></textarea>
          <div class="da-modal-actions">
            <select class="da-length-select" id="da-length-select">
              <option value="short">Short</option>
              <option value="medium" selected>Medium</option>
              <option value="long">Long</option>
            </select>
            <button class="da-btn da-btn-regenerate" id="da-btn-regenerate">Regenerate</button>
            <button class="da-btn da-btn-insert" id="da-btn-insert">Insert Answer</button>
          </div>
        </div>
        <div class="da-loading" id="da-loading" hidden>
          <div class="da-spinner"></div>
          <span>Generating tailored answer...</span>
          <button class="da-btn da-btn-stop" id="da-btn-stop" type="button">Stop</button>
        </div>
      </div>
    `;
    
    modal.style.display = 'none';
    document.body.appendChild(modal);
    this.modal = modal;

    // Update context badge
    this.updateContextBadge();

    // Bind events
    modal.querySelector('.da-modal-close').onclick = () => this.hideModal();
    modal.querySelector('#da-btn-insert').onclick = () => this.insertAnswer();
    modal.querySelector('#da-btn-regenerate').onclick = () => this.regenerate();
    modal.querySelector('#da-btn-stop').onclick = () => this.cancelGeneration();
    
    modal.onclick = (e) => {
      if (e.target === modal) this.hideModal();
    };

    // ESC to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display !== 'none') {
        this.hideModal();
      }
    });
  }

  updateContextBadge() {
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
      if (e.target.matches(fieldSelector)) {
        this.lastFocusedField = e.target;
      }
    });

    // Also track on right-click
    document.addEventListener('contextmenu', (e) => {
      const field = e.target.closest(fieldSelector);
      if (field) {
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
      
      if (message.type === 'SHOW_NOTIFICATION') {
        this.showNotification(message.message);
      }

      if (message.type === 'GET_PAGE_CONTEXT') {
        sendResponse(this.pageContext);
      }
    });
  }

  observeFormFields() {
    // Use overlay buttons instead of wrapping fields (avoids breaking React)
    const buttonMap = new WeakMap(); // field -> button element

    const BTN_SIZE = 40;
    const BTN_INSET = 8;
    
    const positionButton = (field, btn) => {
      const rect = field.getBoundingClientRect();
      btn.style.top = `${window.scrollY + rect.top + BTN_INSET}px`;
      btn.style.left = `${window.scrollX + rect.right - BTN_SIZE - BTN_INSET}px`;
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
        
        const btn = document.createElement('button');
        btn.className = 'da-field-btn-overlay';
        btn.replaceChildren(this.createDraftApplyIconImg(22));
        btn.title = 'Generate answer with DraftApply';
        btn.type = 'button';
        
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.currentField = field;
          
          const label = this.findFieldLabel(field);
          const question = label || field.placeholder || 'Answer this question';
          
          this.handleGenerateRequest(question);
        };
        
        document.body.appendChild(btn);
        buttonMap.set(field, btn);
        btn._draftapplyField = field; // Store reference for orphan cleanup
        
        // Position immediately and keep positioned
        positionButton(field, btn);
        
        // Highlight on focus/hover, dim on blur/leave (always visible)
        const activateBtn = () => {
          positionButton(field, btn);
          btn.classList.add('da-btn-active');
        };
        const deactivateBtn = () => {
          btn.classList.remove('da-btn-active');
        };
        
        field.addEventListener('focus', activateBtn);
        field.addEventListener('mouseenter', activateBtn);
        field.addEventListener('blur', (e) => {
          // Don't deactivate if clicking the button itself
          if (e.relatedTarget === btn) return;
          setTimeout(deactivateBtn, 200);
        });
        field.addEventListener('mouseleave', (e) => {
          if (document.activeElement === field) return;
          setTimeout(deactivateBtn, 200);
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
    
    // Reposition on scroll/resize
    window.addEventListener('scroll', debouncedAddButtons, { passive: true });
    window.addEventListener('resize', debouncedAddButtons, { passive: true });
  }

  findFieldLabel(field) {
    if (field.id) {
      const label = document.querySelector(`label[for="${field.id}"]`);
      if (label) return label.textContent.trim();
    }
    
    if (field.getAttribute('aria-label')) {
      return field.getAttribute('aria-label');
    }

    if (field.getAttribute('aria-labelledby')) {
      const labelEl = document.getElementById(field.getAttribute('aria-labelledby'));
      if (labelEl) return labelEl.textContent.trim();
    }
    
    const prev = field.previousElementSibling;
    if (prev?.tagName === 'LABEL') {
      return prev.textContent.trim();
    }
    
    const parent = field.closest('.form-group, .field, .question, .form-field, [class*="question"]');
    if (parent) {
      const label = parent.querySelector('label, .label, .question-text, [class*="label"]');
      if (label && label.textContent.trim().length < 500) {
        return label.textContent.trim();
      }
    }
    
    return null;
  }

  async handleGenerateRequest(question) {
    this.showModal(question);
    await this.generateAnswer(question);
  }

  showModal(question) {
    const modal = this.modal;
    modal.querySelector('#da-question-preview').textContent = question;
    modal.querySelector('#da-answer-output').value = '';
    modal.querySelector('#da-loading').hidden = true;
    modal.style.display = 'flex';
  }

  hideModal() {
    // If a generation is in-flight, cancel it to avoid "infinite spinner" behavior.
    this.cancelGeneration({ silent: true });
    this.modal.style.display = 'none';
  }

  async generateAnswer(question) {
    const loading = this.modal.querySelector('#da-loading');
    const output = this.modal.querySelector('#da-answer-output');
    const length = this.modal.querySelector('#da-length-select').value;
    const stopBtn = this.modal.querySelector('#da-btn-stop');
    
    this.lastQuestion = question;
    loading.hidden = false;
    stopBtn.disabled = false;
    output.value = '';
    
    try {
      // Get CV from storage
      const response = await chrome.runtime.sendMessage({ type: 'GET_CV' });
      
      if (!response.cvText) {
        output.value = 'Please load your CV first. Click the DraftApply extension icon.';
        loading.hidden = true;
        return;
      }
      
      // Build structured payload — the proxy's recipe module builds prompts server-side
      const ctx = this.pageContext || {};
      const structuredPayload = {
        question,
        length,
        cvText:         response.cvText,
        jobTitle:       ctx.jobTitle || undefined,
        company:        ctx.company || undefined,
        jobDescription: ctx.jobDescription || ctx.fullPageText || undefined,
        requirements:   (ctx.requirements && ctx.requirements.length > 0) ? ctx.requirements : undefined,
        pageUrl:        ctx.url || window.location.href,
        platform:       ctx.platform || undefined,
      };
      
      // Call API via background with timeout
      const requestId = (globalThis.crypto?.randomUUID?.() || `req_${Date.now()}_${Math.random().toString(16).slice(2)}`);
      this.currentRequestId = requestId;
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timed out after 2 minutes')), 120000)
      );
      
      const result = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'CALL_API',
          requestId,
          payload: structuredPayload
        }),
        timeoutPromise
      ]);

      // If user cancelled/restarted while awaiting, ignore stale response.
      if (this.currentRequestId !== requestId) {
        loading.hidden = true;
        return;
      }
      
      if (!result) {
        output.value = 'Error: No response from backend. Is it running?';
      } else if (result.error) {
        output.value = `Error: ${result.error}`;
      } else if (result.answer) {
        output.value = result.answer;
        this.lastAnswer = result.answer;
      } else {
        // Handle unexpected response format
        output.value = result.text || result.content || JSON.stringify(result);
        this.lastAnswer = output.value;
      }
      
    } catch (error) {
      if (error.message.includes('Extension context invalidated')) {
        output.value = 'Extension was updated. Please refresh this page.';
      } else if (error.message === 'Cancelled') {
        output.value = 'Cancelled.';
      } else {
        output.value = `Error: ${error.message}`;
      }
    } finally {
      if (this.currentRequestId) {
        // Clear the request id after completion
        this.currentRequestId = null;
      }
      loading.hidden = true;
    }
  }

  async regenerate() {
    const question = this.modal.querySelector('#da-question-preview').textContent;
    await this.generateAnswer(question);
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

    // Best-effort abort (may fail if background was reloaded)
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
    try {
      await navigator.clipboard.writeText(this.lastAnswer);
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
