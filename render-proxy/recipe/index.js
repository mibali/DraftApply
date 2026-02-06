/**
 * Recipe plug-in interface (public example).
 *
 * This file ships with the open-source proxy engine as a **sample** recipe.
 * Replace it (or override via RECIPE_PATH env var) with your own private
 * implementation to customise prompt engineering, ranking, and tailoring.
 *
 * Contract:
 *   buildPrompts(input)  → { systemPrompt: string, userPrompt: string, temperature?: number }
 *
 * `input` is a structured payload sent by the extension:
 *   {
 *     question:        string,   // the application question / field label
 *     length:          'short' | 'medium' | 'long',
 *     cvText:          string,   // full CV text
 *     jobTitle:        string?,  // extracted job title
 *     company:         string?,  // extracted company name
 *     jobDescription:  string?,  // extracted job description
 *     requirements:    string[]?,// extracted key requirements
 *     pageUrl:         string?,  // URL of the application page
 *     platform:        string?,  // detected ATS platform
 *   }
 */

/**
 * Build LLM prompts from structured input.
 * This example produces a basic, non-proprietary prompt.
 * @param {Object} input - Structured generation input
 * @returns {{ systemPrompt: string, userPrompt: string, temperature?: number }}
 */
/**
 * Strip common form-field artifacts: required markers (*), colons, etc.
 */
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
 * Detect simple data-extraction questions (name, email, phone, linkedin, etc.)
 */
function isDataExtractionQuestion(question) {
  const q = cleanFieldLabel(question);
  const dataPatterns = [
    /^(full\s*)?name$/i,
    /^(first|last|middle|legal|preferred)\s*name$/i,
    /^name\s*(first|last|middle|legal)?$/i,
    /^linkedin/i, /^(email|e-mail)/i, /^phone/i, /^(mobile|cell)/i,
    /^address/i, /^(city|state|zip|postal|country)/i, /^location$/i,
    /^website/i, /^(personal\s*)?portfolio/i, /^github/i, /^twitter/i,
    /^(current\s*)?(job\s*)?title$/i, /^(current\s*)?company$/i,
    /^(current\s*)?employer$/i, /^(your\s*)?(date\s*of\s*)?birth/i,
    /^nationality$/i, /^visa\s*status$/i, /^work\s*authori[sz]ation$/i,
    /^salary/i, /^notice\s*period$/i, /^availability$/i, /^start\s*date$/i,
  ];
  return dataPatterns.some(p => p.test(q));
}

export function buildPrompts(input) {
  const {
    question,
    length = 'medium',
    cvText = '',
    jobTitle,
    company,
    jobDescription,
    requirements,
  } = input;

  // ── Data-extraction shortcut ──────────────────────────────────────────
  if (isDataExtractionQuestion(question)) {
    const cleanQ = cleanFieldLabel(question);
    return {
      systemPrompt: `You are a data extraction assistant. Extract ONLY the requested information from the CV.\n\nRULES:\n- Return ONLY the exact value requested, nothing else\n- No sentences, no explanations, no formatting\n- If the information is not found, respond with: "Not found in CV"\n- For URLs, return the full URL\n- For names, return just the name\n- For phone numbers, include country code if present`,
      userPrompt: `CV:\n${cvText.slice(0, 2500)}\n\nExtract: ${cleanQ}\n\nReturn ONLY the value, nothing else.`,
      temperature: 0.1,
    };
  }

  // ── General answer ────────────────────────────────────────────────────
  const lengthSpec = {
    short: '50-80 words',
    medium: '100-150 words',
    long: '200-300 words',
  }[length] || '100-150 words';

  const systemPrompt = `You are a career coach helping a candidate write answers to job application questions.

Rules:
1. Write in first person as the candidate.
2. Use specific examples from the CV when possible.
3. Do not invent facts not present in the CV.
4. Sound natural and human.`;

  let userPrompt = `## CV\n${cvText.slice(0, 6000)}\n\n`;

  if (jobDescription) {
    userPrompt += `## Job Description\n`;
    if (jobTitle) userPrompt += `Position: ${jobTitle}\n`;
    if (company) userPrompt += `Company: ${company}\n`;
    userPrompt += `${jobDescription.slice(0, 4000)}\n\n`;

    if (requirements && requirements.length > 0) {
      userPrompt += `Key requirements:\n`;
      for (const req of requirements.slice(0, 8)) {
        userPrompt += `- ${req}\n`;
      }
      userPrompt += '\n';
    }
  }

  userPrompt += `## Question\n${question}\n\n`;
  userPrompt += `Write approximately ${lengthSpec}. First person, no preamble.`;

  return { systemPrompt, userPrompt, temperature: 0.7 };
}
