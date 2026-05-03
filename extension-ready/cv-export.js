(async () => {
  const { tailoredCvExport } = await chrome.storage.local.get('tailoredCvExport');
  const loading = document.getElementById('loading');
  const content = document.getElementById('cv-content');

  if (!tailoredCvExport) {
    loading.textContent = 'No CV found — please generate a tailored CV first.';
    return;
  }

  await chrome.storage.local.remove('tailoredCvExport');

  content.innerHTML = formatCvToHtml(tailoredCvExport);
  loading.hidden = true;
  content.hidden = false;
})();

// ── CV text → Harvard-style HTML ──────────────────────────────────────────────

const SECTION_RE = /^(experience|employment|work\s*history|education|academic|qualifications|skills|technologies|competencies|expertise|summary|profile|about|objective|certifications?|licenses?|credentials|achievements?|awards?|projects?|publications?|languages?|interests?|hobbies|references?|contact|links?)s?\s*[:\-]?\s*$/i;

const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|present|current|to\s*date|now)\b/i;

function isSectionHeader(line) {
  if (SECTION_RE.test(line)) return true;
  // ALL CAPS line that reads as a heading
  if (line.length >= 3 && line === line.toUpperCase() && /[A-Z]/.test(line) && !/[@+\d\/]/.test(line)) return true;
  return false;
}

function isContactLine(line) {
  return /[\w.+-]+@[\w-]+\.\w+/.test(line)
    || /https?:\/\//i.test(line)
    || /(?:linkedin|github|twitter|x\.com|portfolio)/i.test(line)
    || /(?:\+\d[\d\s\-.()]{5,}|\b\d{3}[\s\-.]\d{3}[\s\-.]\d{4}\b)/.test(line);
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

function formatCvToHtml(rawText) {
  // Strip trailing "Links:" section added by PDF/DOCX extractor — links are
  // already inline in the text; we don't want them duplicated at the bottom.
  const mainText = rawText.replace(/\n\nLinks:\n[\s\S]+$/i, '').trim();
  const lines = mainText.split('\n');

  let html = '';
  let nameSet = false;
  let headlineSet = false;
  let listOpen = false;
  let inHeader = true;
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
      html += '<div class="cv-spacer"></div>';
      if (inHeader) inHeader = false;
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
      inHeader = false;
      inEntrySection = /^(experience|employment|work|education|academic|qualifications|projects?)\b/i
        .test(line.replace(/[:\-]\s*$/, '').trim());
      html += `<h2 class="cv-section-header">${esc(line.replace(/[:\-]\s*$/, ''))}</h2>`;
      continue;
    }

    // ── Header block (contact / headline) ──
    if (inHeader) {
      if (isContactLine(line)) {
        html += `<p class="cv-contact">${linkify(esc(line))}</p>`;
      } else if (!headlineSet) {
        html += `<p class="cv-headline">${esc(line)}</p>`;
        headlineSet = true;
      } else {
        html += `<p class="cv-contact">${linkify(esc(line))}</p>`;
      }
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
      if (pendingCompany !== null && isDateLine(line) && line.length < 55) {
        flushPendingCompany(line);
        continue;
      }

      // Line immediately after an entry row → job title (italic)
      if (afterEntryRow && line.length < 70 && !isContactLine(line) && !isDateLine(line)) {
        html += `<p class="cv-job-title">${esc(line)}</p>`;
        afterEntryRow = false;
        continue;
      }
      afterEntryRow = false;

      // Pending company + next short non-date line → flush company (no dates), emit as job title
      if (pendingCompany !== null && line.length < 70 && !isContactLine(line)) {
        flushPendingCompany(null);
        html += `<p class="cv-job-title">${esc(line)}</p>`;
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
    if (isDateLine(line) && line.length < 55) {
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
