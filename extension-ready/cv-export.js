(async () => {
  document.getElementById('print-btn')?.addEventListener('click', () => window.print());
  document.getElementById('word-btn')?.addEventListener('click', () => {
    const content = document.getElementById('cv-content');
    const title = document.title || 'Tailored CV';
    if (!content?.innerHTML?.trim()) return;
    downloadWordDocument(content.innerHTML, title);
  });
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

function isSkillsSectionHeader(line) {
  return /^(core\s+competenc(?:y|ies)|technical\s+skills?|skills|technologies|competencies|expertise)\s*[:\-]?$/i
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

function safeDownloadName(title) {
  const clean = String(title || 'Tailored CV')
    .replace(/\s+CV\s*$/i, ' CV')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${clean || 'Tailored CV'}.doc`;
}

function buildWordDocument(cvHtml, title = 'Tailored CV') {
  const cleanTitle = esc(String(title || 'Tailored CV'));
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="utf-8">
  <title>${cleanTitle}</title>
  <!--[if gte mso 9]>
  <xml>
    <w:WordDocument>
      <w:View>Print</w:View>
      <w:Zoom>100</w:Zoom>
      <w:DoNotOptimizeForBrowser/>
    </w:WordDocument>
  </xml>
  <![endif]-->
  <style>
    @page { margin: 0.7in; }
    body {
      font-family: Calibri, Georgia, serif;
      font-size: 11pt;
      line-height: 1.45;
      color: #111;
    }
    .cv-name {
      font-size: 18pt;
      font-weight: 700;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 3px;
      margin-bottom: 5px;
    }
    .cv-headline {
      font-size: 11pt;
      font-style: italic;
      text-align: center;
      color: #444;
      margin-bottom: 3px;
    }
    .cv-contact {
      font-size: 9.5pt;
      text-align: center;
      color: #555;
      line-height: 1.5;
      margin: 0;
    }
    .cv-contact a, .cv-body a, .cv-bullets li a {
      color: #111;
      text-decoration: underline;
    }
    .cv-header-rule {
      border: none;
      border-top: 1.5pt solid #0a0a0a;
      margin: 10pt 0 0;
    }
    .cv-section-header {
      font-size: 10pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      border-bottom: 1.5pt solid #0a0a0a;
      padding-bottom: 2pt;
      margin-top: 16pt;
      margin-bottom: 7pt;
    }
    .cv-entry-row {
      margin-top: 9pt;
      width: 100%;
      clear: both;
    }
    .cv-company {
      font-size: 11.6pt;
      font-weight: 800;
    }
    .cv-entry-dates {
      font-size: 9.5pt;
      color: #444;
      float: right;
      margin-left: 12pt;
    }
    .cv-job-title {
      font-size: 10.5pt;
      font-style: italic;
      font-weight: 600;
      color: #333;
      margin: 0 0 3pt;
    }
    .cv-role-focus {
      font-size: 10pt;
      font-style: italic;
      color: #4b5563;
      margin: 0 0 5pt;
    }
    .cv-bullets {
      padding-left: 18pt;
      margin: 4pt 0;
    }
    .cv-bullets li {
      font-size: 10.5pt;
      line-height: 1.45;
      margin-bottom: 2pt;
    }
    .cv-body {
      font-size: 10.5pt;
      line-height: 1.5;
      margin: 0 0 3pt;
    }
    .cv-date-line {
      font-size: 9.5pt;
      color: #555;
      margin-bottom: 2pt;
    }
    .cv-spacer { height: 4pt; }
  </style>
</head>
<body>${cvHtml}</body>
</html>`;
}

function downloadWordDocument(cvHtml, title = 'Tailored CV') {
  const blob = new Blob(['\ufeff', buildWordDocument(cvHtml, title)], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeDownloadName(title);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function splitSkillLine(line) {
  const text = String(line || '')
    .replace(/\)\s*(?=[A-Z][A-Za-z/& ]{2,36}:)/g, ') ')
    .replace(/([a-z)])(?=[A-Z][A-Za-z/& ]{2,36}:)/g, '$1, ')
    .replace(/\s+/g, ' ')
    .trim();

  const labelled = [...text.matchAll(/(?:^|[.;,]\s*)([A-Z][A-Za-z/& ]{2,40}):\s*([\s\S]*?)(?=(?:[.;,]\s*[A-Z][A-Za-z/& ]{2,40}:)|$)/g)];
  if (labelled.length >= 2) {
    return labelled.map(([, label, value]) => cleanSkillItem(`${label.trim()}: ${value.trim()}`)).filter(isUsefulSkillItem);
  }

  return text
    .split(/\s*(?:;|\n|•)\s*/)
    .flatMap(part => part.split(/\s*,\s+(?=[A-Z][A-Za-z/& ]{2,40}:)/))
    .map(cleanSkillItem)
    .filter(isUsefulSkillItem);
}

function cleanSkillItem(item) {
  return String(item || '')
    .replace(/^[-•*●▪◦–—]\s*/, '')
    .replace(/\.\s*Strong experience with version control systems,\s*particularly\s+Git/gi, ', Git')
    .replace(/\b(?:strong|solid|excellent|deep)\s+(?:knowledge|understanding|experience)\s+of\s+/gi, '')
    .replace(/\bproficiency\s+in\s+/gi, '')
    .replace(/\bexpertise\s+in\s+/gi, '')
    .replace(/\bfamiliarity\s+with\s+/gi, '')
    .replace(/\bexperience\s+with\s+/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([),.;:])/g, '$1')
    .replace(/[.,;]\s*$/, '')
    .trim();
}

function isUsefulSkillItem(item) {
  const text = String(item || '').trim();
  if (!text || text.length < 2 || text.length > 140) return false;
  if (/\b\d+\+?\s+years?\s+of\s+experience\b/i.test(text)) return false;
  if (/\bat least\s+\d+\s+years?\b/i.test(text)) return false;
  if (/:\s*\(?\d+\s*(?:year|yr|month)/i.test(text)) return false;
  if (/\b(highly preferred|required|minimum qualifications?|related field)\b/i.test(text)) return false;
  if (/\b(?:bachelor|master|degree|education:|advanced degrees?)\b/i.test(text)) return false;
  return /[A-Za-z]/.test(text);
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
  let inSkillsSection = false;

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
      inSkillsSection = isSkillsSectionHeader(line);
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
      const body = line.replace(/^[\-•*●▪◦–—]\s*/, '');
      const items = inSkillsSection ? splitSkillLine(body) : [body];
      for (const item of items) html += `<li>${linkify(esc(item))}</li>`;
      continue;
    }

    closeList();

    if (inSkillsSection) {
      const items = splitSkillLine(line);
      if (items.length > 0) {
        html += '<ul class="cv-bullets">';
        for (const item of items) html += `<li>${linkify(esc(item))}</li>`;
        html += '</ul>';
        continue;
      }
    }

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
