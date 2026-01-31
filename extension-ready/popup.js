/**
 * DraftApply Popup Script
 * 
 * Handles CV management and backend status display
 * No API key configuration needed - backend handles LLM
 */

document.addEventListener('DOMContentLoaded', async () => {
  const elements = {
    cvStatusDot: document.getElementById('cv-status-dot'),
    cvStatusText: document.getElementById('cv-status-text'),
    proxyStatusDot: document.getElementById('proxy-status-dot'),
    proxyStatusText: document.getElementById('proxy-status-text'),
    cvInputSection: document.getElementById('cv-input-section'),
    cvLoadedSection: document.getElementById('cv-loaded-section'),
    cvText: document.getElementById('cv-text'),
    cvPreview: document.getElementById('cv-preview'),
    saveCvBtn: document.getElementById('save-cv-btn'),
    changeCvBtn: document.getElementById('change-cv-btn'),
    message: document.getElementById('message'),
    uploadArea: document.getElementById('upload-area'),
    cvFile: document.getElementById('cv-file'),
  };

  let proxyUrl = null; // Will be set by checkProxy()

  // Load saved state
  await loadState();
  await checkProxy();

  // Event listeners
  elements.saveCvBtn.addEventListener('click', saveCV);
  elements.changeCvBtn.addEventListener('click', showCVInput);
  
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
      throw new Error('Proxy not available. Configure and wait for connection.');
    }
    
    // For PDF/DOCX, send to proxy for extraction (server-side parsing)
    const formData = new FormData();
    formData.append('cv', file);
    
    const tokenResp = await fetch(`${proxyUrl}/api/register`, { method: 'POST' });
    const tokenData = await tokenResp.json().catch(() => ({}));
    const token = tokenData.token;
    if (!token) throw new Error('Could not register with proxy');

    const response = await fetch(`${proxyUrl}/api/cv/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Extraction failed');
    }
    
    const result = await response.json();
    return result.text;
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
    
    // Avoid showing CV content in popup by default (privacy)
    elements.cvPreview.textContent = `Saved (${text.length.toLocaleString()} characters)`;
  }

  function showCVInput() {
    elements.cvInputSection.hidden = false;
    elements.cvLoadedSection.hidden = true;
    elements.cvStatusDot.classList.remove('ready');
    elements.cvStatusText.textContent = 'No CV';
    elements.cvText.value = '';
  }

  function showMessage(text, type = 'success') {
    elements.message.textContent = text;
    elements.message.className = 'message' + (type === 'error' ? ' error' : '');
    elements.message.hidden = false;
    
    setTimeout(() => {
      elements.message.hidden = true;
    }, 4000);
  }
});
