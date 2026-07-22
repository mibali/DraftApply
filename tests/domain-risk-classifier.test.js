import { describe, expect, it } from 'vitest';
import { classifyDomainRisk } from '../shared/domain-packs/domain-classifier.js';
import {
  runApplicationAnswerAgents,
  runTailoredCvAgents,
  truthfulnessGuardAgent,
} from '../shared/agent-workflows.js';

const HEALTHCARE_JD = `
Registered Nurse

Requirements
- Active RN license
- Patient care experience
- BLS and ACLS certification
`;

const PRODUCT_JD = `
Product Manager

Requirements
- Product discovery
- Roadmap prioritisation
- User research

Responsibilities
- Lead discovery with customers and internal stakeholders.
- Prioritise roadmap trade-offs with engineering and design.
- Define product metrics, write requirements, and communicate launch plans.
- Partner with data teams to understand activation and retention.
- Coordinate releases with support, sales, and marketing.
- Translate customer feedback into clear problem statements and success measures.
- Work with engineering leads to scope releases, monitor delivery risk, and communicate trade-offs.
- Maintain product documentation so launch teams understand positioning, dependencies, and rollout plans.
`;

const CV_WITHOUT_LICENSE = `
Jordan Taylor

Experience
Healthcare Operations Coordinator
- Coordinated patient intake workflows and scheduling.

Skills
Stakeholder communication, documentation, operations
`;

describe('domain risk classifier', () => {
  it('detects regulated clinical roles and prompts for missing credentials', () => {
    const result = classifyDomainRisk({
      cvText: CV_WITHOUT_LICENSE,
      jobDescription: HEALTHCARE_JD,
      jobTitle: 'Registered Nurse',
    });

    expect(result.detected).toBe(true);
    expect(result.primaryProfile.id).toBe('clinical_healthcare');
    expect(result.reviewRequired).toBe(true);
    expect(result.credentialWarnings[0].severity).toBe('block');
    expect(result.credentialWarnings[0].missingCredentials).toEqual(expect.arrayContaining(['rn license']));
    expect(result.reviewPrompts.some(prompt => /license/i.test(prompt))).toBe(true);
  });

  it('stays passive for ordinary well-described non-regulated roles', () => {
    const result = classifyDomainRisk({
      cvText: 'Product manager with product discovery and user research experience.',
      jobDescription: PRODUCT_JD,
      jobTitle: 'Product Manager',
    });

    expect(result.detected).toBe(false);
    expect(result.reviewRequired).toBe(false);
    expect(result.credentialWarnings).toEqual([]);
  });

  it('flags sparse job descriptions as review cues instead of hard failures', () => {
    const result = classifyDomainRisk({
      cvText: 'Designer with a portfolio and campaign work.',
      jobDescription: 'Designer wanted. Send portfolio.',
      jobTitle: 'Designer',
    });

    expect(result.detected).toBe(true);
    expect(result.sparseContext).toBe(true);
    expect(result.reviewPrompts.some(prompt => /sparse/i.test(prompt))).toBe(true);
  });

  it('detects a regulated role from a job-title match even with only one body keyword hit (regression)', () => {
    // A JD literally titled "Attorney" is a much higher-precision signal than
    // an incidental body mention - it should not need a second corroborating
    // keyword the way a generic body-text mention does.
    const result = classifyDomainRisk({
      cvText: 'Experienced legal professional.',
      jobTitle: 'Attorney',
      jobDescription: 'We are seeking an experienced Attorney to join our growing practice. You will manage a full caseload, advise clients on complex matters, draft agreements, represent clients in negotiations, and work closely with senior partners on strategic decisions.',
    });

    expect(result.primaryProfile?.id).toBe('regulated_legal');
    expect(result.primaryProfile?.riskLevel).toBe('regulated');
    expect(result.reviewRequired).toBe(true);
  });

  it('does not flag an ordinary role whose body incidentally uses two generic business words (regression)', () => {
    // "portfolio" and "campaign" both appear here, but this is a Product
    // Manager JD, not a creative/design role - two generic word matches with
    // no title support should not trigger a creative-portfolio domain banner.
    const result = classifyDomainRisk({
      cvText: 'Senior PM.',
      jobTitle: 'Senior Product Manager',
      jobDescription: 'You will manage a portfolio of products end to end, working with engineering and design to plan and run each marketing campaign, aligned with company strategy and revenue goals across multiple product lines.',
    });

    expect(result.matchedProfiles.some(p => p.id === 'creative_portfolio')).toBe(false);
  });
});

describe('domain metadata in deterministic workflows', () => {
  it('adds domain metadata to application answer workflow without removing existing fields', () => {
    const result = runApplicationAnswerAgents({
      question: 'Do you have an active RN license?',
      cvText: CV_WITHOUT_LICENSE,
      jobDescription: HEALTHCARE_JD,
      jobTitle: 'Registered Nurse',
    });

    expect(result.workflow).toBe('applicationAnswer');
    expect(result.domainRisk.primaryProfile.id).toBe('clinical_healthcare');
    expect(result.truthfulness.domainCredentialWarnings.length).toBeGreaterThan(0);
    expect(result.truthfulness.reviewRequired).toBe(true);
  });

  it('adds domain metadata to tailored CV workflow', () => {
    const result = runTailoredCvAgents({
      cvText: CV_WITHOUT_LICENSE,
      jobDescription: HEALTHCARE_JD,
      jobTitle: 'Registered Nurse',
    });

    expect(result.workflow).toBe('tailoredCv');
    expect(result.domainRisk.primaryProfile.id).toBe('clinical_healthcare');
    expect(result.agentChain).toContain('Domain Risk Classifier');
  });

  it('keeps domain credential warnings inside the truthfulness guard', () => {
    const truth = truthfulnessGuardAgent([], {
      detected: true,
      reviewRequired: true,
      credentialWarnings: [{
        profileId: 'licensed_trade',
        severity: 'block',
        missingCredentials: ['license'],
        message: 'Trade credential requested by the JD is not clearly supported by the CV.',
      }],
    });

    expect(truth.domainCredentialWarnings[0].profileId).toBe('licensed_trade');
    expect(truth.reviewRequired).toBe(true);
    expect(truth.rules.some(rule => /domain-specific/i.test(rule))).toBe(true);
  });
});
