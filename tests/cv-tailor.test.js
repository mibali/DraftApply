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

const SOLUTION_ARCHITECT_JD = {
  jobTitle: 'Senior Solution Architect',
  company: 'LaunchDarkly',
  seniority: 'senior',
  requiredSkills: ['Solution Architecture', 'POC/POV Delivery', 'Stakeholder Engagement', 'MEDDPICC'],
  preferredSkills: ['RFP/RFI Response', 'Technical Demos'],
  tools: ['AWS', 'Docker', 'Kubernetes', 'Python'],
  softSkills: ['Executive Communication', 'Business Communication'],
  responsibilities: [
    'Translate business requirements into technical solution designs',
    'Lead discovery and architecture workshops with enterprise stakeholders',
    'Support technical validation through POCs and implementation planning',
  ],
  atsKeywords: ['solution architect', 'technical discovery', 'stakeholder alignment', 'enterprise SaaS'],
  domain: 'solution_engineering',
  dealBreakers: [],
};

const PRODUCT_MANAGER_JD = {
  jobTitle: 'Product Manager',
  company: 'RoadmapCo',
  seniority: 'senior',
  requiredSkills: ['Roadmap ownership', 'Product discovery', 'Prioritisation', 'Product metrics'],
  preferredSkills: ['Go-to-market alignment'],
  tools: ['Jira', 'SQL'],
  softSkills: ['Stakeholder management'],
  responsibilities: [
    'Own roadmap prioritisation and product discovery',
    'Work with engineering, design, and go-to-market teams',
    'Use product metrics to guide decisions',
  ],
  atsKeywords: ['product manager', 'roadmap', 'prioritisation', 'metrics'],
  domain: 'product_management',
  roleProfile: {
    id: 'product_manager',
    family: 'Product Management',
    domain: 'product_management',
  },
  dealBreakers: [],
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

const GOOGLE_FDE_JD = {
  jobTitle: 'Forward Deployed Engineering Manager, GenAI, Google Cloud',
  company: 'Google',
  seniority: 'senior/executive',
  requiredSkills: [
    'cloud computing',
    'technical customer-facing role',
    'Python',
    'AI/Generative AI solutions',
    'multi-agent workflows',
    'RAG systems',
    'people management',
  ],
  preferredSkills: [
    'data sovereignty',
    'secure governance',
    'context engineering',
    'transparency',
    'explainability',
    'ReAct',
    'tool-calling protocols',
  ],
  tools: ['Google Cloud', 'Vertex AI', 'Python', 'Go', 'ReAct'],
  responsibilities: [
    'Serve as the ultimate technical lead',
    'Partner with sales and tech leadership',
    'Lead technical hiring for FDE',
    'Identify skill gaps in emerging tech',
  ],
  atsKeywords: ['genai', 'forward deployed engineering', 'google cloud', 'vertex ai'],
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

  it('treats controlled synonyms as partial evidence in the production match map', () => {
    const cv = {
      rawText: 'Delivered client-facing presentations and stakeholder workshops for enterprise SaaS accounts.',
      summary: '',
      skills: [],
      experience: [{
        title: 'Customer Success Engineer',
        company: 'Acme',
        responsibilities: [
          'Delivered client-facing presentations and stakeholder workshops for enterprise SaaS accounts.',
        ],
      }],
      certifications: [],
      achievements: [],
    };
    const jd = {
      requiredSkills: ['Technical Demos', 'Technical Discovery'],
      preferredSkills: [],
      tools: [],
      softSkills: [],
    };

    const map = tailor.buildMatchMap(cv, jd);
    expect(map.find(m => m.requirement === 'Technical Demos')).toMatchObject({
      status: 'partial_match',
      allowedToMention: true,
    });
    expect(map.find(m => m.requirement === 'Technical Discovery')).toMatchObject({
      status: 'partial_match',
      allowedToMention: true,
    });
  });

  it('normalises common tool aliases such as Postgres and PostgreSQL', () => {
    const cv = {
      rawText: 'Optimised Postgres schemas and reporting queries for customer dashboards.',
      summary: '',
      skills: ['Postgres'],
      experience: [],
      certifications: [],
      achievements: [],
    };
    const jd = {
      requiredSkills: ['PostgreSQL'],
      preferredSkills: [],
      tools: [],
      softSkills: [],
    };

    const postgres = tailor.buildMatchMap(cv, jd).find(m => m.requirement === 'PostgreSQL');
    expect(postgres.status).toBe('partial_match');
    expect(postgres.allowedToMention).toBe(true);
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

  it('warns when Core Competencies collapses into too few categories or catch-all prose', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const output = `John Doe
john@example.com | +44 7700 900000 | linkedin.com/in/johndoe | github.com/johndoe

Senior Software Engineer

CORE COMPETENCIES
Frontend Engineering: React, TypeScript
Additional Relevant Skills: 3+ years of experience in modern JavaScript frameworks and ability to work cross-functionally

EXPERIENCE
Senior Frontend Engineer | TechCorp | Jan 2021 – Present
- Built React and TypeScript dashboards used by 200+ internal users

EDUCATION
BSc Computer Science | University of London | 2015–2019`;

    const warnings = tailor.validateTailoringQuality(CV, JD, map, output);
    expect(warnings.some(w => /only 2 populated line/i.test(w))).toBe(true);
    expect(warnings.some(w => /Additional Skills/i.test(w))).toBe(true);
    expect(warnings.some(w => /JD requirement prose/i.test(w))).toBe(true);
  });

  it('flags a keyword-stuffed Solution Architect CV that lacks credible role evidence', () => {
    const output = `Michael T Bali
Senior Solutions Engineer

mtbdesigns01@gmail.com

PROFESSIONAL SUMMARY
Results-driven technical leader with 7+ years of experience in cloud-native platform engineering, DevOps, and MLOps, delivering scalable and reliable solutions for enterprise SaaS platforms.

CORE COMPETENCIES
Pre-Sales & Solution Engineering: POV, MEDDPICC, POC/POV Delivery, RFP/RFI Response
Technical Architecture & Integration: Solution Architecture, API Integration, REST APIs, Docker, Kubernetes, CI/CD, GitHub Actions
Cloud & Platform Engineering: AWS, Azure, GCP, Terraform
Programming & Automation: Python, Go, Scripting, Bash
CI/CD & Dev
Ops: Change Management
Leadership & Stakeholder Management: Cross-functional Collaboration, Executive Communication, business communication skills

PROFESSIONAL EXPERIENCE
TechCorp
Jan 2021 – Present
Senior Frontend Engineer
- Built React and TypeScript dashboards used by 200+ internal users`;

    const map = tailor.buildMatchMap(CV, SOLUTION_ARCHITECT_JD);
    const warnings = tailor.validateTailoringQuality(CV, SOLUTION_ARCHITECT_JD, map, output);

    expect(warnings.some(w => /under-positioned.*Senior Solutions Engineer/i.test(w))).toBe(true);
    expect(warnings.some(w => /implementation-only/i.test(w))).toBe(true);
    expect(warnings.some(w => /broken or wrapped category line/i.test(w))).toBe(true);
    expect(warnings.some(w => /business communication skills/i.test(w))).toBe(true);
    expect(warnings.some(w => /MEDDPICC/i.test(w))).toBe(true);
    expect(warnings.some(w => /RFP\/RFI/i.test(w))).toBe(true);
    expect(warnings.some(w => /skills rather than supported experience evidence/i.test(w))).toBe(true);
  });

  it('uses role profiles to flag non-tech CVs that are keywords-only for the target role', () => {
    const output = `John Doe
Product Manager

PROFESSIONAL SUMMARY
Product leader with roadmap ownership, market research, P&L ownership, and go-to-market strategy.

CORE COMPETENCIES
Product Strategy: Roadmapping, Market Analysis, P&L Ownership
Delivery & Execution: Agile Delivery, Launch Planning
Customer & User Insight: User Research, Customer Discovery
Metrics & Analytics: Product Metrics, Experimentation
Technical Collaboration: Engineering Collaboration

PROFESSIONAL EXPERIENCE
TechCorp
Jan 2021 – Present
Senior Frontend Engineer
- Built React and TypeScript dashboards used by 200+ internal users`;

    const warnings = tailor.validateTailoringQuality(CV, PRODUCT_MANAGER_JD, [], output);

    expect(warnings.some(w => /Product Management/i.test(w))).toBe(true);
    expect(warnings.some(w => /P&L ownership/i.test(w))).toBe(true);
  });
});

// ── buildRecruiterReview ─────────────────────────────────────────────────────

describe('buildRecruiterReview', () => {
  it('returns a recruiter-style verdict for a credible tailored CV', () => {
    const map = tailor.buildMatchMap(CV, JD);
    const output = `John Doe
Senior Software Engineer
john@example.com
+44 7700 900000
linkedin.com/in/johndoe

PROFESSIONAL SUMMARY
Senior software engineer with supported frontend, API, cloud, and delivery experience across React, TypeScript, Node.js, PostgreSQL, AWS, Docker, and CI pipelines.

CORE COMPETENCIES
Frontend Engineering: React, TypeScript, JavaScript, Dashboards
Backend & APIs: Node.js, REST APIs, PostgreSQL
Cloud & Containers: AWS, Docker, Containerised Services
Software Delivery: Git, CI Pipelines, Code Review
Team Collaboration: Mentoring, Communication, Teamwork

PROFESSIONAL EXPERIENCE
TechCorp                  Jan 2021 – Present
Senior Frontend Engineer
Focus: frontend engineering, API integration, cloud delivery, and software quality
- Built React and TypeScript dashboards used by 200+ internal users
- Optimised PostgreSQL queries, reducing report generation time
- Deployed containerised services to AWS using Docker

StartupXYZ                  Jun 2019 – Dec 2020
Junior Developer
Focus: backend APIs, CI workflows, and team delivery
- Developed Node.js REST APIs serving 50k requests/day
- Maintained Git workflows and CI pipelines

EDUCATION / CERTIFICATIONS
BSc Computer Science | University of London | 2015–2019`;

    const warnings = [
      ...tailor.validateTailoredCV(CV, output),
      ...tailor.validateTailoringQuality(CV, JD, map, output),
    ];
    const review = tailor.buildRecruiterReview(CV, JD, map, output, warnings);

    expect(['strong', 'ready_with_edits']).toContain(review.verdict);
    expect(review.readyToSend).toBe(true);
    expect(review.overallScore).toBeGreaterThanOrEqual(70);
    expect(review.roleCredibilityScore).toBeGreaterThanOrEqual(70);
    expect(review.jdCoverageScore).toBeGreaterThanOrEqual(70);
    expect(review.sectionScores.professionalExperience.score).toBeGreaterThanOrEqual(70);
    expect(review.recruiterSummary).toMatch(/recruiter|credible|fit/i);
  });

  it('downgrades a keyword-stuffed CV that lacks role evidence', () => {
    const map = tailor.buildMatchMap(CV, SOLUTION_ARCHITECT_JD);
    const output = `John Doe
Senior Solutions Engineer
john@example.com
+44 7700 900000

PROFESSIONAL SUMMARY
Senior cloud and platform engineer with Kubernetes, Docker, and CI/CD experience.

CORE COMPETENCIES
Pre-Sales & Solution Engineering: POV, MEDDPICC, POC/POV Delivery, RFP/RFI Response
Technical Architecture & Integration: Solution Architecture, API Integration, Docker
Communication and Collaboration: business communication skills

PROFESSIONAL EXPERIENCE
TechCorp                  Jan 2021 – Present
Senior Frontend Engineer
- Built React and TypeScript dashboards used by 200+ internal users
- Deployed containerised services to AWS using Docker

EDUCATION / CERTIFICATIONS
BSc Computer Science | University of London | 2015–2019`;

    const warnings = tailor.validateTailoringQuality(CV, SOLUTION_ARCHITECT_JD, map, output);
    const review = tailor.buildRecruiterReview(CV, SOLUTION_ARCHITECT_JD, map, output, warnings);

    expect(['borderline', 'not_ready']).toContain(review.verdict);
    expect(review.readyToSend).toBe(false);
    expect(review.risks.join(' ')).toMatch(/credibility|unsupported|missing/i);
    expect(review.topFixes.join(' ')).toMatch(/credibility|Core Competencies|evidence/i);
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

// ── restoreLockedExperienceDates ─────────────────────────────────────────────

describe('restoreLockedExperienceDates', () => {
  it('restores exact locked date strings when the model splits or reformats them', () => {
    const tailored = `John Doe
Senior Software Engineer

PROFESSIONAL EXPERIENCE
TechCorp
Jan 2021 -
Present
Senior Frontend Engineer
Built React dashboards

StartupXYZ
Jun 2019 - Dec 2020
Junior Developer
Maintained CI pipelines`;

    const result = tailor.restoreLockedExperienceDates(tailored, CV);

    expect(result).toContain('TechCorp\nJan 2021 – Present\nSenior Frontend Engineer');
    expect(result).toContain('StartupXYZ\nJun 2019 – Dec 2020\nJunior Developer');
    expect(result).not.toContain('Jan 2021 -\nPresent');
    expect(result).not.toContain('Jun 2019 - Dec 2020');
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

  it('moves an existing misplaced Focus line above bullets even when no deterministic focus is built', () => {
    const tailored = `John Doe

PROFESSIONAL EXPERIENCE
TechCorp
Jan 2021 – Present
Senior Frontend Engineer
- Built React dashboards
Focus: frontend product delivery and UI quality
- Optimised PostgreSQL queries

EDUCATION
BSc Computer Science`;

    const result = tailor.ensureRoleFocusLines(tailored, CV, JD_NO_MATCH, []);

    expect(result).toMatch(/Senior Frontend Engineer\nFocus: frontend product delivery and UI quality\n- Built React dashboards/);
    expect(result.match(/^Focus:/gm)).toHaveLength(1);
  });
});

describe('normaliseRoleFocusPlacement', () => {
  it('keeps Focus directly under the job title after date restoration and removes duplicates', () => {
    const tailored = `John Doe
Senior Software Engineer

PROFESSIONAL EXPERIENCE
TechCorp
Jan 2021 -
Present
Senior Frontend Engineer
- Built React dashboards
Focus: cloud infrastructure and automation
- Deployed containerised services to AWS using Docker
Focus: duplicate should be removed

StartupXYZ
Jun 2019 - Dec 2020
Junior Developer
- Maintained CI pipelines`;

    const result = tailor.finalizeTailoredCV(tailored, {
      cvData: CV,
      jdData: INFRA_MLOPS_JD,
      matchMap: tailor.buildMatchMap(CV, INFRA_MLOPS_JD, ['Kubernetes', 'Terraform']),
    });

    expect(result).toContain('TechCorp\nJan 2021 – Present\nSenior Frontend Engineer\nFocus: cloud infrastructure and automation\n- Built React dashboards');
    expect(result.match(/^Focus:/gm)).toHaveLength(1);
    expect(result).not.toContain('duplicate should be removed');
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

    expect(result).toContain('MLOps & ML Lifecycle: MLOps');
    expect(result).toMatch(/Model Serving & Infrastructure: .*Docker.*Kubernetes/);
    expect(result).toMatch(/Programming & Automation: .*Python/);
    expect(result).not.toMatch(/4\+ years of experience/i);
    expect(result).not.toMatch(/Bachelor.*related field/i);
    expect(result).not.toMatch(/highly preferred/i);
  });

  it('rebuilds Google FDE skills as professional grouped lines without JD fragments', () => {
    const tailored = `John Doe

TECHNICAL SKILLS
Engineering Enablement: Python, ReAct, Go, Vertex AI, GitHub Actions, Argo Workflows, Prefect, ArgoCD
MLOps & ML Lifecycle: MLflow, DVC, model registry, experiment tracking, artifact versioning, reproducible training workflows
Model Serving & ML Infrastructure: KServe, SageMaker, Flask, FastAPI, BentoML, Docker, Kubernetes
CI/CD & Automation: GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure DevOps, Makefiles, pre-commit, Ruff, Black
Observability & Reliability: Prometheus, Grafana, logging, distributed tracing, incident response, RCA, runbooks
years of experience in cloud computing or a technical customer-facing role, with experience in Python
Experience developing AI
Generative AI solutions utilizing AI tools and designing multi-agent workflows and RAG systems
Experience in people management
Python
ReAct
Go
Vertex AI
leadership
Google Cloud

PROFESSIONAL EXPERIENCE
TechCorp`;

    const matchMap = tailor.buildMatchMap(CV, GOOGLE_FDE_JD, [
      'ReAct',
      'Go',
      'Vertex AI',
      'Google Cloud',
      'multi-agent workflows',
      'RAG systems',
      'people management',
    ]);
    const result = tailor.cleanSkillsSection(tailored, matchMap, [], GOOGLE_FDE_JD);

    expect(result).toContain('AI & GenAI Systems:');
    expect(result).toContain('Cloud & Platform Engineering:');
    expect(result).toContain('Leadership & Stakeholder Management:');
    expect(result).toContain('Vertex AI');
    expect(result).toContain('ReAct');
    expect(result).not.toMatch(/years of experience in cloud computing/i);
    expect(result).not.toMatch(/Experience developing AI/i);
    expect(result).not.toMatch(/Generative AI solutions utilizing AI tools/i);
    expect(result).not.toMatch(/^Python$/m);
  });

  it('removes solution-engineering JD requirement prose from grouped skills', () => {
    const tailored = `John Doe

TECHNICAL SKILLS
Observability & Reliability: Logging, Incident Response, RCA
Leadership & Stakeholder Management: + years in technical sales or solutions engineering, structured sales methodologies MEDDPICC, Technical Leadership, Customer-Facing Support
Additional Relevant Skills: selling complex enterprise SaaS, Track record of leading POCs, POVs, and world-class demos, CoM, or similar, Strong technical and business communication skills, Based in or able to commute to London 1-2 days per week

PROFESSIONAL EXPERIENCE
TechCorp`;

    const jdData = {
      jobTitle: 'Solutions Engineer',
      requiredSkills: ['technical sales', 'solutions engineering', 'POC', 'POV', 'enterprise SaaS'],
      tools: [],
      responsibilities: ['Lead POCs and technical demos for enterprise SaaS customers'],
      atsKeywords: ['MEDDPICC', 'technical leadership', 'customer-facing support'],
    };
    const matchMap = [
      { requirement: 'Incident Response', allowedToMention: true },
      { requirement: 'RCA', allowedToMention: true },
      { requirement: 'Technical Leadership', allowedToMention: true },
      { requirement: 'Customer-Facing Support', allowedToMention: true },
      { requirement: 'POC', allowedToMention: true },
      { requirement: 'POV', allowedToMention: true },
      { requirement: 'MEDDPICC', allowedToMention: true },
    ];

    const result = tailor.cleanSkillsSection(tailored, matchMap, [], jdData);

    expect(result).toContain('Pre-Sales & Solution Engineering:');
    expect(result).toContain('Leadership & Stakeholder Management:');
    expect(result).not.toMatch(/\+ years in technical sales/i);
    expect(result).not.toMatch(/selling complex enterprise SaaS/i);
    expect(result).not.toMatch(/structured sales methodologies/i);
    expect(result).not.toMatch(/Track record of leading/i);
    expect(result).not.toMatch(/world-class demos/i);
    expect(result).not.toMatch(/Strong technical/i);
    expect(result).not.toMatch(/CoM, or similar/i);
    expect(result).not.toMatch(/commute to London/i);
  });

  it('repairs wrapped Core Competencies labels and senior-level communication phrasing', () => {
    const tailored = `John Doe

CORE COMPETENCIES
CI/CD & Dev
Ops: Change Management
Leadership & Stakeholder Management: business communication skills, Cross-functional Collaboration

PROFESSIONAL EXPERIENCE
TechCorp`;

    const matchMap = [
      { requirement: 'Change Management', allowedToMention: true },
      { requirement: 'Cross-functional Collaboration', allowedToMention: true },
      { requirement: 'business communication skills', allowedToMention: true },
    ];

    const result = tailor.cleanSkillsSection(tailored, matchMap, [], SOLUTION_ARCHITECT_JD);

    expect(result).not.toMatch(/CI\/CD & Dev\nOps/i);
    expect(result).not.toMatch(/business communication skills/i);
    expect(result).toMatch(/Stakeholder Communication|Leadership & Stakeholder Management/i);
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

  it('builds the CV against the recruiter screen question during generation', () => {
    const map = tailor.buildMatchMap(CV, SOLUTION_ARCHITECT_JD);
    const { systemPrompt, userPrompt } = tailor.buildTailoringPrompt(CV, SOLUTION_ARCHITECT_JD, map);

    expect(systemPrompt).toContain('RECRUITER SCREENING GATE');
    expect(systemPrompt).toContain('Would this CV credibly pass a 30-second recruiter screen for this exact role?');
    expect(systemPrompt).toContain('Professional Experience, not only through a skills list');
    expect(userPrompt).toContain('RECRUITER SCREENING QUESTION');
    expect(userPrompt).toContain('only pass an ATS keyword scan but fail a human recruiter read');
    expect(userPrompt).toContain('Final internal check before output');
  });

  it('adds Solution Architect credibility guidance for architecture targets', () => {
    const map = tailor.buildMatchMap(CV, SOLUTION_ARCHITECT_JD);
    const { userPrompt } = tailor.buildTailoringPrompt(CV, SOLUTION_ARCHITECT_JD, map);
    expect(userPrompt).toContain('ROLE CREDIBILITY CHECK');
    expect(userPrompt).toContain('architecture/design authority');
    expect(userPrompt).toContain('High-risk claims requiring direct CV evidence');
  });

  it('adds role-profile credibility guidance for non-tech roles', () => {
    const { userPrompt } = tailor.buildTailoringPrompt(CV, PRODUCT_MANAGER_JD, []);
    expect(userPrompt).toContain('ROLE CREDIBILITY CHECK');
    expect(userPrompt).toContain('Role family: Product Management');
    expect(userPrompt).toContain('roadmap ownership');
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

  it('builds a strict post-generation audit prompt for unsupported tailored CV claims', () => {
    const matchMap = [
      {
        requirement: 'React',
        allowedToMention: true,
        evidence: ['Built React dashboards used by support engineers.'],
      },
      {
        requirement: 'Track record of leading POCs and world-class demos',
        allowedToMention: false,
        evidence: [],
      },
    ];
    const tailoredText = `${CV.rawText}

Core Competencies
React, Track record of leading POCs and world-class demos`;

    const { systemPrompt, userPrompt, temperature } = tailor.buildTailoredCvAuditPrompt(
      CV,
      JD,
      matchMap,
      tailoredText,
      ['Grafana']
    );

    expect(systemPrompt).toContain('strict CV truth-auditor');
    expect(systemPrompt).toContain('recruiter screen');
    expect(systemPrompt).toContain('Would this CV credibly pass a 30-second recruiter screen for this exact role?');
    expect(systemPrompt).toContain('Every skill, claim, achievement, tool, methodology, domain phrase, and focus line');
    expect(systemPrompt).toContain('If a phrase only appears in the JD or target role and has no support, remove it');
    expect(userPrompt).toContain('ORIGINAL CV');
    expect(userPrompt).toContain(CV.rawText);
    expect(userPrompt).toContain('TAILORED CV TO AUDIT');
    expect(userPrompt).toContain('✓ React');
    expect(userPrompt).toContain('Evidence: "Built React dashboards used by support engineers."');
    expect(userPrompt).toContain('✗ Track record of leading POCs and world-class demos');
    expect(userPrompt).toContain('+ Grafana');
    expect(userPrompt).toContain('30-second human recruiter scan');
    expect(temperature).toBe(0.1);
  });
});
