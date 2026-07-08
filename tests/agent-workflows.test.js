import { describe, expect, it } from 'vitest';
import {
  runApplicationAnswerAgents,
  runTailoredCvAgents,
  normalizeMatchReport,
} from '../shared/agent-workflows.js';

const CV = `
Jordan Taylor
Product Manager

Summary
Product manager focused on onboarding, product strategy, and user research.

Experience
Product Manager | Acme Inc | 2021 - Present
- Led a cross-functional onboarding redesign with Engineering, Design, and Data.
- Improved activation by 23% after prioritising user research and roadmap trade-offs.
- Managed stakeholder communication across support, sales, and leadership.

Skills
Product Strategy, Roadmapping, User Research, Stakeholder Management, SQL
`;

const JD = `
Job title: Product Manager
Company: ExampleCo

Requirements
- Product Strategy
- Roadmapping
- User Research
- A/B Testing

Responsibilities
- Own product discovery and roadmap prioritisation.
- Work cross-functionally with engineering, design, and stakeholders.
`;

describe('deterministic agent workflows', () => {
  it('builds application-answer evidence and job-context packages', () => {
    const result = runApplicationAnswerAgents({
      question: 'Describe a time you led a cross-functional product project.',
      cvText: CV,
      jobDescription: JD,
      jobTitle: 'Product Manager',
      company: 'ExampleCo',
    });

    expect(result.workflow).toBe('applicationAnswer');
    expect(result.agentChain).toContain('CV Grounding Agent');
    expect(result.agentChain).toContain('Truthfulness Guard Agent');
    expect(result.candidateEvidenceMap.evidenceItems.length).toBeGreaterThan(0);
    expect(result.roleRequirementMap.requirements.length).toBeGreaterThan(0);
    expect(result.relevantEvidence.some(item => /cross-functional|activation/i.test(item.text))).toBe(true);
  });

  it('builds tailored-CV match, gap, keyword, ATS, and truthfulness outputs', () => {
    const result = runTailoredCvAgents({
      cvText: CV,
      jobDescription: JD,
      jobTitle: 'Product Manager',
      company: 'ExampleCo',
    });

    expect(result.workflow).toBe('tailoredCv');
    expect(result.agentChain).toContain('JD Analysis Agent');
    expect(result.agentChain).toContain('ATS Formatting Agent');
    expect(result.matchMap.length).toBeGreaterThan(0);
    expect(result.matchReport).toHaveProperty('missingSkills');
    expect(result.gapAnalysis.confirmationRequired.some(item => /Testing/i.test(item.skill))).toBe(true);
    expect(result.keywordOptimisation.supportedKeywords).toEqual(expect.arrayContaining(['Product Strategy']));
    expect(result.atsFormatting.recommendedSections).toContain('Core Competencies');
    expect(result.truthfulness.unsupportedClaims.some(item => /Testing/i.test(item))).toBe(true);
  });

  it('normalizes legacy and API-contract match report shapes', () => {
    const legacy = normalizeMatchReport({
      score: 50,
      unsupportedRequirements: ['GraphQL'],
      partialMatches: ['API integration'],
    });
    const contract = normalizeMatchReport({
      score: 50,
      missingSkills: [{ skill: 'Kubernetes' }],
    });

    expect(legacy.missingSkills[0].skill).toBe('GraphQL');
    expect(legacy.transferableMatches).toEqual(['API integration']);
    expect(contract.unsupportedRequirements).toEqual(['Kubernetes']);
  });
});
