import { describe, it, expect, beforeEach } from 'vitest';
import { CVTailor } from '../shared/cv-tailor.js';

let tailor;
beforeEach(() => { tailor = new CVTailor(); });

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CV = {
  rawText: `John Doe
john@example.com | +44 7700 900000 | linkedin.com/in/johndoe | github.com/johndoe

Senior Frontend Engineer

EXPERIENCE
Senior Frontend Engineer | TechCorp | Jan 2021 – Present
- Built React and TypeScript dashboards used by 200+ internal users
- Optimised PostgreSQL queries, reducing report generation time
- Deployed containerised services to AWS using Docker

Junior Developer | StartupXYZ | Jun 2019 – Dec 2020
- Developed Node.js REST APIs serving 50k requests/day
- Maintained Git workflows and CI pipelines

EDUCATION
BSc Computer Science | University of London | 2015–2019

SKILLS
React, TypeScript, Node.js, PostgreSQL, AWS, Docker, Git, JavaScript`,

  contactInfo: {
    name:     'John Doe',
    email:    'john@example.com',
    phone:    '+44 7700 900000',
    linkedin: 'linkedin.com/in/johndoe',
    github:   'github.com/johndoe',
  },
  experience: [
    {
      title: 'Senior Frontend Engineer', company: 'TechCorp', dates: 'Jan 2021 – Present',
      responsibilities: [
        'Built React and TypeScript dashboards used by 200+ internal users',
        'Optimised PostgreSQL queries, reducing report generation time',
        'Deployed containerised services to AWS using Docker',
      ],
    },
    {
      title: 'Junior Developer', company: 'StartupXYZ', dates: 'Jun 2019 – Dec 2020',
      responsibilities: [
        'Developed Node.js REST APIs serving 50k requests/day',
        'Maintained Git workflows and CI pipelines',
      ],
    },
  ],
  education: [
    { institution: 'University of London', degree: 'BSc Computer Science', dates: '2015–2019' },
  ],
  skills: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'AWS', 'Docker', 'Git', 'JavaScript'],
  certifications: [],
  achievements: [],
  summary: 'Experienced frontend engineer with a focus on React and TypeScript.',
};

const JD = {
  jobTitle:        'Senior Software Engineer',
  company:         'NewCo',
  seniority:       'senior',
  requiredSkills:  ['React', 'TypeScript', 'Node.js', '3+ years experience'],
  preferredSkills: ['GraphQL', 'Kubernetes'],
  tools:           ['React', 'TypeScript', 'Node.js', 'AWS', 'Docker'],
  softSkills:      ['communication', 'teamwork'],
  responsibilities: ['Build frontend features', 'Code review', 'Mentor junior engineers'],
  atsKeywords:     ['react', 'typescript', 'frontend'],
  dealBreakers:    [],
};

// Completely foreign tech stack — nothing in CV
const JD_NO_MATCH = {
  jobTitle: 'COBOL Developer',
  company: 'OldBank',
  seniority: 'senior',
  requiredSkills: ['COBOL', 'Fortran', 'CICS', 'Mainframe'],
  preferredSkills: ['JCL'],
  tools: ['COBOL', 'Fortran'],
  softSkills: [],
  responsibilities: [],
  atsKeywords: [],
  dealBreakers: [],
};

const INFRA_MLOPS_JD = {
  jobTitle: 'Senior MLOps Engineer',
  company: 'Lighthouse',
  seniority: 'senior',
  requiredSkills: ['Python', 'cloud infrastructure', 'platform reliability', 'CI/CD', 'Kubernetes', 'Docker'],
  preferredSkills: ['Terraform', 'monitoring', 'engineering enablement'],
  tools: ['GCP', 'Docker', 'Kubernetes', 'Terraform', 'Prometheus', 'Grafana'],
  responsibilities: [
    'Design and maintain production infrastructure for machine learning systems',
    'Improve model and platform reliability',
    'Create foundational tooling that enables engineering teams',
  ],
  atsKeywords: ['mlops', 'platform', 'reliability', 'automation', 'infrastructure'],
  dealBreakers: [],
};

// Builds a faithful tailored CV preserving all locked fields
function faithfulTailoring() {
  return `John Doe
john@example.com | +44 7700 900000 | linkedin.com/in/johndoe | github.com/johndoe

Senior Software Engineer

EXPERIENCE
Senior Frontend Engineer | TechCorp | Jan 2021 – Present
- Engineered scalable React and TypeScript dashboards for internal tooling
- Improved PostgreSQL query performance significantly
- Deployed services on AWS using Docker containers

Junior Developer | StartupXYZ | Jun 2019 – Dec 2020
- Built Node.js REST APIs handling high request volumes
- Managed Git-based CI/CD workflows

EDUCATION
BSc Computer Science | University of London | 2015–2019

SKILLS
React, TypeScript, Node.js, AWS, Docker, PostgreSQL, Git, JavaScript`;
}


// ── buildMatchMap ─────────────────────────────────────────────────────────────

describe('buildMatchMap', () => {
  it('marks skills present in the CV as matched', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const react = map.find(m => m.requirement === 'React');
    expect(react).toBeDefined();
    expect(['strong_match', 'partial_match']).toContain(react.status);
    expect(react.allowedToMention).toBe(true);
  });

  it('marks skills absent from the CV as missing', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const graphql = map.find(m => m.requirement === 'GraphQL');
    expect(graphql).toBeDefined();
    expect(graphql.status).toBe('missing');
    expect(graphql.allowedToMention).toBe(false);
  });

  it('marks user-confirmed skills as user_confirmed regardless of CV content', () => {
    const map = tailor.buildMatchMap(CV, JD, ['GraphQL', 'Kubernetes']);
    const graphql = map.find(m => m.requirement === 'GraphQL');
    expect(graphql.status).toBe('user_confirmed');
    expect(graphql.allowedToMention).toBe(true);
    expect(graphql.confirmedByUser).toBe(true);
  });

  it('adds user-confirmed domain suggestions even when they are not in the JD', () => {
    const map = tailor.buildMatchMap(CV, JD, ['Prometheus', 'Grafana']);
    const prometheus = map.find(m => m.requirement === 'Prometheus');
    const grafana = map.find(m => m.requirement === 'Grafana');
    expect(prometheus).toMatchObject({
      type: 'user_confirmed',
      status: 'user_confirmed',
      allowedToMention: true,
      confirmedByUser: true,
    });
    expect(grafana).toMatchObject({
      type: 'user_confirmed',
      status: 'user_confirmed',
      allowedToMention: true,
      confirmedByUser: true,
    });
  });

  it('user_confirmed evidence mentions user confirmation', () => {
    const map = tailor.buildMatchMap(CV, JD, ['GraphQL']);
    const graphql = map.find(m => m.requirement === 'GraphQL');
    expect(graphql.evidence[0]).toMatch(/confirmed by user/i);
  });

  it('deduplicates the same requirement appearing across types', () => {
    // React appears in both requiredSkills and tools in JD
    const map = tailor.buildMatchMap(CV, JD);
    const reactEntries = map.filter(m => m.requirement === 'React');
    expect(reactEntries.length).toBe(1);
  });

  it('returns empty array for a JD with no requirements', () => {
    const emptyJd = { ...JD, requiredSkills: [], preferredSkills: [], tools: [], softSkills: [] };
    expect(tailor.buildMatchMap(CV, emptyJd)).toEqual([]);
  });

  it('marks all requirements missing for a blank CV', () => {
    const blankCv = { rawText: '', contactInfo: {}, experience: [], education: [], skills: [] };
    const map = tailor.buildMatchMap(blankCv, JD);
    expect(map.every(m => m.status === 'missing')).toBe(true);
  });

  it('handles undefined confirmedSkills gracefully', () => {
    expect(() => tailor.buildMatchMap(CV, JD, undefined)).not.toThrow();
    expect(() => tailor.buildMatchMap(CV, JD, null)).not.toThrow();
  });
});


// ── buildMatchSummary ─────────────────────────────────────────────────────────

describe('buildMatchSummary', () => {
  it('returns a score between 0 and 100', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const summary = tailor.buildMatchSummary(map);
    expect(summary.score).toBeGreaterThanOrEqual(0);
    expect(summary.score).toBeLessThanOrEqual(100);
  });

  it('surfaces confirmed additions in the summary', () => {
    const map = tailor.buildMatchMap(CV, JD, ['GraphQL']);
    const summary = tailor.buildMatchSummary(map);
    expect(summary.confirmedAdditions).toContain('GraphQL');
  });

  it('surfaces confirmed domain suggestions in the summary', () => {
    const map = tailor.buildMatchMap(CV, JD, ['Prometheus']);
    const summary = tailor.buildMatchSummary(map);
    expect(summary.confirmedAdditions).toContain('Prometheus');
  });

  it('surfaces unsupported requirements in the summary', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const summary = tailor.buildMatchSummary(map);
    expect(summary.unsupportedRequirements).toContain('GraphQL');
    expect(summary.unsupportedRequirements).toContain('Kubernetes');
  });

  it('returns a low score when the CV has nothing relevant', () => {
    const map = tailor.buildMatchMap(CV, JD_NO_MATCH);
    const summary = tailor.buildMatchSummary(map);
    expect(summary.score).toBeLessThan(20);
  });

  it('returns a high score when the CV strongly matches the JD', () => {
    // JD that only asks for skills the CV clearly has
    const jdAllMatch = {
      ...JD,
      requiredSkills: ['React', 'TypeScript', 'Node.js'],
      preferredSkills: [],
      tools: ['AWS', 'Docker'],
      softSkills: [],
    };
    const map = tailor.buildMatchMap(CV, jdAllMatch);
    const summary = tailor.buildMatchSummary(map);
    expect(summary.score).toBeGreaterThan(60);
  });

  it('returns all four list properties as arrays', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const summary = tailor.buildMatchSummary(map);
    expect(Array.isArray(summary.strongMatches)).toBe(true);
    expect(Array.isArray(summary.partialMatches)).toBe(true);
    expect(Array.isArray(summary.confirmedAdditions)).toBe(true);
    expect(Array.isArray(summary.unsupportedRequirements)).toBe(true);
  });
});


// ── validateTailoredCV ────────────────────────────────────────────────────────

describe('validateTailoredCV', () => {
  it('returns no warnings for a faithful tailoring', () => {
    const warnings = tailor.validateTailoredCV(CV, faithfulTailoring());
    expect(warnings).toEqual([]);
  });

  it('warns when a company name is missing from the output', () => {
    const corrupted = faithfulTailoring().replace('TechCorp', 'SomeOtherCorp');
    const warnings = tailor.validateTailoredCV(CV, corrupted);
    expect(warnings.some(w => w.includes('TechCorp'))).toBe(true);
  });

  it('warns when a job title is missing from the output', () => {
    const corrupted = faithfulTailoring().replace('Junior Developer', 'Software Developer');
    const warnings = tailor.validateTailoredCV(CV, corrupted);
    expect(warnings.some(w => w.includes('Junior Developer'))).toBe(true);
  });

  it('warns when education institution is removed', () => {
    const corrupted = faithfulTailoring().replace('University of London', 'Online University');
    const warnings = tailor.validateTailoredCV(CV, corrupted);
    expect(warnings.some(w => w.includes('University of London'))).toBe(true);
  });

  it('warns when contact email is removed', () => {
    const corrupted = faithfulTailoring().replace('john@example.com', '');
    const warnings = tailor.validateTailoredCV(CV, corrupted);
    expect(warnings.some(w => /email/i.test(w))).toBe(true);
  });

  it('warns when contact phone is removed', () => {
    const corrupted = faithfulTailoring().replace('+44 7700 900000', '');
    const warnings = tailor.validateTailoredCV(CV, corrupted);
    expect(warnings.some(w => /phone/i.test(w))).toBe(true);
  });

  it('warns when a fabricated metric appears in the output', () => {
    const withMetric = faithfulTailoring() + '\n- Increased throughput by 45% using caching';
    const warnings = tailor.validateTailoredCV(CV, withMetric);
    expect(warnings.some(w => /metric/i.test(w) && w.includes('45%'))).toBe(true);
  });

  it('does not warn for metrics already present in the original CV', () => {
    // "200+" and "50k" are in the original CV raw text
    const warnings = tailor.validateTailoredCV(CV, faithfulTailoring());
    // No spurious warnings for numbers that were already there
    expect(warnings.every(w => !w.includes('200+'))).toBe(true);
  });

  it('returns empty array for empty or null tailored text', () => {
    expect(tailor.validateTailoredCV(CV, '')).toEqual([]);
    expect(tailor.validateTailoredCV(CV, null)).toEqual([]);
  });

  it('returns empty array when CV has no locked fields', () => {
    const minimalCv = { rawText: 'Foo', contactInfo: {}, experience: [], education: [] };
    expect(tailor.validateTailoredCV(minimalCv, 'Foo bar baz')).toEqual([]);
  });
});

// ── validateTailoringQuality ─────────────────────────────────────────────────

describe('validateTailoringQuality', () => {
  it('warns when an unsupported JD tool is claimed in the tailored output', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const output = `${faithfulTailoring()}\n\nSKILLS\nReact, TypeScript, GraphQL`;
    const warnings = tailor.validateTailoringQuality(CV, JD, map, output);
    expect(warnings.some(w => /GraphQL/.test(w))).toBe(true);
  });

  it('does not warn when a user-confirmed skill appears in the tailored output', () => {
    const map = tailor.buildMatchMap(CV, JD, ['GraphQL']);
    const output = `${faithfulTailoring()}\n\nSKILLS\nReact, TypeScript, GraphQL`;
    const warnings = tailor.validateTailoringQuality(CV, JD, map, output, ['GraphQL']);
    expect(warnings.some(w => /GraphQL/.test(w))).toBe(false);
  });
});


// ── removeTailoringMetaPhrases ────────────────────────────────────────────────

describe('removeTailoringMetaPhrases', () => {
  it('removes "Tailored for <company>" prefix', () => {
    const result = tailor.removeTailoringMetaPhrases(
      'Tailored for Acme Corp: Experienced engineer with React expertise.',
      'Acme Corp'
    );
    expect(result).not.toMatch(/tailored for acme corp/i);
    expect(result).toContain('Experienced engineer');
  });

  it('removes generic "customized for this role" phrase', () => {
    const result = tailor.removeTailoringMetaPhrases(
      'Customized for this role — strong background in data engineering.'
    );
    expect(result).not.toMatch(/customized for this role/i);
    expect(result).toContain('strong background');
  });

  it('removes "Aligned to this position" phrase', () => {
    const result = tailor.removeTailoringMetaPhrases(
      'Aligned to this position: 5 years of backend experience.'
    );
    expect(result).not.toMatch(/aligned to this position/i);
    expect(result).toContain('5 years');
  });

  it('removes "Optimized for this application" variant', () => {
    const result = tailor.removeTailoringMetaPhrases(
      'Optimized for this application — distributed systems specialist.'
    );
    expect(result).not.toMatch(/optimized for this application/i);
  });

  it('preserves unrelated content on the same line', () => {
    const result = tailor.removeTailoringMetaPhrases(
      'Tailored for Acme Corp role: A results-driven engineer with 8 years.',
      'Acme Corp'
    );
    expect(result).toContain('results-driven engineer');
    expect(result).toContain('8 years');
  });

  it('handles null and empty string without throwing', () => {
    expect(() => tailor.removeTailoringMetaPhrases(null)).not.toThrow();
    expect(tailor.removeTailoringMetaPhrases('')).toBe('');
  });

  it('processes multi-line text correctly', () => {
    const text = `John Doe\nTailored for Acme Corp role: Cloud architect.\nAWS expert.`;
    const result = tailor.removeTailoringMetaPhrases(text, 'Acme Corp');
    expect(result).toContain('John Doe');
    expect(result).toContain('AWS expert');
    expect(result).not.toMatch(/tailored for acme corp/i);
  });
});


// ── enforceTargetHeadline ─────────────────────────────────────────────────────

describe('enforceTargetHeadline', () => {
  it('replaces the existing headline with the target job title', () => {
    const cv = `John Doe\njohn@example.com\n\nFull Stack Developer\n\nEXPERIENCE`;
    const result = tailor.enforceTargetHeadline(cv, 'Senior Software Engineer');
    expect(result).toContain('Senior Software Engineer');
  });

  it('returns the text unchanged when no job title is provided', () => {
    const cv = 'John Doe\nDeveloper\n\nEXPERIENCE';
    expect(tailor.enforceTargetHeadline(cv, '')).toBe(cv);
    expect(tailor.enforceTargetHeadline(cv, null)).toBe(cv);
  });

  it('does not duplicate the target title if already correct', () => {
    const cv = 'John Doe\njohn@example.com\n\nSenior Software Engineer\n\nEXPERIENCE';
    const result = tailor.enforceTargetHeadline(cv, 'Senior Software Engineer');
    const count = (result.match(/Senior Software Engineer/g) || []).length;
    expect(count).toBe(1);
  });
});


// ── detectChangedSections ─────────────────────────────────────────────────────

describe('detectChangedSections', () => {
  it('detects a changed summary section', () => {
    const original = 'Summary:\nExperienced developer.\n\nExperience:\nFoo Corp';
    const tailored = 'Summary:\nSenior engineer with React expertise.\n\nExperience:\nFoo Corp';
    expect(tailor.detectChangedSections(original, tailored)).toContain('summary');
  });

  it('detects a changed skills section', () => {
    const original = 'Skills:\nJavaScript, CSS\n\nExperience:\nFoo';
    const tailored = 'Skills:\nReact, TypeScript, JavaScript\n\nExperience:\nFoo';
    expect(tailor.detectChangedSections(original, tailored)).toContain('skills');
  });

  it('returns empty array when nothing changed', () => {
    const text = 'Summary:\nSame.\n\nExperience:\nSame.';
    expect(tailor.detectChangedSections(text, text)).toEqual([]);
  });

  it('handles null/empty inputs without throwing', () => {
    expect(() => tailor.detectChangedSections(null, null)).not.toThrow();
    expect(() => tailor.detectChangedSections('', '')).not.toThrow();
  });
});

// ── ensureConfirmedSkillsIncluded ────────────────────────────────────────────

describe('ensureConfirmedSkillsIncluded', () => {
  it('adds omitted confirmed skills to an existing skills section', () => {
    const tailored = `John Doe

Senior Software Engineer

SKILLS
React, TypeScript, Docker

EXPERIENCE
TechCorp`;

    const result = tailor.ensureConfirmedSkillsIncluded(tailored, ['Prometheus', 'Grafana']);
    expect(result).toContain('React, TypeScript, Docker, Prometheus, Grafana');
  });

  it('does not duplicate confirmed skills already present', () => {
    const tailored = `John Doe

SKILLS
React, Grafana`;

    const result = tailor.ensureConfirmedSkillsIncluded(tailored, ['Grafana', 'Prometheus']);
    expect(result).toContain('React, Grafana, Prometheus');
    expect(result.match(/Grafana/g)).toHaveLength(1);
  });

  it('creates a skills section when the tailored CV has none', () => {
    const result = tailor.ensureConfirmedSkillsIncluded('John Doe\n\nEXPERIENCE\nTechCorp', ['Prometheus']);
    expect(result).toContain('Technical Skills\nPrometheus');
  });
});

// ── ensureRoleFocusLines ─────────────────────────────────────────────────────

describe('ensureRoleFocusLines', () => {
  it('adds deterministic Focus lines when the LLM omits them', () => {
    const map = tailor.buildMatchMap(CV, INFRA_MLOPS_JD, ['Kubernetes', 'Terraform']);
    const tailored = `John Doe

Senior MLOps Engineer

EXPERIENCE
Senior Frontend Engineer | TechCorp | Jan 2021 – Present
- Deployed services on AWS using Docker containers
- Built React and TypeScript dashboards

Junior Developer | StartupXYZ | Jun 2019 – Dec 2020
- Maintained Git workflows and CI pipelines

SKILLS
AWS, Docker, Git`;

    const result = tailor.ensureRoleFocusLines(tailored, CV, INFRA_MLOPS_JD, map);
    expect(result).toMatch(/Senior Frontend Engineer \| TechCorp[\s\S]*Focus:/);
    expect(result).toMatch(/Focus: .*cloud infrastructure/i);
  });

  it('does not duplicate an existing Focus line', () => {
    const map = tailor.buildMatchMap(CV, INFRA_MLOPS_JD, ['Kubernetes']);
    const tailored = `John Doe

EXPERIENCE
Senior Frontend Engineer | TechCorp | Jan 2021 – Present
Focus: cloud infrastructure and automation
- Deployed services on AWS using Docker containers`;

    const result = tailor.ensureRoleFocusLines(tailored, CV, INFRA_MLOPS_JD, map);
    expect(result.match(/^Focus:/gm)).toHaveLength(1);
  });
});

// ── cleanSkillsSection ───────────────────────────────────────────────────────

describe('cleanSkillsSection', () => {
  it('removes pasted JD requirement prose from skills sections', () => {
    const tailored = `John Doe

Machine Learning Operations Engineer (MLOps)

Core Competencies
- MLOps, Cloud Infrastructure, and DevOps, Experience: 4+ years of experience in MLOps, DevOps, or a related field, with at least 1 year focused on deploying and managing AI, ML models in production. Experience with agentic or autonomous AI systems is highly preferred., Technical Stack: (1 year or less)Strong knowledge of MLOps tools and frameworks(Pytorch, Langraph, CrewAI, N8N). Proficiency in containerization with Docker and orchestration with Kubernetes., Programming & Scripting: Expertise in Python and familiarity with scripting for automation (e.g., Bash, Terraform). Strong experience with version control systems, particularly Git., Security Mindset: A strong understanding of security principles related to cloud and MLOps, including Identity and Access Management (IAM), data encryption, and secure pipeline design., Ethical AI Knowledge: Understanding of ethical AI principles, including bias detection, explainability, and compliance with regulations like GDPR or other relevant standards., Education: Bachelor’s degree in Computer Science, Engineering, Data Science, or a related field.
- Containerization and Orchestration: Docker, Kubernetes

Professional Experience
TechCorp`;

    const matchMap = [
      { requirement: 'MLOps', allowedToMention: true },
      { requirement: 'Cloud Infrastructure', allowedToMention: true },
      { requirement: 'DevOps', allowedToMention: true },
      { requirement: 'Docker', allowedToMention: true },
      { requirement: 'Kubernetes', allowedToMention: true },
      { requirement: 'Python', allowedToMention: true },
      { requirement: 'Bash', allowedToMention: true },
      { requirement: 'Terraform', allowedToMention: true },
      { requirement: 'Git', allowedToMention: true },
    ];

    const result = tailor.cleanSkillsSection(tailored, matchMap);

    expect(result).toContain('- MLOps');
    expect(result).toContain('- Docker');
    expect(result).toContain('- Kubernetes');
    expect(result).toContain('- Python');
    expect(result).not.toMatch(/4\+ years of experience/i);
    expect(result).not.toMatch(/Bachelor.*related field/i);
    expect(result).not.toMatch(/highly preferred/i);
  });
});

// ── buildTailoringPrompt ──────────────────────────────────────────────────────

describe('buildTailoringPrompt', () => {
  it('returns systemPrompt, userPrompt, and temperature', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const prompt = tailor.buildTailoringPrompt(CV, JD, map);
    expect(prompt).toHaveProperty('systemPrompt');
    expect(prompt).toHaveProperty('userPrompt');
    expect(prompt).toHaveProperty('temperature');
  });

  it('embeds locked contact fields in the system prompt', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const { systemPrompt } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(systemPrompt).toContain('john@example.com');
    expect(systemPrompt).toContain('+44 7700 900000');
  });

  it('locks historical job titles and forbids renaming them to the target role', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const { systemPrompt } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(systemPrompt).toContain('Job title: "Senior Frontend Engineer"');
    expect(systemPrompt).toContain('Never rename historical job titles');
  });

  it('instructs the model to add truthful Focus lines under role titles', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const { systemPrompt, userPrompt } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(systemPrompt).toContain('Focus:');
    expect(userPrompt).toContain('add one short "Focus:" line');
  });

  it('lists unsupported requirements in the user prompt', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const { userPrompt } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(userPrompt).toContain('GraphQL');
    // Unsupported items are marked with ✗
    expect(userPrompt).toMatch(/✗.*GraphQL/);
  });

  it('lists supported requirements in the user prompt', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const { userPrompt } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(userPrompt).toMatch(/✓.*React|✓.*TypeScript|✓.*Node/);
  });

  it('instructs the model to put strongest target-role evidence first', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const { userPrompt } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(userPrompt).toContain('strongest target-role evidence comes first');
  });

  it('includes a role-specific tailoring blueprint', () => {
    const map = tailor.buildMatchMap(CV, INFRA_MLOPS_JD, ['Kubernetes', 'Terraform']);
    const { userPrompt } = tailor.buildTailoringPrompt(CV, INFRA_MLOPS_JD, map);
    expect(userPrompt).toContain('TAILORING BLUEPRINT');
    expect(userPrompt).toContain('Target positioning:');
    expect(userPrompt).toContain('Suggested role focus lines:');
    expect(userPrompt).toContain('The CV must visibly prioritize the target role');
  });

  it('requires every user-confirmed addition to be included in skills', () => {
    const map = tailor.buildMatchMap(CV, JD, ['Prometheus', 'Grafana']);
    const { systemPrompt, userPrompt } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(systemPrompt).toContain('Include every user-confirmed addition in the skills/core competencies section');
    expect(userPrompt).toContain('Include every user-confirmed addition in the skills/core competencies section');
    expect(userPrompt).toContain('+ Prometheus');
    expect(userPrompt).toContain('+ Grafana');
  });

  it('includes the original CV text in the user prompt', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const { userPrompt } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(userPrompt).toContain(CV.rawText);
  });

  it('temperature is a number between 0 and 1', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const { temperature } = tailor.buildTailoringPrompt(CV, JD, map);
    expect(typeof temperature).toBe('number');
    expect(temperature).toBeGreaterThanOrEqual(0);
    expect(temperature).toBeLessThanOrEqual(1);
  });
});
