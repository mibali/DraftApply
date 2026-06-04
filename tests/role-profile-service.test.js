import { describe, it, expect } from 'vitest';
import { ROLE_PROFILES, RoleProfileService } from '../shared/role-profile-service.js';

const service = new RoleProfileService();
const normalise = value => String(value || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').replace(/\s+/g, ' ').trim();

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    const key = normalise(value);
    if (!key) continue;
    if (seen.has(key)) repeated.add(value);
    seen.add(key);
  }
  return [...repeated];
}

describe('RoleProfileService', () => {
  it('classifies non-tech job titles into standardized role profiles', () => {
    expect(service.classify({ jobTitle: 'Finance Analyst' })?.id).toBe('finance');
    expect(service.classify({ jobTitle: 'Financial Planning and Analysis Analyst' })?.id).toBe('finance');
    expect(service.classify({ jobTitle: 'Digital Marketing Manager' })?.id).toBe('marketing');
    expect(service.classify({ jobTitle: 'HR Business Partner' })?.id).toBe('hr_people');
    expect(service.classify({ jobTitle: 'Healthcare Administrator' })?.id).toBe('healthcare_admin');
    expect(service.classify({ jobTitle: 'Information Security Analyst' })?.id).toBe('security_analyst');
    expect(service.classify({ jobTitle: 'Systems Administrator' })?.id).toBe('systems_administrator');
  });

  it('classifies official HR occupation variants into the HR role profile', () => {
    expect(service.classify({ jobTitle: 'Human Resources Specialist' })?.id).toBe('hr_people');
    expect(service.classify({ jobTitle: 'Benefits Specialist' })?.id).toBe('hr_people');
    expect(service.classify({ jobTitle: 'Personnel Specialist' })?.id).toBe('hr_people');
    expect(service.enrichJDData({ jobTitle: 'Human Resources Coordinator' }).domain).toBe('hr');
  });

  it('classifies QA/testing job titles into the software QA role profile', () => {
    expect(service.classify({ jobTitle: 'QA Engineer' })?.id).toBe('software_qa');
    expect(service.classify({ jobTitle: 'Quality Assurance Analyst' })?.id).toBe('software_qa');
    expect(service.classify({ jobTitle: 'Software Test Engineer' })?.id).toBe('software_qa');
    expect(service.enrichJDData({ jobTitle: 'QA Analyst' }).domain).toBe('software_quality');
  });

  it('classifies DevOps/SRE/platform job titles into the DevOps role profile', () => {
    expect(service.classify({ jobTitle: 'DevOps Engineer' })?.id).toBe('devops_sre');
    expect(service.classify({ jobTitle: 'Development Operations Engineer' })?.id).toBe('devops_sre');
    expect(service.classify({ jobTitle: 'Network and Infrastructure Engineer' })?.id).toBe('devops_sre');
    expect(service.enrichJDData({ jobTitle: 'Site Reliability Engineer' }).domain).toBe('devops');
  });

  it('classifies data-engineering job titles into the data engineering role profile', () => {
    expect(service.classify({ jobTitle: 'Data Engineer' })?.id).toBe('data_engineer');
    expect(service.classify({ jobTitle: 'Database Architect' })?.id).toBe('data_engineer');
    expect(service.classify({ jobTitle: 'ETL Developer' })?.id).toBe('data_engineer');
    expect(service.classify({ jobTitle: 'Data Warehouse Architect' })?.id).toBe('data_engineer');
    expect(service.enrichJDData({ jobTitle: 'Data Engineer' }).domain).toBe('data_engineering');
  });

  it('classifies analytics job titles into the data analytics role profile', () => {
    expect(service.classify({ jobTitle: 'Data Analyst' })?.id).toBe('data_analytics');
    expect(service.classify({ jobTitle: 'Business Intelligence Analyst' })?.id).toBe('data_analytics');
    expect(service.classify({ jobTitle: 'BI Consultant' })?.id).toBe('data_analytics');
    expect(service.enrichJDData({ jobTitle: 'Business Intelligence Analyst' }).domain).toBe('data_science');
  });

  it('enriches JD data for security and IT operations roles with consistent domains', () => {
    expect(service.enrichJDData({ jobTitle: 'Security Analyst' }).domain).toBe('cybersecurity');
    expect(service.enrichJDData({ jobTitle: 'Network Administrator' }).domain).toBe('it_operations');
  });

  it('classifies customer support job titles into the customer success/support role profile', () => {
    expect(service.classify({ jobTitle: 'Customer Support Representative' })?.id).toBe('customer_success');
    expect(service.classify({ jobTitle: 'Client Services Representative' })?.id).toBe('customer_success');
    expect(service.classify({ jobTitle: 'Call Center Representative' })?.id).toBe('customer_success');
    expect(service.classify({ jobTitle: 'Customer Care Representative' })?.id).toBe('customer_success');
  });

  it('classifies official sales occupation variants into the sales role profile', () => {
    expect(service.classify({ jobTitle: 'Regional Sales Manager' })?.id).toBe('sales');
    expect(service.classify({ jobTitle: 'Sales Operations Manager' })?.id).toBe('sales');
    expect(service.classify({ jobTitle: 'Business Development Representative' })?.id).toBe('sales');
    expect(service.enrichJDData({ jobTitle: 'Territory Manager' }).domain).toBe('sales');
  });

  it('classifies official marketing occupation variants into the marketing role profile', () => {
    expect(service.classify({ jobTitle: 'Marketing Coordinator' })?.id).toBe('marketing');
    expect(service.classify({ jobTitle: 'Market Research Analyst' })?.id).toBe('marketing');
    expect(service.classify({ jobTitle: 'Search Marketing Strategist' })?.id).toBe('marketing');
    expect(service.enrichJDData({ jobTitle: 'Market Research Consultant' }).domain).toBe('marketing');
  });

  it('classifies IT support/helpdesk job titles into the systems administrator role profile', () => {
    expect(service.classify({ jobTitle: 'IT Support Specialist' })?.id).toBe('systems_administrator');
    expect(service.classify({ jobTitle: 'Help Desk Analyst' })?.id).toBe('systems_administrator');
    expect(service.classify({ jobTitle: 'Service Desk Analyst' })?.id).toBe('systems_administrator');
    expect(service.classify({ jobTitle: 'Desktop Support Technician' })?.id).toBe('systems_administrator');
  });

  it('enriches parsed JD data with positioning, credibility signals, risks, and skill categories', () => {
    const enriched = service.enrichJDData({
      jobTitle: 'Product Manager',
      responsibilities: ['Own product roadmap and prioritise customer problems'],
      requiredSkills: ['Roadmap ownership', 'User research'],
    });

    expect(enriched.roleProfile.id).toBe('product_manager');
    expect(enriched.domain).toBe('product_management');
    expect(enriched.targetPositioning).toMatch(/product judgment/i);
    expect(enriched.credibilitySignals).toContain('roadmap ownership');
    expect(enriched.unsupportedClaimRisks).toContain('P&L ownership');
    expect(enriched.skillCategories.some(cat => cat.label === 'Product Strategy')).toBe(true);
  });

  it('builds role-specific credibility guidance for the tailoring prompt', () => {
    const guidance = service.buildCredibilityGuidance({ jobTitle: 'Operations Manager' });
    expect(guidance).toContain('Role family: Operations / Project Management');
    expect(guidance).toContain('High-risk claims');
  });

  it('classifies operations/project roles into the operations role profile', () => {
    expect(service.classify({ jobTitle: 'Project Coordinator' })?.id).toBe('operations');
    expect(service.classify({ jobTitle: 'Project Management Specialist' })?.id).toBe('operations');
    expect(service.enrichJDData({ jobTitle: 'Project Coordinator' }).domain).toBe('operations');
  });

  it('classifies official healthcare administration variants into the healthcare admin profile', () => {
    expect(service.classify({ jobTitle: 'Medical Office Manager' })?.id).toBe('healthcare_admin');
    expect(service.classify({ jobTitle: 'Health Information Manager' })?.id).toBe('healthcare_admin');
    expect(service.classify({ jobTitle: 'Practice Administrator' })?.id).toBe('healthcare_admin');
    expect(service.enrichJDData({ jobTitle: 'Health Services Manager' }).domain).toBe('healthcare');
  });

  it('classifies official training and development variants into the education/training profile', () => {
    expect(service.classify({ jobTitle: 'Learning and Development Specialist' })?.id).toBe('education_training');
    expect(service.classify({ jobTitle: 'Training and Development Specialist' })?.id).toBe('education_training');
    expect(service.classify({ jobTitle: 'Corporate Trainer' })?.id).toBe('education_training');
    expect(service.enrichJDData({ jobTitle: 'Technical Trainer' }).domain).toBe('education');
  });

  it('warns when a tailored CV claims a role identity without role-family proof', () => {
    const warnings = service.validateCredibility({
      originalCvData: {
        rawText: `Jane Doe
Customer Support Specialist
- Answered customer tickets and maintained help centre articles`,
      },
      jdData: service.enrichJDData({ jobTitle: 'Product Manager' }),
      tailoredText: `Jane Doe
Product Manager

PROFESSIONAL SUMMARY
Product leader with ownership of roadmap strategy and market research.

CORE COMPETENCIES
Product Strategy: Roadmapping, Market Analysis, P&L Ownership

PROFESSIONAL EXPERIENCE
SupportCo
Customer Support Specialist
- Answered customer tickets and maintained help centre articles`,
    });

    expect(warnings.some(w => /Product Management/i.test(w))).toBe(true);
    expect(warnings.some(w => /P&L ownership/i.test(w))).toBe(true);
  });

  it('keeps role profile ids and aliases unique', () => {
    expect(duplicates(ROLE_PROFILES.map(profile => profile.id))).toEqual([]);

    const aliasOwners = new Map();
    const duplicateAliases = [];
    for (const profile of ROLE_PROFILES) {
      for (const alias of profile.aliases || []) {
        const key = normalise(alias);
        if (!key) continue;
        if (aliasOwners.has(key)) {
          duplicateAliases.push(`${alias} (${aliasOwners.get(key)} and ${profile.id})`);
        } else {
          aliasOwners.set(key, profile.id);
        }
      }
    }

    expect(duplicateAliases).toEqual([]);
  });

  it('keeps each role profile internally deduplicated', () => {
    const problems = [];

    for (const profile of ROLE_PROFILES) {
      for (const field of ['aliases', 'credibilitySignals', 'riskClaims', 'transferableEvidence']) {
        const repeated = duplicates(profile[field] || []);
        if (repeated.length > 0) problems.push(`${profile.id}.${field}: ${repeated.join(', ')}`);
      }

      const categoryLabels = (profile.skillCategories || []).map(cat => cat.label);
      const repeatedLabels = duplicates(categoryLabels);
      if (repeatedLabels.length > 0) problems.push(`${profile.id}.skillCategories labels: ${repeatedLabels.join(', ')}`);

      const categorySkills = [];
      for (const cat of profile.skillCategories || []) {
        const repeatedWithinCategory = duplicates(cat.skills || []);
        if (repeatedWithinCategory.length > 0) problems.push(`${profile.id}.${cat.label} skills: ${repeatedWithinCategory.join(', ')}`);
        for (const skill of cat.skills || []) categorySkills.push(skill);
      }
      const repeatedSkillsAcrossCategories = duplicates(categorySkills);
      if (repeatedSkillsAcrossCategories.length > 0) {
        problems.push(`${profile.id}.skillCategories duplicate skills: ${repeatedSkillsAcrossCategories.join(', ')}`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('does not let highly specific title aliases compete across profiles', () => {
    const titleOwners = new Map();
    const conflicts = [];

    for (const profile of ROLE_PROFILES) {
      for (const alias of profile.aliases || []) {
        const key = normalise(alias);
        const wordCount = key.split(/\s+/).filter(Boolean).length;
        if (wordCount < 2) continue;
        if (titleOwners.has(key)) {
          conflicts.push(`${alias} (${titleOwners.get(key)} and ${profile.id})`);
        } else {
          titleOwners.set(key, profile.id);
        }
      }
    }

    expect(conflicts).toEqual([]);
  });
});
