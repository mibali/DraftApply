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

// ── CV text → structured HTML ──────────────────────────────────────────────

const SECTION_RE = /^(experience|employment|work history|education|academic|qualifications|skills|technologies|competencies|expertise|summary|profile|about|objective|certifications?|licenses?|credentials|achievements?|awards?|projects?|publications?|languages?|interests?|hobbies|references?|contact|links?)s?\s*[:\-]?\s*$/i;

const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|present|current|to date|now)\b/i;

function isSectionHeader(line) {
  if (SECTION_RE.test(line)) return true;
  // ALL CAPS line (not just punctuation/numbers, and long enough to be a heading)
  if (line.length >= 3 && line === line.toUpperCase() && /[A-Z]/.test(line) && !/[@+\d\/]/.test(line)) return true;
  return false;
}

function isContactLine(line) {
  return /[\w.+-]+@[\w-]+\.\w+/.test(line)
    || /https?:\/\//i.test(line)
    || /(?:linkedin|github|twitter|x\.com|portfolio)/i.test(line)
    || /(?:\+\d[\d\s\-.()]{5,}|\b\d{3}[\s\-.]\d{3}[\s\-.]\d{4}\b)/.test(line);
}

// Dates line: short line that is primarily date-range content
function isDateLine(line) {
  return line.length < 60 && DATE_RE.test(line) && (line.match(/\d{4}/g) || []).length >= 1;
}

function linkify(html) {
  // URLs first (already HTML-escaped, so & is &amp; — handle carefully)
  html = html.replace(/https?:\/\/[\w\-.~:/?#%@!$&amp;'()*+,;=]+/gi, url => {
    const raw = url.replace(/&amp;/g, '&');
    return `<a href="${raw}" target="_blank" rel="noopener">${url}</a>`;
  });
  // Emails
  html = html.replace(/([\w.+-]+@[\w-]+\.[\w.]+)/g, e => `<a href="mailto:${e}">${e}</a>`);
  return html;
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  let inHeader = true; // top-of-CV header block (name, headline, contact)

  const closeList = () => {
    if (listOpen) { html += '</ul>'; listOpen = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      closeList();
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
      inHeader = false;
      html += `<h2 class="cv-section-header">${esc(line.replace(/[:\-]\s*$/, ''))}</h2>`;
      continue;
    }

    // ── Still in the top header block (contact/headline area) ──
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
      if (!listOpen) { html += '<ul class="cv-bullets">'; listOpen = true; }
      html += `<li>${linkify(esc(line.replace(/^[\-•*●▪◦–—]\s*/, '')))}</li>`;
      continue;
    }

    closeList();

    // ── Date / meta line (short, contains dates) ──
    if (isDateLine(line) && line.length < 55) {
      html += `<p class="cv-role-meta">${esc(line)}</p>`;
      continue;
    }

    // ── Short bold-ish line after a section header → role/company header ──
    // Heuristic: non-bullet, < 60 chars, follows a section or another role line
    const prevLine = lines[i - 1]?.trim() || '';
    if (line.length < 65 && !isContactLine(line) && (isSectionHeader(prevLine) || isDateLine(prevLine) || prevLine === '')) {
      html += `<p class="cv-role-header">${esc(line)}</p>`;
      continue;
    }

    // ── Default body text ──
    html += `<p class="cv-body">${linkify(esc(line))}</p>`;
  }

  closeList();
  return html;
}
