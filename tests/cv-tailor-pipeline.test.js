import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CVTailor } from '../shared/cv-tailor.js';

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

function visibleText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('tailored CV user-visible quality gates', () => {
  it('prevents pasted JD requirement prose from reaching the exported CV', () => {
    const tailor = new CVTailor();
    const formatCvToHtml = loadFormatter();

    const llmOutput = `Michael T Bali
mtbdesigns01@gmail.com
Birmingham, UK

Machine Learning Operations Engineer (MLOps)

Core Competencies
- MLOps, Cloud Infrastructure, and DevOps, Experience: 4+ years of experience in MLOps, DevOps, or a related field, with at least 1 year focused on deploying and managing AI, ML models in production. Experience with agentic or autonomous AI systems is highly preferred., Technical Stack: (1 year or less)Strong knowledge of MLOps tools and frameworks(Pytorch, Langraph, CrewAI, N8N). Proficiency in containerization with Docker and orchestration with Kubernetes., Programming & Scripting: Expertise in Python and familiarity with scripting for automation (e.g., Bash, Terraform). Strong experience with version control systems, particularly Git., Security Mindset: A strong understanding of security principles related to cloud and MLOps, including Identity and Access Management (IAM), data encryption, and secure pipeline design., Ethical AI Knowledge: Understanding of ethical AI principles, including bias detection, explainability, and compliance with regulations like GDPR or other relevant standards., Education: Bachelor’s degree in Computer Science, Engineering, Data Science, or a related field.
- Containerization and Orchestration: Docker, Kubernetes

Professional Experience
Sourcegraph
Senior Technical Support Engineer
- Supported production developer infrastructure and automation workflows.`;

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

    const tailoredCvText = tailor.cleanSkillsSection(
      tailor.ensureConfirmedSkillsIncluded(
        tailor.removeTailoringMetaPhrases(
          tailor.enforceTargetHeadline(llmOutput, 'Machine Learning Operations Engineer (MLOps)'),
          ''
        ),
        []
      ),
      matchMap,
      []
    );
    const html = formatCvToHtml(tailoredCvText);
    const text = visibleText(html);
    const bulletTexts = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => visibleText(match[1]));

    expect(text).not.toMatch(/4\+ years of experience/i);
    expect(text).not.toMatch(/highly preferred/i);
    expect(text).not.toMatch(/Bachelor.*related field/i);
    expect(text).not.toMatch(/deploying and managing AI, ML models/i);
    expect(bulletTexts.every(item => item.length <= 160)).toBe(true);
    expect(bulletTexts.some(item => /Model Serving & Infrastructure: .*Docker.*Kubernetes/.test(item))).toBe(true);
    expect(bulletTexts.some(item => /Programming & Automation: .*Python.*Bash/.test(item))).toBe(true);
    expect(text).toMatch(/\bTerraform\b/);
    expect(text).toMatch(/\bGit\b/);
  });
});
