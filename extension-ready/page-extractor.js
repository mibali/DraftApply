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
  }

  /**
   * Extract job-relevant content from the current page
   * @returns {Object} Extracted job context
   */
  extract() {
    // Cache based on URL to avoid re-extraction
    if (this.cachedUrl === window.location.href && this.cachedContent) {
      return this.cachedContent;
    }

    const content = {
      url: window.location.href,
      platform: this.detectPlatform(),
      jobTitle: this.extractJobTitle(),
      company: this.extractCompany(),
      jobDescription: this.extractJobDescription(),
      requirements: this.extractRequirements(),
      fullPageText: this.extractCleanPageText(),
      extractedAt: new Date().toISOString()
    };

    this.cachedContent = content;
    this.cachedUrl = window.location.href;

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
      'glassdoor.co.uk': 'glassdoor'
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

    return document.title.split('|')[0].split('-')[0].trim();
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
      // Greenhouse
      '.company-name', '.employer-name',
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
   * Extract job description content
   */
  extractJobDescription() {
    // 1. Structured data — most reliable on company career pages
    const structured = this.extractFromStructuredData();
    if (structured?.description?.length > 200) {
      return this.cleanText(structured.description);
    }

    const selectors = [
      // Common patterns
      '.job-description', '[class*="job-description"]', '[class*="job-desc"]',
      '[class*="jobDescription"]', '[class*="JobDescription"]',
      '[class*="Description"]', '#job-description', '[id*="job-desc"]',
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
      // Workable / Ashby / Breezy
      '.job-description-wrapper', '[class*="job-body"]', '[class*="listing-description"]',
      // Generic semantic elements — try to find content-rich sections
      'article', '[role="main"] section', 'main section', '.content', 'main'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el?.textContent?.trim().length > 200) {
        return this.cleanText(el.textContent);
      }
    }

    // 2. Look for any element containing typical job description keywords
    const allSections = document.querySelectorAll('section, article, div[class], div[id]');
    const keywords = /responsibilities|requirements|qualifications|about\s+the\s+role|what\s+you.ll\s+do|about\s+this\s+role|the\s+position/i;
    for (const el of allSections) {
      if (el.children.length > 2 && keywords.test(el.textContent) && el.textContent.trim().length > 300) {
        return this.cleanText(el.textContent);
      }
    }

    return this.extractCleanPageText();
  }

  /**
   * Extract specific requirements/qualifications section
   */
  extractRequirements() {
    const requirements = [];
    
    // Look for sections with requirement-related headers
    const headers = document.querySelectorAll('h2, h3, h4, strong, b');
    
    for (const header of headers) {
      const text = header.textContent.toLowerCase();
      if (text.match(/requirement|qualification|what we.+look|must have|you.+have|skills|experience/)) {
        // Get the next sibling content (usually a list)
        let sibling = header.nextElementSibling;
        while (sibling && !sibling.matches('h2, h3, h4')) {
          if (sibling.matches('ul, ol')) {
            const items = sibling.querySelectorAll('li');
            items.forEach(li => {
              const req = li.textContent.trim();
              if (req.length > 10 && req.length < 300) {
                requirements.push(req);
              }
            });
          }
          sibling = sibling.nextElementSibling;
        }
      }
    }

    // Also extract bullet points that look like requirements
    const allListItems = document.querySelectorAll('li');
    for (const li of allListItems) {
      const text = li.textContent.trim();
      if (text.length > 20 && text.length < 300 &&
          text.match(/experience|proficien|knowledge|skill|ability|familiar|degree|year/i)) {
        if (!requirements.includes(text)) {
          requirements.push(text);
        }
      }
    }

    // If DOM extraction found nothing, parse requirements from structured data description
    if (requirements.length === 0) {
      const structured = this.extractFromStructuredData();
      if (structured?.description) {
        const lines = structured.description.split(/\n|<br\s*\/?>/i);
        for (const line of lines) {
          const trimmed = line.replace(/<[^>]+>/g, '').trim();
          if (trimmed.length > 20 && trimmed.length < 300 &&
              trimmed.match(/experience|proficien|knowledge|skill|ability|familiar|degree|year/i)) {
            requirements.push(trimmed);
          }
        }
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
