/**
 * End-to-end pipeline fixture tests.
 *
 * Exercises the full parsing + matching + prompt-building pipeline using a
 * realistic sample CV and JD. These tests catch regressions that unit tests
 * miss because they test the integration between components — e.g. a CV bullet
 * that uses outcome language ("cut onboarding from 6 weeks to 2") should match
 * a JD requirement that uses different language ("reduce time-to-value").
 */

import { describe, it, expect } from 'vitest';
import { CVParser } from '../shared/cv-parser.js';
import { JDParser } from '../shared/jd-parser.js';
import { CVTailor } from '../shared/cv-tailor.js';
import { buildPrompts } from '../render-proxy/recipe/index.js';

// ── Fixture data ─────────────────────────────────────────────────────────────

const SAMPLE_CV = `
Sarah Chen
sarah.chen@email.com | linkedin.com/in/sarahchen | London, UK

PROFESSIONAL SUMMARY
Solutions Engineer with 5 years of experience helping enterprise customers adopt
cloud-native platforms. Proven track record of cutting onboarding from 6 weeks
to 2, reducing customer churn by 30%, and supporting £3M+ in ARR.

EXPERIENCE

Senior Solutions Engineer | Acme Cloud | Jan 2022 – Present
- Led technical discovery workshops and proof-of-concept builds for enterprise prospects
- Cut customer onboarding time from 6 weeks to 2 by building self-serve implementation guides
- Collaborated with product and engineering teams to surface customer feedback, influencing 4 roadmap items
- Supported pre-sales cycles generating £2.1M in new ARR in FY2023
- Delivered 20+ technical demos to C-suite stakeholders at FTSE 500 companies

Solutions Consultant | DataStream Ltd | Mar 2019 – Dec 2021
- Conducted customer discovery sessions and requirements gathering for data integration projects
- Reduced customer churn by 30% through a proactive health monitoring programme
- Contributed to £900k in expansion ARR via upsell opportunities identified during QBRs

EDUCATION
BSc Computer Science | University of Edinburgh | 2019

SKILLS
Python, SQL, REST APIs, Kubernetes, AWS, Docker, Salesforce, Tableau, Jira,
Stakeholder management, Technical documentation, Customer success, Presales
`.trim();

const SAMPLE_JD = `
Senior Solutions Engineer — CloudFirst (London, hybrid)

We're looking for a Senior Solutions Engineer to join our growing GTM team.
You'll work closely with enterprise prospects to understand their needs, run
technical demos, and support the sales cycle from first call to signed contract.

Responsibilities:
- Run technical discovery sessions and workshops with prospects
- Build proof-of-concept implementations tailored to customer requirements
- Deliver compelling technical demonstrations to technical and non-technical audiences
- Partner with sales to support deals from first contact through close
- Provide feedback to product teams to inform roadmap decisions

Required Skills:
- Strong technical background — cloud platforms (AWS, GCP, or Azure), REST APIs
- Experience with pre-sales or solutions engineering
- Ability to run customer-facing workshops and stakeholder presentations
- Strong communication and stakeholder management skills
- Experience with enterprise sales cycles

Preferred Skills:
- Experience with Kubernetes or containerisation
- Customer success or post-sales experience
- Python scripting for integrations or automation

Tools: Salesforce, Jira, Tableau

We value candidates who can reduce time-to-value for our customers and demonstrate
measurable business impact in previous roles.
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFixturePipeline() {
  const cvData = new CVParser().parse(SAMPLE_CV);
  const jdData = new JDParser().parse(SAMPLE_JD, 'Senior Solutions Engineer', 'CloudFirst');
  const tailor = new CVTailor();
  const matchMap = tailor.buildMatchMap(cvData, jdData);
  return { cvData, jdData, matchMap, tailor };
}

// ── CV parsing ────────────────────────────────────────────────────────────────

describe('pipeline fixture — CV parsing', () => {
  it('extracts at least 2 experience entries', () => {
    const { cvData } = buildFixturePipeline();
    expect(cvData.experience.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts skills', () => {
    const { cvData } = buildFixturePipeline();
    expect(cvData.skills.length).toBeGreaterThan(0);
    const skillsLower = cvData.skills.map(s => s.toLowerCase()).join(' ');
    expect(skillsLower).toMatch(/python|kubernetes|aws/);
  });

  it('extracts quantified achievements from experience bullets', () => {
    const { cvData } = buildFixturePipeline();
    expect(cvData.achievements.length).toBeGreaterThan(0);
    const combined = cvData.achievements.join(' ');
    // At least one metric from the CV should be captured
    expect(combined).toMatch(/£|%|weeks?|ARR/i);
  });

  it('extracts recent role title from first experience entry', () => {
    const { cvData } = buildFixturePipeline();
    const titles = cvData.experience.map(e => e.title || '').join(' ').toLowerCase();
    expect(titles).toMatch(/solutions engineer|consultant/);
  });
});

// ── JD parsing ────────────────────────────────────────────────────────────────

describe('pipeline fixture — JD parsing', () => {
  it('extracts required skills including cloud and API skills', () => {
    const { jdData } = buildFixturePipeline();
    const allReqs = [...(jdData.requiredSkills || []), ...(jdData.tools || [])].map(r => r.toLowerCase()).join(' ');
    expect(allReqs).toMatch(/aws|api|salesforce/);
  });

  it('extracts tools', () => {
    const { jdData } = buildFixturePipeline();
    expect(jdData.tools?.length).toBeGreaterThan(0);
  });

  it('captures Kubernetes — in tools or required skills (JD parser routing)', () => {
    const { jdData } = buildFixturePipeline();
    // Kubernetes appears under "Preferred Skills" in the JD but may be
    // normalised into tools or requiredSkills depending on the parser.
    const allExtracted = [
      ...(jdData.preferredSkills || []),
      ...(jdData.requiredSkills || []),
      ...(jdData.tools || []),
    ].map(s => s.toLowerCase()).join(' ');
    expect(allExtracted).toMatch(/kubernetes/);
  });
});

// ── Match map ─────────────────────────────────────────────────────────────────

describe('pipeline fixture — matchMap', () => {
  it('produces at least 5 matched requirements', () => {
    const { matchMap } = buildFixturePipeline();
    expect(matchMap.length).toBeGreaterThanOrEqual(5);
  });

  it('authorizes an OR-list cloud requirement via one evidenced alternative (AWS)', () => {
    // "cloud platforms (AWS, GCP, or Azure)" is an OR-list: AWS in the CV
    // legitimately satisfies it. Treating the list as a conjunction was the
    // root cause of absurdly low match scores for well-qualified candidates.
    const { matchMap } = buildFixturePipeline();
    const awsEntry = matchMap.find(m => /aws|cloud/i.test(m.requirement));
    expect(awsEntry).toBeTruthy();
    expect(awsEntry.allowedToMention).toBe(true);
  });

  it('does not authorize an OR-list requirement when no alternative is evidenced', () => {
    const tailor = new CVTailor();
    const { cvData } = buildFixturePipeline();
    const matchMap = tailor.buildMatchMap(cvData, {
      requiredSkills: ['Production experience with data warehouses such as Snowflake, BigQuery, Redshift or similar'],
      preferredSkills: [], tools: [], softSkills: [],
    }, []);
    expect(matchMap[0].status).toBe('missing');
    expect(matchMap[0].allowedToMention).toBe(false);
  });

  it('marks Salesforce as supported (CV and JD both mention it)', () => {
    const { matchMap } = buildFixturePipeline();
    const sfEntry = matchMap.find(m => /salesforce/i.test(m.requirement));
    expect(sfEntry).toBeTruthy();
    expect(sfEntry.allowedToMention).toBe(true);
  });

  it('does not combine separate sources or semantic aliases to authorize a compound requirement', () => {
    const { matchMap } = buildFixturePipeline();
    // JD mentions "pre-sales or solutions engineering"; CV has "pre-sales cycles"
    const presalesEntry = matchMap.find(m => /pre.?sales|solution/i.test(m.requirement));
    expect(presalesEntry).toBeTruthy();
    expect(presalesEntry.allowedToMention).toBe(false);
  });

  it('calcMatchStrength returns strong or moderate for a well-matched CV', () => {
    const { matchMap, tailor } = buildFixturePipeline();
    const strength = tailor.calcMatchStrength(matchMap);
    expect(['strong', 'moderate']).toContain(strength.level);
    expect(strength.supportedCount).toBeGreaterThan(0);
    expect(strength.totalCount).toBeGreaterThan(0);
  });

  it('includes evidence snippets for supported requirements', () => {
    const { matchMap } = buildFixturePipeline();
    const supported = matchMap.filter(m => m.allowedToMention && m.evidence.length > 0);
    expect(supported.length).toBeGreaterThan(0);
    // Evidence should be non-empty strings
    for (const entry of supported.slice(0, 3)) {
      expect(typeof entry.evidence[0]).toBe('string');
      expect(entry.evidence[0].length).toBeGreaterThan(0);
    }
  });
});

// ── buildTailoringPrompt ──────────────────────────────────────────────────────

describe('pipeline fixture — buildTailoringPrompt', () => {
  it('produces a non-empty system prompt and user prompt', () => {
    const { cvData, jdData, matchMap, tailor } = buildFixturePipeline();
    const { systemPrompt, userPrompt } = tailor.buildTailoringPrompt(cvData, jdData, matchMap);
    expect(systemPrompt.length).toBeGreaterThan(100);
    expect(userPrompt.length).toBeGreaterThan(100);
  });

  it('includes role-specific content in the tailoring prompt', () => {
    const { cvData, jdData, matchMap, tailor } = buildFixturePipeline();
    const { userPrompt } = tailor.buildTailoringPrompt(cvData, jdData, matchMap);
    // Should reference JD role or company
    expect(userPrompt).toMatch(/Solutions Engineer|CloudFirst|pre-?sales|customer/i);
  });

  it('includes a MATCH LEVEL instruction reflecting the CV strength', () => {
    const { cvData, jdData, matchMap, tailor } = buildFixturePipeline();
    const { userPrompt } = tailor.buildTailoringPrompt(cvData, jdData, matchMap);
    expect(userPrompt).toMatch(/MATCH LEVEL:/i);
  });

  it('includes a MATCH REPORT line showing requirement counts', () => {
    const { cvData, jdData, matchMap, tailor } = buildFixturePipeline();
    const { userPrompt } = tailor.buildTailoringPrompt(cvData, jdData, matchMap);
    expect(userPrompt).toMatch(/MATCH REPORT/i);
  });
});

// ── recipe buildPrompts ───────────────────────────────────────────────────────

describe('pipeline fixture — recipe buildPrompts', () => {
  function buildAnswerPrompts(question) {
    const { cvData, jdData, matchMap } = buildFixturePipeline();
    return buildPrompts({
      question,
      length: 'medium',
      tone: 'natural',
      cvText: SAMPLE_CV,
      cvData,
      jdData,
      matchMap,
      jobTitle: 'Senior Solutions Engineer',
      company: 'CloudFirst',
      jobDescription: SAMPLE_JD,
    });
  }

  it('returns non-empty prompts for a behavioral question', () => {
    const result = buildAnswerPrompts('Tell me about a time you managed a complex technical implementation for an enterprise customer.');
    expect(result.systemPrompt.length).toBeGreaterThan(100);
    expect(result.userPrompt.length).toBeGreaterThan(100);
  });

  it('injects a MATCH LEVEL instruction into the system prompt for behavioral questions', () => {
    const result = buildAnswerPrompts('Tell me about a time you managed a complex technical implementation for an enterprise customer.');
    expect(result.systemPrompt).toMatch(/MATCH LEVEL:/i);
  });

  it('injects a requirements bridge now that the OR-list cloud requirement is supported', () => {
    // Under OR-list semantics the fixture's "cloud platforms (AWS, GCP, or
    // Azure), REST APIs" requirement is directly supported via AWS, so the
    // prompt legitimately surfaces it as a proof point.
    const result = buildAnswerPrompts('Tell me about a time you managed a complex technical implementation for an enterprise customer.');
    expect(result.userPrompt).toMatch(/JD REQUIREMENTS YOUR BACKGROUND COVERS/i);
  });

  it('includes CV-specific evidence in the user prompt (not just generic placeholder)', () => {
    const result = buildAnswerPrompts('Tell me about a time you had to influence stakeholders without authority.');
    // Should reference something real from the CV, not just a generic instruction
    expect(result.userPrompt).toMatch(/Acme|DataStream|onboarding|discovery|demo|ARR/i);
  });

  it('detects behavioral question type correctly', () => {
    const result = buildAnswerPrompts('Tell me about a time you managed a complex technical implementation.');
    expect(result.questionType).toBe('behavioral');
  });

  it('detects why_company question type correctly', () => {
    const result = buildAnswerPrompts('Why do you want to work at CloudFirst?');
    expect(result.questionType).toBe('why_company');
  });

  it('detects cover_letter question type correctly', () => {
    const result = buildAnswerPrompts('Please write a cover letter for this role.');
    expect(result.questionType).toBe('cover_letter');
  });

  it('MATCH LEVEL is STRONG or MODERATE for the well-matched fixture CV', () => {
    const result = buildAnswerPrompts('Tell me about your experience with enterprise customers.');
    expect(result.systemPrompt).toMatch(/MATCH LEVEL: (STRONG|MODERATE)/i);
  });

  it('cover letter prompt references specific role and company', () => {
    const result = buildAnswerPrompts('Please write a cover letter for the Senior Solutions Engineer role at CloudFirst.');
    expect(result.userPrompt).toMatch(/CloudFirst|Solutions Engineer/i);
  });

  it('does not inject MATCH LEVEL for salary questions', () => {
    const result = buildAnswerPrompts('What are your salary expectations?');
    expect(result.questionType).toBe('salary');
    expect(result.systemPrompt).not.toMatch(/MATCH LEVEL:/i);
  });
});

// ── ATS keyword coverage ──────────────────────────────────────────────────────

describe('pipeline fixture — ATS keyword coverage', () => {
  it('checkAtsKeywordCoverage returns coverage > 0 when tailored text has JD keywords', () => {
    const { jdData, tailor } = buildFixturePipeline();
    // The sample CV text itself should cover most ATS keywords
    const { coverage } = tailor.checkAtsKeywordCoverage(SAMPLE_CV, jdData);
    expect(coverage).toBeGreaterThan(0);
  });

  it('returns missing keywords when text is empty', () => {
    const { jdData, tailor } = buildFixturePipeline();
    const { missingKeywords, coverage } = tailor.checkAtsKeywordCoverage('', jdData);
    expect(coverage).toBe(0);
    expect(missingKeywords.length).toBeGreaterThan(0);
  });

  it('returns perfect coverage when tailored text contains all ATS keywords', () => {
    const { jdData, tailor } = buildFixturePipeline();
    // Build a text that contains every ATS keyword
    const allKeywords = [
      ...(jdData.atsKeywords || []),
      ...(jdData.requiredSkills || []).slice(0, 10),
      ...(jdData.tools || []).slice(0, 10),
    ].join(' ');
    const { coverage } = tailor.checkAtsKeywordCoverage(allKeywords.toLowerCase(), jdData);
    expect(coverage).toBe(1.0);
  });
});
