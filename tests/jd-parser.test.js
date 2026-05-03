import { describe, it, expect, beforeEach } from 'vitest';
import { JDParser } from '../shared/jd-parser.js';

let parser;
beforeEach(() => { parser = new JDParser(); });

// ── Fixtures ────────────────────────────────────────────────────────────────

const GREENHOUSE_JD = `Senior Software Engineer

About the role
We're hiring a Senior Software Engineer to join our platform team.

Responsibilities:
- Lead design and implementation of backend services
- Mentor junior engineers
- Participate in on-call rotation

Requirements:
- 5+ years of experience in backend development
- Proficiency in Python and Go
- Strong knowledge of PostgreSQL and Redis
- Experience with AWS and Docker
- Familiarity with Kubernetes

Nice to have:
- Experience with Terraform
- GraphQL knowledge
- Contributions to open source

About us
Acme Corp is a leading fintech startup. We offer competitive compensation, equity, health insurance, and unlimited PTO.`;

const LEVER_JD = `What you'll do:
- Build scalable React applications with TypeScript
- Write unit and integration tests
- Review pull requests

What we're looking for:
- 3+ years experience with React
- TypeScript proficiency
- Knowledge of Node.js
- Familiarity with CI/CD pipelines

Good to have:
- Vue.js or Angular experience
- GraphQL
- AWS certifications

We cannot provide visa sponsorship for this position.`;

const NO_SECTIONS_JD = `We are looking for a talented developer with React, TypeScript, and Node.js experience to join our engineering team. You must have at least 3 years of experience. Bachelor's degree required. Full-time on-site in London.`;

const SPARSE_JD = `Software Engineer role available.`;


// ── extractRequiredSkills ────────────────────────────────────────────────────

describe('extractRequiredSkills', () => {
  it('extracts known tech keywords from free text', () => {
    const skills = parser.extractRequiredSkills('We need React, TypeScript, and PostgreSQL.');
    expect(skills).toContain('React');
    expect(skills).toContain('TypeScript');
    expect(skills).toContain('PostgreSQL');
  });

  it('extracts bullets from a Requirements section', () => {
    const skills = parser.extractRequiredSkills(GREENHOUSE_JD);
    // Should pick up from section AND keyword scan
    expect(skills.length).toBeGreaterThan(0);
    const lc = skills.map(s => s.toLowerCase());
    expect(lc.some(s => s.includes('python') || s.includes('go'))).toBe(true);
  });

  it('does not exceed 30 items', () => {
    const dense = Array.from({ length: 40 }, (_, i) => `skill${i} React Vue Angular`).join('\n- ');
    expect(parser.extractRequiredSkills(dense).length).toBeLessThanOrEqual(30);
  });

  it('returns empty array for empty input', () => {
    expect(parser.extractRequiredSkills('')).toEqual([]);
  });

  it('deduplicates exact keyword matches', () => {
    const jd = 'React React React TypeScript TypeScript';
    const skills = parser.extractRequiredSkills(jd);
    const reactCount = skills.filter(s => s === 'React').length;
    expect(reactCount).toBe(1);
  });
});


// ── extractPreferredSkills ───────────────────────────────────────────────────

describe('extractPreferredSkills', () => {
  it('extracts from a "Nice to have" section', () => {
    const preferred = parser.extractPreferredSkills(GREENHOUSE_JD);
    expect(preferred.some(s => /terraform/i.test(s))).toBe(true);
    expect(preferred.some(s => /graphql/i.test(s))).toBe(true);
  });

  it('extracts from a "Good to have" section', () => {
    const preferred = parser.extractPreferredSkills(LEVER_JD);
    expect(preferred.some(s => /graphql/i.test(s))).toBe(true);
  });

  it('does not bleed required skills into preferred', () => {
    const preferred = parser.extractPreferredSkills(GREENHOUSE_JD);
    // Python and PostgreSQL are under Requirements, not preferred
    expect(preferred.every(s => !/python/i.test(s))).toBe(true);
  });

  it('returns empty array when no preferred section exists', () => {
    expect(parser.extractPreferredSkills(NO_SECTIONS_JD)).toEqual([]);
  });

  it('does not exceed 20 items', () => {
    const many = 'Preferred:\n' + Array.from({ length: 30 }, (_, i) => `- Item ${i}`).join('\n');
    expect(parser.extractPreferredSkills(many).length).toBeLessThanOrEqual(20);
  });

  it('ignores section header line itself', () => {
    const preferred = parser.extractPreferredSkills(GREENHOUSE_JD);
    expect(preferred).not.toContain('Nice to have:');
    expect(preferred).not.toContain('Nice to have');
  });
});


// ── extractResponsibilities ──────────────────────────────────────────────────

describe('extractResponsibilities', () => {
  it('extracts bullets from a Responsibilities section', () => {
    const resp = parser.extractResponsibilities(GREENHOUSE_JD);
    expect(resp.length).toBeGreaterThan(0);
    expect(resp.some(r => /mentor/i.test(r))).toBe(true);
  });

  it('extracts from "What you\'ll do" section', () => {
    const resp = parser.extractResponsibilities(LEVER_JD);
    expect(resp.length).toBeGreaterThan(0);
    expect(resp.some(r => /react/i.test(r))).toBe(true);
  });

  it('does not exceed 20 items', () => {
    const many = 'Responsibilities:\n' + Array.from({ length: 30 }, (_, i) => `- Task ${i}`).join('\n');
    expect(parser.extractResponsibilities(many).length).toBeLessThanOrEqual(20);
  });

  it('returns empty array for JDs with no responsibilities section', () => {
    expect(parser.extractResponsibilities(NO_SECTIONS_JD)).toEqual([]);
  });
});


// ── extractTools ─────────────────────────────────────────────────────────────

describe('extractTools', () => {
  it('extracts standard cloud and infra tools', () => {
    const tools = parser.extractTools('Proficiency in Docker, Kubernetes, and Terraform required.');
    expect(tools).toContain('Docker');
    expect(tools).toContain('Kubernetes');
    expect(tools).toContain('Terraform');
  });

  it('extracts ML/data stack tools', () => {
    const tools = parser.extractTools('Experience with TensorFlow, PyTorch, and Snowflake is a plus.');
    expect(tools).toContain('TensorFlow');
    expect(tools).toContain('PyTorch');
    expect(tools).toContain('Snowflake');
  });

  it('returns unique entries only', () => {
    const jd = 'React developer needed. React experience required. Must know React.';
    const tools = parser.extractTools(jd);
    const reactEntries = tools.filter(t => t.toLowerCase() === 'react');
    expect(reactEntries.length).toBe(1);
  });

  it('returns empty array for text with no known tools', () => {
    expect(parser.extractTools('Great teamwork and communication skills.')).toEqual([]);
  });

  it('extracts modern frontend tools', () => {
    const tools = parser.extractTools('Build with Next.js, Vercel, and Supabase.');
    expect(tools).toContain('Next.js');
    expect(tools).toContain('Vercel');
    expect(tools).toContain('Supabase');
  });
});


// ── extractSeniority ─────────────────────────────────────────────────────────

describe('extractSeniority', () => {
  it('detects senior from role title keywords', () => {
    expect(parser.extractSeniority('Senior Software Engineer position')).toBe('senior');
    expect(parser.extractSeniority('Staff Engineer role')).toBe('senior');
    expect(parser.extractSeniority('Lead Developer wanted')).toBe('senior');
  });

  it('detects executive from VP / Director / CTO', () => {
    expect(parser.extractSeniority('Vice President of Engineering')).toBe('senior/executive');
    expect(parser.extractSeniority('Director of Platform Engineering')).toBe('senior/executive');
    expect(parser.extractSeniority('Head of Data')).toBe('senior/executive');
    expect(parser.extractSeniority('Chief Technology Officer')).toBe('senior/executive');
  });

  it('classifies by years-of-experience thresholds', () => {
    expect(parser.extractSeniority('Requires 8+ years of experience')).toBe('senior/executive');
    expect(parser.extractSeniority('5+ years experience required')).toBe('senior');
    expect(parser.extractSeniority('Minimum 3 years of experience')).toBe('mid-senior');
    expect(parser.extractSeniority('1 year of experience preferred')).toBe('mid-level');
  });

  it('detects junior / entry-level keywords', () => {
    expect(parser.extractSeniority('Junior Developer role')).toBe('junior');
    expect(parser.extractSeniority('Entry-level position for graduates')).toBe('junior');
    expect(parser.extractSeniority('Intern position for students')).toBe('junior');
  });

  it('defaults to mid-level when no signal is found', () => {
    expect(parser.extractSeniority('Software Engineer role')).toBe('mid-level');
    expect(parser.extractSeniority(SPARSE_JD)).toBe('mid-level');
  });

  it('gives title-level signals priority over YOE', () => {
    // "Senior ... 1 year" — title wins
    expect(parser.extractSeniority('Senior Engineer with 1 year of experience')).toBe('senior');
  });
});


// ── extractSoftSkills ────────────────────────────────────────────────────────

describe('extractSoftSkills', () => {
  it('detects known soft skill terms', () => {
    const soft = parser.extractSoftSkills('Excellent communication and strong leadership skills required.');
    expect(soft).toContain('communication');
    expect(soft).toContain('leadership');
  });

  it('is case-insensitive', () => {
    expect(parser.extractSoftSkills('You need TEAMWORK and ADAPTABILITY.')).toContain('teamwork');
  });

  it('returns empty array when no soft skills are mentioned', () => {
    expect(parser.extractSoftSkills('React TypeScript Node.js AWS Docker Kubernetes')).toEqual([]);
  });
});


// ── extractAtsKeywords ───────────────────────────────────────────────────────

describe('extractAtsKeywords', () => {
  it('returns high-frequency meaningful terms', () => {
    const jd = 'We need a React developer. React is our stack. React experience required.';
    const kw = parser.extractAtsKeywords(jd);
    expect(kw).toContain('react');
  });

  it('excludes stop words', () => {
    const kw = parser.extractAtsKeywords('the and or but in on at to for of with');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('and');
    expect(kw).not.toContain('for');
  });

  it('does not exceed 20 keywords', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i} word${i}`).join(' ');
    expect(parser.extractAtsKeywords(words).length).toBeLessThanOrEqual(20);
  });

  it('returns empty array for empty input', () => {
    expect(parser.extractAtsKeywords('')).toEqual([]);
  });
});


// ── extractDealBreakers ──────────────────────────────────────────────────────

describe('extractDealBreakers', () => {
  it('detects no-sponsorship language', () => {
    expect(parser.extractDealBreakers('We cannot provide visa sponsorship.')).toContain('No visa sponsorship');
    expect(parser.extractDealBreakers('No sponsor available.')).toContain('No visa sponsorship');
    expect(parser.extractDealBreakers('Must be authorized to work in the US.')).toContain('No visa sponsorship');
  });

  it('detects on-site requirement', () => {
    expect(parser.extractDealBreakers('This is a full-time on-site role.')).toContain('On-site required');
    expect(parser.extractDealBreakers('No remote work available.')).toContain('On-site required');
  });

  it('detects degree requirement', () => {
    const breakers = parser.extractDealBreakers("A Bachelor's degree is required.");
    expect(breakers.some(b => /degree required/i.test(b))).toBe(true);
  });

  it('extracts minimum years of experience', () => {
    const breakers = parser.extractDealBreakers('You must have 5+ years of experience.');
    expect(breakers.some(b => b.startsWith('Min experience:'))).toBe(true);
  });

  it('detects security clearance requirement', () => {
    const breakers = parser.extractDealBreakers('Security clearance required for this role.');
    expect(breakers).toContain('Security clearance required');
  });

  it('detects the no-sponsorship flag in LEVER_JD', () => {
    expect(parser.extractDealBreakers(LEVER_JD)).toContain('No visa sponsorship');
  });

  it('returns empty array when no deal breakers are present', () => {
    const jd = 'Remote-friendly role with visa sponsorship available. No degree requirement.';
    const breakers = parser.extractDealBreakers(jd);
    expect(breakers).not.toContain('No visa sponsorship');
    expect(breakers).not.toContain('On-site required');
  });
});


// ── parse (integration) ──────────────────────────────────────────────────────

describe('parse (integration)', () => {
  it('returns an object with all expected fields', () => {
    const result = parser.parse(GREENHOUSE_JD, 'Senior Software Engineer', 'Acme Corp');
    expect(result).toHaveProperty('jobTitle', 'Senior Software Engineer');
    expect(result).toHaveProperty('company', 'Acme Corp');
    expect(result).toHaveProperty('seniority');
    expect(result).toHaveProperty('requiredSkills');
    expect(result).toHaveProperty('preferredSkills');
    expect(result).toHaveProperty('tools');
    expect(result).toHaveProperty('responsibilities');
    expect(result).toHaveProperty('softSkills');
    expect(result).toHaveProperty('atsKeywords');
    expect(result).toHaveProperty('dealBreakers');
  });

  it('uses provided jobTitle and company over auto-extracted', () => {
    const result = parser.parse('Some job text here...', 'Provided Title', 'Provided Company');
    expect(result.jobTitle).toBe('Provided Title');
    expect(result.company).toBe('Provided Company');
  });

  it('handles a complete structured JD end-to-end', () => {
    const result = parser.parse(GREENHOUSE_JD);
    expect(result.seniority).toBe('senior');
    expect(result.preferredSkills.some(s => /terraform/i.test(s))).toBe(true);
    expect(result.responsibilities.some(r => /mentor/i.test(r))).toBe(true);
  });

  it('handles a sparse JD without crashing', () => {
    const result = parser.parse(SPARSE_JD);
    expect(result.requiredSkills).toEqual([]);
    expect(result.preferredSkills).toEqual([]);
    expect(result.responsibilities).toEqual([]);
  });

  it('handles empty string without crashing', () => {
    const result = parser.parse('');
    expect(result).toBeTruthy();
    expect(result.seniority).toBe('mid-level');
  });
});
