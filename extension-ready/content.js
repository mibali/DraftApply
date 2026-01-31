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

  getCvContext(rawText, maxChars) {
    const raw = rawText || '';
    const max = Math.max(500, Number(maxChars) || 0);
    if (raw.length <= max) {
      return { text: raw, strategy: 'full', rawLen: raw.length, headLen: raw.length, tailLen: 0 };
    }

    // Include both start and end so older roles don't get truncated away.
    const headLen = Math.floor(max * 0.6);
    const tailLen = max - headLen;
    const head = raw.slice(0, headLen);
    const tail = raw.slice(-tailLen);
    const text = `${head}\n\n...[snip - middle omitted to fit prompt]...\n\n${tail}`;
    return { text, strategy: 'head_tail', rawLen: raw.length, headLen, tailLen };
  }

  init() {
    this.extractPageContext();
    this.createModal();
    this.listenForMessages();
    this.observeFormFields();
    this.showPageContextIndicator();
    
    // Re-extract context after delay (for SPAs that load content async)
    setTimeout(() => {
      this.extractPageContext();
      this.updateContextBadge();
    }, 2000);
    
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
          <div class="da-answer-output" id="da-answer-output"></div>
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
      const fields = document.querySelectorAll(
        'textarea,' +
        'input:not([type]),' +
        'input[type="text"],input[type="email"],input[type="tel"],input[type="search"],input[type="url"],' +
        'input[type="number"]'
      );
      
      fields.forEach(field => {
        // Skip if already has button or is too small/hidden
        if (buttonMap.has(field)) return;
        if (field.tagName === 'INPUT' && field.offsetWidth < 200) return;
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
        
        // Position on focus/hover
        const showBtn = () => {
          positionButton(field, btn);
          btn.style.opacity = '1';
          btn.style.pointerEvents = 'auto';
        };
        const hideBtn = () => {
          btn.style.opacity = '0';
          btn.style.pointerEvents = 'none';
        };
        
        field.addEventListener('focus', showBtn);
        field.addEventListener('mouseenter', showBtn);
        field.addEventListener('blur', (e) => {
          // Don't hide if clicking the button
          if (e.relatedTarget === btn) return;
          setTimeout(hideBtn, 200);
        });
        field.addEventListener('mouseleave', (e) => {
          if (document.activeElement === field) return;
          setTimeout(hideBtn, 200);
        });
        
        // Initially hidden
        hideBtn();
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

    this.observer = new MutationObserver(debouncedAddButtons);
    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
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
    modal.querySelector('#da-answer-output').textContent = '';
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
    output.textContent = '';
    
    try {
      // Get CV from storage
      const response = await chrome.runtime.sendMessage({ type: 'GET_CV' });
      
      if (!response.cvText) {
        output.textContent = 'Please load your CV first. Click the DraftApply extension icon.';
        loading.hidden = true;
        return;
      }
      
      // Parse CV
      const cvData = this.parseCV(response.cvText);
      
      // Build prompt with page context
      const prompt = this.buildPrompt(cvData, question, length);
      
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
          payload: prompt
        }),
        timeoutPromise
      ]);

      // If user cancelled/restarted while awaiting, ignore stale response.
      if (this.currentRequestId !== requestId) {
        loading.hidden = true;
        return;
      }
      
      if (!result) {
        output.textContent = 'Error: No response from backend. Is it running?';
      } else if (result.error) {
        output.textContent = `Error: ${result.error}`;
      } else if (result.answer) {
        output.textContent = result.answer;
        this.lastAnswer = result.answer;
      } else {
        // Handle unexpected response format
        output.textContent = result.text || result.content || JSON.stringify(result);
        this.lastAnswer = output.textContent;
      }
      
    } catch (error) {
      if (error.message.includes('Extension context invalidated')) {
        output.textContent = 'Extension was updated. Please refresh this page.';
      } else if (error.message === 'Cancelled') {
        output.textContent = 'Cancelled.';
      } else {
        output.textContent = `Error: ${error.message}`;
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
    if (output && !output.textContent.trim()) output.textContent = 'Cancelled.';

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
    if (!this.lastAnswer) {
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
          document.execCommand('insertText', false, this.lastAnswer);
        } else {
          target.textContent = this.lastAnswer;
        }

        this.dispatchInputEvents(target, this.lastAnswer);
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

        this.setNativeValue(target, this.lastAnswer);
        this.dispatchInputEvents(target, this.lastAnswer);
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

  // Simplified CV parser
  parseCV(text) {
    return {
      summary: text.slice(0, 500),
      experience: this.extractSection(text, 'experience'),
      skills: this.extractSection(text, 'skills'),
      rawText: text
    };
  }

  extractSection(text, section) {
    // Keep regexes literal to avoid ReDoS from dynamic RegExp construction
    const patterns = {
      experience: /experience[:\s]*\n([\s\S]*?)(?=\n\s*(?:education|skills|experience|certifications|$))/i,
      skills: /skills[:\s]*\n([\s\S]*?)(?=\n\s*(?:education|skills|experience|certifications|$))/i,
    };

    const pattern = patterns[section];
    if (!pattern) return '';

    const match = text.match(pattern);
    return match ? match[1].trim() : '';
  }

  // Build prompt for simple data extraction
  buildExtractionPrompt(cvData, question) {
    const systemPrompt = `You are a data extraction assistant. Extract ONLY the requested information from the CV.

RULES:
- Return ONLY the exact value requested, nothing else
- No sentences, no explanations, no formatting
- If the information is not found, respond with: "Not found in CV"
- For URLs, return the full URL
- For names, return just the name
- For phone numbers, include country code if present`;

    const cvContext = this.getCvContext(cvData.rawText, 2500);

    const userPrompt = `CV:
${cvContext.text}

Extract: ${question}

Return ONLY the value, nothing else.`;

    return { systemPrompt, userPrompt };
  }

  // Check if question is asking for simple data extraction
  isDataExtractionQuestion(question) {
    const dataPatterns = [
      /^(full\s*)?name$/i,
      /^(first|last|middle|legal|preferred)\s*name$/i,
      /^name\s*(first|last|middle|legal)?$/i,
      /^linkedin/i,
      /^(email|e-mail)/i,
      /^phone/i,
      /^(mobile|cell)/i,
      /^address/i,
      /^(city|state|zip|postal|country)/i,
      /^location$/i,
      /^website/i,
      /^(personal\s*)?portfolio/i,
      /^github/i,
      /^twitter/i,
      /^(current\s*)?(job\s*)?title$/i,
      /^(current\s*)?company$/i,
      /^(current\s*)?employer$/i,
      /^(your\s*)?(date\s*of\s*)?birth/i,
      /^nationality$/i,
      /^visa\s*status$/i,
      /^work\s*authori[sz]ation$/i,
      /^salary/i,
      /^notice\s*period$/i,
      /^availability$/i,
      /^start\s*date$/i,
    ];
    const q = question.trim();
    return dataPatterns.some(p => p.test(q));
  }

  isWhyCompanyQuestion(question) {
    const q = (question || '').trim().toLowerCase();
    return (
      q.includes('why do you want') ||
      q.includes('why would you like') ||
      q.includes('why are you applying') ||
      q.includes('what draws you') ||
      q.includes('why this company') ||
      q.includes("company's mission") ||
      q.includes('why our company')
    );
  }

  isCoverLetterQuestion(question) {
    const q = (question || '').trim().toLowerCase();
    return (
      q.includes('cover letter') ||
      q.includes('coverletter') ||
      q.includes('motivation letter') ||
      q.includes('letter of interest') ||
      q.includes('application letter') ||
      q === 'cover letter' ||
      q === 'coverletter'
    );
  }

  // Build prompt with automatic page context
  buildPrompt(cvData, question, length) {
    // For simple data extraction, use a direct extraction prompt
    if (this.isDataExtractionQuestion(question)) {
      return this.buildExtractionPrompt(cvData, question);
    }
    const isCoverLetter = this.isCoverLetterQuestion(question);
    const lengthSpec = isCoverLetter
      ? ({
          short: '150-220 words',
          medium: '250-350 words',
          long: '350-500 words'
        }[length] || '250-350 words')
      : ({
          short: '50-80 words',
          medium: '100-150 words',
          long: '200-300 words'
        }[length] || '100-150 words');

    const systemPrompt = `You are helping a job candidate write authentic, tailored answers to application questions.

## MANDATORY: USE THE FULL CV
Before writing, scan the ENTIRE CV and identify ALL relevant experiences:
- Look at EVERY job listed, not just the most recent
- Check education, certifications, projects, volunteer work
- Find the BEST examples regardless of when they occurred
- Older experiences are often MORE relevant than recent ones

## MANDATORY: USE THE JOB DESCRIPTION (IF PROVIDED)
If a job description / requirements are provided, you MUST:
- Identify 3-5 key requirements/responsibilities that matter most
- Map them to concrete CV evidence (specific roles/projects/skills) from anywhere in the CV
- Use the role language naturally (tools, responsibilities) but do NOT copy/paste
- If a requirement is not covered, either avoid claiming it or address it honestly ("I haven't done X directly, but I've done Y which is adjacent")

${isCoverLetter ? `## COVER LETTER MODE
If the user asks for a cover letter (or the field is "Cover letter"), you MUST write a real cover letter:
- Greeting ("Dear Hiring Manager," or "Dear [Company] team,")
- 1st paragraph: specific hook showing you understand the role and why you fit
- 2nd–3rd paragraphs: map at least 3 job requirements to concrete CV evidence (use different roles/time periods when possible)
- Final paragraph: close confidently and add "Sincerely,\\n[Your Name]"
- Do NOT write a generic summary of skills; this must be tailored to the job context
` : ''}

## ANSWER STRUCTURE
Your answer MUST include experiences from at least 2 different time periods or roles when the CV has them. For example:
- "In my role at [OLDER COMPANY], I... Later at [RECENT COMPANY], I built on this by..."
- "My experience spans from [EARLY ROLE] where I learned X, through [MID ROLE] where I applied it to Y"

## RULES
1. Write in first person as the candidate
2. NEVER focus only on the current/most recent role - this is the #1 mistake to avoid
3. NEVER invent employers, degrees, dates, or metrics not in the CV
4. Sound human and genuine - no corporate buzzwords
${this.pageContext?.jobDescription ? '5. Tailor to the job description provided' : ''}

## BANNED PHRASES
- "I'm excited to..." / "I'm passionate about..."
- "leverage", "synergy", "proven track record"
- Starting with "As a [current title]..." (shows recency bias)`;

    const cvContext = this.getCvContext(cvData.rawText, 8000);

    let userPrompt = `## CANDIDATE CV (use ALL relevant roles; older roles may be most relevant)
${cvContext.text}

`;

    // Add page context if available (job posting text or extracted page text)
    if (this.pageContext?.jobDescription || this.pageContext?.fullPageText || this.pageContext?.requirements?.length) {
      const ctx = this.pageExtractor.buildContext();
      userPrompt += ctx;
      userPrompt += '\n\n';
    }

    userPrompt += `## QUESTION
${question}

## INSTRUCTIONS
- Length: approximately ${lengthSpec}
- IMPORTANT: Reference experiences from AT LEAST 2 different roles/time periods in your answer
- Do NOT focus only on the most recent role
- ${this.pageContext?.jobDescription ? 'Tailor to the job requirements above' : 'Show breadth of experience across your career'}

${this.isWhyCompanyQuestion(question) ? `
SPECIAL (WHY COMPANY):
- Use 2-3 specific points from the job context (mission, responsibilities, requirements) to show you understand the role
- Then connect each point to a concrete example from your CV (preferably from different roles/time periods)
- End with 1 sentence explaining why this is a logical next step for you (no generic hype)
` : ''}

${isCoverLetter ? `
SPECIAL (COVER LETTER):
- Output must be a complete cover letter with greeting + 3–4 paragraphs + closing.
- Explicitly mention the role (${this.pageContext?.jobTitle ? this.pageContext.jobTitle : 'the role'})${this.pageContext?.company ? ` at ${this.pageContext.company}` : ''}.
- Include at least 3 specific job requirements from the job context and map each to CV evidence.
` : ''}

Write the answer now. First person, no preamble.`;

    return { systemPrompt, userPrompt };
  }
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
