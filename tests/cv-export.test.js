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

    expect(html).toContain('<li>Containerization and Orchestration: Docker, Kubernetes</li>');
    expect(html).toContain('<li>Programming &amp; Scripting: Python and scripting for automation (e.g., Bash, Terraform), Git</li>');
    expect(html).not.toMatch(/4\+ years of experience/i);
    expect(html).not.toMatch(/Bachelor.*related field/i);
    expect(html).not.toMatch(/highly preferred/i);
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
