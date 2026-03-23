/**
 * Page Content Extractor
 * 
 * Intelligently extracts job description and application context
 * from the current webpage. Works across major job platforms.
 * 
 * Supports: Indeed, LinkedIn, Greenhouse, Lever, Workable, Otta, etc.
 */

class PageExtractor {
  constructor() {
    this.cachedContent = null;
    this.cachedUrl = null;
    this.cachedHash = null;
  }

  /**
   * Lightweight djb2 hash of the main landmark's text.
   * Used to detect SPA partial navigation where the URL stays the same
   * but the page content (e.g. application step) changes.
   */
  _hashMainContent() {
    const main = document.querySelector('main, [role="main"]') || document.body;
    const text = main ? (main.innerText || '').slice(0, 4000) : '';
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash) + text.charCodeAt(i);
      hash |= 0; // Force 32-bit integer
    }
    return hash;
  }

  /**
   * Extract job-relevant content from the current page
   * @returns {Object} Extracted job context
   */
  extract() {
    // Cache based on URL + content hash to handle SPA pages where the URL
    // stays the same but the visible content changes between application steps.
    const currentHash = this._hashMainContent();
    if (this.cachedUrl === window.location.href && this.cachedContent && this.cachedHash === currentHash) {
      return this.cachedContent;
    }

    const { jobDescription, contextQuality } = this.extractJobDescription();
    const content = {
      url: window.location.href,
      platform: this.detectPlatform(),
      jobTitle: this.extractJobTitle(),
      company: this.extractCompany(),
      jobDescription,
      contextQuality, // 'structured' | 'heuristic' | 'fullpage' | 'none'
      requirements: this.extractRequirements(),
      fullPageText: this.extractCleanPageText(),
      extractedAt: new Date().toISOString()
    };

    this.cachedContent = content;
    this.cachedUrl = window.location.href;
    this.cachedHash = currentHash;

    return content;
  }

  /**
   * Detect which job platform we're on
   */
  detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    
    const platforms = {
      'indeed.com': 'indeed',
      'linkedin.com': 'linkedin',
      'greenhouse.io': 'greenhouse',
      'lever.co': 'lever',
      'workable.com': 'workable',
      'otta.com': 'otta',
      'hiringcafe.com': 'hiringcafe',
      'jobs.ashbyhq.com': 'ashby',
      'boards.eu.greenhouse.io': 'greenhouse',
      'jobs.lever.co': 'lever',
      'apply.workable.com': 'workable',
      'glassdoor.com': 'glassdoor',
      'glassdoor.co.uk': 'glassdoor',
      'smartrecruiters.com': 'smartrecruiters'
    };

    for (const [domain, platform] of Object.entries(platforms)) {
      if (host.includes(domain)) return platform;
    }

    // Detect embedded Greenhouse pages on company domains (e.g. lattice.com/job?gh_jid=...)
    const url = window.location.href;
    if (url.includes('gh_jid=') || url.includes('greenhouse')) return 'greenhouse';
    if (url.includes('lever')) return 'lever';

    return 'generic';
  }

  /**
   * Extract from application/ld+json JobPosting schema (most reliable)
   */
  extractFromStructuredData() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
        for (const item of items) {
          if (item['@type'] === 'JobPosting') {
            return {
              title: item.title || item.name || null,
              company: item.hiringOrganization?.name || item.employer?.name || null,
              description: item.description || item.jobDescription || null
            };
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * Extract job title using platform-specific selectors
   */
  extractJobTitle() {
    // 1. Structured data is most reliable
    const structured = this.extractFromStructuredData();
    if (structured?.title) return structured.title;

    const selectors = [
      // Common patterns
      'h1.job-title', 'h1[class*="title"]', 'h1[class*="Title"]', '.job-title h1',
      '[data-testid="job-title"]', '[class*="JobTitle"]', '[class*="job-title"]',
      // SmartRecruiters
      'h1.job-title', '[class*="job-header"] h1', '.job-details h1',
      // Indeed
      '.jobsearch-JobInfoHeader-title',
      // LinkedIn
      '.job-details-jobs-unified-top-card__job-title',
      // Greenhouse
      '.app-title', '.job-title',
      // Lever
      '.posting-headline h2',
      // Glassdoor
      '[data-test="job-title"]', '.JobDetails_jobTitle__Rq2mK', '.css-1vg6q84',
      '[class*="JobDetails"] h1', '.job-title-text',
      // Generic fallbacks
      'h1', '.title h1', 'header h1'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el?.textContent?.trim()) {
        return el.textContent.trim();
      }
    }

    // Try meta tags
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle?.content) return ogTitle.content;

    // Only use document.title as last resort if it looks like a real job title
    // (not a SPA loading placeholder or generic page name).
    const titleCandidate = document.title.split('|')[0].split('-')[0].trim();
    if (
      titleCandidate.length >= 5 &&
      titleCandidate.length < 80 &&
      !/^(loading|untitled|home|default|page\s*\d*|new\s+tab)$/i.test(titleCandidate)
    ) {
      return titleCandidate;
    }

    return '';
  }

  /**
   * Extract company name
   */
  extractCompany() {
    // 1. Structured data first
    const structured = this.extractFromStructuredData();
    if (structured?.company) return structured.company;

    const selectors = [
      // Common patterns
      '[class*="company"]', '[class*="Company"]',
      '[data-testid="company-name"]',
      // Indeed
      '.jobsearch-InlineCompanyRating-companyHeader',
      // LinkedIn
      '.job-details-jobs-unified-top-card__company-name',
      // Greenhouse / SmartRecruiters
      '.company-name', '.employer-name', '[class*="company-details"] a',
      // Lever
      '.posting-categories .location',
      // Glassdoor
      '[data-test="employer-name"]', '.EmployerProfile_companyName__lHhH4',
      '[class*="EmployerProfile"] a', '.css-16nw49e',
      // Generic
      '.employer', '.organization'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el?.textContent?.trim() && el.textContent.trim().length < 100) {
        return el.textContent.trim();
      }
    }

    return '';
  }

  /**
   * Extract job description content.
   * Returns { jobDescription, contextQuality } where contextQuality is one of:
   *   'structured' — from application/ld+json JobPosting schema (most reliable)
   *   'heuristic'  — from platform-specific or keyword-matched DOM selectors
   *   'fullpage'   — fell back to full page text (noisy, lower confidence)
   *   'none'       — nothing useful found
   */
  extractJobDescription() {
    // 1. Structured data — most reliable on company career pages
    const structured = this.extractFromStructuredData();
    if (structured?.description?.length > 200) {
      return { jobDescription: this.cleanText(structured.description), contextQuality: 'structured' };
    }

    const selectors = [
      // Common patterns
      '.job-description', '[class*="job-description"]', '[class*="job-desc"]',
      '[class*="jobDescription"]', '[class*="JobDescription"]',
      '#job-description', '[id*="job-desc"]',
      '[data-testid="job-description"]',
      // Job detail/detail pages
      '[class*="job-detail"]', '[class*="jobDetail"]', '[class*="JobDetail"]',
      '[class*="position-desc"]', '[class*="role-desc"]',
      // Indeed
      '#jobDescriptionText', '.jobsearch-jobDescriptionText',
      // LinkedIn
      '.jobs-description-content', '.jobs-box__html-content',
      // Greenhouse
      '#content', '.job-post-content',
      // Lever
      '.posting-page .content',
      // Glassdoor
      '[data-test="job-description"]', '.JobDetails_jobDescription__uW_fK',
      '.job-description-wrapper', '[class*="JobDescription"]',
      // SmartRecruiters
      '.job-sections', '[class*="job-sections"]', '[class*="details-panels"]',
      // Workable / Ashby / Breezy
      '.job-description-wrapper', '[class*="job-body"]', '[class*="listing-description"]',
      // Generic semantic elements — try to find content-rich sections
      'article', '[role="main"] section', 'main section', '.content', 'main'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el?.textContent?.trim().length > 200) {
        return { jobDescription: this.cleanText(el.textContent), contextQuality: 'heuristic' };
      }
    }

    // 2. Look for any element containing typical job description keywords
    const allSections = document.querySelectorAll('section, article, div[class], div[id]');
    const keywords = /responsibilities|requirements|qualifications|about\s+the\s+role|what\s+you.ll\s+do|about\s+this\s+role|the\s+position/i;
    for (const el of allSections) {
      if (el.children.length > 2 && keywords.test(el.textContent) && el.textContent.trim().length > 300) {
        return { jobDescription: this.cleanText(el.textContent), contextQuality: 'heuristic' };
      }
    }

    // 3. Full page text fallback — noisy, used only as a last resort.
    // Cap at 3000 chars to limit noise injected into prompts.
    const pageText = this.extractCleanPageText();
    if (pageText.length > 100) {
      return { jobDescription: pageText.slice(0, 3000), contextQuality: 'fullpage' };
    }

    return { jobDescription: '', contextQuality: 'none' };
  }

  /**
   * Extract specific requirements/qualifications section.
   * Filters out noise (benefits, culture, perks) and requires specificity markers
   * so only real candidate requirements are passed to the model.
   */
  extractRequirements() {
    // Bullets that describe benefits, culture, or the company — not candidate requirements
    const noisePattern = /\b(compens(ation)?|salary|equity|bonus|stock\s*option|benefit|perk|insurance|pto|vacation|holiday|pension|401k|culture|collaborative|our\s+team|we\s+offer|we\s+provide|we\s+believe|join\s+us|about\s+(us|the\s+(role|company))|competitive\b|enthusiasm|passion\s+for\s+our|fast.?paced|start.?up|environment|diverse|inclusion|equal\s+opportunit)\b/i;
    // Must contain at least one specificity marker (tech, measurable criteria, or explicit skill reference)
    const specificityPattern = /\b(\d+\s*\+?\s*years?|bachelor|master|phd|degree|certif|proficien|experience\s+(in|with)|knowledge\s+(of|in)|famili(ar|arity)\s+(with|in)|skill(s)?\s+(in|with)|ability\s+to|must\s+(have|be|hold)|required|[a-z]+\.(js|py|go|ts|rb|java|cs|cpp|rs)|python|javascript|typescript|react|node|aws|sql|java\b|kubernetes|docker|terraform|machine\s+learning|data\s+(science|analysis|engineering))\b/i;

    const isValidRequirement = (text) =>
      text.length >= 15 &&
      text.length <= 300 &&
      !noisePattern.test(text) &&
      specificityPattern.test(text);

    const requirements = [];

    // Pass 1: section-based — find requirement-section headers, take their list items
    const headers = document.querySelectorAll('h2, h3, h4, strong, b');
    for (const header of headers) {
      if (header.textContent.toLowerCase().match(/requirement|qualification|what we.+look|must have|you.+have|skills|experience/)) {
        let sibling = header.nextElementSibling;
        while (sibling && !sibling.matches('h2, h3, h4')) {
          if (sibling.matches('ul, ol')) {
            sibling.querySelectorAll('li').forEach(li => {
              const req = li.textContent.trim();
              if (isValidRequirement(req) && !requirements.includes(req)) {
                requirements.push(req);
              }
            });
          }
          sibling = sibling.nextElementSibling;
        }
      }
    }

    // Pass 2: scan all list items (deduped against pass 1)
    document.querySelectorAll('li').forEach(li => {
      const text = li.textContent.trim();
      if (isValidRequirement(text) && !requirements.includes(text)) {
        requirements.push(text);
      }
    });

    // Pass 3: fall back to structured data description if still empty
    if (requirements.length === 0) {
      const structured = this.extractFromStructuredData();
      if (structured?.description) {
        structured.description.split(/\n|<br\s*\/?>/i).forEach(line => {
          const trimmed = line.replace(/<[^>]+>/g, '').trim();
          if (isValidRequirement(trimmed) && !requirements.includes(trimmed)) {
            requirements.push(trimmed);
          }
        });
      }
    }

    return requirements.slice(0, 30);
  }

  /**
   * Extract and clean all page text as fallback
   */
  extractCleanPageText() {
    if (!document.body) return '';

    // Remove script, style, nav, footer, header elements
    const clone = document.body.cloneNode(true);
    const removeSelectors = ['script', 'style', 'nav', 'footer', 'header', 
                             'aside', '.sidebar', '.navigation', '.menu',
                             '.cookie', '.popup', '.modal', '.ad', '.advertisement'];
    
    for (const selector of removeSelectors) {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    }

    return this.cleanText(clone.textContent);
  }

  /**
   * Clean extracted text
   */
  cleanText(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim()
      .slice(0, 40000); // Limit for token management
  }

}

// Export for use in content script
window.PageExtractor = PageExtractor;
