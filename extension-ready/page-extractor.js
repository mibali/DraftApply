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

    return 'generic';
  }

  /**
   * Extract job title using platform-specific selectors
   */
  extractJobTitle() {
    const selectors = [
      // Common patterns
      'h1.job-title', 'h1[class*="title"]', '.job-title h1',
      '[data-testid="job-title"]', '[class*="JobTitle"]',
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
    if (ogTitle) return ogTitle.content;

    return document.title.split('|')[0].split('-')[0].trim();
  }

  /**
   * Extract company name
   */
  extractCompany() {
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

    // Try structured data
    const ldJson = document.querySelector('script[type="application/ld+json"]');
    if (ldJson) {
      try {
        const data = JSON.parse(ldJson.textContent);
        if (data.hiringOrganization?.name) return data.hiringOrganization.name;
        if (data.employer?.name) return data.employer.name;
      } catch (e) {}
    }

    return '';
  }

  /**
   * Extract job description content
   */
  extractJobDescription() {
    const selectors = [
      // Common patterns
      '.job-description', '[class*="description"]',
      '[class*="Description"]', '#job-description',
      '[data-testid="job-description"]',
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
      // Workable
      '.job-description-wrapper',
      // Generic content areas
      'article', 'main', '.content'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el?.textContent?.trim().length > 200) {
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

    return requirements.slice(0, 20);
  }

  /**
   * Extract and clean all page text as fallback
   */
  extractCleanPageText() {
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
      .slice(0, 8000); // Limit for token management
  }

  /**
   * Get a summary suitable for display
   */
  getSummary() {
    const content = this.extract();
    return {
      platform: content.platform,
      jobTitle: content.jobTitle,
      company: content.company,
      hasDescription: content.jobDescription.length > 100,
      requirementsCount: content.requirements.length,
      descriptionLength: content.jobDescription.length
    };
  }

  /**
   * Build context string for LLM prompt
   */
  buildContext() {
    const content = this.extract();
    
    let context = `## JOB CONTEXT (Auto-extracted from ${content.platform})\n\n`;
    
    if (content.jobTitle) {
      context += `**Position:** ${content.jobTitle}\n`;
    }
    if (content.company) {
      context += `**Company:** ${content.company}\n`;
    }
    context += '\n';

    if (content.requirements.length > 0) {
      context += '### Key Requirements\n';
      for (const req of content.requirements.slice(0, 10)) {
        context += `- ${req}\n`;
      }
      context += '\n';
    }

    context += '### Job Description\n';
    context += content.jobDescription.slice(0, 4000);
    
    if (content.jobDescription.length > 4000) {
      context += '\n[...truncated...]';
    }

    return context;
  }
}

// Export for use in content script
window.PageExtractor = PageExtractor;
