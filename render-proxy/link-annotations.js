// Hyperlink extraction shared by the CV upload endpoint's PDF and DOCX
// branches. Kept in its own module (rather than inline in server.js) because
// it is pure, dependency-free logic worth unit testing directly.

export function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function normaliseAnnotationUrl(url = '') {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return '';
  return clean;
}

export function cleanAnnotationLabel(value = '') {
  return decodeHtmlEntities(String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, 120);
}

export function linkLabelFromUrl(url = '') {
  const raw = String(url || '').trim();
  if (/linkedin\.com/i.test(raw)) return 'LinkedIn';
  if (/github\.com/i.test(raw)) return 'GitHub';
  if (/gitlab\.com/i.test(raw)) return 'GitLab';
  if (/stackoverflow\.com/i.test(raw)) return 'Stack Overflow';
  if (/behance\.net/i.test(raw)) return 'Behance';
  if (/dribbble\.com/i.test(raw)) return 'Dribbble';
  if (/kaggle\.com/i.test(raw)) return 'Kaggle';
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch {
    return raw;
  }
}

export function extractLinkAnnotationsFromHtml(html = '') {
  const annotations = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(String(html || '')))) {
    const url = normaliseAnnotationUrl(decodeHtmlEntities(match[1]));
    const label = cleanAnnotationLabel(match[2]) || linkLabelFromUrl(url);
    if (!url || !label) continue;
    const key = `${label.toLowerCase()}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    annotations.push({ text: label, url });
  }
  return annotations.slice(0, 100);
}

// A PDF link annotation stores a clickable rectangle and a target URL - it
// never carries the underlying display text. pdf.js's page.getAnnotations()
// (called with no viewport argument, as here) returns `rect` as
// [x0, y0, x1, y1] in the same unscaled PDF user-space coordinates as each
// text item's `transform` (a 6-value matrix whose [4],[5] are the item's x,y
// position) - both are read directly off the page's content stream. Text
// items whose position falls inside the annotation's rectangle are the
// words that were visually hyperlinked, so joining them (in left-to-right
// order, matching normal reading order) recovers the real anchor text -
// "How Support Engineers Use Deep Search..." - instead of a domain guess.
export function extractAnnotationLabel(rect, textItems, { tolerance = 3 } = {}) {
  if (!Array.isArray(rect) || rect.length < 4 || !Array.isArray(textItems)) return '';
  const [x0, y0, x1, y1] = rect;
  const matches = textItems.filter(item => {
    const transform = item?.transform;
    if (!Array.isArray(transform) || transform.length < 6) return false;
    const x = transform[4];
    const y = transform[5];
    return x >= x0 - tolerance && x <= x1 + tolerance && y >= y0 - tolerance && y <= y1 + tolerance;
  });
  if (matches.length === 0) return '';
  matches.sort((a, b) => a.transform[4] - b.transform[4]);
  const label = matches.map(item => String(item.str || '')).join('').replace(/\s+/g, ' ').trim();
  return label.length <= 140 ? label : '';
}
