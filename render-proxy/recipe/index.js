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
 *     cvData:          object?,
 *     jdData:          object?,
 *     matchMap:        object[]?,
 *     roleProfile:     object?,
 *     domainRisk:      object?,
 *     jobTitle:        string?,
 *     company:         string?,
 *     jobDescription:  string?,
 *     requirements:    string[]?,
 *     pageUrl:         string?,
 *     platform:        string?,
 *   }
 */

import { SalaryBenchmarkService } from '../../shared/salary-benchmark-service.js';
import { withAgentPromptHeader } from '../model-router.js';
import { classifyApplicationQuestion } from '../../shared/question-classifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanFieldLabel(raw) {
  return (raw || '')
    .trim()
    .replace(/[*:?.\u2217\u2731]+$/g, '')
    .replace(/^(please\s+)?(?:enter|provide|input|type|specify|share|add|include|paste)\s+(?:a\s+|the\s+)?(?:url|link)\s+(?:to|for)\s+(?:your\s+)?/i, '')
    .replace(/^(please\s+)?link\s+(?:to\s+)?(?:your\s+)?/i, '')
    .replace(/^(please\s+(enter|provide|input|type|specify|link|share|add|include|paste)\s+(your\s+)?)/i, '')
    .replace(/^(enter\s+(your\s+)?)/i, '')
    .replace(/^(your\s+)/i, '')
    .trim();
}

/**
 * Include head + tail of CV to avoid recency bias when truncating.
 * Used as a fallback when structured cvData is unavailable.
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
 * Build a structured markdown CV context from parsed cvData.
 * This gives the model a well-organised view rather than a raw text dump,
 * making evidence retrieval more reliable and reducing recency bias.
 * Falls back to getCvContext(rawText) when cvData is absent or empty.
 */
function buildStructuredCvContext(cvData, rawText, maxRawChars = 60000) {
  // The uploaded CV is the canonical record. Use it exactly once so parsing
  // cannot hide unsupported sections and the prompt does not duplicate the
  // same facts in structured and raw forms. Parsed data is used separately
  // for evidence ranking and grounding.
  if (String(rawText || '').trim()) return getCvContext(rawText, maxRawChars);
  if (!cvData || !cvData.experience?.length) {
    return getCvContext(rawText, maxRawChars);
  }

  const lines = [];

  if (cvData.contactInfo?.name) {
    lines.push(`**Candidate:** ${cvData.contactInfo.name}`);
  }

  // Seniority + recent roles as a quick orientation line
  const recentRoles = (cvData.experience || [])
    .slice(0, 2)
    .map(e => [e.title, e.company].filter(Boolean).join(' at '))
    .filter(Boolean);
  if (recentRoles.length) {
    lines.push(`**Recent roles:** ${recentRoles.join('; ')}`);
  }
  lines.push('');

  if (cvData.summary) {
    lines.push(`**PROFESSIONAL SUMMARY**\n${cvData.summary}`);
    lines.push('');
  }

  if (cvData.experience?.length) {
    lines.push('**WORK EXPERIENCE**');
    for (const exp of cvData.experience) {
      const header = [exp.title, exp.company, exp.dates]
        .filter(Boolean).join(' | ');
      lines.push(header);
      for (const r of (exp.responsibilities || [])) {
        lines.push(`  • ${r}`);
      }
      lines.push('');
    }
  }

  if (cvData.achievements?.length) {
    lines.push('**KEY EVIDENCE (quantified — use these as primary proof points)**');
    for (const a of cvData.achievements) {
      lines.push(`  • ${a}`);
    }
    lines.push('');
  }

  if (cvData.skills?.length) {
    lines.push(`**SKILLS**\n${cvData.skills.join(', ')}`);
    lines.push('');
  }

  if (cvData.education?.length) {
    lines.push('**EDUCATION**');
    for (const e of cvData.education) {
      lines.push(`  • ${[e.degree, e.institution, e.dates].filter(Boolean).join(', ')}`);
    }
    lines.push('');
  }

  if (cvData.certifications?.length) {
    lines.push(`**CERTIFICATIONS**\n${cvData.certifications.join(', ')}`);
    lines.push('');
  }

  if (cvData.projects?.length) {
    lines.push('**PROJECTS**');
    for (const project of cvData.projects) {
      lines.push([project.name, project.url].filter(Boolean).join(' | ') || 'Project');
      for (const bullet of (project.bullets || project.responsibilities || [])) lines.push(`  • ${bullet}`);
      if (project.skills?.length) lines.push(`  • Technologies: ${project.skills.join(', ')}`);
      lines.push('');
    }
  }

  const structured = lines.join('\n').trim();

  // Sanity: if structured output is suspiciously short, fall back to raw
  if (structured.length < 200) {
    return getCvContext(rawText, maxRawChars);
  }
  return structured;
}

/**
 * Build a pre-writing evidence selection step.
 * Forces the model to identify and name specific CV evidence before writing,
 * reducing generic output and anchoring claims to real experience.
 * Skipped for question types where a story or career evidence is not the core ask.
 */
function buildPreWritingStep(qType, hasJobCtx) {
  const skipTypes = new Set(['salary', 'short_factual', 'data_extraction']);
  if (skipTypes.has(qType)) return '';

  const jdLine = hasJobCtx
    ? '\n3. Which 1–2 JD requirements does this question connect to? How does the CV evidence map to them?'
    : '';

  return `
BEFORE WRITING — reason through this silently (do not include this analysis in your answer):
1. What specific competency or quality is this question testing? Be precise — not just "leadership" but e.g. "recovering a project under pressure" or "influencing without authority".
2. What is the single strongest piece of evidence from MY CV that proves it? Name the company, role, and outcome.${jdLine}

Write the answer using that specific evidence. Anchor every substantive claim to something named.
`;
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

/**
 * Extra brevity constraint injected into system prompts when length === 'short'.
 * Giving the model an explicit instruction at the system level is far more
 * reliable than relying on word counts alone.
 */
function getBrevityInstruction(length) {
  if (length !== 'short') return '';
  return `
BREVITY CONSTRAINT — this is a SHORT answer:
- Maximum 2-3 sentences for simple questions; 4-5 for complex ones that need a story
- Lead with the answer in the very first clause — zero warm-up
- Cut any sentence that could be removed without losing meaning
- Do NOT pad, repeat, or add a closing summary sentence`;
}

// ---------------------------------------------------------------------------
// Question type detection
// ---------------------------------------------------------------------------

function detectQuestionType(question) {
  const q = (question || '').toLowerCase();

  // Cover letter (format, not a topic — check first)
  if (
    q.includes('cover letter') || q.includes('coverletter') ||
    q.includes('covering letter') || q.includes('coveringletter') ||
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

  // Salary / compensation questions need a concrete number or range. They are
  // not CV-story questions, even when the modal has job context available.
  if (isSalaryQuestion(q)) return 'salary';

  // Short factual — about candidate's current situation
  if (
    /notice\s*period/.test(q) ||
    /\bstart\s+date\b/.test(q) ||
    /when\s+(can|could|are)\s+you\s+(start|available|join)/.test(q) ||
    /\bavailability\b/.test(q) ||
    /right\s+to\s+work/.test(q) ||
    /work\s*authori[sz]ation/.test(q) ||
    /\bvisa\s+(status|type|sponsorship)\b/.test(q) ||
    /deadline[s]?\s+or\s+timeline/.test(q) ||
    /timeline\s+consideration/.test(q) ||
    /any\s+(deadline|timeline|constraint|commitment)[s]?\s+(we|you|to)\s+/i.test(q) ||
    /\bimmediately\s+available\b/.test(q) ||
    // Location / residence / timezone form fields ("Where are you located?
    // (State/Province & Country)") are one-line facts about the candidate's
    // current situation, never career-history questions.
    /where\s+(are|do)\s+you\s+(currently\s+)?(located|based|resid|liv)/.test(q) ||
    /\b(current|your)\s+location\b/.test(q) ||
    /\bstate\s*\/?\s*province\b/.test(q) ||
    /\b(city|country)\s+of\s+residence\b/.test(q) ||
    /\bwhat\s+time\s*zone\b/.test(q)
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
    /\b(troubleshoot|troubleshooting|debug|debugging|diagnos(?:e|ing|is)|root\s+cause|rca|incident|unknown|unclear|ambiguous|not\s+immediately\s+know|don['’]?t\s+(immediately\s+)?know)\b/i.test(q) &&
    /\b(how|approach|process|method|steps?|when|what\s+do\s+you\s+do)\b/i.test(q)
  ) return 'troubleshooting';

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

function isSalaryQuestion(question) {
  const q = String(question || '').toLowerCase();
  return (
    /\b(salary|compensation|pay|remuneration)\b/.test(q) ||
    /\b(hourly|daily|monthly|annual|yearly)\s+(rate|pay|salary)\b/.test(q) ||
    /\brate\s+(expectation|requirement|range|desired|expected)s?\b/.test(q)
  ) && (
    /\b(expectation|expectations|requirement|requirements|expected|desired|target|current|range|minimum|min|max|maximum)\b/.test(q) ||
    /\bwhat\s+(salary|compensation|pay|rate)\b/.test(q) ||
    /\bhow\s+much\b/.test(q)
  );
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
    /^gitlab/i,
    /^twitter/i,
    /^(x|x\.com)/i,
    /^(url|link|profile\s*(url|link))$/i,
    /^social\s*(media\s*)?(url|link|profile)/i,
    /^(professional|developer|coding)\s*(profile|url|link)/i,
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

function buildShortFactualPrompt(cvText, question, confirmedFacts = []) {
  const systemPrompt = `You are answering a job application question about the candidate's CURRENT SITUATION or AVAILABILITY — not about their work history.

Answer about the candidate's current status or constraints, NOT their career experience.

Good examples:
- "No, I'm available immediately."
- "I have a 4-week notice period."
- "No timeline constraints — I can start as soon as needed."
- "I'm eligible to work in the UK without sponsorship."

Rules:
- 1-2 sentences maximum
- Never infer a personal fact. If the requested fact is not explicitly present in the CV, return exactly: "Needs your input"
- Do NOT mention past jobs or career history`;

  const cvContext = getCvContext(cvText, 8000);
  const facts = (confirmedFacts || []).filter(Boolean).join('\n');
  const userPrompt = `CV:\n${cvContext}${facts ? `\n\nUSER-CONFIRMED FACTS:\n${facts}` : ''}\n\nQuestion: ${question}\n\nAnswer in 1-2 sentences about the candidate's current situation.`;
  return { systemPrompt, userPrompt, temperature: 0.1, maxTokens: 120 };
}

function buildTechnicalPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData = null) {
  const result = buildGeneralPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData);
  return {
    ...result,
    systemPrompt: `${result.systemPrompt}\n\nTECHNICAL ANSWER CONTRACT:\n- Answer the technical question directly.\n- Name the relevant system, tool, architecture, or implementation from the CV.\n- Explain what you personally did, one important technical decision, and the outcome.\n- Do not claim a technology merely because it appears in the JD.`,
  };
}

function buildSalaryPrompt(cvText, question, jobCtx, jobTitle, salaryBenchmarkHint = '', cvData = null) {
  const q = String(question || '').toLowerCase();
  const asksMonthly = /\b(monthly|per\s+month|\/\s*month|pcm)\b/.test(q);
  const asksAnnual = /\b(annual|annually|yearly|per\s+year|\/\s*year|base\s+salary)\b/.test(q);
  const asksHourly = /\b(hourly|per\s+hour|\/\s*hour|hourly\s+rate)\b/.test(q);
  const asksDaily = /\b(daily|day\s+rate|per\s+day|\/\s*day)\b/.test(q);
  const currency = /\b(usd|us\$|\$)\b/.test(q) ? 'USD'
    : /\b(gbp|gb£|£)\b/.test(q) ? 'GBP'
      : /\b(eur|€)\b/.test(q) ? 'EUR'
        : 'the local currency';

  const period = asksMonthly ? 'monthly'
    : asksHourly ? 'hourly'
      : asksDaily ? 'daily'
        : asksAnnual ? 'annual'
          : 'the period requested by the form';

  const systemPrompt = `You are this candidate completing a salary expectation field in a job application.

This is a SALARY / COMPENSATION question. The answer must be a direct number or range, not a career summary.

Rules:
- Start with the salary expectation in the first words.
- Use ${currency}; use a ${period} figure if the question asks for one.
- If the question asks for monthly USD, answer as "$X-$Y per month".
- Keep it to 1 sentence unless a very short note about negotiability is useful.
- Do NOT mention previous employers, role history, projects, skills, or CV details.
- Do NOT say "As a seasoned professional", "based on my experience", or any similar preamble.
- Do NOT avoid the question with "open to discussion" alone; give a concrete range.
- If exact market data is uncertain, give a reasonable professional range and say it is negotiable.
- If salary benchmark context is provided, use it as the anchor.
- If no salary benchmark context is provided, do not claim to have live, official, or real-time salary data. Still answer with a practical market-informed range and do not mention missing benchmark data to the employer.`;

  const cvContext = buildStructuredCvContext(cvData, cvText, 12000);
  let userPrompt = `MY CV, for seniority context only. Do not summarize it in the answer:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  if (salaryBenchmarkHint) userPrompt += `Salary benchmark context:\n${salaryBenchmarkHint}\n\n`;
  userPrompt += `Question: ${question}

Write only the answer to paste into the form. It must contain a concrete ${currency} ${period} salary range and no CV narrative.`;

  if (jobTitle) {
    userPrompt += ` Use the ${jobTitle} role as the market anchor.`;
  }

  return { systemPrompt, userPrompt, temperature: 0.2, maxTokens: 90 };
}

function buildYesNoPrompt(cvText, question, jobCtx, candidateName, tone, cvData = null) {
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

  const cvContext = buildStructuredCvContext(cvData, cvText);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer directly (max 3 sentences).`;
  return { systemPrompt, userPrompt, temperature: 0.3, maxTokens: 180 };
}

function buildBriefPrompt(cvText, question, jobCtx, candidateName, tone, cvData = null) {
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

Answer this job application question briefly and directly.
${writingGuidance}

Additional rules for brevity:
- 1-3 sentences, maximum 50 words
- Lead with the direct answer, not with setup
- Use one specific, concrete detail from the CV`;

  const cvContext = buildStructuredCvContext(cvData, cvText);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer concisely (max 50 words).`;
  return { systemPrompt, userPrompt, temperature: 0.5, maxTokens: 150 };
}

function buildBehavioralPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData = null) {
  const words = { short: '80-120', medium: '160-220', long: '220-300' }[length] || '160-220';
  const maxTokens = { short: 260, medium: 480, long: 620 }[length] || 480;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a behavioral interview question. Tell ONE specific story from your background.
${writingGuidance}${getBrevityInstruction(length)}

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

  const cvContext = buildStructuredCvContext(cvData, cvText);
  const preWriting = buildPreWritingStep('behavioral', !!jobCtx);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n\n`;
  userPrompt += `${preWriting}
Question: ${question}

Write a ${words}-word answer. First person, no preamble, no "Great question".`;
  return { systemPrompt, userPrompt, temperature: 0.75, maxTokens };
}

function buildTroubleshootingPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData = null) {
  const words = { short: '70-105', medium: '115-165', long: '170-230' }[length] || '115-165';
  const maxTokens = { short: 240, medium: 380, long: 520 }[length] || 380;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a troubleshooting/process question for a job application.
${writingGuidance}${getBrevityInstruction(length)}

WHAT GOOD LOOKS LIKE:
- Open with the candidate's actual troubleshooting method, not a career summary and not a vague "structured approach" sentence.
- The first sentence must name the sequence before any employer/example appears: define or reproduce the issue, gather evidence, isolate variables, test hypotheses, fix, then prevent recurrence.
- Include ONE concrete example from the CV to prove the method is real.
- Sound practical and calm under ambiguity.
- If job context is provided, subtly align the method to what the role needs: production reliability, customer impact, logs, incidents, systems, automation, documentation, or cross-functional debugging.

AVOID:
- "I draw on my experience from various roles"
- "I follow a structured approach" unless the same sentence immediately names the actual steps
- Listing multiple employers without a clear method
- Vague phrases like "break down complex problems" unless followed by the exact steps
- Invented tools, incidents, metrics, or outcomes`;

  const cvContext = buildStructuredCvContext(cvData, cvText);
  const preWriting = buildPreWritingStep('troubleshooting', !!jobCtx);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n\n`;
  userPrompt += `${preWriting}
Question: ${question}

Write a ${words}-word answer with this shape:
1. First sentence: state the actual method as a sequence, e.g. "I start by reproducing the issue, gathering logs and user impact, isolating variables, testing the most likely failure points, then documenting the fix so it does not repeat."
2. Second sentence: explain how you decide what to inspect first based on severity, customer impact, logs, metrics, or recent changes.
3. Then give ONE specific CV example, preferably from production support, incident response, RCA, log analysis, automation, or platform reliability.
4. End: how this process prevents repeat issues or improves future troubleshooting.

First person, no preamble, no bullet list, no headers. Do not repeat the same sentence twice.`;
  return { systemPrompt, userPrompt, temperature: 0.6, maxTokens };
}

/**
 * Focused strength builder — does not mention weaknesses.
 */
function buildStrengthPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData = null) {
  const words = { short: '30-55', medium: '90-130', long: '130-180' }[length] || '90-130';
  const maxTokens = { short: 140, medium: 300, long: 420 }[length] || 300;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a question about your greatest strength.
${writingGuidance}${getBrevityInstruction(length)}

HOW TO ANSWER:
- Name the strength directly in the first sentence
- Prove it immediately with ONE specific, concrete example from the CV — name the company, project, or situation
- Do NOT explain why it is a strength in abstract terms — show it through evidence
- Do NOT name a generic strength ("communication", "teamwork") without immediate proof
- Do NOT pivot to discussing weaknesses or growth areas

NEVER invent examples, employers, or metrics`;

  const cvContext = buildStructuredCvContext(cvData, cvText);
  const preWriting = buildPreWritingStep('strength_weakness', !!jobCtx);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n\n`;
  userPrompt += `${preWriting}
Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.65, maxTokens };
}

/**
 * Focused weakness builder — does not conflate with strengths or pivot away.
 */
function buildWeaknessPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData = null) {
  const words = { short: '30-55', medium: '90-130', long: '130-180' }[length] || '90-130';
  const maxTokens = { short: 140, medium: 300, long: 420 }[length] || 300;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a question about a weakness or area for improvement.
${writingGuidance}${getBrevityInstruction(length)}

HOW TO ANSWER:
- Name something REAL — not "I work too hard", "I'm a perfectionist", or "I care too much"
- State the weakness clearly in the first sentence — do not bury it
- Describe what you have been actively doing to address it — be concrete (a course, a changed habit, a mentor, a process change)
- Keep it brief — this is not the main event of the application
- Do NOT pivot to discussing a strength or reframe the weakness as secretly a positive trait

NEVER fabricate examples or claim you have no weaknesses`;

  const cvContext = buildStructuredCvContext(cvData, cvText);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n`;
  userPrompt += `Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.65, maxTokens };
}

function buildMotivationPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData = null) {
  const words = { short: '35-60', medium: '100-150', long: '150-200' }[length] || '100-150';
  const maxTokens = { short: 160, medium: 340, long: 460 }[length] || 340;
  const hasJobCtx = !!jobCtx;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a question about your motivation or interest in this role/field.
${writingGuidance}${getBrevityInstruction(length)}

HOW TO WRITE A GENUINE MOTIVATION ANSWER:
- Be specific about WHAT interests you — name the actual thing (a technology, a problem space, a type of work)
- Connect it to something real in your background — a project, a role, a skill you've been building
- Explain why THIS role is the right next step based on your actual career direction
- ${hasJobCtx ? 'Use specific language from the job description to show you understand what they need' : 'Draw on clear patterns visible in your career history'}

Do NOT:
- Open with "I'm excited/passionate/driven by..."
- Give a vague "I enjoy helping people" type answer
- Write about the company being "amazing" or the "incredible opportunity"`;

  const cvContext = buildStructuredCvContext(cvData, cvText);
  const preWriting = buildPreWritingStep('motivation', hasJobCtx);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n\n`;
  userPrompt += `${preWriting}
Question: ${question}\n\nAnswer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.75, maxTokens };
}

function buildWhyCompanyPrompt(cvText, question, length, jobCtx, jobTitle, company, candidateName, tone, cvData = null) {
  const words = { short: '45-70', medium: '110-160', long: '160-220' }[length] || '110-160';
  const maxTokens = { short: 180, medium: 380, long: 520 }[length] || 380;
  const hasJobCtx = !!jobCtx;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a "why this company / why this role" question.
${writingGuidance}${getBrevityInstruction(length)}

MANDATORY STRUCTURE — in this exact order:
1. COMPANY/ROLE FIRST: Open with 1-2 sentences naming something SPECIFIC about the company or role from the job description — their mission, the product they build, a specific challenge they're tackling, a responsibility that stood out. This MUST come before any mention of your background.
2. YOUR CONNECTION: 2-3 sentences connecting specific things from the role/company to concrete evidence from your CV.
3. CLOSE: One sentence on why this is the logical next step in your career direction.

CRITICAL:
- If job context is provided, the opening MUST reference something specific from it — do NOT open with your CV history
- "I've always been interested in AI" is not specific enough — say WHICH aspect of the company's work / which part of the job description resonates and WHY
- This answer must be impossible to reuse for a different company — it must feel written specifically for THIS role
${!hasJobCtx ? '- No job description provided: open with what the company/role name clearly implies, then connect to your CV' : ''}`;

  const cvContext = buildStructuredCvContext(cvData, cvText);
  const preWriting = buildPreWritingStep('why_company', hasJobCtx);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n\n`;
  userPrompt += `${preWriting}
Question: ${question}

Start your answer with something specific about ${company || 'the company'} or this role — NOT with your own background. Then connect it to your CV.

Answer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.75, maxTokens };
}

function buildCoverLetterPrompt(cvText, question, length, jobCtx, jobTitle, company, candidateName, tone, cvData = null) {
  const words = { short: '120-170', medium: '250-350', long: '350-450' }[length] || '250-350';
  const maxTokens = { short: 420, medium: 800, long: 1100 }[length] || 800;
  const writingGuidance = getWritingGuidance(tone);
  const hasJobCtx = !!jobCtx;

  const systemPrompt = `${identityPreamble(candidateName)}

You are writing a cover letter for this role.
${writingGuidance}

STRUCTURE (mandatory):
1. "Dear Hiring Manager," (or "Dear [Company] team," if company name is known)
2. Opening paragraph: ONE specific thing about the company/business/mission/product/team OR role that connects directly to your background — not generic enthusiasm
3. 2-3 body paragraphs: map specific job requirements to specific CV evidence — use different roles/time periods when possible, don't just summarise your most recent job
4. Closing: brief, confident, genuine — "I'd welcome the chance to discuss how I could contribute."
5. Sign-off: "Sincerely,\n[Your Name]"

Rules:
- ${hasJobCtx ? 'The job context is provided. You MUST use one concrete company/business detail from it in the opening paragraph when available, such as what the company builds, who it serves, its mission, market, product, or operating environment.' : 'No job context is provided, so do not invent company mission, products, customers, funding, market, or culture.'}
- Do not only repeat the job title and location; that is not company-specific enough
- Reference at least 3 specific requirements from the job description if provided
- Every paragraph should earn its place — no padding
- NEVER invent employers, degrees, dates, or metrics
- A generic letter that could be sent to any company is a failure — make it specific`;

  const cvContext = buildStructuredCvContext(cvData, cvText);
  const preWriting = buildPreWritingStep('cover_letter', !!jobCtx);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n\n`;
  userPrompt += `${preWriting}
Write a cover letter for${jobTitle ? ` the ${jobTitle} role` : ' this role'}${company ? ` at ${company}` : ''}.
${hasJobCtx ? 'In the first paragraph, explicitly connect my background to one real company/business detail from the role context above. Do not settle for only naming the role.' : ''}
Target length: ${words} words. Start with "Dear..." — no preamble before the letter.`;
  return { systemPrompt, userPrompt, temperature: 0.72, maxTokens };
}

function buildGeneralPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData = null) {
  const words = { short: '30-55', medium: '90-140', long: '150-220' }[length] || '90-140';
  const maxTokens = { short: 160, medium: 340, long: 520 }[length] || 340;
  const hasJobCtx = !!jobCtx;
  const writingGuidance = getWritingGuidance(tone);

  const systemPrompt = `${identityPreamble(candidateName)}

You are answering a job application question.
${writingGuidance}${getBrevityInstruction(length)}

HOW TO APPROACH THIS:
1. Read the question carefully — what is it ACTUALLY asking? (experience with X? your approach to Y? a specific capability?)
2. Identify the ONE piece of your background that most directly and convincingly answers it
3. Lead with that — don't bury the answer

If the question is about a specific skill or technology: confirm clearly whether you have it, then give one concrete example of using it.
If the question is about your approach or process: describe how you actually work, with a real example.
If the question is broad: pick the angle from your background that's most relevant to ${hasJobCtx ? 'what this role needs' : 'the question'}.

${hasJobCtx ? 'The job context is provided — use it to tailor your answer to what this specific role actually needs.' : ''}`;

  const cvContext = buildStructuredCvContext(cvData, cvText);
  const preWriting = buildPreWritingStep('general', hasJobCtx);
  let userPrompt = `MY CV:\n${cvContext}\n\n`;
  if (jobCtx) userPrompt += `Role I'm applying for:\n${jobCtx}\n\n`;
  userPrompt += `${preWriting}
Question: ${question}

Answer in approximately ${words} words. First person, no preamble.`;
  return { systemPrompt, userPrompt, temperature: 0.75, maxTokens };
}

// ---------------------------------------------------------------------------
// Match strength / confidence calibration
// ---------------------------------------------------------------------------

function calcMatchStrength(matchMap) {
  if (!Array.isArray(matchMap) || matchMap.length === 0) return { level: 'unknown', score: 0, supportedCount: 0, totalCount: 0 };
  const scoreable = matchMap.filter(m => m.type !== 'user_confirmed');
  const total = scoreable.length;
  if (total === 0) return { level: 'unknown', score: 0, supportedCount: 0, totalCount: 0 };
  const supported = scoreable.filter(m => m.allowedToMention).length;
  const score = supported / total;
  const level = score >= 0.65 ? 'strong' : score >= 0.40 ? 'moderate' : 'weak';
  return { level, score, supportedCount: supported, totalCount: total };
}

function buildConfidenceInstruction(matchStrength) {
  return {
    strong:   'MATCH LEVEL: STRONG — the CV covers most requirements for this role. Write with confidence and assertive, achievement-led language for supported claims.',
    moderate: 'MATCH LEVEL: MODERATE — the CV covers some requirements. Write confidently where supported; frame gaps honestly as transferable experience.',
    weak:     'MATCH LEVEL: WEAK — the CV has limited direct matches. Focus on genuine transferable evidence. Do not overstate. Be honest about what is supported.',
  }[matchStrength.level] || '';
}

// ---------------------------------------------------------------------------
// Structured-data enrichment helpers
// ---------------------------------------------------------------------------

// Words common in question phrasing that score too many unrelated CV bullets.
const HINT_STOP = new Set([
  'about', 'would', 'could', 'should', 'where', 'which', 'while', 'since',
  'other', 'being', 'using', 'doing', 'going', 'describe', 'example',
  'situation', 'experience', 'share', 'think', 'tell', 'give', 'walk',
  'through', 'worked', 'working', 'candidate', 'application', 'answer',
]);

function significantWords(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length >= 5 && !HINT_STOP.has(w))
  )];
}

const EVIDENCE_CONCEPTS = [
  ['leadership', 'led', 'managed', 'mentored', 'coached', 'owned', 'directed'],
  ['influence', 'influenced', 'influencing', 'persuaded', 'aligned', 'buy-in', 'stakeholder', 'negotiated'],
  ['collaboration', 'collaborated', 'partnered', 'cross-functional', 'stakeholder', 'team'],
  ['troubleshooting', 'debugged', 'diagnosed', 'investigated', 'root cause', 'incident', 'resolved'],
  ['reliability', 'availability', 'incident', 'outage', 'production', 'resilience', 'stability'],
  ['customer', 'client', 'user', 'discovery', 'adoption', 'support', 'escalation'],
  ['improved', 'increased', 'reduced', 'saved', 'grew', 'delivered', 'automated', 'optimised', 'optimized'],
  ['pressure', 'deadline', 'urgent', 'critical', 'incident', 'escalation', 'recovered'],
  ['ambiguity', 'ambiguous', 'unclear', 'undefined', 'discovery', 'requirements'],
  ['communication', 'presented', 'explained', 'documented', 'workshop', 'trained', 'authored'],
];

function conceptKeys(text) {
  const haystack = String(text || '').toLowerCase();
  return EVIDENCE_CONCEPTS
    .filter(group => group.some(term => haystack.includes(term)))
    .map(group => group[0]);
}

function overlapScore(words, text, queryText = '') {
  const haystack = String(text || '').toLowerCase();
  const lexical = words.filter(w => haystack.includes(w)).length * 3;
  const wantedConcepts = new Set(conceptKeys(queryText));
  const semantic = conceptKeys(text).filter(key => wantedConcepts.has(key)).length * 2;
  const metricBoost = /(?:[$£€]\s*\d|\b\d+(?:\.\d+)?\s*(?:%|x\b|users?|customers?|weeks?|months?|years?))/i.test(text) ? 1 : 0;
  return lexical + semantic + metricBoost;
}

function evidenceCandidateKey(item) {
  return `${String(item.label || '').toLowerCase()}|${String(item.text || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

function collectEvidenceCandidates(cvData = {}) {
  const candidates = [];
  const add = (item) => {
    if (!String(item?.text || '').trim()) return;
    candidates.push(item);
  };

  (cvData.experience || []).forEach(exp => {
    const label = [exp.title, exp.company].filter(Boolean).join(' @ ') || 'Experience';
    (exp.responsibilities || []).forEach(text => add({ text, label, sourceKey: exp.sourceId || label }));
  });
  (cvData.projects || []).forEach(project => {
    const label = `Project: ${project.name || 'Unnamed project'}`;
    const sourceKey = project.sourceId || label;
    if (project.name || project.url) add({ text: [project.name, project.url].filter(Boolean).join(' | '), label, sourceKey });
    (project.bullets || project.responsibilities || []).forEach(text => add({ text, label, sourceKey }));
    (project.skills || []).forEach(text => add({ text, label: `${label} skill`, sourceKey }));
  });
  (cvData.achievements || []).forEach(text => add({ text, label: 'Achievement', sourceKey: `achievement:${text}` }));
  (cvData.certifications || []).forEach(text => add({ text, label: 'Certification', sourceKey: `certification:${text}` }));
  (cvData.skills || []).forEach(text => add({ text, label: 'Skill', sourceKey: `skill:${text}` }));
  (cvData.education || []).forEach((item, index) => add({
    text: typeof item === 'string' ? item : [item.degree, item.institution, item.dates].filter(Boolean).join(', '),
    label: 'Education', sourceKey: `education:${index}`,
  }));
  if (cvData.summary) add({ text: cvData.summary, label: 'Professional Summary', sourceKey: 'summary' });
  (cvData.evidenceIndex || []).forEach(item => add({
    text: item.text, label: item.label || String(item.type || 'Additional CV evidence').replace(/_/g, ' '),
    sourceKey: item.sourceId || `indexed:${item.text}`,
  }));

  const seen = new Set();
  return candidates.filter(item => {
    const key = evidenceCandidateKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Surface the CV bullets most lexically relevant to this question.
 * Injected before MY CV: so the model knows where to look without losing
 * the full CV as fallback context.
 * Returns '' if cvData is absent or no bullets score above zero.
 */
function buildEvidenceHint(cvData, question, jdData = null, semanticEvidence = []) {
  if (!cvData) return '';

  const jdFocus = [
    ...(jdData?.responsibilities || []).slice(0, 6),
    ...(jdData?.requiredSkills || []).slice(0, 10),
    ...(jdData?.tools || []).slice(0, 10),
  ].join(' ');
  const questionWords = significantWords(question);
  const jdWords = significantWords(jdFocus);
  if (questionWords.length === 0 && jdWords.length === 0) return '';

  const semanticScores = new Map();
  for (const item of (semanticEvidence || [])) {
    const score = Number(item.semanticScore || 0);
    if (item.sourceId) semanticScores.set(String(item.sourceId).toLowerCase(), score);
    if (item.text) semanticScores.set(String(item.text).toLowerCase(), score);
  }
  const ranked = collectEvidenceCandidates(cvData)
    .map(item => {
      const questionScore = overlapScore(questionWords, item.text, question);
      const jdScore = overlapScore(jdWords, item.text, jdFocus);
      const semanticScore = semanticScores.get(String(item.sourceKey || '').toLowerCase())
        || semanticScores.get(String(item.text || '').toLowerCase()) || 0;
      return { ...item, questionScore, jdScore, semanticScore, score: questionScore * 3 + jdScore + semanticScore * 8 };
    })
    // For a specific question, JD relevance may break ties but cannot make
    // unrelated evidence relevant by itself. Cover letters are intentionally
    // broad and may use evidence selected primarily from the JD.
    .filter(item => item.score > 0 && (questionWords.length === 0 || item.questionScore > 0 || item.semanticScore > 0 || /cover(?:ing)?\s+letter/i.test(question)))
    .sort((a, b) => b.score - a.score || b.questionScore - a.questionScore);

  const selected = [];
  const usedRoles = new Set();
  for (const bullet of ranked) {
    if (selected.length >= 6) break;
    if (usedRoles.has(bullet.sourceKey)) continue;
    selected.push(bullet);
    usedRoles.add(bullet.sourceKey);
  }
  for (const bullet of ranked) {
    if (selected.length >= 6) break;
    if (selected.includes(bullet)) continue;
    selected.push(bullet);
  }

  if (selected.length === 0) return '';

  const lines = selected.map(b => `  • [${b.label}] ${b.text.slice(0, 220)}`);
  return `MOST RELEVANT CV BULLETS AND EVIDENCE FOR THIS QUESTION AND ROLE:\n${lines.join('\n')}\n\n`;
}

function buildJdFocusBlock(jdData, qType) {
  if (!jdData || !['motivation', 'why_company', 'cover_letter'].includes(qType)) return '';

  const responsibilities = (jdData.responsibilities || []).slice(0, qType === 'cover_letter' ? 5 : 3);
  const keywords = [
    ...(jdData.requiredSkills || []),
    ...(jdData.tools || []),
    ...(jdData.atsKeywords || []),
  ].filter(Boolean);
  const uniqueKeywords = [...new Set(keywords.map(k => String(k).trim()).filter(Boolean))].slice(0, 12);

  if (responsibilities.length === 0 && uniqueKeywords.length === 0) return '';

  let block = 'ROLE/JD SIGNALS TO USE FOR TAILORING:\n';
  if (responsibilities.length > 0) {
    block += `Responsibilities that matter:\n${responsibilities.map(r => `  - ${r}`).join('\n')}\n`;
  }
  if (uniqueKeywords.length > 0) {
    block += `Keywords/tools to echo naturally: ${uniqueKeywords.join(', ')}\n`;
  }
  return `${block}\n`;
}

/**
 * Map the question to the candidate's strongest matched JD requirements
 * and surface their CV evidence. Injected right before the question so
 * the model knows exactly which proof points to use.
 * Returns '' if matchMap is absent or no matched requirements exist.
 */
function buildRequirementsBridge(matchMap, question, qType) {
  if (!Array.isArray(matchMap) || matchMap.length === 0) return '';

  const qWords = significantWords(question);
  const allowTopMatchesWithoutQuestionOverlap = qType === 'cover_letter';

  const candidates = matchMap
    .filter(m => m.allowedToMention && m.evidence && m.evidence.length > 0)
    .map(m => {
      const reqTokens = significantWords(m.requirement);
      const overlap = qWords.filter(w => reqTokens.includes(w)).length;
      return { requirement: m.requirement, evidence: m.evidence, overlap };
    })
    .filter(m => allowTopMatchesWithoutQuestionOverlap || m.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.evidence.length - a.evidence.length)
    .slice(0, 3);

  if (candidates.length === 0) return '';

  const lines = candidates.map(c => {
    const ev = (c.evidence[0] || '').slice(0, 110);
    return ev
      ? `  ✓ ${c.requirement}\n    → "${ev}"`
      : `  ✓ ${c.requirement}`;
  });

  return `JD REQUIREMENTS YOUR BACKGROUND COVERS (use these as your proof points):\n${lines.join('\n')}\n\n`;
}

function buildUnsupportedBridge(matchMap, question, qType) {
  if (!Array.isArray(matchMap) || matchMap.length === 0) return '';
  if (!['yes_no', 'general', 'brief'].includes(qType)) return '';

  const qWords = significantWords(question);
  if (qWords.length === 0) return '';

  const candidates = matchMap
    .filter(m => !m.allowedToMention)
    .map(m => {
      const reqTokens = significantWords(m.requirement);
      const overlap = qWords.filter(w => reqTokens.includes(w)).length;
      return { requirement: m.requirement, overlap };
    })
    .filter(m => m.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3);

  if (candidates.length === 0) return '';

  const lines = candidates.map(c => `  - ${c.requirement}`);
  return `NOT CONFIRMED BY THE CV OR USER REVIEW:\n${lines.join('\n')}\nIf the question asks about one of these directly, do not claim it. Say "Not directly" and pivot to the closest truthful adjacent experience.\n\n`;
}

function buildDomainRiskBlock(domainRisk, qType) {
  if (!domainRisk?.detected || ['salary', 'short_factual', 'data_extraction'].includes(qType)) return '';
  const profile = domainRisk.primaryProfile?.label || 'Domain-sensitive role';
  const warnings = Array.isArray(domainRisk.credentialWarnings) ? domainRisk.credentialWarnings : [];
  const prompts = Array.isArray(domainRisk.reviewPrompts) ? domainRisk.reviewPrompts : [];
  const missingCredentials = [...new Set(warnings.flatMap(item => item.missingCredentials || []))]
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  let block = `DOMAIN REVIEW GUARD:\n  Detected profile: ${profile}.\n`;
  if (missingCredentials.length > 0) {
    block += `  Do not claim these credentials unless they are explicitly present in the CV or user-confirmed: ${missingCredentials.join(', ')}.\n`;
  }
  if (prompts.length > 0) {
    block += `  Review prompts before strong claims: ${prompts.slice(0, 3).join(' | ')}\n`;
  }
  block += '  If a regulated credential, clearance, license, certification, publication, or portfolio proof is not supported, leave it out or frame the answer as adjacent/transferable experience.\n\n';
  return block;
}

function buildRoleCredibilityBlock(jdData, qType) {
  const roleProfile = jdData?.roleProfile;
  if (!roleProfile || ['salary', 'short_factual'].includes(qType)) return '';

  const family = roleProfile.family || 'Target role';
  const signals = [
    ...(roleProfile.credibilitySignals || []),
    ...(jdData.credibilitySignals || []),
  ].map(item => String(item || '').trim()).filter(Boolean);
  const transferable = [
    ...(roleProfile.transferableEvidence || []),
    ...(jdData.transferableEvidence || []),
  ].map(item => String(item || '').trim()).filter(Boolean);
  const risks = [
    ...(roleProfile.riskClaims || []),
    ...(jdData.unsupportedClaimRisks || []),
  ].map(item => String(item || '').trim()).filter(Boolean);

  const unique = values => {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const key = value.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
    return result;
  };

  const uniqueSignals = unique(signals).slice(0, 8);
  const uniqueTransferable = unique(transferable).slice(0, 5);
  const uniqueRisks = unique(risks).slice(0, 8);
  if (uniqueSignals.length === 0 && uniqueTransferable.length === 0 && uniqueRisks.length === 0) return '';

  let block = `ROLE CREDIBILITY RUBRIC:\n  Role family: ${family}\n`;
  if (uniqueSignals.length > 0) {
    block += `  What a credible answer should prove: ${uniqueSignals.join(', ')}\n`;
  }
  if (uniqueTransferable.length > 0) {
    block += `  Transferable evidence you may use honestly: ${uniqueTransferable.join('; ')}\n`;
  }
  if (uniqueRisks.length > 0) {
    block += `  Do not claim without direct CV evidence or user confirmation: ${uniqueRisks.join(', ')}\n`;
  }
  block += '  Use this rubric to choose evidence, not to stuff keywords. If direct proof is thin, be honest and pivot to adjacent supported experience.\n\n';
  return block;
}

/**
 * Inject structured-data hints into a user prompt.
 * Evidence hint goes before MY CV: (guidance on where to look).
 * JD focus and requirements bridge go before Question: or Write a cover letter
 * (role signals first, then matched proof points closest to the answer task).
 * If neither insertion point is found the prompt is returned unchanged.
 */
function injectHints(userPrompt, evidenceHint, jdFocusBlock, roleCredibilityBlock, bridge, unsupportedBridge = '', domainRiskBlock = '') {
  let p = userPrompt;
  if (evidenceHint) {
    p = p.replace(/^MY CV:/m, `${evidenceHint}MY CV:`);
  }
  if (jdFocusBlock) {
    p = p.replace(/^(Question:|Write a cover letter)/m, `${jdFocusBlock}$1`);
  }
  if (roleCredibilityBlock) {
    p = p.replace(/^(Question:|Write a cover letter)/m, `${roleCredibilityBlock}$1`);
  }
  if (bridge) {
    p = p.replace(/^(Question:|Write a cover letter)/m, `${bridge}$1`);
  }
  if (unsupportedBridge) {
    p = p.replace(/^(Question:|Write a cover letter)/m, `${unsupportedBridge}$1`);
  }
  if (domainRiskBlock) {
    p = p.replace(/^(Question:|Write a cover letter)/m, `${domainRiskBlock}$1`);
  }
  return p;
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
    cvData,
    jdData,
    matchMap,
    roleProfile,
    domainRisk,
    jobTitle,
    company,
    jobDescription,
    requirements,
    maxChars,
    semanticEvidence = [],
    confirmedFacts = [],
  } = input;

  // Plain field labels (name, email, LinkedIn, phone, etc.)
  if (isDataExtractionQuestion(question)) {
    return buildExtractionPrompt(cvText, question);
  }

  const jobCtx = buildJobContext(jobTitle, company, jobDescription, requirements);
  const enrichedJdData = (jdData || roleProfile || jobTitle || company)
    ? {
        ...(jdData || {}),
        jobTitle: jdData?.jobTitle || jobTitle,
        company: jdData?.company || company,
        roleProfile: jdData?.roleProfile || roleProfile,
      }
    : jdData;
  const candidateName = extractCandidateName(cvText);
  const classification = classifyApplicationQuestion(question);
  const qType = classification.type;
  let salaryBenchmarkHint = '';
  if (qType === 'salary') {
    const salaryBenchmarks = new SalaryBenchmarkService();
    salaryBenchmarkHint = salaryBenchmarks.formatForPrompt(salaryBenchmarks.lookup({
      jobTitle,
      question,
      jobDescription,
      roleProfile: enrichedJdData?.roleProfile,
    }));
  }

  let result;
  switch (qType) {
    case 'salary':
      result = buildSalaryPrompt(cvText, question, jobCtx, jobTitle, salaryBenchmarkHint, cvData);
      {
        const salaryFacts = confirmedFacts.filter(value => /salary|compensation|pay/i.test(value));
        if (salaryFacts.length) result.userPrompt += `\n\nUSER-CONFIRMED SALARY EXPECTATION (use this instead of estimating):\n${salaryFacts.join('\n')}`;
      }
      break;
    case 'short_factual':
    case 'personal_factual':
    case 'sensitive_voluntary':
      result = buildShortFactualPrompt(cvText, question, confirmedFacts);
      break;
    case 'yes_no':
      result = buildYesNoPrompt(cvText, question, jobCtx, candidateName, tone, cvData);
      break;
    case 'brief':
      result = buildBriefPrompt(cvText, question, jobCtx, candidateName, tone, cvData);
      break;
    case 'behavioral':
      result = buildBehavioralPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData);
      break;
    case 'troubleshooting':
      result = buildTroubleshootingPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData);
      break;
    case 'technical':
      result = buildTechnicalPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData);
      break;
    case 'strength_weakness': {
      const isWeakness = /weakness(es)?|areas?\s+(for|of|to)\s+improve(ment)?|development\s+area|improve\s+about\s+yourself/i.test(question);
      const isStrength = /\bstrength(s)?\b/i.test(question);
      result = (isStrength && isWeakness)
        ? buildGeneralPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData)
        : isWeakness
          ? buildWeaknessPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData)
          : buildStrengthPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData);
      break;
    }
    case 'motivation':
      result = buildMotivationPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData);
      break;
    case 'why_company':
      result = buildWhyCompanyPrompt(cvText, question, length, jobCtx, jobTitle, company, candidateName, tone, cvData);
      break;
    case 'cover_letter':
      result = buildCoverLetterPrompt(cvText, question, length, jobCtx, jobTitle, company, candidateName, tone, cvData);
      break;
    default:
      result = buildGeneralPrompt(cvText, question, length, jobCtx, candidateName, tone, cvData);
  }

  // Inject structured-data hints for question types where structured context
  // meaningfully improves specificity. Skipped for salary, short factual, and
  // data extraction prompts where CV stories would be noise.
  const HINT_TYPES = new Set([
    'behavioral', 'troubleshooting', 'strength_weakness',
    'motivation', 'why_company', 'cover_letter', 'general', 'technical', 'yes_no', 'brief',
  ]);

  // Inject confidence calibration into the system prompt so the model knows
  // how assertively to write based on how well the CV covers the role.
  if (result && Array.isArray(matchMap) && matchMap.length > 0 && HINT_TYPES.has(qType)) {
    const matchStrength = calcMatchStrength(matchMap);
    const confidenceInstruction = buildConfidenceInstruction(matchStrength);
    if (confidenceInstruction) {
      result = { ...result, systemPrompt: `${result.systemPrompt}\n\n${confidenceInstruction}` };
    }
  }

  if (result && HINT_TYPES.has(qType)) {
    const evidenceHint = buildEvidenceHint(cvData, question, enrichedJdData, semanticEvidence);
    const jdFocusBlock = buildJdFocusBlock(enrichedJdData, qType);
    const roleCredibilityBlock = buildRoleCredibilityBlock(enrichedJdData, qType);
    const bridge = buildRequirementsBridge(matchMap, question, qType);
    const unsupportedBridge = buildUnsupportedBridge(matchMap, question, qType);
    const domainRiskBlock = buildDomainRiskBlock(domainRisk, qType);
    if (evidenceHint || jdFocusBlock || roleCredibilityBlock || bridge || unsupportedBridge || domainRiskBlock) {
      result = { ...result, userPrompt: injectHints(result.userPrompt, evidenceHint, jdFocusBlock, roleCredibilityBlock, bridge, unsupportedBridge, domainRiskBlock) };
    }
  }

  // Append a hard character limit instruction when the form field has a known maxlength.
  // This is more reliable than post-generation truncation — the model targets the right
  // length from the start rather than needing to be cut afterwards.
  if (maxChars > 0) {
    result.userPrompt += `\n\nHARD LIMIT: This form field accepts a maximum of ${maxChars} characters. Your entire answer must be ${maxChars} characters or fewer (including spaces). Write concisely to stay within this limit.`;
  }

  if (classification.multiPart) {
    result.userPrompt += '\n\nMULTI-PART QUESTION: Answer every part explicitly and in the order asked. Use a short paragraph or numbered structure when useful. Do not omit a part.';
  }

  const orchestrated = withAgentPromptHeader(result, 'applicationAnswer');
  return orchestrated ? { ...orchestrated, questionType: qType } : orchestrated;
}
