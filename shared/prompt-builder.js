/**
 * Prompt Builder Module
 * 
 * Constructs optimized prompts for LLM-based answer generation.
 * This is the core of the "intelligence" - how we frame CV data
 * and questions to get human-like, authentic responses.
 * 
 * DESIGN DECISIONS:
 * 1. CV is PRIMARY context but not a prison - we allow natural inference
 * 2. Question type detection enables tone/approach adaptation
 * 3. Response length is controllable for different form field sizes
 * 4. Anti-AI-speak instructions are baked into the system prompt
 */

export class PromptBuilder {
  constructor() {
    this.questionTypes = {
      cover_letter: [
        'cover letter',
        'coverletter',
        'letter of interest',
        'motivation letter',
        'application letter',
        'write a cover letter',
        'write cover letter'
      ],
      behavioral: [
        'tell me about a time',
        'describe a situation',
        'give an example',
        'how did you handle',
        'what would you do if',
        'have you ever'
      ],
      technical: [
        'experience with',
        'familiar with',
        'technical skills',
        'programming',
        'technology',
        'tools',
        'systems',
        'architecture'
      ],
      leadership: [
        'leadership',
        'managed',
        'team',
        'mentored',
        'delegated',
        'conflict',
        'difficult colleague'
      ],
      motivation: [
        'why do you want',
        'what interests you',
        'why are you applying',
        'what motivates',
        'career goals',
        'where do you see yourself'
      ],
      culture: [
        'work environment',
        'company culture',
        'values',
        'work-life',
        'collaboration',
        'remote work'
      ],
      strengths: [
        'strengths',
        'weaknesses',
        'best quality',
        'areas for improvement',
        'what are you good at'
      ]
    };

    this.responseLengths = {
      short: { words: '50-80', sentences: '2-3' },
      medium: { words: '100-150', sentences: '4-6' },
      long: { words: '200-300', sentences: '8-12' }
    };
  }

  /**
   * Detect the type of question being asked
   * @param {string} question - The job application question
   * @returns {string} Question type
   */
  detectQuestionType(question) {
    const lowerQuestion = question.toLowerCase();
    
    for (const [type, patterns] of Object.entries(this.questionTypes)) {
      for (const pattern of patterns) {
        if (lowerQuestion.includes(pattern)) {
          return type;
        }
      }
    }
    
    return 'general';
  }

  /**
   * Build the system prompt that sets up the LLM's behavior
   * @returns {string} System prompt
   */
  buildSystemPrompt() {
    return `You are an expert career coach helping a job candidate write authentic, compelling answers to job application questions.

CRITICAL INSTRUCTIONS:
1. You ARE the candidate. Write in first person as if you are them.
2. Base your answers primarily on the CV provided, but you may use reasonable professional inference.
3. NEVER invent specific facts: employers, job titles, degrees, certifications, dates, or metrics not in the CV.
4. You MAY infer motivations, reasoning, soft skills, and professional approach based on CV patterns.
5. Sound human and genuine - avoid corporate buzzwords and AI-speak.
6. Avoid recency bias: do NOT default to the most recent role. Select the BEST evidence from anywhere in the CV that fits the question.

ANTI-AI PATTERNS TO AVOID:
- Starting with "I'm excited to..." or "I'm passionate about..."
- Using "leverage" as a verb
- Phrases like "proven track record" or "results-driven professional"
- Overusing "I believe" or "I feel"
- Generic statements that could apply to anyone
- Overly formal or robotic language
- Lists of buzzwords without substance

GOOD PATTERNS:
- Specific examples from the CV with concrete details
- Natural conversational flow
- Honest reflection on experience
- Connecting past experience to the question's context
- Showing genuine interest without being sycophantic

The answer should feel like something the candidate would naturally write themselves - not too polished, not too casual, but authentic and confident.`;
  }

  /**
   * Build context from parsed CV data
   * @param {Object} cvData - Parsed CV data
   * @param {string} questionType - Type of question
   * @returns {string} Formatted CV context
   */
  buildCVContext(cvData, questionType) {
    let context = '## CANDIDATE CV DATA\n\n';

    if (cvData.summary) {
      context += `### Professional Summary\n${cvData.summary}\n\n`;
    }

    if (cvData.experience?.length > 0) {
      context += '### Work Experience\n';
      for (const exp of cvData.experience) {
        context += `**${exp.title}** at **${exp.company}** (${exp.dates})\n`;
        if (exp.responsibilities?.length > 0) {
          for (const resp of exp.responsibilities.slice(0, 5)) {
            context += `- ${resp}\n`;
          }
        }
        context += '\n';
      }
    }

    if (cvData.skills?.length > 0) {
      context += `### Skills\n${cvData.skills.join(', ')}\n\n`;
    }

    if (cvData.achievements?.length > 0) {
      context += '### Key Achievements\n';
      for (const achievement of cvData.achievements.slice(0, 5)) {
        context += `- ${achievement}\n`;
      }
      context += '\n';
    }

    if (cvData.education?.length > 0) {
      context += '### Education\n';
      for (const edu of cvData.education) {
        context += `- ${edu.degree} from ${edu.institution} (${edu.dates})\n`;
      }
      context += '\n';
    }

    if (cvData.certifications?.length > 0) {
      context += `### Certifications\n${cvData.certifications.join(', ')}\n\n`;
    }

    return context;
  }

  /**
   * Build type-specific instructions based on question type
   * @param {string} questionType - Detected question type
   * @returns {string} Type-specific instructions
   */
  buildTypeInstructions(questionType) {
    const instructions = {
      cover_letter: `This is a COVER LETTER request. Write a real cover letter (not a paragraph answer).

Format:
- "Dear Hiring Manager," (or "Dear [Company] team," if company is known)
- 1st paragraph: specific hook showing you understand the role and why you fit (no generic hype)
- 2nd–3rd paragraphs: map 3 key job requirements to concrete evidence from DIFFERENT parts of the CV when possible (older roles/projects are valid)
- Final paragraph: close confidently, mention interest in discussing, and add a simple sign-off
- End with: "Sincerely," and the candidate name as "[Your Name]"

Rules:
- Must reference at least 3 specific requirements/responsibilities from the job description when provided
- Must NOT invent employers, degrees, dates, or metrics not in the CV
- Avoid buzzwords and "AI voice"`,
      behavioral: `This is a BEHAVIORAL question. Use the STAR method implicitly (Situation, Task, Action, Result) without making it obvious. Draw from specific experiences in the CV. Include concrete details and outcomes where available.`,
      
      technical: `This is a TECHNICAL question. Reference specific technologies, tools, or methodologies from the CV. Be honest about proficiency levels. It's okay to mention related experience even if not an exact match.`,
      
      leadership: `This is a LEADERSHIP question. Focus on team management, mentorship, or project leadership examples from the CV. Highlight collaborative approaches and outcomes achieved through others.`,
      
      motivation: `This is a MOTIVATION question. Connect genuine interests to the role based on your career trajectory across the CV (not just the most recent role). Be specific about what attracts you - avoid generic enthusiasm. Tie motivations to concrete skills and examples.`,
      
      culture: `This is a CULTURE FIT question. Draw from work environment preferences that can be reasonably inferred from the CV (startup vs enterprise experience, team sizes, remote/on-site patterns). Be genuine about working style.`,
      
      strengths: `This is a STRENGTHS/WEAKNESSES question. For strengths, point to evidence in the CV. For weaknesses, be honest but strategic - mention something genuine and how you're addressing it. Avoid clichéd "weakness" answers.`,
      
      general: `Answer thoughtfully based on the CV content. Be specific where possible, and professional but natural in tone.`
    };

    return instructions[questionType] || instructions.general;
  }

  /**
   * Build the complete prompt for answer generation
   * @param {Object} cvData - Parsed CV data
   * @param {string} question - The application question
   * @param {string} length - Desired response length (short/medium/long)
   * @param {Object} options - Additional options (jobTitle, company, etc.)
   * @returns {Object} Complete prompt structure
   */
  /**
   * Build job description context for the prompt
   * @param {string} jobDescription - Full job description text
   * @param {string} jobTitle - Job title
   * @param {string} company - Company name
   * @returns {string} Formatted job context
   */
  buildJobContext(jobDescription, jobTitle, company) {
    if (!jobDescription) return '';

    let context = '## TARGET JOB\n\n';
    
    if (jobTitle || company) {
      context += `**Position:** ${jobTitle || 'Not specified'}`;
      if (company) context += ` at **${company}**`;
      context += '\n\n';
    }

    context += '### Job Description\n';
    // Give the model enough detail to tailor properly without blowing up tokens.
    const cap = 6000;
    context += jobDescription.slice(0, cap);
    
    if (jobDescription.length > cap) {
      context += '\n[...truncated for length...]';
    }
    
    context += '\n\n';

    // Extract and highlight key requirements
    const requirements = this.extractKeyRequirements(jobDescription);
    if (requirements.length > 0) {
      context += '### Key Requirements to Address\n';
      for (const req of requirements.slice(0, 8)) {
        context += `- ${req}\n`;
      }
      context += '\n';
    }

    return context;
  }

  /**
   * Extract key requirements from job description
   * @param {string} jobDescription - Job description text
   * @returns {string[]} List of key requirements
   */
  extractKeyRequirements(jobDescription) {
    const requirements = [];
    const lines = jobDescription.split('\n');
    
    const patterns = [
      /experience\s+(?:with|in)\s+(.{10,60})/gi,
      /proficien(?:t|cy)\s+(?:in|with)\s+(.{10,60})/gi,
      /knowledge\s+of\s+(.{10,60})/gi,
      /familiar(?:ity)?\s+with\s+(.{10,60})/gi,
      /ability\s+to\s+(.{10,60})/gi,
      /(\d+\+?\s+years?\s+.{10,60})/gi
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Bullet points with skill/requirement keywords
      if (trimmed.match(/^[\-\•\*\d\.]\s*.{15,}/) && 
          trimmed.match(/experience|skill|knowledge|ability|proficien|familiar|require|must|should/i)) {
        requirements.push(trimmed.replace(/^[\-\•\*\d\.]\s*/, '').slice(0, 100));
      }
      
      // Pattern-based extraction
      for (const pattern of patterns) {
        const matches = trimmed.matchAll(pattern);
        for (const match of matches) {
          if (match[1]) {
            requirements.push(match[1].trim());
          }
        }
      }
    }
    
    // Deduplicate
    return [...new Set(requirements)];
  }

  buildPrompt(cvData, question, length = 'medium', options = {}) {
    const questionType = this.detectQuestionType(question);
    const lengthSpec = this.responseLengths[length] || this.responseLengths.medium;
    const coverLetterLengths = {
      short: { words: '150-220', sentences: '6-10' },
      medium: { words: '250-350', sentences: '10-16' },
      long: { words: '350-500', sentences: '16-24' }
    };
    const effectiveLengthSpec =
      questionType === 'cover_letter'
        ? (coverLetterLengths[length] || coverLetterLengths.medium)
        : lengthSpec;

    const systemPrompt = this.buildSystemPrompt();
    const cvContext = this.buildCVContext(cvData, questionType);
    const jobContext = this.buildJobContext(options.jobDescription, options.jobTitle, options.company);
    const typeInstructions = this.buildTypeInstructions(questionType);
    const isWhyCompany =
      /why\s+(do\s+you\s+want|you\s+want)\s+to\s+(join|work\s+at|work\s+with)/i.test(question) ||
      /what\s+draws\s+you\s+to/i.test(question) ||
      /why\s+(this|our)\s+company/i.test(question);

    let userPrompt = `${cvContext}
${jobContext}
## QUESTION TYPE
${questionType.toUpperCase()}

## SPECIFIC INSTRUCTIONS
${typeInstructions}
${options.jobDescription ? `
IMPORTANT: Tailor your answer to the specific job description provided. Reference relevant requirements, technologies, or responsibilities mentioned in the job posting where they align with your experience. Show that you understand what the employer is looking for.
${questionType === 'cover_letter' ? `For a cover letter, you MUST explicitly connect job requirements to CV evidence (not generic claims).` : ''}
` : ''}
${questionType === 'motivation' && isWhyCompany ? `
${options.jobDescription ? `FOR THIS "WHY COMPANY" QUESTION, you MUST use BOTH the job description and the CV:` : `FOR THIS "WHY COMPANY" QUESTION, use the CV and any company/job context provided:`}
- Start with 1–2 sentences showing you understand what the company/team is building (use the job description language if available).
- Then map 2–3 specific job needs/requirements to 2–3 concrete examples from DIFFERENT parts of the CV when possible.
- If only one role is relevant, use that role plus another relevant project/skill/achievement/education example from elsewhere in the CV.
- End with a grounded reason this role is a logical next step based on your trajectory (no generic excitement).
` : ''}
## RESPONSE LENGTH
Write approximately ${effectiveLengthSpec.words} words (${effectiveLengthSpec.sentences} sentences).

## THE QUESTION
${question}

Write the answer now, in first person, as the candidate. Do not include any preamble or meta-commentary.`;

    return {
      systemPrompt,
      userPrompt,
      metadata: {
        questionType,
        length,
        options,
        hasJobContext: !!options.jobDescription
      }
    };
  }
}

export default PromptBuilder;
