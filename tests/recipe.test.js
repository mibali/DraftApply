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
    expect(prompt.systemPrompt).toMatch(/define\/reproduce the issue, gather evidence, isolate variables, test hypotheses/i);
    expect(prompt.systemPrompt).toMatch(/AVOID:/);
    expect(prompt.userPrompt).toMatch(/one specific CV example/i);
    expect(prompt.userPrompt).toMatch(/no bullet list/i);
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
