/**
 * DraftApply - Frontend Application
 * 
 * Main application logic for the web interface.
 * Designed to be modular for easy extraction into browser extension.
 * 
 * ARCHITECTURE NOTES FOR EXTENSION CONVERSION:
 * - CVManager: Handles CV storage/parsing (reusable)
 * - AnswerService: API communication (swap for extension messaging)
 * - UIController: DOM manipulation (replace for popup/content script)
 */

import { CVParser } from '../shared/cv-parser.js';
import { PromptBuilder } from '../shared/prompt-builder.js';

// Configuration
function getApiEndpoint() {
  const url = new URL(window.location.href);

  // If the frontend is served by the backend, use same-origin API.
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.port && url.port !== '3000') {
    return `${url.origin}/api`;
  }

  // Otherwise allow override via query param or localStorage (useful when backend port changes).
  // Example: http://localhost:3000/?api=http://localhost:3002/api
  const params = new URLSearchParams(url.search);
  return (
    params.get('api') ||
    localStorage.getItem('draftapply_api') ||
    'http://localhost:3001/api'
  );
}

const CONFIG = {
  apiEndpoint: getApiEndpoint(),
  storageKey: 'draftapply_cv',
  jobStorageKey: 'draftapply_job'
};

// CV Manager - handles CV storage and parsing
class CVManager {
  constructor() {
    this.parser = new CVParser();
    this.rawText = null;
    this.parsed = null;
  }

  loadFromText(text) {
    this.rawText = text;
    this.parsed = this.parser.parse(text);
    this.saveToStorage();
    return this.parsed;
  }

  async loadFromFile(file) {
    const formData = new FormData();
    formData.append('cv', file);

    const response = await fetch(`${CONFIG.apiEndpoint}/cv/upload`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to upload CV');
    }

    const data = await response.json();
    return this.loadFromText(data.text);
  }

  saveToStorage() {
    if (this.rawText) {
      localStorage.setItem(CONFIG.storageKey, this.rawText);
    }
  }

  loadFromStorage() {
    const saved = localStorage.getItem(CONFIG.storageKey);
    if (saved) {
      return this.loadFromText(saved);
    }
    return null;
  }

  clear() {
    this.rawText = null;
    this.parsed = null;
    localStorage.removeItem(CONFIG.storageKey);
  }

  isLoaded() {
    return this.parsed !== null;
  }

  getSummary() {
    if (!this.parsed) return null;

    const name = this.parsed.contactInfo?.name || 'Unknown';
    const expCount = this.parsed.experience?.length || 0;
    const skillCount = this.parsed.skills?.length || 0;
    const latestRole = this.parsed.experience?.[0]?.title || 'N/A';
    const latestCompany = this.parsed.experience?.[0]?.company || 'N/A';

    return {
      name,
      latestRole,
      latestCompany,
      expCount,
      skillCount
    };
  }
}

// Job Manager - handles job description storage and parsing
class JobManager {
  constructor() {
    this.jobTitle = '';
    this.company = '';
    this.description = '';
  }

  load(jobTitle, company, description) {
    this.jobTitle = jobTitle;
    this.company = company;
    this.description = description;
    this.saveToStorage();
    return this.getSummary();
  }

  saveToStorage() {
    localStorage.setItem(CONFIG.jobStorageKey, JSON.stringify({
      jobTitle: this.jobTitle,
      company: this.company,
      description: this.description
    }));
  }

  loadFromStorage() {
    const saved = localStorage.getItem(CONFIG.jobStorageKey);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        this.jobTitle = data.jobTitle || '';
        this.company = data.company || '';
        this.description = data.description || '';
        return this.isLoaded() ? this.getSummary() : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  clear() {
    this.jobTitle = '';
    this.company = '';
    this.description = '';
    localStorage.removeItem(CONFIG.jobStorageKey);
  }

  isLoaded() {
    return this.description.trim().length > 20;
  }

  getSummary() {
    if (!this.isLoaded()) return null;

    // Extract key requirements from job description
    const requirements = this.extractRequirements();
    
    return {
      jobTitle: this.jobTitle || 'Unknown Role',
      company: this.company || 'Unknown Company',
      descriptionLength: this.description.length,
      keyRequirements: requirements.slice(0, 5)
    };
  }

  extractRequirements() {
    const requirements = [];
    const lines = this.description.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      // Look for bullet points or numbered items that mention skills/requirements
      if (trimmed.match(/^[\-\•\*\d\.]\s*.{10,}/) && 
          (trimmed.match(/experience|skill|knowledge|ability|proficien|familiar|understand/i))) {
        requirements.push(trimmed.replace(/^[\-\•\*\d\.]\s*/, '').slice(0, 80));
      }
    }
    
    return requirements;
  }

  getData() {
    return {
      jobTitle: this.jobTitle,
      company: this.company,
      description: this.description
    };
  }
}

// Answer Service - handles API communication
class AnswerService {
  constructor(cvManager, jobManager) {
    this.cvManager = cvManager;
    this.jobManager = jobManager;
    this.promptBuilder = new PromptBuilder();
  }

  async generate(question, options = {}) {
    if (!this.cvManager.isLoaded()) {
      throw new Error('No CV loaded');
    }

    const jobData = this.jobManager.isLoaded() ? this.jobManager.getData() : null;

    const prompt = this.promptBuilder.buildPrompt(
      this.cvManager.parsed,
      question,
      options.length || 'medium',
      {
        jobTitle: jobData?.jobTitle || options.jobTitle,
        company: jobData?.company || options.company,
        jobDescription: jobData?.description
      }
    );

    const response = await fetch(`${CONFIG.apiEndpoint}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        temperature: 0.7,
        stream: options.stream || false
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Generation failed');
    }

    if (options.stream) {
      return this.handleStream(response, options.onChunk);
    }

    const data = await response.json();
    return {
      answer: data.answer,
      questionType: prompt.metadata.questionType,
      tokensUsed: data.tokensUsed
    };
  }

  async handleStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              fullAnswer += parsed.text;
              if (onChunk) onChunk(parsed.text, fullAnswer);
            }
          } catch (e) {
            // Skip malformed chunks
          }
        }
      }
    }

    return { answer: fullAnswer };
  }

  validateAnswer(answer) {
    const warnings = [];
    const cv = this.cvManager.parsed;

    // Check for company names not in CV
    const cvCompanies = cv?.experience?.map(e => e.company?.toLowerCase()) || [];
    const companyPattern = /(?:at|with|for)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/g;
    let match;

    while ((match = companyPattern.exec(answer)) !== null) {
      const mentioned = match[1].toLowerCase();
      const isKnown = cvCompanies.some(c => 
        c && (c.includes(mentioned) || mentioned.includes(c))
      );
      if (!isKnown && mentioned.length > 3) {
        warnings.push(`Company "${match[1]}" not found in CV - verify if correct`);
      }
    }

    return { valid: warnings.length === 0, warnings };
  }
}

// UI Controller - handles DOM interactions
class UIController {
  constructor(cvManager, jobManager, answerService) {
    this.cvManager = cvManager;
    this.jobManager = jobManager;
    this.answerService = answerService;
    this.selectedLength = 'medium';
    this.lastAnswer = null;
    this.lastQuestion = null;

    this.initElements();
    this.bindEvents();
    this.checkSavedCV();
    this.checkSavedJob();
  }

  initElements() {
    // CV Section
    this.cvSection = document.getElementById('cv-section');
    this.cvStatus = document.getElementById('cv-status');
    this.cvInputArea = document.getElementById('cv-input-area');
    this.cvLoaded = document.getElementById('cv-loaded');
    this.cvSummary = document.getElementById('cv-summary');
    this.uploadZone = document.getElementById('upload-zone');
    this.cvFileInput = document.getElementById('cv-file');
    this.cvTextInput = document.getElementById('cv-text');
    this.loadCvBtn = document.getElementById('load-cv-btn');
    this.changeCvBtn = document.getElementById('change-cv-btn');

    // Job Section
    this.jobStatus = document.getElementById('job-status');
    this.jobInputArea = document.getElementById('job-input-area');
    this.jobLoaded = document.getElementById('job-loaded');
    this.jobSummary = document.getElementById('job-summary');
    this.jobTitleInput = document.getElementById('job-title');
    this.companyInput = document.getElementById('company');
    this.jobDescriptionInput = document.getElementById('job-description');
    this.loadJobBtn = document.getElementById('load-job-btn');
    this.changeJobBtn = document.getElementById('change-job-btn');

    // Question Section
    this.questionInput = document.getElementById('question');
    this.lengthBtns = document.querySelectorAll('.length-btn');
    this.generateBtn = document.getElementById('generate-btn');

    // Answer Section
    this.answerSection = document.getElementById('answer-section');
    this.answerOutput = document.getElementById('answer-output');
    this.answerMeta = document.getElementById('answer-meta');
    this.copyBtn = document.getElementById('copy-btn');
    this.regenerateBtn = document.getElementById('regenerate-btn');
    this.warningsDiv = document.getElementById('warnings');

    // Global
    this.loadingOverlay = document.getElementById('loading-overlay');
    this.toast = document.getElementById('toast');
  }

  bindEvents() {
    // CV Upload
    this.uploadZone.addEventListener('click', () => this.cvFileInput.click());
    this.uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.uploadZone.classList.add('dragover');
    });
    this.uploadZone.addEventListener('dragleave', () => {
      this.uploadZone.classList.remove('dragover');
    });
    this.uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.uploadZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) this.handleFileUpload(file);
    });
    this.cvFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.handleFileUpload(file);
    });

    // CV Text
    this.loadCvBtn.addEventListener('click', () => this.handleTextLoad());
    this.changeCvBtn.addEventListener('click', () => this.showCVInput());

    // Job Description
    this.loadJobBtn.addEventListener('click', () => this.handleJobLoad());
    this.changeJobBtn.addEventListener('click', () => this.showJobInput());

    // Length Selection
    this.lengthBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.lengthBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedLength = btn.dataset.length;
      });
    });

    // Question Input
    this.questionInput.addEventListener('input', () => this.updateGenerateButton());

    // Generate
    this.generateBtn.addEventListener('click', () => this.generateAnswer());
    this.regenerateBtn.addEventListener('click', () => this.generateAnswer());

    // Copy
    this.copyBtn.addEventListener('click', () => this.copyAnswer());
  }

  checkSavedCV() {
    const cv = this.cvManager.loadFromStorage();
    if (cv) {
      this.showCVLoaded();
    }
  }

  async handleFileUpload(file) {
    try {
      this.showLoading(true);
      await this.cvManager.loadFromFile(file);
      this.showCVLoaded();
      this.showToast('CV loaded successfully');
    } catch (error) {
      this.showToast(error.message, 'error');
    } finally {
      this.showLoading(false);
    }
  }

  handleTextLoad() {
    const text = this.cvTextInput.value.trim();
    if (text.length < 50) {
      this.showToast('Please enter more CV content', 'error');
      return;
    }

    try {
      this.cvManager.loadFromText(text);
      this.showCVLoaded();
      this.showToast('CV loaded successfully');
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  showCVLoaded() {
    this.cvInputArea.hidden = true;
    this.cvLoaded.hidden = false;
    this.cvStatus.classList.add('loaded');
    this.cvStatus.querySelector('.status-text').textContent = 'CV loaded';

    const summary = this.cvManager.getSummary();
    // Avoid innerHTML: CV content is user-controlled
    this.cvSummary.replaceChildren();
    const nameEl = document.createElement('strong');
    nameEl.textContent = summary.name;
    const roleEl = document.createElement('span');
    roleEl.textContent = `${summary.latestRole} at ${summary.latestCompany}`;
    const metaEl = document.createElement('span');
    metaEl.textContent = `${summary.expCount} roles • ${summary.skillCount} skills`;
    this.cvSummary.append(nameEl, roleEl, metaEl);

    this.updateGenerateButton();
  }

  showCVInput() {
    this.cvManager.clear();
    this.cvInputArea.hidden = false;
    this.cvLoaded.hidden = true;
    this.cvStatus.classList.remove('loaded');
    this.cvStatus.querySelector('.status-text').textContent = 'No CV loaded';
    this.cvTextInput.value = '';
    this.cvFileInput.value = '';
    this.updateGenerateButton();
  }

  // Job Description Methods
  checkSavedJob() {
    const job = this.jobManager.loadFromStorage();
    if (job) {
      this.showJobLoaded(job);
    }
  }

  handleJobLoad() {
    const jobTitle = this.jobTitleInput.value.trim();
    const company = this.companyInput.value.trim();
    const description = this.jobDescriptionInput.value.trim();

    if (description.length < 50) {
      this.showToast('Please enter more job description content', 'error');
      return;
    }

    try {
      const summary = this.jobManager.load(jobTitle, company, description);
      this.showJobLoaded(summary);
      this.showToast('Job description loaded successfully');
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  showJobLoaded(summary) {
    this.jobInputArea.hidden = true;
    this.jobLoaded.hidden = false;
    this.jobStatus.classList.add('loaded');
    this.jobStatus.querySelector('.status-text').textContent = 'Job loaded';

    this.jobSummary.replaceChildren();
    const titleEl = document.createElement('strong');
    titleEl.textContent = `${summary.jobTitle} at ${summary.company}`;
    const metaEl = document.createElement('span');
    metaEl.textContent = `${Math.round(summary.descriptionLength / 100) * 100}+ characters`;
    this.jobSummary.append(titleEl, metaEl);
    
    if (summary.keyRequirements?.length > 0) {
      const reqEl = document.createElement('span');
      reqEl.textContent = `Key: ${summary.keyRequirements.slice(0, 2).join(', ')}...`;
      reqEl.style.fontSize = '0.75rem';
      this.jobSummary.append(reqEl);
    }
  }

  showJobInput() {
    this.jobManager.clear();
    this.jobInputArea.hidden = false;
    this.jobLoaded.hidden = true;
    this.jobStatus.classList.remove('loaded');
    this.jobStatus.querySelector('.status-text').textContent = 'No job loaded';
    this.jobTitleInput.value = '';
    this.companyInput.value = '';
    this.jobDescriptionInput.value = '';
  }

  updateGenerateButton() {
    const hasCV = this.cvManager.isLoaded();
    const hasQuestion = this.questionInput.value.trim().length > 10;
    this.generateBtn.disabled = !(hasCV && hasQuestion);
  }

  async generateAnswer() {
    const question = this.questionInput.value.trim();
    if (!question) return;

    this.lastQuestion = question;

    try {
      this.showLoading(true);
      this.answerSection.hidden = false;
      this.answerOutput.textContent = '';
      this.answerSection.classList.add('streaming');
      this.warningsDiv.hidden = true;

      const hasJobContext = this.jobManager.isLoaded();
      
      const result = await this.answerService.generate(question, {
        length: this.selectedLength,
        stream: true,
        onChunk: (chunk, full) => {
          this.answerOutput.textContent = full;
        }
      });

      this.lastAnswer = result.answer;
      this.answerSection.classList.remove('streaming');
      
      let metaText = `Type: ${result.questionType || 'general'} • Length: ${this.selectedLength}`;
      if (hasJobContext) {
        metaText += ' • Job-tailored ✓';
      }
      this.answerMeta.textContent = metaText;

      // Validate
      const validation = this.answerService.validateAnswer(result.answer);
      if (!validation.valid) {
        // Avoid innerHTML: warnings can be influenced by LLM output
        this.warningsDiv.replaceChildren();
        const title = document.createElement('strong');
        title.textContent = '⚠️ Review suggested:';
        const ul = document.createElement('ul');
        for (const w of validation.warnings) {
          const li = document.createElement('li');
          li.textContent = w;
          ul.appendChild(li);
        }
        this.warningsDiv.append(title, ul);
        this.warningsDiv.hidden = false;
      }

      this.answerOutput.scrollIntoView({ behavior: 'smooth', block: 'center' });

    } catch (error) {
      this.showToast(error.message, 'error');
      this.answerSection.classList.remove('streaming');
    } finally {
      this.showLoading(false);
    }
  }

  async copyAnswer() {
    if (!this.lastAnswer) return;

    try {
      await navigator.clipboard.writeText(this.lastAnswer);
      this.showToast('Copied to clipboard');
    } catch (error) {
      this.showToast('Failed to copy', 'error');
    }
  }

  showLoading(show) {
    this.loadingOverlay.hidden = !show;
  }

  showToast(message, type = 'success') {
    this.toast.textContent = message;
    this.toast.style.background = type === 'error' ? 'var(--color-error)' : 'var(--color-text)';
    this.toast.hidden = false;

    setTimeout(() => {
      this.toast.hidden = true;
    }, 3000);
  }
}

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
  const cvManager = new CVManager();
  const jobManager = new JobManager();
  const answerService = new AnswerService(cvManager, jobManager);
  const ui = new UIController(cvManager, jobManager, answerService);
  
  // Check LLM status
  try {
    const response = await fetch(`${CONFIG.apiEndpoint}/llm-status`);
    const status = await response.json();
    
    const providerEl = document.getElementById('llm-provider');
    if (providerEl) {
      providerEl.textContent = `${status.provider} (${status.model})`;
    }
    
    if (!status.available) {
      ui.showToast(status.hint || 'LLM not available', 'error');
    }
  } catch (e) {
    console.warn('Could not check LLM status');
  }
});

// Export for extension reuse
export { CVManager, JobManager, AnswerService, CONFIG };
