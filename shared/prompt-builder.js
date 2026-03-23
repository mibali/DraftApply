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
 * 5. Pre-writing analysis step forces evidence selection before generating
 */

export class PromptBuilder {
  constructor() {
    this.questionTypes = {
      salary: [
        'salary requirement',
        'salary expectation',
        'salary range',
        'expected salary',
        'desired salary',
        'compensation requirement',
        'compensation expectation',
        'compensation range',
        'desired compensation',
        'expected compensation',
        'total compensation',
        'pay requirement',
        'pay expectation',
        'pay range',
        'what are your salary',
        'what is your salary',
        'how much are you looking',
        'how much do you expect',
        'what salary are you',
        'annual salary',
        'base salary',
        'starting salary',
        'minimum salary',
        'rate expectation',
        'hourly rate',
        'day rate',
        'what compensation',
        'current salary',
        'current compensation',
        'target salary',
        'target compensation'
      ],
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
        'tell us about a time',
        'describe a situation',
        'describe a time',
        'give an example',
        'share an example',
        'share a time',
        'walk me through a time',
        'walk us through',
        'can you describe a time',
        'how did you handle',
        'what would you do if',
        'have you ever',
        'give me an example',
        'describe an instance',
        'share an experience where'
      ],
      technical: [
        'experience with',
        'familiar with',
        'technical skills',
        'programming',
        'technology',
        'tools',
        'systems',
        'architecture',
        'tech stack',
        'languages',
        'frameworks',
        'infrastructure',
        'databases'
      ],
      leadership: [
        'leadership',
        'led a team',
        'managed a team',
        'managed people',
        'people management',
        'mentored',
        'delegated',
        'conflict',
        'difficult colleague',
        'cross-functional',
        'stakeholder'
      ],
      motivation: [
        'why do you want',
        'what interests you',
        'why are you applying',
        'what motivates',
        'career goals',
        'where do you see yourself',
        'why this role',
        'why this position',
        'what excites you',
        'what draws you'
      ],
      culture: [
        'work environment',
        'company culture',
        'values',
        'work-life',
        'collaboration',
        'remote work',
        'working style',
        'ideal team',
        'ideal workplace',
        'describe your ideal'
      ],
      strengths: [
        'strengths',
        'weaknesses',
        'best quality',
        'areas for improvement',
        'what are you good at',
        'greatest strength',
        'biggest weakness',
        'room for improvement',
        'what do you bring'
      ]
    };

    this.responseLengths = {
      short: { words: '60-100',   sentences: '3-4'  },
      medium: { words: '170-230', sentences: '6-9'  },
      long:   { words: '280-400', sentences: '10-16' }
    };
  }

  /**
   * Detect the type of question being asked
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
   * Infer candidate seniority from CV experience titles
   */
  inferSeniority(cvData) {
    if (!cvData.experience?.length) return null;

    const allTitles = cvData.experience.map(e => (e.title || '').toLowerCase()).join(' ');
    if (/\b(vp|vice president|director|head of|chief|cto|ceo|coo|ciso)\b/.test(allTitles)) {
      return 'senior/executive';
    }
    if (/\b(principal|staff|senior|lead|manager|architect|engineering manager)\b/.test(allTitles)) {
      return 'senior';
    }
    if (/\b(junior|associate|graduate|intern|trainee|entry.level)\b/.test(allTitles)) {
      return 'early-career';
    }
    if (cvData.experience.length >= 4) return 'mid–senior';
    return 'mid-level';
  }

  /**
   * Build the system prompt that sets up the LLM's behavior
   */
  buildSystemPrompt(tone = 'natural') {
    const toneGuide = {
      formal:  'Use polished, professional language. Complete sentences, measured phrasing, appropriate for a formal application. No contractions.',
      natural: 'Sound like a real person — confident but not stiff, specific but not robotic. Contractions are fine. Natural conversational flow.',
      direct:  'Be concise and direct. Lead with the strongest point immediately. Short sentences. No filler phrases or qualifiers. Cut anything that does not add information.'
    }[tone] || '';

    return `You are an expert career coach helping a job candidate write authentic, compelling answers to job application questions.

CRITICAL RULES:
1. You ARE the candidate. Write in first person as if you are them.
2. Base answers on the CV provided. You may infer soft skills, motivations, and professional approach — but NEVER invent employers, job titles, degrees, certifications, dates, or metrics not in the CV.
3. Avoid recency bias: select the BEST evidence from anywhere in the CV, not just the most recent role.

EVIDENCE STANDARD — the single most important rule:
Every substantive claim must be backed by something specific from the CV: a named project, a real metric, a specific technology, a concrete situation. "I have strong leadership skills" is not acceptable. "Leading the platform migration at [Company], which cut deployment time by 60%" is. If you cannot back a claim with a specific, do not make it. Vague assertions kill credibility.

TONE: ${toneGuide}

STRUCTURE:
- Open with your strongest, most specific point — never with context-setting, role description, or a statement about what you're about to say.
- For stories: lead with action, then add context, then give the result. Not "In my role at X, I was responsible for..." — instead "When our infrastructure hit capacity limits, I designed..."
- Keep paragraphs tight (2–4 sentences). White space is your friend.
- End with something concrete and forward-looking, not a generic sign-off.

ANTI-AI PATTERNS — never use these:
- "I'm excited/passionate/thrilled to..."
- "Throughout my career..."
- "As a [job title], I have always..."
- "I have always been passionate about..."
- "Leverage" as a verb
- "Proven track record" / "results-driven" / "self-starter"
- "I believe" / "I feel that" (state things directly)
- "Dynamic" / "fast-paced" / "collaborative environment" as empty descriptors
- Generic closers: "I look forward to the opportunity to discuss..."
- Filler openers: "Great question" / "Certainly" / "Of course"

The answer must feel like something the candidate wrote themselves on a good day — specific, human, and confident.`;
  }

  /**
   * Build context from parsed CV data
   */
  buildCVContext(cvData, questionType) {
    let context = '## CANDIDATE CV DATA\n\n';

    // Candidate profile synthesis — gives the model a sense of who this person is
    const seniority = this.inferSeniority(cvData);
    const name = cvData.contactInfo?.name;
    const roleCount = cvData.experience?.length || 0;
    const recentRoles = cvData.experience?.slice(0, 2)
      .map(e => `${e.title} at ${e.company}`).join(', ');

    if (seniority || name || recentRoles) {
      context += '### Candidate Profile\n';
      if (name) context += `**Name:** ${name}\n`;
      if (seniority) context += `**Career level:** ${seniority}`;
      if (roleCount) context += ` (${roleCount} roles on CV)`;
      context += '\n';
      if (recentRoles) context += `**Recent roles:** ${recentRoles}\n`;
      context += '\n';
    }

    if (cvData.contactInfo) {
      const ci = cvData.contactInfo;
      const links = [
        ci.linkedin  && `LinkedIn: ${ci.linkedin}`,
        ci.github    && `GitHub: ${ci.github}`,
        ci.website   && `Website: ${ci.website}`,
        ci.portfolio && `Portfolio: ${ci.portfolio}`,
      ].filter(Boolean);
      if (links.length > 0) {
        context += `### Contact & Links\n${links.join('\n')}\n\n`;
      }
    }

    if (cvData.summary) {
      context += `### Professional Summary\n${cvData.summary}\n\n`;
    }

    if (cvData.experience?.length > 0) {
      context += '### Work Experience\n';
      for (const exp of cvData.experience) {
        context += `**${exp.title}** at **${exp.company}** (${exp.dates})\n`;
        if (exp.responsibilities?.length > 0) {
          // Show more bullets for recent roles, fewer for older ones
          const bulletCap = 6;
          for (const resp of exp.responsibilities.slice(0, bulletCap)) {
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
      for (const achievement of cvData.achievements.slice(0, 8)) {
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
   */
  buildTypeInstructions(questionType) {
    const instructions = {
      salary: `This is a SALARY / COMPENSATION question. Provide a specific, well-reasoned salary range — not a vague non-answer.

Use the following logic:
1. SENIORITY: Determine the candidate's level from their CV (years of experience, scope of roles, team sizes managed, technologies used).
2. ROLE: Use the job title from the job description to anchor the market rate.
3. MARKET DATA: Apply your knowledge of current industry salary benchmarks for this role and seniority level. Be specific — give a realistic range in the format "£X–£Y" or "$X–$Y" depending on context. If the job location is known, adjust for it; otherwise default to UK/London rates for UK roles and US national rates for US roles.
4. FRAMING: State the range confidently, briefly explain the reasoning (experience level, market rate), and keep the door open for negotiation based on the full package.

RULES:
- Always give a specific number range. Never say "competitive" or "open to discussion" without first naming a range.
- Do NOT make up CV facts. Base seniority on what is in the CV.
- Keep the answer concise: 2–4 sentences is ideal for short/medium; up to 6 for long.
- Sound confident but not rigid — mention you're open to discussing the full package.

EXAMPLE STRUCTURE: "Based on my X years of [relevant experience] at [seniority level], I'm looking for a base salary in the range of £X–£Y. This reflects current market rates for [role] roles at this level and aligns with my experience in [key relevant area]. I'm happy to discuss the full package and am open to conversations around benefits and structure."`,

      cover_letter: `This is a COVER LETTER request. Write a real cover letter (not a paragraph answer).

Format:
- "Dear Hiring Manager," (or "Dear [Company] team," if company is known)
- 1st paragraph: open with something specific about the company or role — what they're building, a challenge they're solving, or what makes this opportunity distinct. Not a statement about yourself. Show you've read the job description.
- 2nd–3rd paragraphs: map 3 key job requirements to concrete evidence from DIFFERENT parts of the CV when possible — name the project, the metric, the specific outcome. Older roles are valid if the evidence is strong.
- Final paragraph: close with confidence and genuine interest. One sentence on why this next step makes sense. End with "Sincerely," and the candidate name as "[Your Name]"

RULES:
- Opening line must NOT be "I am writing to apply for..." or any variation. Open with a specific observation about the company/role.
- Must reference at least 3 specific requirements from the job description (when provided)
- Must NOT invent employers, degrees, dates, or metrics not in the CV
- Every paragraph should contain at least one concrete specific (named project, metric, technology)`,

      behavioral: `This is a BEHAVIORAL question. Tell a tight, specific story from the CV.

STRUCTURE (follow this proportionally):
- Opening (1 sentence): Drop straight into the action or situation — "When our deployment pipeline failed the night before a major release..." or "During the acquisition of [Company], I was asked to..." Give just enough context so the story makes sense, then move on.
- Actions (2–3 sentences, this is the core): Focus on what YOU specifically decided and did. Be concrete — what approach did you take, why, and how? Name technologies, team sizes, timelines where they're in the CV.
- Outcome (1–2 sentences): What was the measurable result? What did you learn or change as a result? Quantify if the CV provides numbers.
- Optional: One sentence connecting this to how you'd approach similar situations in the new role.

RULES:
- Never open with "I have always..." or "In my experience..." — open with the situation
- Use past tense throughout
- The story must come from a specific role/project in the CV — do not fabricate
- If multiple CV examples are relevant, pick the strongest one (not the most recent)`,

      technical: `This is a TECHNICAL question. Demonstrate depth, not just breadth.

APPROACH:
- Name specific technologies, tools, or systems from the CV with context — not just "I've used Python" but "I've used Python extensively for data pipeline work at [Company], including building ETL processes that processed X records/day"
- Be honest about depth: distinguish between "daily production use" and "I've worked with this in projects"
- If the question asks about something not in the CV but you have adjacent experience, connect them explicitly: "I haven't worked directly with X, but at [Company] I built Y which solves the same class of problems by..."
- For architecture or design questions: describe your reasoning process, tradeoffs you've navigated, and outcomes — not just what you built`,

      leadership: `This is a LEADERSHIP question. Show how you actually led, not just that you did.

APPROACH:
- Be specific about team size, composition, and context from the CV
- Focus on HOW you led: decisions you made, how you built trust, how you handled pushback, how you enabled others
- For conflict/difficult colleague questions: show emotional maturity and problem-solving. Describe the approach (direct conversation, finding shared interests, escalation if appropriate) and the outcome
- Outcomes should be specific: what did the team deliver, how did it change, what did people say or do differently?
- Avoid "I created a collaborative environment" — show what that actually looked like in practice`,

      motivation: `This is a MOTIVATION question. Give a specific, reasoned answer — not enthusiasm.

APPROACH:
- Start with what specifically attracts you to THIS role or company (not a generic statement about the field)
- Connect to a genuine pattern in your career trajectory — why does this role make sense as the next step given your specific history?
- Map 1–2 concrete things from the job description to 1–2 concrete things from your CV — show alignment, not aspiration
- Avoid: "I've always been passionate about X" — instead say what specifically about this role or company aligns with what you've been building toward and why`,

      culture: `This is a CULTURE FIT / WORKING STYLE question. Be honest and specific.

APPROACH:
- Ground your answer in your actual CV experience — if you've worked at both startups and enterprises, you have real evidence about what suits you
- Describe a specific aspect of how you work best: team structure, how you collaborate, how you handle ambiguity, what kind of problems energize you
- Connect your working style to something in the job description that matches — show this isn't just a generic preference
- Be genuine: it's better to be specific about what you want (and risk not being a fit) than to give a vague answer that could apply to anyone`,

      strengths: `This is a STRENGTHS / WEAKNESSES question.

FOR STRENGTHS:
- Name one or two genuine strengths backed by specific CV evidence. "I'm strong at X — for example, at [Company] when [situation], I [action] and [outcome]."
- The strength should be relevant to the role in question, ideally one the job description signals they care about

FOR WEAKNESSES:
- Pick something real and work-relevant — not a fake weakness dressed up as a strength ("I work too hard")
- Describe it honestly, then show what you've done to address it: a process you've adopted, a skill you've deliberately built, feedback you've acted on
- The weakness should not be a core requirement of the job
- Show self-awareness without undermining your candidacy

RULES:
- Do not give two weaknesses unless specifically asked
- Do not claim your weakness is "perfectionism" or "caring too much"`,

      general: `Answer this question directly, specifically, and with evidence from the CV.

APPROACH:
- Identify the underlying quality or competency this question is testing (e.g. a question about "biggest achievement" is testing self-awareness + ability to quantify impact)
- Select the strongest relevant evidence from anywhere in the CV — not just the most recent role
- If this is a story-based question, structure it as: situation → your specific action → outcome
- If this is a preference/opinion question, ground your answer in real experience from the CV rather than abstract statements
- Every paragraph should contain at least one concrete specific: a named company, project, metric, or decision`
    };

    return instructions[questionType] || instructions.general;
  }

  /**
   * Build job description context for the prompt
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
    const cap = 6000;
    context += jobDescription.slice(0, cap);

    if (jobDescription.length > cap) {
      context += '\n[...truncated for length...]';
    }

    context += '\n\n';

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

      if (trimmed.match(/^[\-\•\*\d\.]\s*.{15,}/) &&
          trimmed.match(/experience|skill|knowledge|ability|proficien|familiar|require|must|should/i)) {
        requirements.push(trimmed.replace(/^[\-\•\*\d\.]\s*/, '').slice(0, 100));
      }

      for (const pattern of patterns) {
        const matches = trimmed.matchAll(pattern);
        for (const match of matches) {
          if (match[1]) {
            requirements.push(match[1].trim());
          }
        }
      }
    }

    return [...new Set(requirements)];
  }

  buildPrompt(cvData, question, length = 'medium', options = {}) {
    const questionType = this.detectQuestionType(question);
    const lengthSpec = this.responseLengths[length] || this.responseLengths.medium;
    const coverLetterLengths = {
      short: { words: '200-280', sentences: '8-12'  },
      medium: { words: '300-400', sentences: '12-18' },
      long:   { words: '400-550', sentences: '18-26' }
    };
    const salaryLengths = {
      short:  { words: '30-50',  sentences: '2-3' },
      medium: { words: '50-80',  sentences: '3-4' },
      long:   { words: '80-120', sentences: '4-6' }
    };
    const effectiveLengthSpec =
      questionType === 'cover_letter'
        ? (coverLetterLengths[length] || coverLetterLengths.medium)
        : questionType === 'salary'
          ? (salaryLengths[length] || salaryLengths.medium)
          : lengthSpec;

    const systemPrompt = this.buildSystemPrompt(options.tone || 'natural');
    const cvContext = this.buildCVContext(cvData, questionType);
    const jobContext = this.buildJobContext(options.jobDescription, options.jobTitle, options.company);
    const typeInstructions = this.buildTypeInstructions(questionType);
    const isWhyCompany =
      /why\s+(do\s+you\s+want|you\s+want)\s+to\s+(join|work\s+at|work\s+with)/i.test(question) ||
      /what\s+draws\s+you\s+to/i.test(question) ||
      /why\s+(this|our)\s+company/i.test(question);

    // Pre-writing analysis step — forces the model to select the best evidence
    // before generating the answer rather than defaulting to generic assertions.
    const analysisStep = questionType === 'salary' || questionType === 'cover_letter' ? '' : `
## BEFORE YOU WRITE
Reason through the following silently (do not include this analysis in your answer):
1. What specific competency or quality is this question testing? Be precise — not just "leadership" but e.g. "leading through ambiguity" or "recovering a failing project".
2. What is the single strongest piece of evidence from the CV that demonstrates it? Name the company, project, and outcome.
3. Is there a second piece of evidence that adds depth or shows range across different roles?${options.jobDescription ? `
4. Which 1–2 requirements in the job description does this question relate to? How does the CV evidence map to them?` : ''}

Now write the answer using that specific evidence. Do not include the analysis itself.
`;

    let userPrompt = `${cvContext}
${jobContext}
## QUESTION TYPE
${questionType.toUpperCase()}

## SPECIFIC INSTRUCTIONS
${typeInstructions}
${options.jobDescription ? `
TAILORING: This answer must be tailored to the specific job description. Reference the company's language, specific requirements, and role context where they connect to real experience from the CV. Make it obvious this answer was written for this specific role, not copy-pasted.
${questionType === 'cover_letter' ? `For the cover letter, EVERY body paragraph must connect a specific job requirement to a named CV achievement.` : ''}
` : ''}
${questionType === 'motivation' && isWhyCompany ? `
${options.jobDescription ? `FOR THIS "WHY COMPANY" QUESTION, you MUST use BOTH the job description and the CV:` : `FOR THIS "WHY COMPANY" QUESTION, use the CV and any company/job context provided:`}
- Start with 1–2 sentences showing you understand what the company/team is building or solving (use the job description language if available). This shows you've done your homework.
- Then map 2–3 specific job needs/requirements to 2–3 concrete examples from DIFFERENT parts of the CV when possible.
- If only one role is relevant, use that role plus another relevant project/skill/achievement/education example from elsewhere in the CV.
- End with a grounded reason this role is a logical next step based on your trajectory — not excitement, but fit.
` : ''}
${analysisStep}
## RESPONSE LENGTH
Write approximately ${effectiveLengthSpec.words} words (${effectiveLengthSpec.sentences} sentences).

## THE QUESTION
${question}

Write the answer now, in first person, as the candidate. Output only the answer — no preamble, no meta-commentary, no headers.`;

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
