import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../extension-ready/page-extractor.js', import.meta.url), 'utf8');

function createExtractor() {
  const sandbox = {
    window: {
      location: {
        href: 'https://example.test/jobs/123',
        hostname: 'example.test'
      }
    },
    document: {
      body: null
    }
  };
  vm.runInNewContext(source, sandbox);
  return new sandbox.window.PageExtractor();
}

describe('PageExtractor classified job context', () => {
  it('classifies generic job page text into role, team, responsibilities, requirements, and tech sections', () => {
    const extractor = createExtractor();
    const sections = extractor.classifyContextSections(`
      About the team
      You will join the AI platform team supporting customer-facing engineering work.

      About the role
      This role bridges cloud products and production-grade customer deployments.

      Your Responsibilities
      Build reusable tools and deployment patterns for enterprise AI systems.
      Partner with product and engineering leaders to unblock customer implementations.

      Minimum Qualifications
      10 years of experience in cloud computing or a technical customer-facing role.
      Experience developing Generative AI solutions and RAG systems.

      Technologies
      Python, Vertex AI, Google Cloud, Kubernetes, Docker, Terraform, GitHub Actions.
    `);

    expect(sections.about_team.join(' ')).toContain('AI platform team');
    expect(sections.about_role.join(' ')).toContain('production-grade customer deployments');
    expect(sections.responsibilities.join(' ')).toContain('deployment patterns');
    expect(sections.requirements.join(' ')).toContain('Generative AI solutions');
    expect(sections.tech_stack.join(' ')).toContain('Vertex AI');
  });

  it('builds a compact prompt context without benefits or application-form noise', () => {
    const extractor = createExtractor();
    const sections = extractor.classifyContextSections(`
      About the role
      Lead forward deployed engineering for GenAI customers.

      Responsibilities
      Manage engineers who code, debug, and deploy agentic systems.

      Benefits
      Lunch vouchers and pension funding.

      Apply for this job
      Resume/CV, salary expectations, and sponsorship questions.
    `);

    const context = extractor.buildSectionedContextText(sections, 'fallback text');

    expect(context).toContain('About the role:');
    expect(context).toContain('Responsibilities:');
    expect(context).toContain('agentic systems');
    expect(context).not.toContain('Lunch vouchers');
    expect(context).not.toContain('salary expectations');
  });

  it('scores richer classified contexts higher than sparse fallback text', () => {
    const extractor = createExtractor();
    const sparse = extractor.classifyContextSections('Apply now. Resume/CV. Cover letter.');
    const rich = extractor.classifyContextSections(`
      About the role
      Build production AI systems.
      Responsibilities
      Deploy and maintain cloud services.
      Requirements
      Python, SQL, Kubernetes, and Google Cloud.
    `);

    expect(extractor.scoreContextSections(rich, 'heuristic')).toBeGreaterThan(
      extractor.scoreContextSections(sparse, 'fullpage')
    );
  });
});
