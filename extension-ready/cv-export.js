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

  const stored = await chrome.storage.local.get(['tailoredCvExport', 'tailoredCvContactUrls', 'tailoredCvLinkAnnotations', 'tailoredCvStructured']);
  const tailoredCvExport = stored.tailoredCvExport;
  const originalContactUrls = stored.tailoredCvContactUrls || {};
  const linkAnnotations = Array.isArray(stored.tailoredCvLinkAnnotations) ? stored.tailoredCvLinkAnnotations : [];
  const structuredCv = stored.tailoredCvStructured || null;
  const loading = document.getElementById('loading');
  const content = document.getElementById('cv-content');

  if (!tailoredCvExport) {
    loading.textContent = 'No CV found — please generate a tailored CV first.';
    return;
  }

  await chrome.storage.local.remove(['tailoredCvExport', 'tailoredCvContactUrls', 'tailoredCvLinkAnnotations', 'tailoredCvStructured']);

  // Set page title (and therefore PDF filename) to "Full Name CV"
  const candidateName = structuredCv?.skeleton?.name
    || tailoredCvExport.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (candidateName) document.title = `${candidateName} CV`;

  // Structured payload renders directly from data - no text re-parsing, so
  // none of the text-parsing failure modes apply. Any defect in the payload
  // falls back to the legacy text renderer.
  let html = '';
  if (structuredCv) {
    try {
      html = formatStructuredCvToHtml(structuredCv, linkAnnotations);
    } catch (e) {
      console.warn('Structured render failed; falling back to text parsing:', e);
      html = '';
    }
  }
  content.innerHTML = html || formatCvToHtml(tailoredCvExport, originalContactUrls, linkAnnotations);
  loading.hidden = true;
  content.hidden = false;
})();

// ── Structured CV → HTML (no text parsing) ───────────────────────────────────
// Renders directly from the locked skeleton + validated content produced by
// the server (docs/structured-cv-generation.md). Reuses the same CSS classes
// as the text renderer so print/Word output is identical.

function formatStructuredCvToHtml(structuredCv, linkAnnotations = []) {
  const skeleton = structuredCv?.skeleton;
  const body = structuredCv?.content;
  if (!skeleton || !body || !Array.isArray(skeleton.roles)) return '';

  let html = '';
  if (skeleton.name) html += `<h1 class="cv-name">${esc(skeleton.name)}</h1>`;
  if (skeleton.headline) html += `<p class="cv-headline">${esc(skeleton.headline)}</p>`;
  for (const contact of (skeleton.contacts || [])) {
    html += `<p class="cv-contact">${renderInline(String(contact), linkAnnotations)}</p>`;
  }
  html += '<hr class="cv-header-rule">';

  if (body.summary) {
    html += '<h2 class="cv-section-header">Professional Summary</h2>';
    html += `<p class="cv-body">${renderInline(body.summary, linkAnnotations)}</p>`;
  }

  if (Array.isArray(body.competencies) && body.competencies.length > 0) {
    html += '<h2 class="cv-section-header">Core Competencies</h2>';
    for (const cat of body.competencies) {
      if (!cat?.label || !Array.isArray(cat.items) || cat.items.length === 0) continue;
      html += `<p class="cv-skill-row"><strong>${esc(String(cat.label))}:</strong> ${renderInline(cat.items.join(', '), linkAnnotations)}</p>`;
    }
  }

  if (skeleton.roles.length > 0) {
    html += '<h2 class="cv-section-header">Professional Experience</h2>';
    const contentById = new Map((body.roles || []).map(r => [r?.id, r]));
    for (const role of skeleton.roles) {
      const mutable = contentById.get(role.id);
      html += '<div class="cv-entry"><div class="cv-entry-row">';
      html += `<span class="cv-company">${esc(String(role.company || ''))}</span>`;
      if (role.dates) html += `<span class="cv-entry-dates">${esc(String(role.dates))}</span>`;
      html += '</div>';
      if (role.title) html += `<p class="cv-job-title">${esc(String(role.title))}</p>`;
      if (mutable?.focus) html += `<p class="cv-role-focus">Focus: ${esc(String(mutable.focus))}</p>`;
      const bullets = Array.isArray(mutable?.bullets) ? mutable.bullets : [];
      if (bullets.length > 0) {
        html += '<ul class="cv-bullets">';
        for (const bullet of bullets) html += `<li>${renderInline(String(bullet), linkAnnotations)}</li>`;
        html += '</ul>';
      }
      html += '</div>';
    }
  }

  if (Array.isArray(skeleton.projects) && skeleton.projects.length > 0) {
    html += '<h2 class="cv-section-header">Projects</h2>';
    for (const project of skeleton.projects) {
      html += '<div class="cv-entry">';
      if (project.name) html += `<p class="cv-job-title">${esc(String(project.name))}</p>`;
      if (project.url) html += `<p class="cv-body">${renderInline(String(project.url), linkAnnotations)}</p>`;
      const bullets = Array.isArray(project.originalBullets) ? project.originalBullets : project.bullets;
      if (Array.isArray(bullets) && bullets.length) {
        html += '<ul class="cv-bullets">';
        for (const bullet of bullets) html += `<li>${renderInline(String(bullet), linkAnnotations)}</li>`;
        html += '</ul>';
      }
      if (Array.isArray(project.skills) && project.skills.length) html += `<p class="cv-skill-row"><strong>Technologies:</strong> ${project.skills.map(value => esc(String(value))).join(', ')}</p>`;
      html += '</div>';
    }
  }

  if (Array.isArray(skeleton.educationLines) && skeleton.educationLines.length > 0) {
    html += '<h2 class="cv-section-header">Education, Certifications &amp; Recognition</h2>';
    html += '<ul class="cv-bullets">';
    for (const line of skeleton.educationLines) {
      html += `<li>${renderInline(String(line), linkAnnotations)}</li>`;
    }
    html += '</ul>';
  }

  return html;
}

// ── CV text → Harvard-style HTML ──────────────────────────────────────────────

const SECTION_RE = /^(professional\s+summary|core\s+competenc(?:y|ies)|professional\s+experience|technical\s+skills?|certifications?\s*(?:&|and)\s*awards?|technical\s+leadership(?:,\s*achievements?\s*(?:&|and)\s*innovation)?|experience|employment|work\s*history|education|academic|qualifications|skills|technologies|competencies|expertise|summary|profile|about|objective|certifications?|licenses?|credentials|achievements?|awards?|projects?|publications?|languages?|interests?|hobbies|references?|contact|links?)s?\s*[:\-]?\s*$/i;

const DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}|present|current|to\s*date|now)\b/i;

// Strip LLM-inserted label prefixes from job title lines, e.g. "Position: Senior Engineer"
function stripJobTitleLabel(line) {
  return line.replace(/^(position|title|role|job\s*title)\s*:\s*/i, '').trim();
}

function isSectionHeader(line) {
  if (/^[\-•*●▪◦–—]\s/.test(line)) return false; // bullet lines are never section headers
  if (SECTION_RE.test(line)) return true;
  // ALL CAPS line that reads as a heading. "/" is allowed ("EDUCATION /
  // CERTIFICATIONS"); digits, @ and + still disqualify (dates/contacts).
  if (line.length >= 3 && line === line.toUpperCase() && /[A-Z]/.test(line) && !/[@+\d]/.test(line)) return true;
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

function isSplitDateRangeStart(line) {
  return isDateLine(line) && /(?:-|–|—|\bto\b)\s*$/i.test(String(line || '').trim());
}

function moveFocusLinesAboveBulletRuns(lines) {
  const output = [...lines];
  const BULLET_RE = /^[-•*●▪◦–—]\s/;

  for (let i = 0; i < output.length; i++) {
    if (!/^focus\s*:/i.test(String(output[i] || '').trim())) continue;

    let cursor = i - 1;
    while (cursor >= 0 && !String(output[cursor] || '').trim()) cursor--;

    // A Focus line is only ever meaningful directly under a role title. If
    // it isn't above a bullet run and the nearest preceding content is a
    // section header instead, it has drifted into an unrelated section
    // (e.g. stranded under "EDUCATION, CERTIFICATIONS & RECOGNITION"). There
    // is no reliable way to know which role it belonged to, so drop it
    // rather than render positioning text under the wrong heading.
    if (cursor >= 0 && isSectionHeader(String(output[cursor] || '').trim())) {
      output.splice(i, 1);
      i--;
      continue;
    }

    if (cursor < 0 || !BULLET_RE.test(String(output[cursor] || '').trim())) continue;

    let runStart = cursor;
    while (runStart > 0 && BULLET_RE.test(String(output[runStart - 1] || '').trim())) {
      runStart--;
    }

    const [focusLine] = output.splice(i, 1);
    output.splice(runStart, 0, focusLine);
  }

  return output;
}

function repairDanglingBulletEndings(lines) {
  return lines.map(line => {
    const match = String(line || '').match(/^(\s*[-•*●▪◦–—]\s+)(.+)$/);
    if (!match) return line;

    const [, prefix, body] = match;
    // Trim repeatedly until stable: a token-limit truncation can cut a bullet
    // mid-word ("...across production-"), and stripping the hyphenated
    // fragment then exposes a dangling conjunction needing a second pass.
    let repaired = body;
    let previous;
    do {
      previous = repaired;
      repaired = repaired
        .replace(/\s+\S*[a-z]-$/, '')
        .replace(/\s+\b(?:and|or|with|including|across|for|to|by)\s*$/i, '')
        .replace(/[,\s]+$/, '');
    } while (repaired !== previous);

    if (repaired === body) return line;
    return `${prefix}${repaired}.`;
  });
}

function repairHardWrappedExportLines(lines) {
  const output = [];
  const BULLET_RE = /^[-•*●▪◦–—]\s/;
  const LABEL_RE = /^[A-Za-z][A-Za-z0-9 &/+.\-]{0,48}:\s/;

  const isContinuation = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return false;
    if (BULLET_RE.test(trimmed)) return false;
    if (LABEL_RE.test(trimmed)) return false;
    if (isSectionHeader(trimmed)) return false;
    if (isDateLine(trimmed)) return false;
    if (isContactLine(trimmed) || isLocationLine(trimmed)) return false;
    return /^[a-z]/.test(trimmed);
  };

  for (const line of lines) {
    const prev = output.length ? output[output.length - 1] : '';
    const prevTrimmed = String(prev || '').trimEnd();

    if (prevTrimmed.length >= 8 && /[a-z]-$/.test(prevTrimmed) && isContinuation(line)) {
      output[output.length - 1] = `${prevTrimmed}${String(line).trim()}`;
      continue;
    }
    if (prevTrimmed.length >= 36 && /[a-z,]$/i.test(prevTrimmed) && !/[.!?:;]$/.test(prevTrimmed) && isContinuation(line)) {
      output[output.length - 1] = `${prevTrimmed} ${String(line).trim()}`;
      continue;
    }
    output.push(line);
  }

  return output;
}

function normaliseExportLines(text) {
  const source = repairHardWrappedExportLines(String(text || '').split('\n'));
  const output = [];

  for (let i = 0; i < source.length; i++) {
    const current = source[i];
    const line = current.trim();
    let nextIdx = i + 1;
    while (nextIdx < source.length && !String(source[nextIdx] || '').trim()) nextIdx++;
    const nextLine = source[nextIdx]?.trim() || '';

    // Column extraction can flatten a two-column date range into one textual
    // line such as "Feb 2024 - | Jun 2025" or "Feb 2024 -    Jun 2025".
    // Without this guard the entry formatter reads the left side as a company
    // and the right side as the date, producing exactly the bad exported row
    // "Feb 2024 -" on the left and "Jun 2025" on the right.
    const sameLineSplit = line.match(/^(.+?)\s*(?:\||\t+|\s{2,})(.+)$/);
    if (
      sameLineSplit &&
      isSplitDateRangeStart(sameLineSplit[1].trim()) &&
      isDateLine(sameLineSplit[2].trim())
    ) {
      output.push(`${sameLineSplit[1].trim()} ${sameLineSplit[2].trim()}`);
      continue;
    }

    // LLMs sometimes split ranges as:
    // "February 2024 -"
    // "June 2025"
    // Keep the export parser from rendering the end date far away as a
    // standalone right-aligned date.
    if (
      line &&
      nextLine &&
      isSplitDateRangeStart(line) &&
      isDateLine(nextLine)
    ) {
      output.push(`${line} ${nextLine}`);
      i = nextIdx;
      continue;
    }

    output.push(current);
  }

  return repairDanglingBulletEndings(moveFocusLinesAboveBulletRuns(output));
}

function linkify(html) {
  // Full https?:// URLs
  html = html.replace(/https?:\/\/[\w\-.~:/?#%@!$&amp;'()*+,;=]+/gi, url => {
    const raw = url.replace(/&amp;/g, '&');
    return `<a href="${raw}" target="_blank" rel="noopener">${url}</a>`;
  });
  // Email addresses
  html = html.replace(/([\w.+-]+@[\w-]+\.[\w.]+)/g, e => `<a href="mailto:${e}">${e}</a>`);
  // Bare domains that lack the scheme, e.g. "michaelbali.dev", "portfolio.site/work",
  // "linkedin.com/in/...", or "github.com/...". Avoid matching inside href/src/mailto
  // attributes or inside email addresses that were already linkified above.
  html = html.replace(
    /(?<![@/"'=.:>-])\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|dev|app|co|ai|me|info|tech|cloud|site|online|uk|us|ca|de|fr|ie|nl|be|au|in|edu|gov)(?:\/[a-z0-9\-._~:/?#[\]@!$&amp;'()*+,;=%]*)?)([).,;:!?]?)/gi,
    (match, url, trailing = '') => {
      let displayUrl = url;
      let suffix = trailing || '';
      const punctuation = displayUrl.match(/[).,;:!?]+$/)?.[0] || '';
      if (punctuation) {
        displayUrl = displayUrl.slice(0, -punctuation.length);
        suffix = punctuation + suffix;
      }
      const raw = displayUrl.replace(/&amp;/g, '&');
      if (/^(?:mailto|http|https):/i.test(raw)) return match;
      return `<a href="https://${raw}" target="_blank" rel="noopener">${displayUrl}</a>${suffix}`;
    }
  );
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
  // Match label-only lines like "LinkedIn", "LinkedIn Profile", "LinkedIn Profile URL",
  // "GitHub", "GitHub Profile", "Portfolio", "Website", etc.
  // Lines that already contain a raw URL are handled by linkify() instead.
  if (/https?:\/\//i.test(line)) return null;
  if (/^linkedin(\s+(profile|url|link|profile\s+url|profile\s+link))?$/i.test(line) && socialUrls.linkedin)
    return { label: 'LinkedIn', url: socialUrls.linkedin };
  if (/^github(\s+(profile|url|link|profile\s+url))?$/i.test(line) && socialUrls.github)
    return { label: 'GitHub', url: socialUrls.github };
  if (/^twitter(\s+(profile|url|handle))?$|^x(\s+profile)?$/i.test(line) && socialUrls.twitter)
    return { label: line, url: socialUrls.twitter };
  if (/^(website|portfolio|personal\s+website|personal\s+site|portfolio\s+website)(\s+url)?$/i.test(line) && (socialUrls.portfolio || socialUrls.website))
    return { label: line, url: socialUrls.portfolio || socialUrls.website };
  return null;
}

function contactLink(label, url) {
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
}

function renderInline(text, linkAnnotations = []) {
  return applyLinkAnnotationsToHtml(linkify(esc(String(text || ''))), linkAnnotations);
}

function applyLinkAnnotationsToHtml(html, linkAnnotations = []) {
  const annotations = normaliseLinkAnnotations(linkAnnotations);
  if (annotations.length === 0) return html;

  return String(html || '').split(/(<a\b[\s\S]*?<\/a>|<[^>]+>)/gi).map(part => {
    if (!part || /^</.test(part)) return part;
    let segment = part;
    for (const ann of annotations) {
      const re = new RegExp(`(^|[^\\w])(${escapeRegExp(ann.text)})(?=$|[^\\w])`, 'gi');
      segment = segment.replace(re, (match, prefix, label) => {
        return `${prefix}<a href="${esc(ann.url)}" target="_blank" rel="noopener">${label}</a>`;
      });
    }
    return segment;
  }).join('');
}

// Generic call-to-action anchor text ("here", "click here", "this project")
// carries no content of its own to distinguish it from the same words used
// elsewhere in the CV. applyLinkAnnotationsToHtml re-links every occurrence
// of a label within a text segment, so a label this generic risks
// hyperlinking unrelated prose that happens to contain the same common
// word/phrase, not just the one link the original document intended.
const GENERIC_LINK_LABELS = new Set([
  'here', 'this', 'this project', 'this link', 'this repo', 'this repository',
  'click', 'click here', 'link', 'view', 'view here', 'see', 'see here',
  'read more', 'learn more', 'more', 'more info',
]);

function normaliseLinkAnnotations(linkAnnotations = []) {
  const seen = new Set();
  return (Array.isArray(linkAnnotations) ? linkAnnotations : [])
    .map(item => ({
      text: String(item?.text || item?.label || '').replace(/\s+/g, ' ').trim(),
      url: String(item?.url || item?.href || '').trim(),
    }))
    .filter(item => item.text.length >= 2 && item.text.length <= 120 && /^https?:\/\//i.test(item.url))
    .filter(item => !/^https?:\/\//i.test(item.text))
    .filter(item => !GENERIC_LINK_LABELS.has(item.text.toLowerCase()))
    .sort((a, b) => b.text.length - a.text.length)
    .filter(item => {
      const key = `${item.text.toLowerCase()}|${normalizeUrl(item.url)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      font-size: 10pt;
      line-height: 1.35;
      color: #111;
    }
    .cv-name {
      font-size: 16pt;
      font-weight: 700;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 3px;
    }
    .cv-headline {
      font-size: 10pt;
      font-style: italic;
      text-align: center;
      color: #444;
      margin-bottom: 3px;
    }
    .cv-contact {
      font-size: 8.8pt;
      text-align: center;
      color: #555;
      line-height: 1.35;
      margin: 0;
    }
    .cv-contact a, .cv-body a, .cv-bullets li a, .cv-skill-row a {
      color: #111;
      text-decoration: underline;
    }
    .cv-header-rule {
      border: none;
      border-top: 1.5pt solid #0a0a0a;
      margin: 7pt 0 0;
    }
    .cv-section-header {
      font-size: 9.2pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      border-bottom: 1.5pt solid #0a0a0a;
      padding-bottom: 2pt;
      margin-top: 11pt;
      margin-bottom: 5pt;
    }
    .cv-entry-row {
      margin-top: 7pt;
      width: 100%;
      clear: both;
    }
    .cv-company {
      font-size: 10.4pt;
      font-weight: 800;
    }
    .cv-entry-dates {
      font-size: 8.8pt;
      color: #444;
      float: right;
      margin-left: 12pt;
    }
    .cv-job-title {
      font-size: 9.6pt;
      font-style: italic;
      font-weight: 600;
      color: #333;
      margin: 0 0 3pt;
    }
    .cv-role-focus {
      font-size: 9pt;
      font-style: italic;
      color: #4b5563;
      margin: 0 0 5pt;
    }
    .cv-bullets {
      padding-left: 15pt;
      margin: 2pt 0 3pt;
    }
    .cv-bullets li {
      font-size: 9.4pt;
      line-height: 1.3;
      margin-bottom: 1pt;
    }
    .cv-skill-row {
      font-size: 9.4pt;
      line-height: 1.3;
      margin: 0 0 2pt;
    }
    .cv-skill-row strong {
      font-weight: 700;
    }
    .cv-body {
      font-size: 9.7pt;
      line-height: 1.35;
      margin: 0 0 2pt;
    }
    .cv-date-line {
      font-size: 8.8pt;
      color: #555;
      margin-bottom: 2pt;
    }
    .cv-spacer { height: 3pt; }
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
    return labelled
      .flatMap(([, label, value]) => splitLongSkillItem(cleanSkillItem(`${label.trim()}: ${value.trim()}`)))
      .filter(isUsefulSkillItem);
  }

  return text
    .split(/\s*(?:;|\n|•)\s*/)
    .flatMap(part => part.split(/\s*,\s+(?=[A-Z][A-Za-z/& ]{2,40}:)/))
    .map(cleanSkillItem)
    .flatMap(splitLongSkillItem)
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
  if (!text || text.length < 2 || text.length > 160) return false;
  if (/\b\d+\+?\s+years?\s+of\s+experience\b/i.test(text)) return false;
  if (/\bat least\s+\d+\s+years?\b/i.test(text)) return false;
  if (/:\s*\(?\d+\s*(?:year|yr|month)/i.test(text)) return false;
  if (/\b(highly preferred|required|minimum qualifications?|related field)\b/i.test(text)) return false;
  if (/\b(?:bachelor|master|degree|education:|advanced degrees?)\b/i.test(text)) return false;
  return /[A-Za-z]/.test(text);
}

function renderSkillItem(item, linkAnnotations = []) {
  const text = String(item || '').trim();
  const match = text.match(/^([A-Z][A-Za-z/&+ .-]{2,46}):\s+(.+)$/);
  if (match) {
    return `<p class="cv-skill-row"><strong>${esc(match[1].trim())}:</strong> ${renderInline(match[2].trim(), linkAnnotations)}</p>`;
  }
  return `<p class="cv-skill-row">${renderInline(text, linkAnnotations)}</p>`;
}

function splitLongSkillItem(item) {
  const text = String(item || '').trim();
  if (text.length <= 160) return [text];

  const match = text.match(/^([A-Z][A-Za-z/& ]{2,40}):\s+(.+)$/);
  if (!match) return [text];

  const [, label, rest] = match;
  const skills = rest.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const skill of skills) {
    const next = current ? `${current}, ${skill}` : skill;
    if (`${label}: ${next}`.length <= 160) {
      current = next;
      continue;
    }
    if (current) chunks.push(`${label}: ${current}`);
    current = skill;
  }
  if (current) chunks.push(`${label}: ${current}`);

  return chunks.length ? chunks : [text];
}

function formatCvToHtml(rawText, fallbackContactUrls = {}, linkAnnotations = []) {
  // Strip trailing "Links:" section added by PDF/DOCX extractor — links are
  // already inline in the text; we don't want them duplicated at the bottom.
  // Merge: tailored-text URLs take priority; original CV URLs fill any gaps.
  const tailoredUrls = extractSocialUrls(rawText);
  const socialUrls = {};
  for (const key of ['linkedin', 'github', 'portfolio', 'website', 'twitter']) {
    socialUrls[key] = tailoredUrls[key] || fallbackContactUrls[key] || '';
  }
  const knownSocialUrls = new Set(Object.values(socialUrls).filter(Boolean).map(normalizeUrl));
  const emailDomains = extractEmailDomains(rawText);
  const mainText = rawText.replace(/\n\nLinks:\n[\s\S]+$/i, '').trim();
  const lines = normaliseExportLines(mainText);

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
  let openEntry = false;
  // Prevent duplicate Focus: lines — LLMs sometimes emit one per sub-section
  let focusEmitted = false;

  const closeList = () => {
    if (listOpen) { html += '</ul>'; listOpen = false; }
  };

  const closeEntry = () => {
    if (openEntry) { html += '</div>'; openEntry = false; }
  };

  const emitEntryRow = (company, dates) => {
    closeList();
    closeEntry();
    html += '<div class="cv-entry">';
    openEntry = true;
    focusEmitted = false;
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
      afterEntryRow = false;
      if (inHeader) {
        inHeader = false;
        html += '<hr class="cv-header-rule">';
      }
      // Keep any pending company buffered across blank lines — LLM output
      // often reads "Company", blank, "dates", "title"; flushing here would
      // emit the company row before its dates arrive, and the orphaned date
      // line downstream then gets misparsed as a company of its own.
      if (pendingCompany === null) html += '<div class="cv-spacer"></div>';
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
      closeEntry();
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
        html += `<p class="cv-contact">${renderInline(line, linkAnnotations)}</p>`;
      } else if (!headlineSet) {
        html += `<p class="cv-headline">${esc(line)}</p>`;
        headlineSet = true;
      } else {
        html += `<p class="cv-contact">${renderInline(line, linkAnnotations)}</p>`;
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
      const body = line.replace(/^[\-•*●▪◦–—]\s*/, '');
      const items = inSkillsSection ? splitSkillLine(body) : [body];
      if (inSkillsSection) {
        closeList();
        for (const item of items) html += renderSkillItem(item, linkAnnotations);
      } else {
        if (!listOpen) { html += '<ul class="cv-bullets">'; listOpen = true; }
        for (const item of items) html += `<li>${renderInline(item, linkAnnotations)}</li>`;
      }
      continue;
    }

    closeList();

    if (inSkillsSection) {
      const items = splitSkillLine(line);
      if (items.length > 0) {
        for (const item of items) html += renderSkillItem(item, linkAnnotations);
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

      // Pending company + this is a date line → complete entry row.
      // Keep this before the inline company/date parser so a standalone date
      // range such as "February 2024 - June 2025" is not mistaken for a
      // company called "February 2024 -".
      if (pendingCompany !== null && isDateLine(line)) {
        flushPendingCompany(line);
        continue;
      }

      // "Company Name Month Year – Month Year" on one line without pipe (OpenRouter format).
      // The "company" part must not itself be a date fragment: a rejoined
      // split range like "Feb 2024 - Jun 2025" also matches this shape, and
      // without the guard it renders as a fake entry with company "Feb 2024 -".
      const inlineDateMatch = line.match(
        /^(.{3,60}?)\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}.{0,40})$/i
      );
      if (inlineDateMatch && !isSectionHeader(inlineDateMatch[1].trim()) && !isDateLine(inlineDateMatch[1].trim())) {
        flushPendingCompany(null);
        emitEntryRow(inlineDateMatch[1].trim(), inlineDateMatch[2].trim());
        continue;
      }

      // Line immediately after an entry row → job title (italic)
      if (afterEntryRow && line.length < 120 && !isContactLine(line) && !isDateLine(line)) {
        const title = stripJobTitleLabel(line);
        if (title) html += `<p class="cv-job-title">${esc(title)}</p>`;
        afterEntryRow = false;
        continue;
      }
      afterEntryRow = false;

      if (/^focus\s*:/i.test(line)) {
        if (focusEmitted) continue; // skip duplicate Focus: lines for the same entry
        focusEmitted = true;
        html += `<p class="cv-role-focus">${esc(line)}</p>`;
        continue;
      }

      // Pending company + next short non-date line → flush company (no dates), emit as job title
      if (pendingCompany !== null && line.length < 120 && !isContactLine(line) && !isDateLine(line)) {
        flushPendingCompany(null);
        afterEntryRow = false;
        const title = stripJobTitleLabel(line);
        if (title) html += `<p class="cv-job-title">${esc(title)}</p>`;
        continue;
      }

      // Short line that could be a company / institution name — buffer it, but only when
      // at the start of a new entry (preceded by blank, section header, or date line).
      // LLM output also frequently omits the blank line between one role's last
      // bullet and the next role's company line; in that case a short line
      // straight after a bullet is still a new entry header when the next
      // content line is a date range.
      if (pendingCompany === null && line.length < 70 && !isContactLine(line) && !isDateLine(line)) {
        const prevLine = lines[i - 1]?.trim() || '';
        let lookahead = i + 1;
        while (lookahead < lines.length && !String(lines[lookahead] || '').trim()) lookahead++;
        const nextIsDate = lookahead < lines.length && isDateLine(String(lines[lookahead]).trim());
        if (
          prevLine === '' || isSectionHeader(prevLine) || isDateLine(prevLine) ||
          (/^[-•*●▪◦–—]\s/.test(prevLine) && nextIsDate)
        ) {
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
    html += `<p class="cv-body">${renderInline(line, linkAnnotations)}</p>`;
  }

  closeList();
  flushPendingCompany(null);
  closeEntry();
  return html;
}
