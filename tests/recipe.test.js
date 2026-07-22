import { describe, expect, it } from 'vitest';
import { buildPrompts } from '../render-proxy/recipe/index.js';

const CV = `Michael T Bali
Infra & MLOps Engineer
Birmingham, UK
mtbdesigns01@gmail.com

Professional Experience
Sourcegraph
Senior Technical Support Engineer

Semgrep
Senior Technical Support Engineer`;

describe('render proxy recipe', () => {
  it('routes monthly salary questions to a direct salary prompt', () => {
    const prompt = buildPrompts({
      question: 'What are your monthly salary expectations? (in USD)*',
      length: 'short',
      tone: 'natural',
      cvText: CV,
      jobTitle: 'Machine Learning Operations Engineer (MLOps)',
      jobDescription: 'We need an MLOps engineer for production ML systems.',
      requirements: ['MLOps', 'Kubernetes', 'Python', 'Cloud'],
      maxChars: 255,
    });

    expect(prompt.systemPrompt).toMatch(/SALARY \/ COMPENSATION question/);
    expect(prompt.systemPrompt).toMatch(/\$X-\$Y per month/);
    expect(prompt.systemPrompt).toMatch(/Do NOT mention previous employers/);
    expect(prompt.systemPrompt).toMatch(/do not claim to have live, official, or real-time salary data/i);
    expect(prompt.userPrompt).toMatch(/concrete USD monthly salary range/);
    expect(prompt.userPrompt).toMatch(/255 characters or fewer/);
    expect(prompt.maxTokens).toBeLessThanOrEqual(90);
  });

  it('does not treat a bare salary field as CV data extraction', () => {
    const prompt = buildPrompts({
      question: 'Salary expectations',
      cvText: CV,
    });

    expect(prompt.systemPrompt).not.toMatch(/data extraction assistant/i);
    expect(prompt.systemPrompt).toMatch(/SALARY \/ COMPENSATION question/);
  });

  it('routes troubleshooting approach questions to a dedicated process prompt', () => {
    const prompt = buildPrompts({
      question: "How do you approach troubleshooting when you don't immediately know what's wrong?",
      length: 'medium',
      tone: 'natural',
      cvText: `${CV}

Built Python-based automation tools for diagnostics and environment validation.
Led root cause analysis for production issues and authored runbooks.
Used log analysis to reproduce and isolate customer platform issues.`,
      jobTitle: 'AI Architect',
      jobDescription: 'The role needs customer-facing technical troubleshooting, production reliability, documentation, and root cause analysis.',
      requirements: ['Troubleshooting', 'Root cause analysis', 'Customer-facing technical support'],
    });

    expect(prompt.systemPrompt).toMatch(/troubleshooting\/process question/i);
    expect(prompt.systemPrompt).toMatch(/define or reproduce the issue, gather evidence, isolate variables, test hypotheses/i);
    expect(prompt.systemPrompt).toMatch(/first sentence must name the sequence before any employer\/example appears/i);
    expect(prompt.systemPrompt).toMatch(/not a vague "structured approach" sentence/i);
    expect(prompt.systemPrompt).toMatch(/AVOID:/);
    expect(prompt.userPrompt).toMatch(/state the actual method as a sequence/i);
    expect(prompt.userPrompt).toMatch(/Second sentence: explain how you decide what to inspect first/i);
    expect(prompt.userPrompt).toMatch(/no bullet list/i);
    expect(prompt.userPrompt).toMatch(/Do not repeat the same sentence twice/i);
    expect(prompt.maxTokens).toBeLessThanOrEqual(380);
  });

  it('does not inject a requirements bridge when the question does not map to those requirements', () => {
    const prompt = buildPrompts({
      question: 'What kind of work environment helps you do your best work?',
      length: 'medium',
      tone: 'natural',
      cvText: CV,
      matchMap: [
        {
          requirement: 'Kubernetes platform operations',
          allowedToMention: true,
          evidence: ['Led Kubernetes migration for production services'],
        },
        {
          requirement: 'Python automation',
          allowedToMention: true,
          evidence: ['Built Python automation scripts for diagnostics'],
        },
      ],
    });

    expect(prompt.userPrompt).not.toMatch(/JD REQUIREMENTS YOUR BACKGROUND COVERS/);
    expect(prompt.userPrompt).not.toMatch(/Kubernetes platform operations/);
  });

  it('uses parsed JD data for why-company role focus hints', () => {
    const prompt = buildPrompts({
      question: 'Why are you interested in this role?',
      length: 'medium',
      tone: 'natural',
      cvText: CV,
      jobTitle: 'Senior SRE',
      company: 'Acme AI',
      jobDescription: 'We need reliability and automation experience.',
      jdData: {
        responsibilities: [
          'Own production reliability for customer-facing AI systems',
          'Build automation that reduces manual operational toil',
        ],
        requiredSkills: ['Incident response'],
        tools: ['Kubernetes', 'Python'],
        atsKeywords: ['reliability', 'automation'],
      },
    });

    expect(prompt.userPrompt).toMatch(/ROLE\/JD SIGNALS TO USE FOR TAILORING/);
    expect(prompt.userPrompt).toMatch(/Own production reliability/);
    expect(prompt.userPrompt).toMatch(/Keywords\/tools to echo naturally: Incident response, Kubernetes, Python, reliability, automation/);
  });

  it('can surface achievements in the evidence hint when they match the question', () => {
    const prompt = buildPrompts({
      question: 'Tell me about a time you improved reliability',
      length: 'medium',
      tone: 'natural',
      cvText: CV,
      cvData: {
        experience: [
          {
            title: 'Senior Technical Support Engineer',
            company: 'Sourcegraph',
            responsibilities: ['Handled customer escalations and technical support workflows'],
          },
        ],
        achievements: ['Improved production reliability by cutting repeat incidents through RCA follow-up'],
      },
    });

    expect(prompt.userPrompt).toMatch(/MOST RELEVANT CV BULLETS/);
    expect(prompt.userPrompt).toMatch(/\[Achievement\] Improved production reliability/);
  });

  it('keeps the complete original CV and all parsed role bullets available to answer generation', () => {
    const omittedByOldCaps = 'Recovered a legacy public-sector migration by aligning six resistant stakeholder groups.';
    const rawCv = `${CV}\n\nVOLUNTEERING\nMentored career changers through a community technology programme.\n${omittedByOldCaps}`;
    const prompt = buildPrompts({
      question: 'Describe a time you influenced stakeholders during a difficult migration',
      cvText: rawCv,
      jobDescription: 'Lead complex customer migrations and build stakeholder alignment.',
      cvData: {
        contactInfo: { name: 'Michael T Bali' },
        experience: [{
          title: 'Migration Lead', company: 'Legacy Systems Ltd', dates: '2018-2020',
          responsibilities: [
            'First bullet', 'Second bullet', 'Third bullet', 'Fourth bullet',
            'Fifth bullet', 'Sixth bullet', 'Seventh bullet', omittedByOldCaps,
          ],
        }],
      },
    });

    expect(prompt.userPrompt).toContain(omittedByOldCaps);
    expect(prompt.userPrompt).toContain('VOLUNTEERING');
    expect(prompt.userPrompt.match(/VOLUNTEERING/g)).toHaveLength(1);
    expect(prompt.userPrompt).not.toMatch(/COMPLETE ORIGINAL CV — SOURCE OF TRUTH/);
  });

  it('does not duplicate the canonical CV when parsed data is available', () => {
    const marker = 'UNIQUE_SOURCE_MARKER_FOR_PROMPT';
    const prompt = buildPrompts({
      question: 'Describe your relevant experience',
      cvText: `${CV}\n${marker}`,
      jobDescription: 'Build reliable systems.',
      cvData: { experience: [{ title: 'Engineer', company: 'Acme', responsibilities: ['Built reliable systems'] }] },
    });
    expect(prompt.userPrompt.match(new RegExp(marker, 'g'))).toHaveLength(1);
  });

  it('uses a technical answer contract and covers every part of multi-part questions', () => {
    const prompt = buildPrompts({
      question: 'Describe your experience designing cloud API architectures, and explain one important technical decision you made?',
      cvText: CV,
      jobDescription: 'Design secure cloud APIs and explain architectural tradeoffs.',
    });
    expect(prompt.questionType).toBe('technical');
    expect(prompt.systemPrompt).toMatch(/TECHNICAL ANSWER CONTRACT/);
    expect(prompt.userPrompt).toMatch(/MULTI-PART QUESTION/);
  });

  it('never invents an absent personal fact', () => {
    const prompt = buildPrompts({ question: 'What is your notice period?', cvText: CV });
    expect(prompt.questionType).toBe('personal_factual');
    expect(prompt.systemPrompt).toMatch(/Never infer a personal fact/);
    expect(prompt.systemPrompt).toMatch(/Needs your input/);
  });

  it('selects semantically related project evidence even without exact question wording', () => {
    const prompt = buildPrompts({
      question: 'Tell me about influencing without authority',
      cvText: CV,
      jobDescription: 'Partner across teams to secure support for technical change.',
      cvData: {
        experience: [{ title: 'Engineer', company: 'Acme', responsibilities: ['Maintained internal services'] }],
        projects: [{
          name: 'Platform Adoption',
          bullets: ['Secured executive buy-in and aligned cross-functional stakeholders around the rollout plan'],
          skills: ['facilitation'],
        }],
      },
    });

    expect(prompt.userPrompt).toMatch(/MOST RELEVANT CV BULLETS AND EVIDENCE/);
    expect(prompt.userPrompt).toMatch(/\[Project: Platform Adoption\]/);
    expect(prompt.userPrompt).toMatch(/Secured executive buy-in/);
  });

  it('allows cover letters to use top matched requirements even without question word overlap', () => {
    const prompt = buildPrompts({
      question: 'Cover letter',
      length: 'short',
      tone: 'natural',
      cvText: CV,
      jobTitle: 'Platform Engineer',
      company: 'Acme AI',
      jobDescription: 'We need Kubernetes and Python automation.',
      matchMap: [
        {
          requirement: 'Kubernetes platform operations',
          allowedToMention: true,
          evidence: ['Led Kubernetes migration for production services'],
        },
      ],
    });

    expect(prompt.userPrompt).toMatch(/JD REQUIREMENTS YOUR BACKGROUND COVERS/);
    expect(prompt.userPrompt).toMatch(/Kubernetes platform operations/);
  });

  it('treats covering-letter fields as cover letters and requires company context in the opening', () => {
    const prompt = buildPrompts({
      question: 'Covering Letter',
      length: 'medium',
      tone: 'natural',
      cvText: CV,
      jobTitle: 'Principal AI Solution Architect',
      company: 'NeuralBridge Cloud',
      jobDescription: 'NeuralBridge Cloud helps regulated enterprises design, deploy, and govern production AI systems. The role leads customer-facing GenAI, RAG, observability, and secure cloud architecture work.',
      jdData: {
        responsibilities: [
          'Lead discovery and architecture for customer-facing GenAI programmes',
          'Guide customers through production readiness, observability, and governance decisions',
        ],
        requiredSkills: ['GenAI architecture', 'Cloud architecture'],
        tools: ['RAG', 'Kubernetes'],
      },
    });

    expect(prompt.questionType).toBe('cover_letter');
    expect(prompt.systemPrompt).toMatch(/MUST use one concrete company\/business detail/i);
    expect(prompt.systemPrompt).toMatch(/what the company builds, who it serves, its mission, market, product, or operating environment/i);
    expect(prompt.systemPrompt).toMatch(/Do not only repeat the job title and location/i);
    expect(prompt.userPrompt).toMatch(/regulated enterprises design, deploy, and govern production AI systems/);
    expect(prompt.userPrompt).toMatch(/explicitly connect my background to one real company\/business detail/i);
  });

  it('surfaces unsupported directly-asked requirements so the answer does not overclaim', () => {
    const prompt = buildPrompts({
      question: 'Do you have experience with Redis?',
      length: 'short',
      tone: 'natural',
      cvText: 'Jane Smith\nPlatform Engineer\nBuilt Python automation and Kubernetes deployment pipelines.',
      cvData: {
        experience: [
          { title: 'Platform Engineer', company: 'Acme', responsibilities: ['Built Python automation and Kubernetes deployment pipelines.'] },
        ],
      },
      matchMap: [
        { requirement: 'Redis', allowedToMention: false, evidence: [] },
        { requirement: 'Kubernetes', allowedToMention: true, evidence: ['Built Kubernetes deployment pipelines.'] },
      ],
    });

    expect(prompt.userPrompt).toMatch(/NOT CONFIRMED BY THE CV OR USER REVIEW/);
    expect(prompt.userPrompt).toMatch(/Redis/);
    expect(prompt.userPrompt).toMatch(/do not claim it/);
  });

  it('injects role-profile credibility rubrics into generated answers', () => {
    const prompt = buildPrompts({
      question: 'Why are you a strong fit for this Product Manager role?',
      length: 'medium',
      tone: 'natural',
      cvText: `${CV}

Built dashboards that helped support teams understand customer pain points.
Worked with engineering and support stakeholders to prioritise fixes.`,
      jobTitle: 'Product Manager',
      jobDescription: 'Own product discovery, roadmap prioritisation, and product metrics.',
      jdData: {
        roleProfile: {
          family: 'Product Management',
          credibilitySignals: ['roadmap ownership', 'customer discovery', 'product metrics'],
          transferableEvidence: ['support escalations -> customer pain-point discovery'],
          riskClaims: ['P&L ownership', 'pricing strategy'],
        },
        credibilitySignals: ['cross-functional delivery'],
        unsupportedClaimRisks: ['revenue ownership'],
      },
    });

    expect(prompt.userPrompt).toMatch(/ROLE CREDIBILITY RUBRIC/);
    expect(prompt.userPrompt).toMatch(/Role family: Product Management/);
    expect(prompt.userPrompt).toMatch(/roadmap ownership, customer discovery, product metrics/);
    expect(prompt.userPrompt).toMatch(/support escalations -> customer pain-point discovery/);
    expect(prompt.userPrompt).toMatch(/Do not claim without direct CV evidence/);
    expect(prompt.userPrompt).toMatch(/Use this rubric to choose evidence, not to stuff keywords/);
  });

  it('treats "Please link your LinkedIn profile" as a data extraction field, not an essay', () => {
    const cvWithLinkedIn = `${CV}\nhttps://linkedin.com/in/michael-test-bali`;
    const prompt = buildPrompts({
      question: 'Please link your LinkedIn profile.',
      cvText: cvWithLinkedIn,
    });

    expect(prompt.systemPrompt).toMatch(/data extraction assistant/i);
    expect(prompt.userPrompt).toMatch(/linkedin\.com\/in\/michael-test-bali/);
    expect(prompt.userPrompt).toMatch(/Return ONLY the value/i);
  });

  it('treats "Please share your LinkedIn URL" as a data extraction field', () => {
    const cvWithLinkedIn = `${CV}\nhttps://linkedin.com/in/michael-test-bali`;
    const prompt = buildPrompts({
      question: 'Please share your LinkedIn URL',
      cvText: cvWithLinkedIn,
    });

    expect(prompt.systemPrompt).toMatch(/data extraction assistant/i);
  });

  it('treats sentence-style portfolio link requests as data extraction fields', () => {
    const cvWithPortfolio = `${CV}\nPortfolio: michaelbali.dev/work`;
    const prompt = buildPrompts({
      question: 'Please provide a link to your portfolio.',
      cvText: cvWithPortfolio,
    });

    expect(prompt.systemPrompt).toMatch(/data extraction assistant/i);
    expect(prompt.userPrompt).toMatch(/portfolio/i);
    expect(prompt.userPrompt).toMatch(/Return ONLY the value/i);
  });

  it('keeps role-profile rubrics out of salary answers', () => {
    const prompt = buildPrompts({
      question: 'What are your salary expectations?',
      cvText: CV,
      jdData: {
        roleProfile: {
          family: 'Product Management',
          credibilitySignals: ['roadmap ownership'],
        },
      },
    });

    expect(prompt.userPrompt).not.toMatch(/ROLE CREDIBILITY RUBRIC/);
    expect(prompt.systemPrompt).toMatch(/SALARY \/ COMPENSATION question/);
  });
});

describe('domain risk prompt guard', () => {
  it('adds domain review guidance without changing the recipe contract', async () => {
    const { buildPrompts } = await import('../render-proxy/recipe/index.js');
    const result = buildPrompts({
      question: 'Do you have an active RN license?',
      cvText: 'Jordan Taylor\nHealthcare Operations Coordinator\nExperience\nCoordinated patient intake workflows and documentation for clinical teams.',
      jobTitle: 'Registered Nurse',
      jobDescription: 'Requirements: Active RN license, BLS certification, patient care.',
      domainRisk: {
        detected: true,
        primaryProfile: { label: 'Clinical healthcare' },
        credentialWarnings: [{ missingCredentials: ['rn license'], severity: 'block' }],
        reviewPrompts: ['Which clinical licenses or registrations do you currently hold?'],
      },
    });

    expect(result).toHaveProperty('systemPrompt');
    expect(result).toHaveProperty('userPrompt');
    expect(result.userPrompt).toContain('DOMAIN REVIEW GUARD');
    expect(result.userPrompt).toContain('rn license');
  });
});

describe('location and residence form fields (regression: rambling career-history answers)', () => {
  it('routes "Where are you located?" to the short-factual prompt, not general', () => {
    const prompt = buildPrompts({
      question: 'Where are you located? (State/Province & Country)',
      length: 'short',
      tone: 'natural',
      cvText: CV,
      maxChars: 255,
    });
    expect(prompt.questionType).toBe('short_factual');
    expect(prompt.systemPrompt).toMatch(/CURRENT SITUATION/);
    expect(prompt.systemPrompt).toMatch(/Do NOT mention past jobs/);
  });

  it('routes residence/timezone variants to short-factual', () => {
    for (const question of [
      'What is your current location?',
      'Where are you based?',
      'What timezone do you work in?',
    ]) {
      expect(buildPrompts({ question, cvText: CV }).questionType).toBe('short_factual');
    }
  });

  it('keeps bare location field labels on the data-extraction path', () => {
    const prompt = buildPrompts({ question: 'City of residence', cvText: CV });
    expect(prompt.systemPrompt).toMatch(/data extraction/i);
  });

  it('keeps relocation-willingness questions as yes/no, not short-factual', () => {
    const prompt = buildPrompts({ question: 'Are you willing to relocate?', cvText: CV });
    expect(prompt.questionType).toBe('yes_no');
  });
});
