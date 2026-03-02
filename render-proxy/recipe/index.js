/**
 * DraftApply Recipe Module (open-source default).
 *
 * Builds LLM prompts from structured input. This is the default recipe
 * used by the proxy; override with RECIPE_PATH to use a custom module.
 *
 * Contract:
 *   buildPrompts(input)  → { systemPrompt: string, userPrompt: string, temperature?: number }
 *
 * `input` is a structured payload sent by the extension:
 *   {
 *     question:        string,
 *     length:          'short' | 'medium' | 'long',
 *     cvText:          string,
 *     jobTitle:        string?,
 *     company:         string?,
 *     jobDescription:  string?,
 *     requirements:    string[]?,
 *     pageUrl:         string?,
 *     platform:        string?,
 *   }
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanFieldLabel(raw) {
  return (raw || '')
    .trim()
    .replace(/[*:?\u2217\u2731]+$/g, '')
    .replace(/^(please\s+(enter|provide|input|type|specify)\s+(your\s+)?)/i, '')
    .replace(/^(enter\s+(your\s+)?)/i, '')
    .replace(/^(your\s+)/i, '')
    .trim();
}

/**
 * Include head + tail of CV to avoid recency bias when truncating.
 */
function getCvContext(rawText, maxChars) {
  const raw = rawText || '';
  const max = Math.max(500, Number(maxChars) || 0);
  if (raw.length <= max) return raw;

  const headLen = Math.floor(max * 0.6);
  const tailLen = max - headLen;
  return `${raw.slice(0, headLen)}\n\n...[snip]...\n\n${raw.slice(-tailLen)}`;
}

function buildJobContext(jobTitle, company, jobDescription, requirements) {
  let ctx = '';
  if (!jobDescription && !(requirements && requirements.length > 0)) return ctx;

  if (jobTitle || company) {
    ctx += `Position: ${jobTitle || 'Not specified'}`;
    if (company) ctx += ` at ${company}`;
    ctx += '\n\n';
  }
  if (requirements && requirements.length > 0) {
    ctx += `Key Requirements:\n${requirements.slice(0, 10).map(r => `- ${r}`).join('\n')}\n\n`;
  }
  if (jobDescription) {
    ctx += `Job Description:\n${jobDescription.slice(0, 8000)}`;
    if (jobDescription.length > 8000) ctx += '\n[...truncated...]';
    ctx += '\n\n';
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Question type detection
// ---------------------------------------------------------------------------

function detectQuestionType(question) {
  const q = (question || '').toLowerCase();

  // Cover letter (must check first — it's a format, not a topic)
  if (
    q.includes('cover letter') || q.includes('coverletter') ||
    q.includes('motivation letter') || q.includes('letter of interest') ||
    q.includes('application letter')
  ) return 'cover_letter';

  // Why company / why this role (specific motivation questions)
  if (
    q.includes('why do you want') || q.includes('why would you like') ||
    q.includes('why are you applying') || q.includes('what draws you') ||
    q.includes('why this company') || q.includes("company's mission") ||
    q.includes('why our company') || q.includes('why do you want to join') ||
    q.includes('what attracted you') || q.includes('why are you interested in')
  ) return 'why_company';

  // Short factual fields — conversational forms (notice period, start date, etc.)
  if (
    /notice\s*period/.test(q) ||
    /\bstart\s+date\b/.test(q) ||
    /when\s+(can|could|are)\s+you\s+(start|available|join)/.test(q) ||
    /\bavailability\b/.test(q) ||
    /salary\s*(expectation|requirement|expect)/.test(q) ||
    /expected\s+salary/.test(q) ||
    /current\s+salary/.test(q) ||
    /right\s+to\s+work/.test(q) ||
    /work\s*authori[sz]ation/.test(q) ||
    /\bvisa\s+(status|type|sponsorship)\b/.test(q)
  ) return 'short_factual';

  // Yes / No style questions
  if (
    /^(are|do|have|can|will|would|is|did)\s+you\b/i.test(question.trim()) ||
    /\bdo you (currently |have |hold |possess |own )/i.test(q) ||
    /\bare you (willing|able|comfortable|open|available|authorized|eligible|happy|prepared|fluent|proficient)\b/i.test(q) ||
    /\bhave you (ever|previously|worked|used|managed|led|built)\b/i.test(q)
  ) return 'yes_no';

  // Explicitly brief questions
  if (
    /\b(briefly|in\s+a?\s*few\s+words?|in\s+one\s+(sentence|paragraph)|summarize|give\s+a\s+(short|brief|quick)\s+(description|overview|summary))\b/i.test(q)
  ) return 'brief';

  // Behavioral — STAR method
  if (
    /tell\s+(me\s+)?about\s+a\s+time/i.test(q) ||
    /describe\s+a\s+(time|situation|scenario|challenge|moment|instance)/i.test(q) ||
    /give\s+(me\s+)?(an?\s+)?example\s+(of|where|when)/i.test(q) ||
    /how\s+did\s+you\s+(handle|deal|manage|overcome|approach|resolve)/i.test(q) ||
    /walk\s+(me\s+)?through\s+(a\s+time|how\s+you)/i.test(q) ||
    /share\s+(a|an)\s+(example|experience|time|situation)/i.test(q)
  ) return 'behavioral';

  // Strengths / weaknesses
  if (
    /\b(greatest?|biggest?|main|key|top)\s+(strength|weakness|achievement|accomplishment)\b/i.test(q) ||
    /areas?\s+(for|of|to)\s+improve(ment)?/i.test(q) ||
    /what\s+would\s+you\s+improve\s+about\s+yourself/i.test(q) ||
    /\bweakness(es)?\b/i.test(q)
  ) return 'strength_weakness';

  // Motivation / interest in the role (broader than why_company)
  if (
    /what\s+(interests?|motivates?|excites?|appeals?)\s+(you|to\s+you)/i.test(q) ||
    /what\s+about\s+(this\s+)?(role|position|job|opportunity)/i.test(q) ||
    /why\s+(apply|applying)\b/i.test(q) ||
    /career\s+(goal|aspiration|objective)/i.test(q) ||
    /where\s+do\s+you\s+see\s+yourself/i.test(q)
  ) return 'motivation';

  return 'general';
}

// ---------------------------------------------------------------------------
// Plain-field data extraction (name, email, LinkedIn URL, etc.)
// ---------------------------------------------------------------------------

function isDataExtractionQuestion(question) {
  const q = cleanFieldLabel(question);
  const dataPatterns = [
    /^(full\s*)?name$/i,
    /^(first|last|middle|legal|preferred)\s*name$/i,
    /^name\s*(first|last|middle|legal)?$/i,
    /^linkedin/i,
    /^(email|e-mail)/i,
    /^phone/i,
    /^(mobile|cell)/i,
    /^address/i,
    /^(city|state|zip|postal|country)/i,
    /^location$/i,
    /^website/i,
    /^(personal\s*)?(website|site)\s*(url|link)?$/i,
    /^(personal\s*)?portfolio/i,
    /^portfolio\s*(url|link)?$/i,
    /^github/i,
    /^twitter/i,
    /^(x|x\.com)/i,
    /^(url|link|profile\s*(url|link))$/i,
    /^social\s*(media\s*)?(url|link|profile)/i,
    /^blog\s*(url|link)?$/i,
    /^behance/i,
    /^dribbble/i,
    /^kaggle/i,
    /^stack\s*overflow/i,
    /^(current\s*)?(job\s*)?title$/i,
    /^(current\s*)?company$/i,
    /^(current\s*)?employer$/i,
    /^(your\s*)?(date\s*of\s*)?birth/i,
    /^nationality$/i,
    /^visa\s*status$/i,
    /^work\s*authori[sz]ation$/i,
    /^salary/i,
    /^notice\s*period$/i,
    /^availability$/i,
    /^start\s*date$/i,
  ];
  return dataPatterns.some(p => p.test(q));
}

function buildExtractionPrompt(cvText, question) {
  const cleanQ = cleanFieldLabel(question);
  const systemPrompt = `You are a data extraction assistant. Extract ONLY the requested information from the CV.

RULES:
- Return ONLY the exact value requested, nothing else
- No sentences, no explanations, no formatting
- If the information is not found, respond with: "Not found in CV"
- For URLs (LinkedIn, GitHub, portfolio, website, Twitter/X, etc.), return the full URL including https:// prefix
- For names, return just the name
- For phone numbers, include country code if present`;

  const cvContext = getCvContext(cvText, 10000);
  const userPrompt = `CV:\n${cvContext}\n\nExtract: ${cleanQ}\n\nReturn ONLY the value, nothing else.`;
  return { systemPrompt, userPrompt, temperature: 0.1 };
}

// ---------------------------------------------------------------------------
// Per-type prompt builders
// ---------------------------------------------------------------------------

function buildShortFactualPrompt(cvText, question) {
  const systemPrompt = `You are answering a job application question that requires a short, direct response.

RULES:
- Give a SHORT, DIRECT answer — e.g. "4 weeks", "Immediately", "£60,000–£70,000", "Yes, eligible to work in the UK"
- 1–2 sentences maximum — no paragraphs, no career history
- Use information from the CV if present; otherwise give a reasonable professional default`;

  const cvContext = getCvContext(cvText, 8000);
  const userPrompt = `CV:\n${cvContext}\n\nQuestion: ${question}\n\nAnswer in 1–2 sentences maximum.`;
  return { systemPrompt, userPrompt, temperature: 0.1 };
}

function buildYesNoPrompt(cvText, question, jobCtx) {
  const systemPrompt = `You are filling out a job application on behalf of the candidate.

RULES:
- Start with a clear YES or NO (or equivalent direct statement like "Yes, I have..." / "No, but...")
- Add at most 1–2 supporting sentences from the CV if they strengthen the answer
- Maximum 3 sentences total — this is a short-answer field, not an essay
- Be honest: if the CV doesn't clearly confirm the skill/experience, say "Not directly, but..." and give the closest relevant experience`;

  const cvContext = getCvContext(cvText, 8000);
  let userPrompt = `CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Job Context:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer directly (max 3 sentences).`;
  return { systemPrompt, userPrompt, temperature: 0.3 };
}

function buildBriefPrompt(cvText, question, jobCtx) {
  const systemPrompt = `You are filling out a job application on behalf of the candidate.

RULES:
- Answer in 1–3 sentences (max 50 words)
- Be direct and specific — no filler, no padding, no "I am a dedicated professional"
- Pick the single most relevant fact or experience from the CV`;

  const cvContext = getCvContext(cvText, 8000);
  let userPrompt = `CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Job Context:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer concisely (1–3 sentences, max 50 words).`;
  return { systemPrompt, userPrompt, temperature: 0.4 };
}

function buildBehavioralPrompt(cvText, question, length, jobCtx) {
  const words = { short: '120–160', medium: '160–220', long: '220–300' }[length] || '160–220';
  const systemPrompt = `You are helping a job candidate answer a behavioral interview question.

RULES:
1. Use the STAR structure naturally (Situation → Task → Action → Result) — don't label the sections
2. Pick ONE specific, concrete example from the CV that best answers THIS exact question
3. The example can come from any point in the career — pick the BEST fit, not the most recent
4. Include a specific outcome or result where possible (even qualitative if no metric is in the CV)
5. Write in first person, natural conversational tone — not corporate or over-polished
6. NEVER invent employers, dates, or metrics not in the CV
7. Stay tightly focused on what the question is actually asking — don't pad with unrelated experience`;

  const cvContext = getCvContext(cvText, 10000);
  let userPrompt = `CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Job Context:\n${jobCtx}\n`;
  userPrompt += `Behavioral question: ${question}\n\nWrite a ${words}-word answer using one specific example. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.7 };
}

function buildStrengthWeaknessPrompt(cvText, question, length, jobCtx) {
  const words = { short: '60–90', medium: '90–130', long: '130–180' }[length] || '90–130';
  const systemPrompt = `You are helping a job candidate answer a strengths or weaknesses question.

RULES:
- For STRENGTHS: name the strength clearly, then give ONE specific example from the CV that proves it
- For WEAKNESSES: be honest and human — name a real development area and briefly how you've been addressing it
- Avoid clichés: "I work too hard", "I'm a perfectionist", "I care too much"
- Keep it grounded in CV evidence; don't invent examples`;

  const cvContext = getCvContext(cvText, 8000);
  let userPrompt = `CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Job Context:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.6 };
}

function buildMotivationPrompt(cvText, question, length, jobCtx) {
  const words = { short: '70–100', medium: '100–150', long: '150–200' }[length] || '100–150';
  const hasJobCtx = !!jobCtx;
  const systemPrompt = `You are helping a job candidate explain their motivation for applying.

RULES:
1. Be specific to the role/company if job context is available — no generic "I'm passionate about..." answers
2. Connect genuine interest to concrete evidence from the CV (skills used, problems enjoyed solving, career direction)
3. Explain why this is the RIGHT NEXT STEP based on career trajectory — not just enthusiasm
4. ${hasJobCtx ? 'Use specific language from the job description to show alignment' : 'Draw on clear patterns from the career history'}
5. Avoid: "I'm excited/passionate about...", "amazing company", "incredible opportunity"`;

  const cvContext = getCvContext(cvText, 8000);
  let userPrompt = `CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Job Context:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.7 };
}

function buildWhyCompanyPrompt(cvText, question, length, jobCtx, jobTitle, company) {
  const words = { short: '80–110', medium: '110–160', long: '160–220' }[length] || '110–160';
  const hasJobCtx = !!jobCtx;
  const systemPrompt = `You are helping a job candidate answer a "why this company / why this role" question.

RULES:
1. ${hasJobCtx
    ? 'Open with 1–2 sentences showing you understand what the company/team is working on — use specific language from the job description'
    : 'Show genuine, specific interest based on what the role/company clearly involves'}
2. Connect 2–3 specific aspects of the role or company to concrete evidence from the CV (different roles when possible)
3. End with 1 sentence on why this is a logical next step — based on career direction, not hype
4. Do NOT use: "I'm excited/passionate/thrilled", "amazing company", "incredible opportunity", "perfect fit"
5. NEVER invent facts about the company not in the job description`;

  const cvContext = getCvContext(cvText, 8000);
  let userPrompt = `CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Job Context:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.7 };
}

function buildCoverLetterPrompt(cvText, question, length, jobCtx, jobTitle, company) {
  const words = { short: '150–220', medium: '250–350', long: '350–450' }[length] || '250–350';
  const systemPrompt = `You are writing a cover letter for a job candidate.

STRUCTURE (mandatory):
1. "Dear Hiring Manager," (or "Dear [Company] team," if company name is known)
2. Opening paragraph: show you understand the role and make a specific, grounded connection to your background — no generic hype
3. 2–3 body paragraphs: map KEY job requirements to SPECIFIC CV evidence — draw from different roles/time periods when possible
4. Closing paragraph: confident, brief — express genuine interest and availability for next steps
5. Sign-off: "Sincerely,\\n[Your Name]"

RULES:
- Reference at least 3 specific requirements from the job description if provided
- NEVER invent employers, degrees, dates, or metrics
- No corporate buzzwords, no hollow enthusiasm
- Tailor to the specific role — a generic letter is a failed letter`;

  const cvContext = getCvContext(cvText, 10000);
  let userPrompt = `CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Job Context:\n${jobCtx}\n`;
  userPrompt += `Write a cover letter for${jobTitle ? ` the ${jobTitle} role` : ' this role'}${company ? ` at ${company}` : ''}.\nTarget length: ${words} words. No preamble — start with "Dear...".`;
  return { systemPrompt, userPrompt, temperature: 0.7 };
}

function buildGeneralPrompt(cvText, question, length, jobCtx) {
  const words = { short: '60–90', medium: '90–140', long: '150–220' }[length] || '90–140';
  const hasJobCtx = !!jobCtx;
  const systemPrompt = `You are helping a job candidate answer a job application question.

RULES:
1. DIRECTLY answer the specific question being asked — this is the most important rule
2. Support your answer with the most relevant evidence from the CV
3. Match the scope to the question — if the question is narrow, the answer should be focused; if broad, draw on career breadth
4. ${hasJobCtx ? 'Tailor the answer to the job context provided — reference relevant requirements' : 'Draw the most relevant parts of the CV for this specific question'}
5. Only reference multiple time periods if the question genuinely calls for career breadth
6. Write in first person, natural tone — not corporate or over-polished
7. NEVER invent employers, dates, or metrics not in the CV

BANNED:
- "I'm excited/passionate about..."
- "leverage", "synergy", "proven track record", "results-driven"
- Starting with "As a [current title]..."`;

  const cvContext = getCvContext(cvText, 10000);
  let userPrompt = `CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Job Context:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.7 };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildPrompts(input) {
  const {
    question = '',
    length = 'medium',
    cvText = '',
    jobTitle,
    company,
    jobDescription,
    requirements,
  } = input;

  // Plain field labels (name, email, LinkedIn, phone, etc.)
  if (isDataExtractionQuestion(question)) {
    return buildExtractionPrompt(cvText, question);
  }

  const jobCtx = buildJobContext(jobTitle, company, jobDescription, requirements);
  const qType = detectQuestionType(question);

  switch (qType) {
    case 'short_factual':
      return buildShortFactualPrompt(cvText, question);
    case 'yes_no':
      return buildYesNoPrompt(cvText, question, jobCtx);
    case 'brief':
      return buildBriefPrompt(cvText, question, jobCtx);
    case 'behavioral':
      return buildBehavioralPrompt(cvText, question, length, jobCtx);
    case 'strength_weakness':
      return buildStrengthWeaknessPrompt(cvText, question, length, jobCtx);
    case 'motivation':
      return buildMotivationPrompt(cvText, question, length, jobCtx);
    case 'why_company':
      return buildWhyCompanyPrompt(cvText, question, length, jobCtx, jobTitle, company);
    case 'cover_letter':
      return buildCoverLetterPrompt(cvText, question, length, jobCtx, jobTitle, company);
    default:
      return buildGeneralPrompt(cvText, question, length, jobCtx);
  }
}
