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
    chrome: { storage: { local: { async get() { return {}; }, async remove() {} } } },
    document: { getElementById() { return fakeEl; } },
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
    expect(html).toContain('class="cv-job-title">Position: Senior Technical Support Engineer IC4</p>');
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

    expect(html).toContain('class="cv-job-title">Position: Senior Technical Support Engineer IC4</p>');
    expect(html).toContain('class="cv-role-focus">Focus: MLOps, platform reliability, cloud infrastructure, automation, and production diagnostics</p>');
  });
});
