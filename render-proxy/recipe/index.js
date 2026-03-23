/**
 * DraftApply Recipe Module (open-source default).
 *
 * Builds LLM prompts from structured input. This is the default recipe
 * used by the proxy; override with RECIPE_PATH to use a custom module.
 *
 * Contract:
 *   buildPrompts(input)  → { systemPrompt, userPrompt, temperature, maxTokens }
 *
 * `input` is a structured payload sent by the extension:
 *   {
 *     question:        string,
 *     length:          'short' | 'medium' | 'long',
 *     tone:            'natural' | 'formal' | 'direct',
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

/**
 * Extract candidate name from top of CV.
 * Skips lines that look like job titles or section headers.
 */
function extractCandidateName(cvText) {
  const lines = (cvText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const titlePattern = /\b(engineer|developer|manager|designer|analyst|director|lead|head\s+of|vp|chief|intern|consultant|architect|specialist|officer|coordinator|executive)\b/i;
  const metaPattern = /\b(resume|curriculum\s*vitae|cv|portfolio|profile)\b/i;
  for (const line of lines.slice(0, 4)) {
    if (line.length < 40 && /^[A-Z]/.test(line) && !/[@:/]/.test(line) && !titlePattern.test(line) && !metaPattern.test(line)) {
      return line;
    }
  }
  return null;
}

function buildJobContext(jobTitle, company, jobDescription, requirements) {
  let ctx = '';
  if (!jobDescription?.trim() && !(requirements && requirements.length > 0)) return ctx;

  if (jobTitle || company) {
    ctx += `Position: ${jobTitle || 'Not specified'}`;
    if (company) ctx += ` at ${company}`;
    ctx += '\n\n';
  }
  if (requirements && requirements.length > 0) {
    ctx += `Key Requirements:\n${requirements.slice(0, 30).map(r => `- ${r}`).join('\n')}\n\n`;
  }
  if (jobDescription) {
    ctx += `Job Description:\n${jobDescription.slice(0, 40000)}`;
    if (jobDescription.length > 40000) ctx += '\n[...truncated...]';
    ctx += '\n\n';
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Shared prompt building blocks
// ---------------------------------------------------------------------------

/**
 * Identity preamble — shifts the model from "assistant helping someone"
 * to "I AM this person filling out the form".
 */
function identityPreamble(candidateName) {
  const name = candidateName ? `You are ${candidateName}.` : 'You are this candidate.';
  return `${name} You are NOT an AI assistant writing on someone's behalf — you ARE this person, completing this job application in your own voice right now.

Your CV is your background. Read it fully, internalize it, then answer as yourself — in your own natural voice.`;
}

/**
 * Natural writing guidance — the default tone.
 */
const WRITING_GUIDANCE = `
WRITE LIKE A HUMAN — concrete examples of what that means:

BAD (AI-speak, generic, will get ignored):
"Throughout my career I've developed strong skills in X, leveraging my proven track record to deliver results."
"I'm passionate about [thing] and believe my experience uniquely positions me to contribute."
"As a results-driven professional with expertise in..."

GOOD (specific, direct, sounds like a real person):
"At [Company], I did X which led to Y."
"The hardest part was Z — I handled it by..."
"I've spent most of my time on [specific thing], which is directly what this role needs."

RULES:
- Lead with the answer, not with context-setting
- Use actual company names, tools, and situations from the CV
- Short sentences where possible — long ones lose the reader
- Never start with "I'm excited/passionate/thrilled about..."
- Never use: leverage, synergy, proven track record, results-driven, dynamic, spearheaded
- NEVER invent employers, dates, metrics, or facts not in the CV`;

/**
 * Formal tone — structured, professional register, no contractions.
 */
const FORMAL_GUIDANCE = `
WRITE IN A FORMAL, PROFESSIONAL REGISTER:

RULES:
- No contractions: write "I have" not "I've", "I am" not "I'm", "It is" not "It's"
- Use complete, well-structured sentences with clear topic sentences per paragraph
- Measured language for outcomes: "This resulted in..." rather than casual constructions
- Professional vocabulary throughout — avoid slang, casual connectors, filler phrases
- Never start with "I'm excited/passionate/thrilled about..."
- Never use: leverage, synergy, proven track record, results-driven, dynamic, spearheaded
- NEVER invent employers, dates, metrics, or facts not in the CV`;

/**
 * Direct tone — no preamble, stripped-down, specific nouns and verbs.
 */
const DIRECT_GUIDANCE = `
WRITE IN A DIRECT, CONCISE STYLE:

RULES:
- Answer the question in the very first clause — no warm-up sentences
- Prefer active verbs and specific nouns: "Built X", "Cut Y by Z%", "Led team of N"
- Target <= 18 words per sentence — cut anything that does not add new information
- Eliminate all hedging: no "I believe", "I feel", "It seems", "In my experience"
- Eliminate qualifiers: no "quite", "rather", "very", "somewhat"
- Never start with "I'm excited/passionate/thrilled about..."
- Never use: leverage, synergy, proven track record, results-driven, dynamic, spearheaded
- NEVER invent employers, dates, metrics, or facts not in the CV`;

/**
 * Return the appropriate writing guidance block for the chosen tone.
 */
function getWritingGuidance(tone) {
  if (tone === 'formal') return FORMAL_GUIDANCE;
  if (tone === 'direct') return DIRECT_GUIDANCE;
  return WRITING_GUIDANCE; // 'natural' is the default
}

// ---------------------------------------------------------------------------
// Question type detection
// ---------------------------------------------------------------------------

function detectQuestionType(question) {
  const q = (question || '').toLowerCase();

  // Cover letter (format, not a topic — check first)
  if (
    q.includes('cover letter') || q.includes('coverletter') ||
    q.includes('motivation letter') || q.includes('letter of interest') ||
    q.includes('application letter')
  ) return 'cover_letter';

  // Why company / why this role
  if (
    q.includes('why do you want') || q.includes('why would you like') ||
    q.includes('why are you applying') || q.includes('what draws you') ||
    q.includes('why this company') || q.includes("company's mission") ||
    q.includes('why our company') || q.includes('why do you want to join') ||
    q.includes('what attracted you') || q.includes('why are you interested in') ||
    q.includes('why us?') || q.includes('why us ') ||
    // "What interests/excites/appeals to you about this company/role?" forms
    /what\s+(interests?|excites?|appeals?|draws?|attracts?)\s+you\s+about\s+(this|the|our)\s+(company|role|position|opportunity|organisation|organization)/i.test(q) ||
    /what\s+(interests?|excites?|appeals?|draws?|attracts?)\s+you\s+about\s+working\s+(for|at|with|here)/i.test(q) ||
    (
      /^why\s+[a-z]/i.test(question.trim()) &&
      question.trim().split(/\s+/).length <= 4 &&
      !/^why\s+(remote|contract|part.?time|full.?time|freelance|hybrid)/i.test(question.trim())
    )
  ) return 'why_company';

  // Short factual — about candidate's current situation
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
    /\bvisa\s+(status|type|sponsorship)\b/.test(q) ||
    /deadline[s]?\s+or\s+timeline/.test(q) ||
    /timeline\s+consideration/.test(q) ||
    /any\s+(deadline|timeline|constraint|commitment)[s]?\s+(we|you|to)\s+/i.test(q) ||
    /\bimmediately\s+available\b/.test(q)
  ) return 'short_factual';

  // Yes / No questions
  if (
    /^(are|do|have|can|will|would|is|did)\s+you\b/i.test(question.trim()) ||
    /\bdo you (currently |have |hold |possess |own )/i.test(q) ||
    /\bare you (willing|able|comfortable|open|available|authorized|eligible|happy|prepared|fluent|proficient)\b/i.test(q) ||
    /\bhave you (ever|previously|worked|used|managed|led|built)\b/i.test(q)
  ) return 'yes_no';

  // Explicitly brief
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

  // Strengths / weaknesses — dispatched to focused sub-builders in buildPrompts
  if (
    /\b(greatest?|biggest?|main|key|top)\s+(strength|weakness|achievement|accomplishment)\b/i.test(q) ||
    /areas?\s+(for|of|to)\s+improve(ment)?/i.test(q) ||
    /what\s+would\s+you\s+improve\s+about\s+yourself/i.test(q) ||
    /\bweakness(es)?\b/i.test(q)
  ) return 'strength_weakness';

  // Motivation / interest in the role
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
// Plain-field data extraction (name, email, LinkedIn, phone, etc.)
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

  const cvContext = getCvContext(cvText, 40000);
  const userPrompt = `CV:\n${cvContext}\n\nExtract: ${cleanQ}\n\nReturn ONLY the value, nothing else.`;
  return { systemPrompt, userPrompt, temperature: 0.1, maxTokens: 150 };
}

// ---------------------------------------------------------------------------
// Per-type prompt builders
// ---------------------------------------------------------------------------

function buildShortFactualPrompt(cvText, question) {
  const systemPrompt = `You are answering a job application question about the candidate's CURRENT SITUATION or AVAILABILITY — not about their work history.

Answer about the candidate's current status or constraints, NOT their career experience.

Good examples:
- "No, I'm available immediately."
- "I have a 4-week notice period."
- "No timeline constraints — I can start as soon as needed."
- "I'm eligible to work in the UK without sponsorship."

Rules:
- 1-2 sentences maximum
- If the CV doesn't have this information, give a sensible professional default
- Do NOT mention past jobs or career history`;

  const cvContext = getCvContext(cvText, 40000);
  const userPrompt = `CV:\n${cvContext}\n\nQuestion: ${question}\n\nAnswer in 1-2 sentences about the candidate's current situation.`;
  return { systemPrompt, userPrompt, temperature: 0.1, maxTokens: 120 };
}

function buildYesNoPrompt(cvText, question, jobCtx, candidateName, tone) {
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a yes/no job application question.
${writingGuidance}

HOW TO ANSWER:
- Start with a clear YES or NO (or "Yes, I have..." / "No, but I have...")
- Follow with 1-2 sentences of specific supporting evidence from the CV if relevant
- Maximum 3 sentences total
- If the CV doesn't clearly confirm the thing asked, be honest: "Not directly, but [closest relevant experience]"
- Do NOT write an essay or career summary`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer directly (max 3 sentences).`;
  return { systemPrompt, userPrompt, temperature: 0.3, maxTokens: 180 };
}

function buildBriefPrompt(cvText, question, jobCtx, candidateName, tone) {
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

Answer this job application question briefly and directly.
${writingGuidance}

Additional rules for brevity:
- 1-3 sentences, maximum 50 words
- Lead with the direct answer, not with setup
- Use one specific, concrete detail from the CV`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer concisely (max 50 words).`;
  return { systemPrompt, userPrompt, temperature: 0.5, maxTokens: 150 };
}

function buildBehavioralPrompt(cvText, question, length, jobCtx, candidateName, tone) {
  const words = { short: '120-160', medium: '160-220', long: '220-300' }[length] || '160-220';
  const maxTokens = { short: 320, medium: 480, long: 620 }[length] || 480;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a behavioral interview question. Tell ONE specific story from your background.
${writingGuidance}

HOW TO STRUCTURE YOUR STORY (naturally, without labeling sections):
1. Set the scene briefly — what was happening, what was at stake
2. What YOU specifically did (not "the team" — you)
3. What happened as a result — be specific even if the outcome was just qualitative
4. Optional: one-sentence reflection on what you'd do differently or what you learned

EXAMPLE of what good looks like:
Q: "Tell me about a time you had to solve a complex technical problem under pressure."
A: "We had a customer going live in 48 hours when a race condition surfaced in production — auth tokens were expiring mid-session under load. I pulled the logs, traced it to our token refresh service not handling concurrent requests, and shipped a fix with the on-call engineer by midnight. Customer went live on schedule. After that I added concurrent load tests to our staging pipeline so we'd catch it earlier."

Notice: specific situation, specific problem, specific action, specific outcome, natural voice, no buzzwords.

Rules:
- ONE story, not a tour of your CV
- Pick the example that best fits THIS specific question, not just the most recent thing
- Include what YOU did personally, not what "the team" did
- NEVER invent employers, dates, or metrics`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}

Before writing, think: what single experience in my background BEST answers exactly what this question is asking? Use that one.

Write a ${words}-word answer. First person, no preamble, no "Great question".`;
  return { systemPrompt, userPrompt, temperature: 0.75, maxTokens };
}

/**
 * Focused strength builder — does not mention weaknesses.
 */
function buildStrengthPrompt(cvText, question, length, jobCtx, candidateName, tone) {
  const words = { short: '60-90', medium: '90-130', long: '130-180' }[length] || '90-130';
  const maxTokens = { short: 200, medium: 300, long: 420 }[length] || 300;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a question about your greatest strength.
${writingGuidance}

HOW TO ANSWER:
- Name the strength directly in the first sentence
- Prove it immediately with ONE specific, concrete example from the CV — name the company, project, or situation
- Do NOT explain why it is a strength in abstract terms — show it through evidence
- Do NOT name a generic strength ("communication", "teamwork") without immediate proof
- Do NOT pivot to discussing weaknesses or growth areas

NEVER invent examples, employers, or metrics`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.65, maxTokens };
}

/**
 * Focused weakness builder — does not conflate with strengths or pivot away.
 */
function buildWeaknessPrompt(cvText, question, length, jobCtx, candidateName, tone) {
  const words = { short: '60-90', medium: '90-130', long: '130-180' }[length] || '90-130';
  const maxTokens = { short: 200, medium: 300, long: 420 }[length] || 300;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a question about a weakness or area for improvement.
${writingGuidance}

HOW TO ANSWER:
- Name something REAL — not "I work too hard", "I'm a perfectionist", or "I care too much"
- State the weakness clearly in the first sentence — do not bury it
- Describe what you have been actively doing to address it — be concrete (a course, a changed habit, a mentor, a process change)
- Keep it brief — this is not the main event of the application
- Do NOT pivot to discussing a strength or reframe the weakness as secretly a positive trait

NEVER fabricate examples or claim you have no weaknesses`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.65, maxTokens };
}

function buildMotivationPrompt(cvText, question, length, jobCtx, candidateName, tone) {
  const words = { short: '70-100', medium: '100-150', long: '150-200' }[length] || '100-150';
  const maxTokens = { short: 220, medium: 340, long: 460 }[length] || 340;
  const hasJobCtx = !!jobCtx;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a question about your motivation or interest in this role/field.
${writingGuidance}

HOW TO WRITE A GENUINE MOTIVATION ANSWER:
- Be specific about WHAT interests you — name the actual thing (a technology, a problem space, a type of work)
- Connect it to something real in your background — a project, a role, a skill you've been building
- Explain why THIS role is the right next step based on your actual career direction
- ${hasJobCtx ? 'Use specific language from the job description to show you understand what they need' : 'Draw on clear patterns visible in your career history'}

Do NOT:
- Open with "I'm excited/passionate/driven by..."
- Give a vague "I enjoy helping people" type answer
- Write about the company being "amazing" or the "incredible opportunity"`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.75, maxTokens };
}

function buildWhyCompanyPrompt(cvText, question, length, jobCtx, jobTitle, company, candidateName, tone) {
  const words = { short: '80-110', medium: '110-160', long: '160-220' }[length] || '110-160';
  const maxTokens = { short: 250, medium: 380, long: 520 }[length] || 380;
  const hasJobCtx = !!jobCtx;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a "why this company / why this role" question.
${writingGuidance}

MANDATORY STRUCTURE — in this exact order:
1. COMPANY/ROLE FIRST: Open with 1-2 sentences naming something SPECIFIC about the company or role from the job description — their mission, the product they build, a specific challenge they're tackling, a responsibility that stood out. This MUST come before any mention of your background.
2. YOUR CONNECTION: 2-3 sentences connecting specific things from the role/company to concrete evidence from your CV.
3. CLOSE: One sentence on why this is the logical next step in your career direction.

CRITICAL:
- If job context is provided, the opening MUST reference something specific from it — do NOT open with your CV history
- "I've always been interested in AI" is not specific enough — say WHICH aspect of the company's work / which part of the job description resonates and WHY
- This answer must be impossible to reuse for a different company — it must feel written specifically for THIS role
${!hasJobCtx ? '- No job description provided: open with what the company/role name clearly implies, then connect to your CV' : ''}`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}

Start your answer with something specific about ${company || 'the company'} or this role — NOT with your own background. Then connect it to your CV.

Answer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.75, maxTokens };
}

function buildCoverLetterPrompt(cvText, question, length, jobCtx, jobTitle, company, candidateName, tone) {
  const words = { short: '150-220', medium: '250-350', long: '350-450' }[length] || '250-350';
  const maxTokens = { short: 500, medium: 800, long: 1100 }[length] || 800;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are writing a cover letter for this role.
${writingGuidance}

STRUCTURE (mandatory):
1. "Dear Hiring Manager," (or "Dear [Company] team," if company name is known)
2. Opening paragraph: ONE specific thing about this role that connects directly to your background — not generic enthusiasm
3. 2-3 body paragraphs: map specific job requirements to specific CV evidence — use different roles/time periods when possible, don't just summarise your most recent job
4. Closing: brief, confident, genuine — "I'd welcome the chance to discuss how I could contribute."
5. Sign-off: "Sincerely,\n[Your Name]"

Rules:
- Reference at least 3 specific requirements from the job description if provided
- Every paragraph should earn its place — no padding
- NEVER invent employers, degrees, dates, or metrics
- A generic letter that could be sent to any company is a failure — make it specific`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Write a cover letter for${jobTitle ? ` the ${jobTitle} role` : ' this role'}${company ? ` at ${company}` : ''}.
Target length: ${words} words. Start with "Dear..." — no preamble before the letter.`;
  return { systemPrompt, userPrompt, temperature: 0.72, maxTokens };
}

function buildGeneralPrompt(cvText, question, length, jobCtx, candidateName, tone) {
  const words = { short: '60-90', medium: '90-140', long: '150-220' }[length] || '90-140';
  const maxTokens = { short: 220, medium: 340, long: 520 }[length] || 340;
  const hasJobCtx = !!jobCtx;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a job application question.
${writingGuidance}

HOW TO APPROACH THIS:
1. Read the question carefully — what is it ACTUALLY asking? (experience with X? your approach to Y? a specific capability?)
2. Identify the ONE piece of your background that most directly and convincingly answers it
3. Lead with that — don't bury the answer

If the question is about a specific skill or technology: confirm clearly whether you have it, then give one concrete example of using it.
If the question is about your approach or process: describe how you actually work, with a real example.
If the question is broad: pick the angle from your background that's most relevant to ${hasJobCtx ? 'what this role needs' : 'the question'}.

${hasJobCtx ? 'The job context is provided — use it to tailor your answer to what this specific role actually needs.' : ''}`;

  const cvContext = getCvContext(cvText, 40000);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}

Think: what is this question specifically asking, and what in my background most directly answers it?

Answer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.75, maxTokens };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildPrompts(input) {
  const {
    question = '',
    length = 'medium',
    tone = 'natural',
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
  const candidateName = extractCandidateName(cvText);
  const qType = detectQuestionType(question);

  switch (qType) {
    case 'short_factual':
      return buildShortFactualPrompt(cvText, question);
    case 'yes_no':
      return buildYesNoPrompt(cvText, question, jobCtx, candidateName, tone);
    case 'brief':
      return buildBriefPrompt(cvText, question, jobCtx, candidateName, tone);
    case 'behavioral':
      return buildBehavioralPrompt(cvText, question, length, jobCtx, candidateName, tone);
    case 'strength_weakness': {
      // Dispatch to a focused builder based on which sub-type is being asked.
      // If the question asks for BOTH (e.g. "strengths and weaknesses"), fall
      // through to the general builder so neither sub-topic is ignored.
      const isWeakness = /weakness(es)?|areas?\s+(for|of|to)\s+improve(ment)?|development\s+area|improve\s+about\s+yourself/i.test(question);
      const isStrength = /\bstrength(s)?\b/i.test(question);
      if (isStrength && isWeakness) {
        return buildGeneralPrompt(cvText, question, length, jobCtx, candidateName, tone);
      }
      return isWeakness
        ? buildWeaknessPrompt(cvText, question, length, jobCtx, candidateName, tone)
        : buildStrengthPrompt(cvText, question, length, jobCtx, candidateName, tone);
    }
    case 'motivation':
      return buildMotivationPrompt(cvText, question, length, jobCtx, candidateName, tone);
    case 'why_company':
      return buildWhyCompanyPrompt(cvText, question, length, jobCtx, jobTitle, company, candidateName, tone);
    case 'cover_letter':
      return buildCoverLetterPrompt(cvText, question, length, jobCtx, jobTitle, company, candidateName, tone);
    default:
      return buildGeneralPrompt(cvText, question, length, jobCtx, candidateName, tone);
  }
}
