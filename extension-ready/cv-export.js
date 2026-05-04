(async () => {
  document.getElementById('print-btn')?.addEventListener('click', () => window.print());
  document.getElementById('close-btn')?.addEventListener('click', async () => {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) {
        await chrome.tabs.remove(tab.id);
        return;
      }
    } catch {}

    window.close();
  });

  const { tailoredCvExport } = await chrome.storage.local.get('tailoredCvExport');
  const loading = document.getElementById('loading');
  const content = document.getElementById('cv-content');

  if (!tailoredCvExport) {
    loading.textContent = 'No CV found — please generate a tailored CV first.';
    return;
  }

  await chrome.storage.local.remove('tailoredCvExport');

  // Set page title (and therefore PDF filename) to "Full Name CV"
  const candidateName = tailoredCvExport.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (candidateName) document.title = `${candidateName} CV`;

  content.innerHTML = formatCvToHtml(tailoredCvExport);
  loading.hidden = true;
  content.hidden = false;
})();

// ── CV text → Harvard-style HTML ──────────────────────────────────────────────

const SECTION_RE = /^(professional\s+summary|core\s+competenc(?:y|ies)|professional\s+experience|technical\s+skills?|certifications?\s*(?:&|and)\s*awards?|technical\s+leadership(?:,\s*achievements?\s*(?:&|and)\s*innovation)?|experience|employment|work\s*history|education|academic|qualifications|skills|technologies|competencies|expertise|summary|profile|about|objective|certifications?|licenses?|credentials|achievements?|awards?|projects?|publications?|languages?|interests?|hobbies|references?|contact|links?)s?\s*[:\-]?\s*$/i;

const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|present|current|to\s*date|now)\b/i;

// Strip LLM-inserted label prefixes from job title lines, e.g. "Position: Senior Engineer"
function stripJobTitleLabel(line) {
  return line.replace(/^(position|title|role|job\s*title)\s*:\s*/i, '').trim();
}

function isSectionHeader(line) {
  if (SECTION_RE.test(line)) return true;
  // ALL CAPS line that reads as a heading
  if (line.length >= 3 && line === line.toUpperCase() && /[A-Z]/.test(line) && !/[@+\d\/]/.test(line)) return true;
  return false;
}

function isEntrySectionHeader(line) {
  return /\b(experience|employment|work|education|academic|qualifications|projects?)\b/i
    .test(line.replace(/[:\-]\s*$/, '').trim());
}

function isContactLine(line) {
  return /[\w.+-]+@[\w-]+\.\w+/.test(line)
    || /https?:\/\//i.test(line)
    || /(?:linkedin|github|twitter|x\.com|portfolio)/i.test(line)
    || /(?:\+\d[\d\s\-.()]{5,}|\b\d{3}[\s\-.]\d{3}[\s\-.]\d{4}\b)/.test(line);
}

function isLocationLine(line) {
  return line.length <= 80
    && /,/.test(line)
    && /\b(uk|united kingdom|usa|united states|belgium|canada|germany|france|ireland|netherlands|remote)\b/i.test(line)
    && !/\b(engineer|developer|manager|architect|support|mlops|devops|sre|data|platform)\b/i.test(line);
}

function isDateLine(line) {
  return line.length < 60 && DATE_RE.test(line) && (line.match(/\d{4}/g) || []).length >= 1;
}

function linkify(html) {
  html = html.replace(/https?:\/\/[\w\-.~:/?#%@!$&amp;'()*+,;=]+/gi, url => {
    const raw = url.replace(/&amp;/g, '&');
    return `<a href="${raw}" target="_blank" rel="noopener">${url}</a>`;
  });
  html = html.replace(/([\w.+-]+@[\w-]+\.[\w.]+)/g, e => `<a href="mailto:${e}">${e}</a>`);
  return html;
}

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeUrl(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();
}

function extractSocialUrls(text) {
  const urls = {};
  const allUrls = String(text || '').match(/https?:\/\/[^\s<>"')]+/gi) || [];
  for (const url of allUrls) {
    if (/linkedin\.com/i.test(url) && !urls.linkedin) urls.linkedin = url;
    else if (/github\.com/i.test(url) && !urls.github) urls.github = url;
    else if (/(?:portfolio|behance\.net|dribbble\.com|kaggle\.com)/i.test(url) && !urls.portfolio) urls.portfolio = url;
    else if (!/(?:linkedin|github|twitter|x)\.com/i.test(url) && !urls.website) urls.website = url;
  }
  return urls;
}

function extractEmailDomains(text) {
  const emails = String(text || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
  return new Set(emails.map(email => email.split('@')[1]?.toLowerCase()).filter(Boolean));
}

function urlHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function socialLabelUrl(line, socialUrls) {
  if (/^linkedin$/i.test(line) && socialUrls.linkedin) return { label: 'LinkedIn', url: socialUrls.linkedin };
  if (/^github$/i.test(line) && socialUrls.github) return { label: 'GitHub', url: socialUrls.github };
  if (/^(website|portfolio|personal\s+website|personal\s+site)$/i.test(line) && (socialUrls.portfolio || socialUrls.website)) {
    return { label: line, url: socialUrls.portfolio || socialUrls.website };
  }
  return null;
}

function contactLink(label, url) {
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
}

function formatCvToHtml(rawText) {
  // Strip trailing "Links:" section added by PDF/DOCX extractor — links are
  // already inline in the text; we don't want them duplicated at the bottom.
  const socialUrls = extractSocialUrls(rawText);
  const knownSocialUrls = new Set(Object.values(socialUrls).filter(Boolean).map(normalizeUrl));
  const emailDomains = extractEmailDomains(rawText);
  const mainText = rawText.replace(/\n\nLinks:\n[\s\S]+$/i, '').trim();
  const lines = mainText.split('\n');

  let html = '';
  let nameSet = false;
  let headlineSet = false;
  let listOpen = false;
  let inHeader = true;
  let beforeFirstSection = true;
  let inEntrySection = false; // true inside Experience / Education sections

  // Buffer for a potential company name — flushed once we know what follows:
  //   dates → cv-entry-row with dates; short non-date → entry-row + cv-job-title; other → standalone
  let pendingCompany = null;
  // True immediately after emitting an entry row, so the next short line → cv-job-title
  let afterEntryRow = false;

  const closeList = () => {
    if (listOpen) { html += '</ul>'; listOpen = false; }
  };

  const emitEntryRow = (company, dates) => {
    html += '<div class="cv-entry-row">';
    html += `<span class="cv-company">${esc(company)}</span>`;
    if (dates) html += `<span class="cv-entry-dates">${esc(dates)}</span>`;
    html += '</div>';
    pendingCompany = null;
    afterEntryRow = true;
  };

  const flushPendingCompany = (dates) => {
    if (pendingCompany !== null) {
      emitEntryRow(pendingCompany, dates || null);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // ── Blank line ──
    if (!line) {
      closeList();
      flushPendingCompany(null);
      afterEntryRow = false;
      if (inHeader) {
        inHeader = false;
        html += '<hr class="cv-header-rule">';
      }
      html += '<div class="cv-spacer"></div>';
      continue;
    }

    // Skip pure-decorator lines — LLMs often insert ────────, ————————, ----, ====
    // as horizontal rules between sections. They contain no word characters.
    if (line.length >= 3 && !/\w/.test(line)) continue;

    // Some generated CVs inherit a bad "website" from the parser when an
    // email domain is mistaken for a URL, e.g. mtbdesigns01@gmail.com → http://gmail.com.
    if (/^https?:\/\//i.test(line) && emailDomains.has(urlHost(line))) {
      continue;
    }

    // ── Name (very first non-empty line) ──
    if (!nameSet) {
      html += `<h1 class="cv-name">${esc(line)}</h1>`;
      nameSet = true;
      continue;
    }

    // ── Section header ──
    if (isSectionHeader(line)) {
      closeList();
      flushPendingCompany(null);
      afterEntryRow = false;
      if (inHeader) {
        html += '<hr class="cv-header-rule">';
      }
      inHeader = false;
      beforeFirstSection = false;
      inEntrySection = isEntrySectionHeader(line);
      const sectionText = line.replace(/[:\-]\s*$/, '').trim();
      if (sectionText) html += `<h2 class="cv-section-header">${esc(sectionText)}</h2>`;
      continue;
    }

    // ── Header block (contact / headline) ──
    if (inHeader) {
      const social = socialLabelUrl(line, socialUrls);
      if (social) {
        html += `<p class="cv-contact">${contactLink(social.label, social.url)}</p>`;
      } else if (isContactLine(line) || isLocationLine(line)) {
        html += `<p class="cv-contact">${linkify(esc(line))}</p>`;
      } else if (!headlineSet) {
        html += `<p class="cv-headline">${esc(line)}</p>`;
        headlineSet = true;
      } else {
        html += `<p class="cv-contact">${linkify(esc(line))}</p>`;
      }
      continue;
    }

    // Some LLM/CV outputs insert a blank line before the professional title.
    // Still treat the first pre-section, non-contact line as the headline.
    if (beforeFirstSection && !headlineSet && !isContactLine(line) && !isLocationLine(line) && !isDateLine(line)) {
      html += `<p class="cv-headline">${esc(line)}</p>`;
      headlineSet = true;
      continue;
    }

    // ── Bullet point ──
    if (/^[\-•*●▪◦–—]\s/.test(line)) {
      flushPendingCompany(null);
      afterEntryRow = false;
      if (!listOpen) { html += '<ul class="cv-bullets">'; listOpen = true; }
      html += `<li>${linkify(esc(line.replace(/^[\-•*●▪◦–—]\s*/, '')))}</li>`;
      continue;
    }

    closeList();

    // If a PDF/DOCX extractor put a raw social URL at the bottom, keep the
    // header link and omit the duplicated standalone URL from the body.
    if (/^https?:\/\//i.test(line) && knownSocialUrls.has(normalizeUrl(line))) {
      continue;
    }

    // ── Entry-section logic (Experience / Education) ──
    if (inEntrySection) {

      // Inline separator: "Company Name | Jan 2020 – Present"
      const pipeSep = line.match(/^(.+?)\s*\|\s*(.{4,40})$/);
      if (pipeSep && DATE_RE.test(pipeSep[2])) {
        flushPendingCompany(null);
        emitEntryRow(pipeSep[1].trim(), pipeSep[2].trim());
        continue;
      }

      // Pending company + this is a date line → complete entry row
      if (pendingCompany !== null && isDateLine(line)) {
        flushPendingCompany(line);
        continue;
      }

      // Line immediately after an entry row → job title (italic)
      if (afterEntryRow && line.length < 70 && !isContactLine(line) && !isDateLine(line)) {
        const title = stripJobTitleLabel(line);
        if (title) html += `<p class="cv-job-title">${esc(title)}</p>`;
        afterEntryRow = false;
        continue;
      }
      afterEntryRow = false;

      if (/^focus\s*:/i.test(line)) {
        html += `<p class="cv-role-focus">${esc(line)}</p>`;
        continue;
      }

      // Pending company + next short non-date line → flush company (no dates), emit as job title
      if (pendingCompany !== null && line.length < 70 && !isContactLine(line) && !isDateLine(line)) {
        flushPendingCompany(null);
        afterEntryRow = false;
        const title = stripJobTitleLabel(line);
        if (title) html += `<p class="cv-job-title">${esc(title)}</p>`;
        continue;
      }

      // Short line that could be a company / institution name — buffer it, but only when
      // at the start of a new entry (preceded by blank, section header, or date line).
      if (pendingCompany === null && line.length < 70 && !isContactLine(line) && !isDateLine(line)) {
        const prevLine = lines[i - 1]?.trim() || '';
        if (prevLine === '' || isSectionHeader(prevLine) || isDateLine(prevLine)) {
          pendingCompany = line;
          continue;
        }
      }
    } else {
      afterEntryRow = false;
    }

    // ── Flush any pending state before falling through to body content ──
    flushPendingCompany(null);
    afterEntryRow = false;

    // Standalone date line (outside entry section accumulator)
    if (isDateLine(line)) {
      html += `<p class="cv-date-line">${esc(line)}</p>`;
      continue;
    }

    // Default body text
    html += `<p class="cv-body">${linkify(esc(line))}</p>`;
  }

  closeList();
  flushPendingCompany(null);
  return html;
}
