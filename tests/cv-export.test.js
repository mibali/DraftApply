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
});
