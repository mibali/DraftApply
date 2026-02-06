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
