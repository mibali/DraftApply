import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadFormatter() {
  const code = fs.readFileSync(new URL('../extension-ready/cv-export.js', import.meta.url), 'utf8');
  const fakeEl = {
    hidden: false,
    innerHTML: '',
    textContent: '',
  };
  const sandbox = {
    chrome: {
      storage: { local: { async get() { return {}; }, async remove() {} } },
      tabs: { async getCurrent() { return null; }, async remove() {} },
    },
    document: { getElementById() { return { ...fakeEl, addEventListener() {} }; } },
    window: { print() {}, close() {} },
    URL,
    console,
  };

  vm.runInNewContext(`${code}\nglobalThis.__formatCvToHtml = formatCvToHtml;`, sandbox);
  return sandbox.__formatCvToHtml;
}

function loadExportHelpers() {
  const code = fs.readFileSync(new URL('../extension-ready/cv-export.js', import.meta.url), 'utf8');
  const fakeEl = {
    hidden: false,
    innerHTML: '',
    textContent: '',
    addEventListener() {},
  };
  const sandbox = {
    chrome: {
      storage: { local: { async get() { return {}; }, async remove() {} } },
      tabs: { async getCurrent() { return null; }, async remove() {} },
    },
    document: {
      title: 'Tailored CV',
      body: { appendChild() {} },
      createElement() { return { click() {}, remove() {} }; },
      getElementById() { return fakeEl; },
    },
    window: { print() {}, close() {} },
    Blob,
    URL,
    console,
  };

  vm.runInNewContext(`${code}
globalThis.__buildWordDocument = buildWordDocument;
globalThis.__safeDownloadName = safeDownloadName;`, sandbox);
  return {
    buildWordDocument: sandbox.__buildWordDocument,
    safeDownloadName: sandbox.__safeDownloadName,
  };
}

describe('cv-export formatter', () => {
  it('turns a LinkedIn label into a link and suppresses the duplicate raw URL', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Michael T Bali
Birmingham, UK
mtbdesigns01@gmail.com
Linkedin

Senior MLOps Engineer

Professional Summary
Cloud platform support experience.

http://linkedin.com/in/michael-temitope-bali-830640171`);

    expect(html).toContain('href="http://linkedin.com/in/michael-temitope-bali-830640171"');
    expect(html).toContain('>LinkedIn</a>');
    expect(html).not.toContain('cv-body"><a href="http://linkedin.com/in/michael-temitope-bali-830640171"');
  });

  it('does not link a generic anchor label like "here", even where it appears in unrelated prose (regression)', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Michael T Bali
Birmingham, UK
mtbdesigns01@gmail.com

Professional Summary
See my portfolio here. I relocated here in 2020 and have worked remotely since.`, {}, [
      { text: 'here', url: 'https://myportfolio.example.com' },
    ]);

    expect(html).not.toContain('href="https://myportfolio.example.com"');
    expect(html).toContain('See my portfolio here');
    expect(html).toContain('I relocated here in 2020');
  });

  it('still links a specific, non-generic annotation label (regression control)', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Michael T Bali
Birmingham, UK
mtbdesigns01@gmail.com

Professional Summary
Built the Acme Dashboard Project, a real-time analytics tool.`, {}, [
      { text: 'Acme Dashboard Project', url: 'https://acme.example.com/dashboard' },
    ]);

    expect(html).toContain('href="https://acme.example.com/dashboard"');
    expect(html).toContain('>Acme Dashboard Project</a>');
  });

  it('uses original CV contact URLs when tailored text only has social labels', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Michael T Bali
Birmingham, UK
mtbdesigns01@gmail.com
LinkedIn Profile
GitHub Profile
Website

Senior Platform Engineer

Professional Summary
Cloud platform support experience.`, {
      linkedin: 'https://linkedin.com/in/michael-temitope-bali-830640171',
      github: 'https://github.com/mibali',
      website: 'https://michaelbali.dev',
    });

    expect(html).toContain('href="https://linkedin.com/in/michael-temitope-bali-830640171"');
    expect(html).toContain('>LinkedIn</a>');
    expect(html).toContain('href="https://github.com/mibali"');
    expect(html).toContain('>GitHub</a>');
    expect(html).toContain('href="https://michaelbali.dev"');
    expect(html).toContain('>Website</a>');
  });

  it('prefers tailored CV URLs over original CV fallback URLs', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
GitHub
https://github.com/new-handle

Professional Summary
Cloud engineer.`, {
      github: 'https://github.com/old-handle',
    });

    expect(html).toContain('href="https://github.com/new-handle"');
    expect(html).not.toContain('https://github.com/old-handle');
  });

  it('linkifies partial social URLs without an https scheme in body content', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Engineer

Projects
- Maintained github.com/janedoe/platform-tools and documented linkedin.com/in/janedoe examples`);

    expect(html).toContain('href="https://github.com/janedoe/platform-tools"');
    expect(html).toContain('href="https://linkedin.com/in/janedoe"');
  });

  it('relinks arbitrary linked text from original CV annotations when the label survives tailoring', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Engineer

Projects
- Led the migration described in the platform case study and presented the demo deck to stakeholders.`, {}, [
      { text: 'platform case study', url: 'https://example.com/case-study' },
      { text: 'demo deck', url: 'https://example.com/demo' },
    ]);

    expect(html).toContain('href="https://example.com/case-study"');
    expect(html).toContain('>platform case study</a>');
    expect(html).toContain('href="https://example.com/demo"');
    expect(html).toContain('>demo deck</a>');
  });

  it('does not nest annotation links inside raw URLs already linkified in the tailored CV', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Engineer

Projects
- Portfolio: https://example.com/case-study`, {}, [
      { text: 'example.com', url: 'https://example.com' },
    ]);

    expect(html).toContain('href="https://example.com/case-study"');
    expect(html).not.toContain('<a href="https://<a');
  });

  it('linkifies bare non-social domains without breaking emails or punctuation', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Engineer

Projects
- Portfolio: michaelbali.dev/work.
- Case studies at docs.example.co.uk/case-study, plus demo app portfolio.app/demo.
- Contact remains jane@example.com`);

    expect(html).toContain('href="https://michaelbali.dev/work"');
    expect(html).toContain('michaelbali.dev/work</a>.');
    expect(html).toContain('href="https://docs.example.co.uk/case-study"');
    expect(html).toContain('docs.example.co.uk/case-study</a>,');
    expect(html).toContain('href="https://portfolio.app/demo"');
    expect(html).toContain('href="mailto:jane@example.com"');
    expect(html).not.toContain('https://example.com');
  });

  it('suppresses generated website links that are only email domains', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Michael T Bali
Infra & MLOps Engineer
Birmingham, UK
mtbdesigns01@gmail.com || 07401731548
http://linkedin.com/in/michael-temitope-bali-830640171
http://gmail.com

Professional Summary
Cloud platform support experience.`);

    expect(html).toContain('mtbdesigns01@gmail.com');
    expect(html).not.toContain('http://gmail.com');
  });

  it('recognizes common generated CV headings as section headers', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Software Engineer

Professional Summary
Summary text.

Core Competencies
- Python

Professional Experience
Acme
2022 - Present
Position: Engineer

Technical Skills
Python, SQL`);

    expect(html.match(/cv-section-header/g)).toHaveLength(4);
    expect(html).toContain('Professional Summary');
    expect(html).toContain('Core Competencies');
    expect(html).toContain('Professional Experience');
    expect(html).toContain('Technical Skills');
  });

  it('repairs hard-wrapped prose during export rendering', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
MLOps Engineer

Professional Summary
Strong production reliability background with hands-on experience building reproducible ML workflows,
containerized inference services, cloud-
native model serving, and scalable platform operations across AWS, Azure, and GCP.`);

    expect(html).toContain('containerized inference services, cloud-native model serving');
    expect(html).not.toContain('cloud-\n');
  });

  it('renders the target job title as the headline after contact lines', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
London, UK
jane@example.com

Senior MLOps Engineer

Professional Summary
Summary text.`);

    expect(html).toContain('class="cv-headline">Senior MLOps Engineer');
  });

  it('renders company names distinctly in experience sections', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Engineer

Professional Experience
Sourcegraph, UK
February 2026 - Present
Position: Senior Technical Support Engineer IC4`);

    expect(html).toContain('class="cv-company">Sourcegraph, UK</span>');
    expect(html).toContain('class="cv-entry-dates">February 2026 - Present</span>');
    expect(html).toContain('class="cv-job-title">Senior Technical Support Engineer IC4</p>');
  });

  it('keeps split date ranges together in experience sections', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Engineer

Professional Experience
Semgrep | USA
February 2024 -

June 2025
Senior Customer Success Engineer (IC4)

- Resolved complex support issues`);

    expect(html).toContain('class="cv-entry-dates">February 2024 - June 2025</span>');
    expect(html).toContain('class="cv-job-title">Senior Customer Success Engineer (IC4)</p>');
    expect(html).not.toContain('class="cv-date-line">June 2025</p>');
    expect(html).not.toContain('class="cv-date-line">February 2024 -</p>');
  });

  it('keeps column-flattened date ranges from becoming fake company rows', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Engineer

Professional Experience
Semgrep | USA
Feb 2024 - | Jun 2025
Senior Customer Success Engineer IC4
- Resolved complex support issues

Opay Financial Services | Nigeria
Mar 2021 -    Jun 2021
DevOps Engineer
- Improved deployment reliability`);

    expect(html).toContain('class="cv-company">Semgrep | USA</span>');
    expect(html).toContain('class="cv-entry-dates">Feb 2024 - Jun 2025</span>');
    expect(html).toContain('class="cv-company">Opay Financial Services | Nigeria</span>');
    expect(html).toContain('class="cv-entry-dates">Mar 2021 - Jun 2021</span>');
    expect(html).not.toContain('class="cv-company">Feb 2024 -</span>');
    expect(html).not.toContain('class="cv-company">Mar 2021 -</span>');
  });

  it('renders Focus lines distinctly without replacing the official job title', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior MLOps Engineer

Professional Experience
Sourcegraph, UK
February 2026 - Present
Position: Senior Technical Support Engineer IC4
Focus: MLOps, platform reliability, cloud infrastructure, automation, and production diagnostics

- Built Python automation tools`);

    expect(html).toContain('class="cv-job-title">Senior Technical Support Engineer IC4</p>');
    expect(html).toContain('class="cv-role-focus">Focus: MLOps, platform reliability, cloud infrastructure, automation, and production diagnostics</p>');
  });

  it('moves Focus lines above bullets during export rendering', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior MLOps Engineer

Professional Experience
Microsoft (Tek-Experts) | Nigeria
May 2020 - Mar 2021
Cloud Support Engineer | Cloud Service SME
- Provided advanced cloud and SaaS troubleshooting for corporate customers.

Focus: MLOps and AI platform enablement, cloud infrastructure, platform reliability

Bincom ICT Solutions | Nigeria
Feb 2019 - May 2020
Python Developer`);

    const focusIdx = html.indexOf('class="cv-role-focus"');
    const bulletIdx = html.indexOf('<li>Provided advanced cloud');
    expect(focusIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeLessThan(bulletIdx);
  });

  it('repairs dangling bullet endings during export rendering', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
Senior Engineer

Professional Experience
Sourcegraph | USA / Remote
Jul 2021 - Feb 2024
Senior Technical Support Engineer
- Improved deployment and troubleshooting efficiency through Python scripting, automation, log analysis, and collaboration with Engineering and`);

    expect(html).toContain('collaboration with Engineering.</li>');
    expect(html).not.toContain('collaboration with Engineering and</li>');
  });

  it('cleans pasted JD prose from Core Competencies when rendering', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
MLOps Engineer

Core Competencies
- MLOps, Cloud Infrastructure, and DevOps, Experience: 4+ years of experience in MLOps, DevOps, or a related field, with at least 1 year focused on deploying and managing AI, ML models in production. Experience with agentic or autonomous AI systems is highly preferred., Technical Stack: (1 year or less)Strong knowledge of MLOps tools and frameworks(Pytorch, Langraph, CrewAI, N8N). Proficiency in containerization with Docker and orchestration with Kubernetes., Programming & Scripting: Expertise in Python and familiarity with scripting for automation (e.g., Bash, Terraform). Strong experience with version control systems, particularly Git., Security Mindset: A strong understanding of security principles related to cloud and MLOps, including Identity and Access Management (IAM), data encryption, and secure pipeline design., Ethical AI Knowledge: Understanding of ethical AI principles, including bias detection, explainability, and compliance with regulations like GDPR or other relevant standards., Education: Bachelor’s degree in Computer Science, Engineering, Data Science, or a related field.
- Containerization and Orchestration: Docker, Kubernetes

Professional Experience
TechCorp`);

    expect(html).toContain('<p class="cv-skill-row"><strong>Containerization and Orchestration:</strong> Docker, Kubernetes</p>');
    expect(html).toContain('<p class="cv-skill-row"><strong>Programming &amp; Scripting:</strong> Python and scripting for automation (e.g., Bash, Terraform), Git</p>');
    expect(html).not.toMatch(/4\+ years of experience/i);
    expect(html).not.toMatch(/Bachelor.*related field/i);
    expect(html).not.toMatch(/highly preferred/i);
  });

  it('renders long labelled Core Competencies lines as consistent category rows', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jane Doe
jane@example.com
AI Solution Architect

Core Competencies
Cloud & Platform Engineering: AWS, Azure, GCP, Production Systems Engineering & Platform Operations, Debugging & Service Reliability, Azure DevOps, Azure Machine Learning
Programming & Automation: Python

Professional Experience
TechCorp`);

    expect(html).toContain('<p class="cv-skill-row"><strong>Cloud &amp; Platform Engineering:</strong> AWS, Azure, GCP, Production Systems Engineering &amp; Platform Operations, Debugging &amp; Service Reliability, Azure DevOps</p>');
    expect(html).toContain('<p class="cv-skill-row"><strong>Cloud &amp; Platform Engineering:</strong> Azure Machine Learning</p>');
    expect(html).not.toContain('class="cv-body">Cloud &amp; Platform Engineering');
    expect(html).not.toContain('<li>Cloud &amp; Platform Engineering');
  });

  // Regression for a live-generated CV: the model omitted the blank line
  // between one role's last bullet and the next role's company line
  // ("Semgrep | USA"), put a blank line AFTER the company instead, and split
  // the date range across two lines. The renderer showed the company as plain
  // body text and invented a fake bold entry with company "Feb 2024 -" and
  // dates "Jun 2025".
  it('renders a company line straight after a bullet, with a blank + split date range below it, as one proper entry', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jordan Taylor
Senior MLOps Engineer

PROFESSIONAL EXPERIENCE
Sourcegraph | UK
Feb 2026 - Present
DevOps & Platform Engineer IC4

• Conducted root cause analysis and implemented long-term remediation.
• Partnered with SRE and Engineering teams to improve operational resilience across production-
Semgrep | USA

Feb 2024 -
Jun 2025
Senior Customer Success Engineer IC4

• Resolved complex Tier 3/4 security platform issues across enterprise-scale integrations.

Sourcegraph | USA / Remote
Jul 2021 - Feb 2024
Senior Technical Support Engineer

• Delivered advanced customer-facing DevOps and platform support.`);

    expect(html).toContain('<span class="cv-company">Semgrep | USA</span>');
    expect(html).toContain('<span class="cv-entry-dates">Feb 2024 - Jun 2025</span>');
    expect(html).toContain('<p class="cv-job-title">Senior Customer Success Engineer IC4</p>');
    expect(html).not.toContain('<span class="cv-company">Feb 2024 -</span>');
    expect(html).not.toContain('<p class="cv-body">Semgrep | USA</p>');
    // The truncated trailing bullet fragment is repaired, not left dangling.
    expect(html).not.toContain('across production-</li>');
    expect(html).toContain('to improve operational resilience.</li>');
    // Neighbouring entries stay intact.
    expect(html).toContain('<span class="cv-company">Sourcegraph | USA / Remote</span>');
    expect(html).toContain('<span class="cv-entry-dates">Jul 2021 - Feb 2024</span>');
  });

  it('never turns a standalone date range into an entry row company', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jordan Taylor
Senior MLOps Engineer

PROFESSIONAL EXPERIENCE
• Some earlier bullet content.

Feb 2024 - Jun 2025
Senior Engineer

• Did the work.`);

    expect(html).not.toContain('<span class="cv-company">Feb 2024 -</span>');
    expect(html).not.toContain('cv-company">Feb 2024');
  });

  it('holds a pending company across blank lines so "Company / blank / dates / title" renders as one entry', () => {
    const formatCvToHtml = loadFormatter();
    const html = formatCvToHtml(`Jordan Taylor
Senior MLOps Engineer

PROFESSIONAL EXPERIENCE

Opay Financial Services | Nigeria

Mar 2021 - Jun 2021
DevOps Engineer

• Improved deployment reliability using Kubernetes and Docker.`);

    expect(html).toContain('<span class="cv-company">Opay Financial Services | Nigeria</span>');
    expect(html).toContain('<span class="cv-entry-dates">Mar 2021 - Jun 2021</span>');
    expect(html).toContain('<p class="cv-job-title">DevOps Engineer</p>');
  });

  it('builds an editable Word-compatible document from the rendered CV HTML', () => {
    const { buildWordDocument, safeDownloadName } = loadExportHelpers();
    const doc = buildWordDocument('<h1 class="cv-name">Jane Doe</h1><p class="cv-body">Cloud engineer</p>', 'Jane Doe CV');

    expect(doc).toMatch(/xmlns:w="urn:schemas-microsoft-com:office:word"/);
    expect(doc).toContain('<w:WordDocument>');
    expect(doc).toContain('.cv-name');
    expect(doc).toContain('Jane Doe');
    expect(doc).toContain('Cloud engineer');
    expect(safeDownloadName('Jane / Doe: CV')).toBe('Jane Doe CV.doc');
  });
});
