import { describe, expect, it } from 'vitest';
import { CVParser } from '../shared/cv-parser.js';

describe('CVParser contact extraction', () => {
  it('does not treat an email domain as a personal website', () => {
    const cv = new CVParser().parse(`Michael T Bali
Birmingham, UK
mtbdesigns01@gmail.com | 07401731548
http://linkedin.com/in/michael-temitope-bali-830640171

Infra & MLOps Engineer`);

    expect(cv.contactInfo.email).toBe('mtbdesigns01@gmail.com');
    expect(cv.contactInfo.website).toBe('');
  });

  it('extracts an explicit website URL when one is present', () => {
    const cv = new CVParser().parse(`Jane Doe
jane@example.com
www.janedoe.dev

Platform Engineer`);

    expect(cv.contactInfo.website).toBe('www.janedoe.dev');
  });
});

describe('CVParser experience extraction', () => {
  it('parses title, company, and dates when they share one header line', () => {
    const cv = new CVParser().parse(`Alex Morgan
alex@example.com

PROFESSIONAL EXPERIENCE
Senior Product Manager | Acme Corp | Jan 2022 - Present
- Owned roadmap prioritisation for a B2B analytics product
- Led customer discovery with enterprise accounts

Product Analyst | Beta Ltd | Mar 2020 - Dec 2021
- Built dashboards for product and commercial teams

EDUCATION
BSc Economics - Example University`);

    expect(cv.experience[0]).toMatchObject({
      title: 'Senior Product Manager',
      company: 'Acme Corp',
      dates: 'Jan 2022 - Present',
    });
    expect(cv.experience[0].responsibilities).toContain('Owned roadmap prioritisation for a B2B analytics product');
    expect(cv.experience[1]).toMatchObject({
      title: 'Product Analyst',
      company: 'Beta Ltd',
      dates: 'Mar 2020 - Dec 2021',
    });
  });

  it('parses company-date lines followed by the job title', () => {
    const cv = new CVParser().parse(`Jane Doe
jane@example.com

Experience
LaunchDarkly | September 2025 - Present
Senior Solution Architect
- Delivered technical demos and customer architecture workshops
- Built proof-of-value plans with enterprise stakeholders

Semgrep, USA
February 2024 - June 2025
Senior Customer Success Engineer
- Resolved complex enterprise integration issues

Education
BSc Information Technology`);

    expect(cv.experience[0]).toMatchObject({
      company: 'LaunchDarkly',
      title: 'Senior Solution Architect',
      dates: 'September 2025 - Present',
    });
    expect(cv.experience[1]).toMatchObject({
      company: 'Semgrep, USA',
      title: 'Senior Customer Success Engineer',
      dates: 'February 2024 - June 2025',
    });
  });

  it('does not promote bullet text into company or title fields', () => {
    const cv = new CVParser().parse(`Pat Lee
pat@example.com

Work History
Cloud Engineer at Nimbus Labs | 2021 - Present
- Designed Kubernetes deployment automation for production services
- Reduced incident triage time through better observability

Education
MSc Computer Science`);

    expect(cv.experience).toHaveLength(1);
    expect(cv.experience[0].company).toBe('Nimbus Labs');
    expect(cv.experience[0].title).toBe('Cloud Engineer');
    expect(cv.experience[0].company).not.toMatch(/Designed Kubernetes/i);
    expect(cv.experience[0].title).not.toMatch(/Reduced incident/i);
  });
});
