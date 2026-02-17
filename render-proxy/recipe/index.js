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

function isWhyCompanyQuestion(question) {
  const q = (question || '').trim().toLowerCase();
  return (
    q.includes('why do you want') ||
    q.includes('why would you like') ||
    q.includes('why are you applying') ||
    q.includes('what draws you') ||
    q.includes('why this company') ||
    q.includes("company's mission") ||
    q.includes('why our company')
  );
}

function isCoverLetterQuestion(question) {
  const q = (question || '').trim().toLowerCase();
  return (
    q.includes('cover letter') ||
    q.includes('coverletter') ||
    q.includes('motivation letter') ||
    q.includes('letter of interest') ||
    q.includes('application letter') ||
    q === 'cover letter' ||
    q === 'coverletter'
  );
}

function cleanFieldLabel(raw) {
  return (raw || '')
    .trim()
    .replace(/[*:?\u2217\u2731]+$/g, '')
    .replace(/^(please\s+(enter|provide|input|type|specify)\s+(your\s+)?)/i, '')
    .replace(/^(enter\s+(your\s+)?)/i, '')
    .replace(/^(your\s+)/i, '')
    .trim();
}

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

/**
 * Include head + tail of CV to avoid recency bias when truncating.
 */
function getCvContext(rawText, maxChars) {
  const raw = rawText || '';
  const max = Math.max(500, Number(maxChars) || 0);
  if (raw.length <= max) return raw;

  const headLen = Math.floor(max * 0.6);
  const tailLen = max - headLen;
  const head = raw.slice(0, headLen);
  const tail = raw.slice(-tailLen);
  return `${head}\n\n...[snip - middle omitted to fit prompt]...\n\n${tail}`;
}

// ---------------------------------------------------------------------------
// Data extraction (simple fields like name, email, phone, LinkedIn)
// ---------------------------------------------------------------------------

function buildExtractionPrompt(cvText, question) {
  const cleanQ = cleanFieldLabel(question);

  const systemPrompt = `You are a data extraction assistant. Extract ONLY the requested information from the CV.

RULES:
- Return ONLY the exact value requested, nothing else
- No sentences, no explanations, no formatting
- If the information is not found, respond with: "Not found in CV"
- For URLs (LinkedIn, GitHub, portfolio, website, Twitter/X, etc.), return the full URL including https:// prefix. If the CV only shows "linkedin.com/in/johndoe", return "https://linkedin.com/in/johndoe"
- For names, return just the name
- For phone numbers, include country code if present`;

  const cvContext = getCvContext(cvText, 10000);

  const userPrompt = `CV:\n${cvContext}\n\nExtract: ${cleanQ}\n\nReturn ONLY the value, nothing else.`;

  return { systemPrompt, userPrompt, temperature: 0.1 };
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

  if (isDataExtractionQuestion(question)) {
    return buildExtractionPrompt(cvText, question);
  }

  const coverLetter = isCoverLetterQuestion(question);
  const whyCompany = isWhyCompanyQuestion(question);

  const lengthSpec = coverLetter
    ? ({ short: '150-220 words', medium: '250-350 words', long: '350-500 words' }[length] || '250-350 words')
    : ({ short: '50-80 words', medium: '100-150 words', long: '200-300 words' }[length] || '100-150 words');

  let systemPrompt = `You are helping a job candidate write authentic, tailored answers to application questions.

## MANDATORY: USE THE FULL CV
Before writing, scan the ENTIRE CV and identify ALL relevant experiences:
- Look at EVERY job listed, not just the most recent
- Check education, certifications, projects, volunteer work
- Find the BEST examples regardless of when they occurred
- Older experiences are often MORE relevant than recent ones

## MANDATORY: USE THE JOB DESCRIPTION (IF PROVIDED)
If a job description / requirements are provided, you MUST:
- Identify 3-5 key requirements/responsibilities that matter most
- Map them to concrete CV evidence (specific roles/projects/skills) from anywhere in the CV
- Use the role language naturally (tools, responsibilities) but do NOT copy/paste
- If a requirement is not covered, either avoid claiming it or address it honestly ("I haven't done X directly, but I've done Y which is adjacent")
`;

  if (coverLetter) {
    systemPrompt += `
## COVER LETTER MODE
If the user asks for a cover letter (or the field is "Cover letter"), you MUST write a real cover letter:
- Greeting ("Dear Hiring Manager," or "Dear [Company] team,")
- 1st paragraph: specific hook showing you understand the role and why you fit
- 2nd–3rd paragraphs: map at least 3 job requirements to concrete CV evidence (use different roles/time periods when possible)
- Final paragraph: close confidently and add "Sincerely,\\n[Your Name]"
- Do NOT write a generic summary of skills; this must be tailored to the job context
`;
  }

  systemPrompt += `
## ANSWER STRUCTURE
Your answer MUST include experiences from at least 2 different time periods or roles when the CV has them. For example:
- "In my role at [OLDER COMPANY], I... Later at [RECENT COMPANY], I built on this by..."
- "My experience spans from [EARLY ROLE] where I learned X, through [MID ROLE] where I applied it to Y"

## RULES
1. Write in first person as the candidate
2. NEVER focus only on the current/most recent role - this is the #1 mistake to avoid
3. NEVER invent employers, degrees, dates, or metrics not in the CV
4. Sound human and genuine - no corporate buzzwords
${jobDescription ? '5. Tailor to the job description provided' : ''}

## BANNED PHRASES
- "I'm excited to..." / "I'm passionate about..."
- "leverage", "synergy", "proven track record"
- Starting with "As a [current title]..." (shows recency bias)`;

  const cvContext = getCvContext(cvText, 8000);

  let userPrompt = `## CANDIDATE CV (use ALL relevant roles; older roles may be most relevant)\n${cvContext}\n\n`;

  if (jobDescription || (requirements && requirements.length > 0)) {
    userPrompt += `## JOB CONTEXT\n`;
    if (jobTitle) userPrompt += `**Position:** ${jobTitle}\n`;
    if (company) userPrompt += `**Company:** ${company}\n`;
    userPrompt += '\n';

    if (requirements && requirements.length > 0) {
      userPrompt += `### Key Requirements\n`;
      for (const req of requirements.slice(0, 10)) {
        userPrompt += `- ${req}\n`;
      }
      userPrompt += '\n';
    }

    if (jobDescription) {
      userPrompt += `### Job Description\n`;
      userPrompt += jobDescription.slice(0, 10000);
      if (jobDescription.length > 10000) userPrompt += '\n[...truncated...]';
      userPrompt += '\n\n';
    }
  }

  userPrompt += `## QUESTION\n${question}\n\n`;

  userPrompt += `## INSTRUCTIONS
- Length: approximately ${lengthSpec}
- IMPORTANT: Reference experiences from AT LEAST 2 different roles/time periods in your answer
- Do NOT focus only on the most recent role
- ${jobDescription ? 'Tailor to the job requirements above' : 'Show breadth of experience across your career'}
`;

  if (whyCompany) {
    userPrompt += `
SPECIAL (WHY COMPANY):
- Use 2-3 specific points from the job context (mission, responsibilities, requirements) to show you understand the role
- Then connect each point to a concrete example from your CV (preferably from different roles/time periods)
- End with 1 sentence explaining why this is a logical next step for you (no generic hype)
`;
  }

  if (coverLetter) {
    userPrompt += `
SPECIAL (COVER LETTER):
- Output must be a complete cover letter with greeting + 3–4 paragraphs + closing.
- Explicitly mention the role (${jobTitle || 'the role'})${company ? ` at ${company}` : ''}.
- Include at least 3 specific job requirements from the job context and map each to CV evidence.
`;
  }

  userPrompt += `\nWrite the answer now. First person, no preamble.`;

  return { systemPrompt, userPrompt, temperature: 0.7 };
}
