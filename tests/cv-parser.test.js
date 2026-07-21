import { describe, expect, it } from 'vitest';
import { CVParser } from '../shared/cv-parser.js';
import { MULTICOLUMN_CV_TEXT } from './fixtures/multicolumn-cv.js';
import { DUPLICATED_TEXT_LAYER_CV } from './fixtures/duplicated-text-layer-cv.js';
import { EMDASH_FORMAT_CV } from './fixtures/emdash-format-cv.js';

describe('CVParser contact extraction', () => {
  it('does not treat an email domain as a personal website', () => {
    const cv = new CVParser().parse(`Michael T Bali
Birmingham, UK
mtbdesigns01@gmail.com | 07401731548
http://linkedin.com/in/michael-temitope-bali-830640171

Infra & MLOps Engineer`);

    expect(cv.contactInfo.email).toBe('mtbdesigns01@gmail.com');
    expect(cv.contactInfo.phone).toBe('07401731548');
    expect(cv.contactInfo.website).toBe('');
  });

  it('extracts an explicit website URL when one is present', () => {
    const cv = new CVParser().parse(`Jane Doe
jane@example.com
www.janedoe.dev

Platform Engineer`);

    expect(cv.contactInfo.website).toBe('www.janedoe.dev');
  });

  it('repairs PDF whitespace inserted inside hyphenated words', () => {
    const cv = new CVParser().parse(`Jane Doe
jane@example.com
SUMMARY
Customer- facing engineer with hands- on production support experience.`);
    expect(cv.summary).toBe('Customer-facing engineer with hands-on production support experience.');
    expect(cv.rawText).not.toMatch(/customer- facing|hands- on/i);
  });
});

describe('CVParser multi-column PDF recovery', () => {
  const cv = new CVParser().parse(MULTICOLUMN_CV_TEXT);

  it('recovers identity and headingless summary without compacting the display headline', () => {
    expect(cv.contactInfo.name).toBe('Alex Morgan');
    expect(cv.summary).toContain('deep experience diagnosing API integrations');
    expect(cv.summary).not.toContain('alex@example.test');
    expect(cv.rawText).toContain('S E N I O R   D E V E L O P E R');
    expect(cv.rawText).toContain('PROFESSIONAL EXPERIENCE');
  });

  it('recovers trailing-date roles in reverse chronological order without crossing evidence', () => {
    expect(cv.experience.map(role => [role.company, role.title, role.dates])).toEqual([
      ['Northstar Payments', 'Team Lead, Developer Support', 'Feb 2021 - Present'],
      ['Harbor Systems', 'Senior Software Engineer', 'Aug 2020 - Jan 2021'],
      ['Freelance/Contract', 'Software Engineer', 'May 2019 - Aug 2020'],
    ]);
    expect(cv.experience[0].responsibilities[0]).toContain('request tracing, and SQL');
    expect(cv.experience[0].responsibilities[1]).toContain('25% through structured debugging');
    expect(cv.experience[0].responsibilities.join(' ')).not.toContain('Sentry monitoring');
    expect(cv.experience[1].responsibilities.join(' ')).toContain('Sentry monitoring');
    expect(JSON.stringify(cv.experience)).not.toContain('Skills:');
  });

  it('extracts deduplicated role and global skills without swallowing project prose', () => {
    expect(cv.skills).toEqual(expect.arrayContaining(['REST APIs', 'PostgreSQL', 'Django', 'TypeScript', 'Redis']));
    expect(cv.skills.filter(skill => skill.toLowerCase() === 'postgresql')).toHaveLength(1);
    expect(cv.skills).not.toContain('Projects');
    expect(cv.skills.join(' ')).not.toContain('Issue-tracking platform');
  });

  it('preserves locked projects in extracted order with deterministic provenance', () => {
    expect(cv.projects.map(project => [project.name, project.url])).toEqual([
      ['SprintBoard', 'https://sprintboard.example.test'],
      ['PayCycle', 'https://paycycle.example.test'],
    ]);
    expect(cv.projects[0].bullets[1]).toContain('Django Channels');
    expect(cv.projects[0].skills).toContain('WebSockets');
    expect(cv.projects[1].bullets).toHaveLength(2);
    const projectEvidence = cv.evidenceIndex.filter(record => record.projectSourceId);
    expect(projectEvidence.length).toBeGreaterThan(0);
    expect(new Set(projectEvidence.map(record => record.sourceId)).size).toBe(projectEvidence.length);
    for (const record of projectEvidence) expect(cv.sourceIndex[record.sourceId]).toBe(record);
    const again = new CVParser().parse(MULTICOLUMN_CV_TEXT);
    expect(again.evidenceIndex.filter(record => record.projectSourceId).map(record => record.sourceId))
      .toEqual(projectEvidence.map(record => record.sourceId));
  });

  it('fails closed on ambiguous names, action prose, and numbered non-project lists', () => {
    const ambiguous = new CVParser().parse(`S U P P O R T   E N G I N E E R\nSupport developers through difficult integrations.\n\nPROFESSIONAL EXPERIENCE\nSupport customers during incidents.\n2022 - Present\n\nPROJECTS\n1.) Improved alerts\n2.) Updated docs`);
    expect(ambiguous.contactInfo.name).toBe('');
    expect(ambiguous.experience).toEqual([]);
    expect(ambiguous.projects).toEqual([]);
    expect(ambiguous.rawText).toContain('S U P P O R T   E N G I N E E R');
  });

  it('stops every parsed section at canonical compound headings', () => {
    const parsed = new CVParser().parse(`Jamie Rivera
jamie@example.test

PROFESSIONAL SUMMARY
Support engineer focused on reliable API integrations.

CORE COMPETENCIES
APIs: REST, Webhooks

PROFESSIONAL EXPERIENCE
Example Corp
Jan 2022 - Present
Senior Support Engineer
- Resolved complex production incidents.

PROJECTS
1.) SignalBoard (https://signal.example.test)
- Built an incident dashboard.

EDUCATION / CERTIFICATIONS
Example University
Certified Example Practitioner`);
    expect(parsed.summary).toBe('Support engineer focused on reliable API integrations.');
    expect(parsed.experience[0].responsibilities).toEqual(['Resolved complex production incidents.']);
    expect(parsed.projects[0].bullets).toEqual(['Built an incident dashboard.']);
    expect(JSON.stringify(parsed.projects)).not.toContain('Example University');
  });

  it('parses trailing-date roles with one action each and fails closed when a later block is malformed', () => {
    const valid = new CVParser().parse(`Alex Morgan
alex@example.test

PROFESSIONAL EXPERIENCE
Alpha Corp
Senior Engineer
Built reliable API integrations for enterprise customers.
Led a migration from Jan 2020 to Dec 2021 while maintaining service reliability.
Jan 2022 - Present
Beta Corp
Software Engineer
Developed internal support tooling for incident response.
Jan 2020 - Dec 2021

SKILLS
Node.js, SQL`);
    expect(valid.experience.map(role => role.responsibilities)).toEqual([
      [
        'Built reliable API integrations for enterprise customers.',
        'Led a migration from Jan 2020 to Dec 2021 while maintaining service reliability.',
      ],
      ['Developed internal support tooling for incident response.'],
    ]);

    const malformed = new CVParser().parse(`Alex Morgan
alex@example.test

PROFESSIONAL EXPERIENCE
Alpha Corp
Senior Engineer
Built reliable API integrations for enterprise customers.
Jan 2022 - Present
This later block has no credible title
Developed internal support tooling for incident response.
Jan 2020 - Dec 2021

SKILLS
Node.js, SQL`);
    expect(malformed.experience).toEqual([]);
  });
});

describe('CVParser experience extraction', () => {
  it('adds deterministic unique role and responsibility source IDs without replacing strings', () => {
    const text = `Alex Morgan

EXPERIENCE
Senior Product Manager | Acme Corp | Jan 2022 - Present
- Owned roadmap prioritisation for a B2B analytics product
- Led customer discovery with enterprise accounts

Product Analyst | Beta Ltd | Mar 2020 - Dec 2021
- Built dashboards for product and commercial teams

EDUCATION
BSc Economics`;
    const first = new CVParser().parse(text);
    const second = new CVParser().parse(text);
    const ids = [
      ...first.experience.map(role => role.sourceId),
      ...first.evidenceIndex.map(record => record.sourceId),
    ];

    expect(first.experience.map(role => role.sourceId)).toEqual(second.experience.map(role => role.sourceId));
    expect(first.evidenceIndex.map(record => record.sourceId)).toEqual(second.evidenceIndex.map(record => record.sourceId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(first.experience[0].responsibilities).toEqual([
      'Owned roadmap prioritisation for a B2B analytics product',
      'Led customer discovery with enterprise accounts',
    ]);
    expect(first.sourceIndex[first.evidenceIndex[0].sourceId]).toBe(first.evidenceIndex[0]);
  });

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

  it('splits a location squished directly against a date with no space (regression)', () => {
    // PDF/DOCX extraction sometimes flattens a location and a date that were
    // visually separated (different columns) in the original document into
    // one line with no space between them, e.g. "Birmingham, UKSep 2021 -
    // Present" - the date regex's word-boundary check fails to see "Sep"
    // when it's glued directly to "UK", so the whole garbled string used to
    // land in a structured field (company/title) instead of being split.
    const cv = new CVParser().parse(`Jordan Taylor
jordan@example.com

Experience

Senior Engineer
Acme Corp
Birmingham, UKSep 2021 - Present
- Led backend development for the platform team.

Software Engineer
Beta Inc
Manchester, UKFeb 2019 - Aug 2021
- Built internal tooling for the growth team.

Skills
Python, SQL, AWS`);

    for (const exp of cv.experience) {
      expect(exp.company).not.toMatch(/UK(Sep|Feb)/);
      expect(exp.title).not.toMatch(/UK(Sep|Feb)/);
      expect(exp.dates).not.toContain('UK');
    }
    expect(cv.experience.some(exp => exp.dates.includes('Sep 2021'))).toBe(true);
    expect(cv.experience.some(exp => exp.dates.includes('Feb 2019'))).toBe(true);
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

  it('does not classify a company name containing "Solutions" as a job title', () => {
    const cv = new CVParser().parse(`Sam Okafor
sam@example.com

PROFESSIONAL EXPERIENCE
Bincom ICT Solutions
March 2019 - January 2022
Software Developer
- Built internal tools and REST APIs

EDUCATION
BSc Computer Science`);

    expect(cv.experience[0]).toMatchObject({
      company: 'Bincom ICT Solutions',
      title: 'Software Developer',
    });
  });

  it('does not classify a company name with a legal suffix as a job title', () => {
    const parser = new CVParser();
    expect(parser._isLikelyJobTitle('Bincom ICT Solutions')).toBe(false);
    expect(parser._isLikelyJobTitle('Acme Technologies')).toBe(false);
    expect(parser._isLikelyJobTitle('Ventures Holdings Ltd')).toBe(false);
    expect(parser._isLikelyJobTitle('Sourcegraph, USA')).toBe(false);
    expect(parser._isLikelyJobTitle('Semgrep, India')).toBe(false);
  });

  it('still classifies legitimate job titles that contain role keywords', () => {
    const parser = new CVParser();
    expect(parser._isLikelyJobTitle('Solutions Architect')).toBe(true);
    expect(parser._isLikelyJobTitle('Senior Software Engineer')).toBe(true);
    expect(parser._isLikelyJobTitle('Data Platform Lead')).toBe(true);
    expect(parser._isLikelyJobTitle('Cloud Security Consultant')).toBe(true);
  });

  it('does not classify "Position: X" lines as job titles', () => {
    const parser = new CVParser();
    expect(parser._isLikelyJobTitle('Position: MLOps/DevOps Engineer')).toBe(false);
    expect(parser._isLikelyJobTitle('Title: Senior Data Scientist')).toBe(false);
  });

  it('does not classify preposition-start lines as job titles', () => {
    const parser = new CVParser();
    expect(parser._isLikelyJobTitle('with Engineering and Product teams')).toBe(false);
  });

  it('does not store prose sentence fragments as company or title', () => {
    const cv = new CVParser().parse(`Alex Smith
alex@example.com

PROFESSIONAL EXPERIENCE
Semgrep, USA
January 2023 - Present
SRE / DevOps Engineer
- Improved operational scalability and team effectiveness
- and communicating measures effectively.
- Drove platform reliability improvements

EDUCATION
BSc Computer Science`);

    const exp = cv.experience[0];
    expect(exp.company).toBe('Semgrep, USA');
    expect(exp.title).toBe('SRE / DevOps Engineer');
    expect(exp.company).not.toBe('operational scalability');
    expect(exp.company).not.toMatch(/team effectiveness/);
    expect(exp.title).not.toMatch(/and communicating/);
  });
});

describe('CVParser nonstandard bullet markers', () => {
  it('accepts double-angle extraction bullets without stripping comparison operators', () => {
    const parser = new CVParser();
    expect(parser._cleanBullet('>> Automated Kubernetes deployments.')).toBe('Automated Kubernetes deployments.');
    expect(parser._cleanBullet('>= 99.9% availability target')).toBe('');
    expect(parser._cleanBullet('>5 years operating distributed systems')).toBe('');
  });
});

// Regression fixture mirroring the live CV whose export dropped the owner's
// name, truncated wrapped bullets, swallowed CORE SKILLS into the summary,
// and absorbed trailing custom sections into the last experience role.
const SPACED_FINAL_CV_TEXT = `MICHAEL T BALI
Birmingham, UK | mtbdesigns01@gmail.com | 07401731548 | LinkedIn
AI Enablement & Technical Operations Lead
PROFESSIONAL SUMMARY
AI enablement, technical operations, and AI solutions professional with 7+ years of experience helping SaaS teams.
CORE SKILLS
• AI enablement, AI adoption, prompt engineering, AI workflow design
• Cloud and DevOps: AWS, Azure, GCP, Docker, Kubernetes, Terraform
PROFESSIONAL EXPERIENCE
DualMind Tech Consulting Ltd | MLOps / DevOps Engineer | Sep 2025 - Present
• Create model and data governance patterns using DVC, MLflow, validation gates, promotion-readiness workflows, and production
monitoring.
• Translate complex MLOps concepts into reusable templates, documentation, and implementation playbooks that help teams adopt AI capabilities
confidently.
Bincom ICT Solutions | Python Developer | Feb 2019 - May 2020
• Developed reusable and maintainable Python code for production systems and internal automation.
• Supported codebase modernisation by improving structure, reliability, and maintainability of existing applications.
AI STRATEGY, ENABLEMENT & OPERATING MODEL
• Defined practical AI adoption patterns for engineering, support, DevOps, and SaaS operations workflows.
SELECTED AI ENABLEMENT, OPERATIONS & INNOVATION ACHIEVEMENTS
• Built an AI-powered log analysis tool that accelerated issue diagnosis and helped teams move from
manual log review toward repeatable AI-assisted investigation.
• Designed a case review automation system using the Plain API, introducing structured monthly peer reviews.
EDUCATION, CERTIFICATIONS & RECOGNITION
• BSc Information Technology - University of Cape Coast, 2018
• Certified Kubernetes Administrator - CKA`;

describe('CVParser regression: spaced-final live CV defects', () => {
  const cv = new CVParser().parse(SPACED_FINAL_CV_TEXT);

  it('extracts a name containing a single-letter middle initial', () => {
    expect(cv.contactInfo.name).toBe('MICHAEL T BALI');
  });

  it('stops the summary at the CORE SKILLS heading', () => {
    expect(cv.summary).not.toMatch(/CORE SKILLS|AI adoption, prompt engineering/);
    expect(cv.summary).toMatch(/7\+ years of experience/);
  });

  it('rejoins hard-wrapped bullet continuations instead of truncating mid-phrase', () => {
    const bullets = cv.experience[0].responsibilities;
    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toMatch(/and production monitoring\.$/);
    expect(bullets[1]).toMatch(/adopt AI capabilities confidently\.$/);
  });

  it('does not absorb trailing custom ALL-CAPS sections into the last role', () => {
    const last = cv.experience.at(-1);
    expect(last.company).toBe('Bincom ICT Solutions');
    expect(last.responsibilities).toHaveLength(2);
    expect(last.responsibilities.join(' ')).not.toMatch(/AI adoption patterns|log analysis tool/);
  });

  it('extracts achievements from a custom ALL-CAPS achievements heading, joining wrapped lines', () => {
    expect(cv.achievements).toContain(
      'Built an AI-powered log analysis tool that accelerated issue diagnosis and helped teams move from manual log review toward repeatable AI-assisted investigation.'
    );
    expect(cv.achievements.some(a => a.includes('case review automation system'))).toBe(true);
  });
});

describe('CVParser regression: duplicated PDF text layer (live Harvard-style CV)', () => {
  // The live defect: only DualMind + Sourcegraph UK survived because the
  // repeated PROFESSIONAL EXPERIENCE heading terminated section extraction.
  const cv = new CVParser().parse(DUPLICATED_TEXT_LAYER_CV);

  it('keeps every role that appears after the repeated experience heading', () => {
    const companies = cv.experience.map(e => e.company.split('|')[0].trim());
    expect(companies).toContain('Semgrep');
    expect(companies).toContain('Opay Financial Services');
    expect(companies).toContain('Microsoft (Tek-Experts)');
    expect(companies).toContain('Bincom ICT Solutions');
  });

  it('parses the Bincom company line as a company, not a job title', () => {
    const bincom = cv.experience.find(e => /Bincom/.test(e.company));
    expect(bincom).toBeDefined();
    expect(bincom.title).toBe('Python Developer');
  });

  it('joins a capitalised continuation after a dangling conjunction', () => {
    const sourcegraph = cv.experience.find(e => e.company === 'Sourcegraph | UK');
    expect(sourcegraph.responsibilities.some(b =>
      b.endsWith('collaboration with Engineering and Product teams.'))).toBe(true);
  });

  it('captures a SELECTED TECHNICAL LEADERSHIP & PROJECTS section as achievements, not last-role bullets', () => {
    const bincom = cv.experience.find(e => /Bincom/.test(e.company));
    expect(bincom.responsibilities.join(' ')).not.toMatch(/log analysis tool|Cody API wrapper/);
    expect(cv.achievements.some(a => a.includes('AI-powered log analysis tool'))).toBe(true);
    expect(cv.achievements.some(a =>
      a.includes('Cody API wrapper compatible with OpenAI and LangChain, enabling flexible AI integration for internal tooling and automation workflows.'))).toBe(true);
  });
});

describe('CVParser: em-dash header format + labelled skill categories (reference CV format)', () => {
  const cv = new CVParser().parse(EMDASH_FORMAT_CV);

  it('keeps company and location together and claims the real title from the next line', () => {
    const sg = cv.experience.find(e => /Sourcegraph/.test(e.company));
    expect(sg.company).toBe('Sourcegraph — UK (Remote)');
    expect(sg.title).toBe('DevOps & Platform Engineer (IC4) — promoted from Senior Technical Support Engineer');
    const ms = cv.experience.find(e => /Microsoft/.test(e.company));
    expect(ms.title).toBe('Cloud Support Engineer | Cloud Service SME');
  });

  it('extracts labelled skill categories, joining hard-wrapped lines and comma labels', () => {
    const labels = cv.skillCategories.map(c => c.label);
    expect(labels).toEqual(['MLOps & ML Lifecycle', 'CI/CD & Automation', 'Cloud, IaC & Platform']);
    const mlops = cv.skillCategories[0];
    expect(mlops.items).toContain('batch & real-time inference');
    expect(cv.skillCategories[1].items).toContain('Python');
  });

  it('drops glued cross-category items containing a colon', () => {
    for (const category of cv.skillCategories) {
      expect(category.items.some(item => item.includes(':'))).toBe(false);
    }
  });
});

describe('CVParser regression: auto-generated "Links:" trailer pollution (live defect)', () => {
  // Real defect: PDF upload appends a "Links:" block collecting EVERY
  // hyperlink annotation in the source document - including reference links
  // inside body bullets (a blog post, a conference page) - right after
  // whatever section happens to be last (usually Education). Left in the
  // text, it got swallowed whole into Education as bogus bullets AND
  // poisoned contactInfo.github/website with unrelated company/product URLs.
  const cvText = `MICHAEL T BALI
Birmingham, UK | mtbdesigns01@gmail.com | 07401731548 | LinkedIn
PROFESSIONAL SUMMARY
Cloud, platform, and MLOps engineer with 7+ years of experience.
PROFESSIONAL EXPERIENCE
Sourcegraph | UK
Feb 2026 - Present
DevOps & Platform Engineer
• Published an article on the Sourcegraph engineering blog.
EDUCATION, CERTIFICATIONS & RECOGNITION
• BSc Information Technology, University of Cape Coast, 2018
• Certified Kubernetes Administrator (CKA)

Links:
https://www.linkedin.com/in/michael-temitope-b-830640171/
https://www.amazon.co.uk/dp/B0H8M8Q2CG
https://sourcegraph.com/blog/how-our-support-engineers-use-deep-search
https://github.com/sourcegraph/handbook/blob/main/content/k8-migration.md`;

  const cv = new CVParser().parse(cvText);

  it('strips the auto-generated Links: trailer from rawText', () => {
    expect(cv.rawText).not.toMatch(/\nLinks:\n/);
    expect(cv.rawText).not.toMatch(/amazon\.co\.uk|sourcegraph\.com\/blog/);
  });

  it('does not misattribute an unrelated body/reference link as the candidate\'s own GitHub or website', () => {
    expect(cv.contactInfo.github).toBe('');
    expect(cv.contactInfo.website).toBe('');
    // The header word "LinkedIn" carries no URL of its own once the trailer
    // (the only place the URL appeared) is stripped - this is correct: the
    // header line is preserved and rendered as-is by the tailoring layer.
    expect(cv.contactInfo.linkedin).toBe('');
  });

  it('does not leave any URL or "Links:" heading inside the education section', () => {
    expect(cv.education.join(' ')).not.toMatch(/https?:\/\//);
  });
});

describe('CVParser: contact-info matching is scoped to the header, not the whole document', () => {
  it('ignores a GitHub URL that appears only in a body bullet, far from the header', () => {
    const cv = new CVParser().parse(`Jane Doe
jane@example.com

PROFESSIONAL EXPERIENCE
Acme | Engineer | 2020 - Present
• Migrated the team's internal tools, referencing github.com/some-other-org/tool for context.

EDUCATION
BSc Computer Science`);
    expect(cv.contactInfo.github).toBe('');
  });

  it('still finds a genuine GitHub URL presented in the header', () => {
    const cv = new CVParser().parse(`Jane Doe
jane@example.com
github.com/janedoe

PROFESSIONAL EXPERIENCE
Acme | Engineer | 2020 - Present
• Did the work.`);
    expect(cv.contactInfo.github).toBe('github.com/janedoe');
  });
});
