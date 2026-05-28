import { describe, it, expect } from 'vitest';
import { CVParser } from '../shared/cv-parser.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function parse(text) {
  return new CVParser().parse(text);
}

// ── metric extraction from experience bullets ─────────────────────────────────

describe('CVParser.extractAchievements — metrics from experience bullets', () => {
  it('extracts percentage metrics embedded in experience bullets', () => {
    const cv = parse(`Jane Smith
jane@example.com

EXPERIENCE
Senior Engineer | Acme Corp | Jan 2021 – Present
- Reduced infrastructure costs by 35% by migrating to spot instances
- Built internal tooling for deployment automation
- Reviewed pull requests and mentored junior engineers

SKILLS
Python, AWS, Terraform`);

    expect(cv.achievements.some(a => a.includes('35%'))).toBe(true);
  });

  it('extracts currency metrics from bullets', () => {
    const cv = parse(`Tom Williams
tom@example.com

EXPERIENCE
Product Manager | StartupCo | Mar 2020 – Dec 2022
- Launched pricing feature that generated £240k in additional ARR
- Ran user research sessions with 15 enterprise customers

SKILLS
Product Management, Roadmapping`);

    expect(cv.achievements.some(a => a.includes('£240k'))).toBe(true);
  });

  it('extracts user/scale metrics from bullets', () => {
    const cv = parse(`Alex Chen
alex@example.com

EXPERIENCE
Staff Engineer | DataCo | Jun 2019 – Present
- Scaled platform from 5,000 to 80,000 monthly active users
- Reduced mean time to recovery from 45 minutes to 8 minutes

SKILLS
Distributed Systems, Kubernetes`);

    expect(cv.achievements.some(a => a.includes('users'))).toBe(true);
  });

  it('extracts "halved" / "doubled" verbal metrics from bullets', () => {
    const cv = parse(`Sara Mitchell
sara@example.com

EXPERIENCE
Operations Lead | FlowOps | Jan 2018 – Jan 2020
- Doubled team throughput by restructuring sprint ceremonies
- Halved onboarding time by building a self-serve documentation portal

SKILLS
Operations, Process Improvement`);

    const hasBulletMetric = cv.achievements.some(a =>
      a.toLowerCase().includes('doubled') || a.toLowerCase().includes('halved')
    );
    expect(hasBulletMetric).toBe(true);
  });

  it('does not include bullets without any quantified signal', () => {
    const cv = parse(`Lee Cooper
lee@example.com

EXPERIENCE
Developer | BuildCo | Jan 2022 – Present
- Reviewed pull requests and provided feedback to the team
- Participated in sprint planning and backlog grooming
- Collaborated with designers on feature specifications

SKILLS
JavaScript, React`);

    // Bullets are generic — none should be in achievements
    expect(cv.achievements).toHaveLength(0);
  });

  it('also picks up a dedicated achievements section', () => {
    const cv = parse(`Maria Gomez
maria@example.com

KEY ACHIEVEMENTS
- Grew ARR from $1.2M to $4.8M over 18 months
- Won "Employee of the Year" for two consecutive years

EXPERIENCE
Sales Lead | SellCo | 2020 – Present
- Managed enterprise accounts across EMEA

SKILLS
Sales, CRM`);

    expect(cv.achievements.some(a => a.includes('$'))).toBe(true);
  });

  it('does not duplicate a metric bullet that appears in both experience and achievements sections', () => {
    const cv = parse(`Kai Tran
kai@example.com

KEY ACHIEVEMENTS
- Reduced deployment pipeline time by 70%

EXPERIENCE
DevOps Engineer | PipeCo | Jan 2021 – Present
- Reduced deployment pipeline time by 70%

SKILLS
Docker, CI/CD`);

    const count = cv.achievements.filter(a => a.includes('70%')).length;
    expect(count).toBe(1);
  });

  it('caps individual achievement length at 300 characters', () => {
    for (const a of cv_with_long_bullets().achievements) {
      expect(a.length).toBeLessThanOrEqual(300);
    }
  });
});

function cv_with_long_bullets() {
  const longBullet = 'A'.repeat(250) + ' reduced costs by 50% through extensive and comprehensive infrastructure rationalisation across multiple cloud providers including AWS, GCP, and Azure, affecting 47 internal services and reducing spend by £500k annually plus ongoing operational savings';
  return parse(`Someone Someone
someone@example.com

EXPERIENCE
Engineer | LargeCo | 2020 – Present
- ${longBullet}

SKILLS
Cloud, AWS`);
}

// ── parse() wires experience into extractAchievements ────────────────────────

describe('CVParser.parse() achievement extraction uses structured experience', () => {
  it('achievements list is populated when metrics are in bullets', () => {
    const cv = parse(`Dev User
dev@example.com

EXPERIENCE
Backend Engineer | TechStart | Jan 2022 – Present
- Improved API response time by 60% through query optimisation
- Onboarded 3 new engineers, halving their ramp-up time

EDUCATION
BSc Computer Science | University of Birmingham | 2019

SKILLS
Node.js, PostgreSQL`);

    expect(cv.achievements.length).toBeGreaterThan(0);
    expect(cv.achievements.some(a => a.includes('60%') || a.includes('halving'))).toBe(true);
  });

  it('achievements is an empty array when there are no metrics', () => {
    const cv = parse(`Plain User
plain@example.com

EXPERIENCE
Junior Dev | SimpleCo | 2022 – Present
- Wrote unit tests and documentation
- Participated in code reviews

SKILLS
JavaScript`);

    expect(cv.achievements).toEqual([]);
  });
});
