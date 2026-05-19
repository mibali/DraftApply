/**
 * Page Content Extractor
 *
 * Intelligently extracts job description and application context
 * from the current webpage. Works across major job platforms.
 *
 * Supports: Indeed, LinkedIn, Greenhouse, Lever, Workable, Workday, Ashby,
 *           SmartRecruiters, Glassdoor, Otta, iCIMS, JazzHR, BambooHR,
 *           Breezy HR, Pinpoint, Recruitee, and generic career pages.
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
    const main = this.querySelectorDeep('main, [role="main"]') || document.body;
    const text = main ? (main.innerText || '').slice(0, 4000) : '';
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  openRoots(root = document, seen = new Set()) {
    if (!root || seen.has(root)) return [];
    seen.add(root);

    const roots = [root];
    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of elements) {
      if (el.shadowRoot) roots.push(...this.openRoots(el.shadowRoot, seen));
    }
    return roots;
  }

  querySelectorDeep(selector) {
    for (const root of this.openRoots()) {
      try {
        const found = root.querySelector?.(selector);
        if (found) return found;
      } catch (e) {}
    }
    return null;
  }

  querySelectorAllDeep(selector) {
    const results = [];
    for (const root of this.openRoots()) {
      try {
        results.push(...(root.querySelectorAll?.(selector) || []));
      } catch (e) {}
    }
    return [...new Set(results)];
  }

  /**
   * Extract job-relevant content from the current page.
   * @returns {Object} Extracted job context
   */
  extract() {
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
   * Detect which job platform we're on.
   */
  detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    const url  = window.location.href;

    const exactDomains = {
      'indeed.com':                  'indeed',
      'linkedin.com':                'linkedin',
      'greenhouse.io':               'greenhouse',
      'boards.eu.greenhouse.io':     'greenhouse',
      'lever.co':                    'lever',
      'jobs.lever.co':               'lever',
      'workable.com':                'workable',
      'apply.workable.com':          'workable',
      'otta.com':                    'otta',
      'hiringcafe.com':              'hiringcafe',
      'jobs.ashbyhq.com':            'ashby',
      'glassdoor.com':               'glassdoor',
      'glassdoor.co.uk':             'glassdoor',
      'smartrecruiters.com':         'smartrecruiters',
      'myworkdayjobs.com':           'workday',
      'icims.com':                   'icims',
      'careers.icims.com':           'icims',
      'applytojob.com':              'jazzhr',
      'bamboohr.com':                'bamboohr',
      'breezy.hr':                   'breezy',
      'pinpointhq.com':              'pinpoint',
      'recruitee.com':               'recruitee',
      'taleo.net':                   'taleo',
      'oraclecloud.com':             'taleo',
    };

    for (const [domain, platform] of Object.entries(exactDomains)) {
      if (host.includes(domain)) return platform;
    }

    // Detect embedded ATS by URL params / path patterns
    if (url.includes('gh_jid=') || url.includes('/greenhouse/'))  return 'greenhouse';
    if (url.includes('/lever/') || url.includes('lever'))         return 'lever';
    if (url.includes('workday'))                                   return 'workday';
    if (url.includes('icims'))                                     return 'icims';
    if (url.includes('taleo'))                                     return 'taleo';

    return 'generic';
  }

  /**
   * Extract from application/ld+json JobPosting schema (most reliable).
   */
  extractFromStructuredData() {
    const scripts = this.querySelectorAllDeep('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
        for (const item of items) {
          if (item['@type'] === 'JobPosting') {
            return {
              title:       item.title || item.name || null,
              company:     item.hiringOrganization?.name || item.employer?.name || null,
              description: item.description || item.jobDescription || null
            };
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * Extract job title using platform-specific and generic selectors.
   */
  extractJobTitle() {
    const structured = this.extractFromStructuredData();
    if (structured?.title) return structured.title;

    const selectors = [
      // Generic semantic
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
      // SmartRecruiters
      '[class*="job-header"] h1', '.job-details h1',
      // Workday
      '[data-automation-id="jobPostingHeader"] h2',
      '[data-automation-id="jobPostingHeader"]',
      '.wd-text-block-title h2',
      // iCIMS
      '.iCIMS_JobTitle h1', '.iCIMS_JobTitle',
      // JazzHR
      '.apply-button-wrapper h1', '.app_job_header h2',
      // BambooHR
      '.BH-intro h1', '.job-title-info h2',
      // Breezy HR
      '.position-title h1', '.position h2',
      // Pinpoint
      '.posting-title', '[class*="PostingTitle"]',
      // Recruitee
      '.job-title h1', '[class*="job-header"] h1',
      // Taleo
      '.requisitionNumberClass', '#jobdetails h1',
      // Glassdoor
      '[data-test="job-title"]', '.JobDetails_jobTitle__Rq2mK', '.css-1vg6q84',
      '[class*="JobDetails"] h1', '.job-title-text',
      // Generic fallback
      'h1', '.title h1', 'header h1'
    ];

    for (const selector of selectors) {
      const el = this.querySelectorDeep(selector);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }

    const ogTitle = this.querySelectorDeep('meta[property="og:title"]');
    if (ogTitle?.content) return ogTitle.content;

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
   * Extract company name using platform-specific and generic selectors.
   */
  extractCompany() {
    const structured = this.extractFromStructuredData();
    if (structured?.company) return structured.company;

    const selectors = [
      // Generic
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
      // Workday
      '[data-automation-id="jobPostingHeader"] .wd-text-block-company',
      // iCIMS
      '.iCIMS_CompanyName',
      // BambooHR
      '.BH-intro .company-name',
      // Breezy HR
      '.company-name', '.company-info h3',
      // Pinpoint
      '[class*="CompanyName"]', '.company-details .name',
      // Recruitee
      '.company-name', '[class*="company"] h2',
      // Glassdoor
      '[data-test="employer-name"]', '.EmployerProfile_companyName__lHhH4',
      '[class*="EmployerProfile"] a', '.css-16nw49e',
      // Generic
      '.employer', '.organization'
    ];

    for (const selector of selectors) {
      const el = this.querySelectorDeep(selector);
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
      // Generic
      '.job-description', '[class*="job-description"]', '[class*="job-desc"]',
      '[class*="jobDescription"]', '[class*="JobDescription"]',
      '#job-description', '[id*="job-desc"]',
      '[data-testid="job-description"]',
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
      // Workday
      '[data-automation-id="job-posting-details"]',
      '[data-automation-id="jobPostingDescription"]',
      '.wd-content-area [data-automation-id]',
      // iCIMS
      '.iCIMS_InfoMsg_Job', '.iCIMS_MainColumn .iCIMS_JobDescriptionBody',
      '#iCIMS_Content', '.iCIMS_JobDescription',
      // JazzHR
      '.apply-job-description', '.job-description .app_content',
      // BambooHR
      '.BH-intro-text', '.BH-JobBoard-jobListing-description',
      '.description', '#job-details',
      // Breezy HR
      '.job-description-wrapper', '[class*="job-body"]',
      '.listing-description', '.position-description',
      // Pinpoint
      '[class*="JobDescription"]', '.posting-description',
      '.posting-content', '[class*="PostingBody"]',
      // Recruitee
      '.job-description', '[class*="job-content"]',
      '.careers-section-content',
      // Taleo (older interface)
      '#requisitionDescriptionInterface', '.atsJobdetailscontainer',
      '#jobdetails .description',
      // Workable / Ashby
      '[class*="listing-description"]',
      // Generic semantic fallbacks
      'article', '[role="main"] section', 'main section', '.content', 'main'
    ];

    for (const selector of selectors) {
      const el = this.querySelectorDeep(selector);
      if (el?.textContent?.trim().length > 200) {
        return { jobDescription: this.cleanText(el.textContent), contextQuality: 'heuristic' };
      }
    }

    // 2. Look for any element containing typical job description keywords
    const allSections = this.querySelectorAllDeep('section, article, div[class], div[id]');
    const keywords = /responsibilities|requirements|qualifications|about\s+the\s+role|what\s+you.ll\s+do|about\s+this\s+role|the\s+position/i;
    for (const el of allSections) {
      if (el.children.length > 2 && keywords.test(el.textContent) && el.textContent.trim().length > 300) {
        return { jobDescription: this.cleanText(el.textContent), contextQuality: 'heuristic' };
      }
    }

    // 3. Full page text fallback — cap at 3000 chars
    const pageText = this.extractCleanPageText();
    if (pageText.length > 100) {
      const capped = pageText.slice(0, 5000);
      return {
        jobDescription: capped,
        contextQuality: this.isLikelyJobPostingText(capped) ? 'heuristic' : 'fullpage'
      };
    }

    return { jobDescription: '', contextQuality: 'none' };
  }

  /**
   * Some generic application pages render the JD as plain visible page text
   * without semantic containers. Treat that as usable context when there are
   * multiple job-posting signals, instead of downgrading to noisy fullpage.
   */
  isLikelyJobPostingText(text) {
    const value = String(text || '');
    if (value.length < 250) return false;

    const signals = [
      /\b(responsibilities|your responsibilities|what you(?:'|’)ll do|what you will do)\b/i,
      /\b(requirements|qualifications|must have|you must|this role requires)\b/i,
      /\b(tech|technical skills|skills|experience with|experience in)\b/i,
      /\b(salary|£\s?\d|€\s?\d|\$\s?\d|\d+\s?k)\b/i,
      /\b(apply|covering letter|cv upload|resume upload)\b/i,
      /\b(role|position|job title|engineer|architect|manager|developer|consultant)\b/i,
    ];

    const score = signals.reduce((count, re) => count + (re.test(value) ? 1 : 0), 0);
    return score >= 3;
  }

  /**
   * Extract specific requirements/qualifications section.
   * Filters out benefits/culture noise and requires specificity markers.
   */
  extractRequirements() {
    const noisePattern = /\b(compens(ation)?|salary|equity|bonus|stock\s*option|benefit|perk|insurance|pto|vacation|holiday|pension|401k|culture|collaborative|our\s+team|we\s+offer|we\s+provide|we\s+believe|join\s+us|about\s+(us|the\s+(role|company))|competitive\b|enthusiasm|passion\s+for\s+our|fast.?paced|start.?up|environment|diverse|inclusion|equal\s+opportunit)\b/i;
    const specificityPattern = /\b(\d+\s*\+?\s*years?|bachelor|master|phd|degree|certif|proficien|experience\s+(in|with)|knowledge\s+(of|in)|famili(ar|arity)\s+(with|in)|skill(s)?\s+(in|with)|ability\s+to|must\s+(have|be|hold)|required|[a-z]+\.(js|py|go|ts|rb|java|cs|cpp|rs)|python|javascript|typescript|react|node|aws|sql|java\b|kubernetes|docker|terraform|machine\s+learning|data\s+(science|analysis|engineering))\b/i;

    const isValidRequirement = (text) =>
      text.length >= 15 &&
      text.length <= 300 &&
      !noisePattern.test(text) &&
      specificityPattern.test(text);

    const requirements = [];

    // Pass 1: section-based — requirement-section headers → list items
    const headers = this.querySelectorAllDeep('h2, h3, h4, strong, b');
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
    this.querySelectorAllDeep('li').forEach(li => {
      const text = li.textContent.trim();
      if (isValidRequirement(text) && !requirements.includes(text)) {
        requirements.push(text);
      }
    });

    // Pass 3: fall back to structured data description
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
   * Extract and clean all page text as fallback.
   */
  extractCleanPageText() {
    if (!document.body) return '';

    let bodyText = '';
    try {
      const clone = document.body.cloneNode(true);
      const removeSelectors = [
        'script', 'style', 'nav', 'footer', 'header',
        'aside', '.sidebar', '.navigation', '.menu',
        '.cookie', '.popup', '.modal', '.ad', '.advertisement'
      ];
      for (const selector of removeSelectors) {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      }
      bodyText = clone.textContent || '';
    } catch {
      // cloneNode can throw on pages with date/number inputs whose value attribute
      // is "undefined" or out of range (e.g. Ashby application forms)
      bodyText = document.body.innerText || document.body.textContent || '';
    }

    const shadowText = this.openRoots()
      .filter(root => root !== document)
      .map(root => root.textContent || '')
      .join('\n');

    return this.cleanText(`${bodyText}\n${shadowText}`);
  }

  /**
   * Clean extracted text.
   */
  cleanText(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim()
      .slice(0, 40000);
  }
}

window.PageExtractor = PageExtractor;
