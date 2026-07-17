const PLATFORM_RULES = [
  { key: 'linkedin', question: /linkedin/i, url: /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|pub|company)\/[\w\-_%]+\/?/i },
  { key: 'github', question: /github/i, url: /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w\-_%]+\/?/i },
  { key: 'gitlab', question: /gitlab/i, url: /(?:https?:\/\/)?(?:www\.)?gitlab\.com\/[\w\-_%]+\/?/i },
  { key: 'behance', question: /behance/i, url: /(?:https?:\/\/)?(?:www\.)?behance\.net\/[\w\-_%]+\/?/i },
  { key: 'dribbble', question: /dribbble/i, url: /(?:https?:\/\/)?(?:www\.)?dribbble\.com\/[\w\-_%]+\/?/i },
  { key: 'kaggle', question: /kaggle/i, url: /(?:https?:\/\/)?(?:www\.)?kaggle\.com\/[\w\-_%]+\/?/i },
  { key: 'stackoverflow', question: /stack\s*overflow/i, url: /(?:https?:\/\/)?(?:www\.)?stackoverflow\.com\/users\/\d+(?:\/[\w\-_%]+)?\/?/i },
  { key: 'twitter', question: /(?:twitter|\bx\.com\b)/i, url: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[\w_]+\/?/i },
];

const GENERIC_PROFILE_QUESTION = /\b(portfolio|personal\s+(?:website|site)|website|web\s*site|blog|professional\s+(?:profile|url)|developer\s+(?:profile|url)|coding\s+(?:profile|url))\b/i;
const URL = /(?:https?:\/\/|www\.)[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi;
const SOCIAL_HOST = /(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|dribbble\.com|kaggle\.com|stackoverflow\.com|twitter\.com|x\.com)/i;

function normalizeUrl(value) {
  const cleaned = String(value || '').trim().replace(/[.,;:!?)]*$/g, '');
  if (!cleaned) return null;
  return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

export function extractProfileUrl(question = '', cvText = '') {
  const q = String(question || '').trim();
  const cv = String(cvText || '');
  for (const rule of PLATFORM_RULES) {
    if (!rule.question.test(q)) continue;
    const match = cv.match(rule.url);
    return match ? normalizeUrl(match[0]) : null;
  }

  if (!GENERIC_PROFILE_QUESTION.test(q)) return null;
  const labelled = cv.match(/\b(?:portfolio|website|personal\s+(?:website|site)|blog)\s*[:\-]\s*((?:https?:\/\/|www\.)[^\s<>"]+)/i)?.[1];
  if (labelled) return normalizeUrl(labelled);
  const urls = cv.match(URL) || [];
  const personal = urls.find(url => !SOCIAL_HOST.test(url) && !/@/.test(url));
  return personal ? normalizeUrl(personal) : null;
}

export default extractProfileUrl;
