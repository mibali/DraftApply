import { describe, expect, it } from 'vitest';
import { CVTailor } from '../shared/cv-tailor.js';
import { CVParser } from '../shared/cv-parser.js';
import { MULTICOLUMN_CV_TEXT } from './fixtures/multicolumn-cv.js';

const tailor = new CVTailor();

const cvData = {
  contactInfo: {
    name: 'Michael T Bali',
    email: 'mtb@example.com',
    phone: '07401731548',
    linkedin: 'linkedin.com/in/michael-bali',
  },
  summary: 'Cloud, platform, and MLOps engineer with production support background.',
  experience: [
    {
      company: 'DualMind Tech Consulting Ltd | Birmingham, UK',
      title: 'MLOps / DevOps Engineer',
      dates: 'Sep 2025 - Present',
      responsibilities: [
        'Designed end-to-end MLOps workflows covering model training, deployment, and monitoring.',
        'Deployed ML inference services on Kubernetes using KServe patterns.',
      ],
    },
    {
      company: 'Semgrep | USA',
      title: 'Senior Customer Success Engineer',
      dates: 'Feb 2024 - Jun 2025',
      responsibilities: [
        'Resolved complex Tier 3/4 security platform issues across CI/CD pipelines.',
      ],
    },
    {
      company: 'Bincom ICT Solutions | Nigeria',
      title: 'Python Developer',
      dates: 'Feb 2019 - May 2020',
      responsibilities: [
        'Developed reusable, testable Python code for production systems.',
      ],
    },
  ],
  skills: ['Terraform', 'Kubernetes', 'MLflow', 'AWS', 'Python', 'Docker'],
  education: [{ institution: 'University of Cape Coast', degree: 'BSc Information Technology', dates: '2018' }],
  certifications: ['Certified Kubernetes Administrator (CKA)'],
  rawText: [
    'Michael T Bali',
    'MLOps Engineer',
    'mtb@example.com',
    '07401731548',
    'Birmingham, UK',
    '',
    'PROFESSIONAL SUMMARY',
    'Cloud, platform, and MLOps engineer with production support background.',
    '',
    'PROFESSIONAL EXPERIENCE',
    'DualMind Tech Consulting Ltd | Birmingham, UK',
    'Sep 2025 - Present',
    'MLOps / DevOps Engineer',
    '• Designed end-to-end MLOps workflows covering model training, deployment, and monitoring.',
    '',
    'EDUCATION, CERTIFICATIONS & RECOGNITION',
    'BSc Information Technology, University of Cape Coast, 2018',
    'Certified Kubernetes Administrator (CKA)',
    'UK Global Talent Endorsement - Tech Nation',
  ].join('\n'),
};

const jdData = { jobTitle: 'Senior MLOps Engineer', company: 'ClimateAi', seniority: 'Senior' };

describe('buildCvSkeleton', () => {
  const skeleton = tailor.buildCvSkeleton(cvData, jdData);

  it('locks company, dates, and title verbatim per role with stable ids', () => {
    expect(skeleton.roles).toHaveLength(3);
    expect(skeleton.roles[0]).toMatchObject({
      id: 'role_0',
      company: 'DualMind Tech Consulting Ltd | Birmingham, UK',
      dates: 'Sep 2025 - Present',
      title: 'MLOps / DevOps Engineer',
    });
    expect(skeleton.roles[1].id).toBe('role_1');
    expect(skeleton.roles[0].originalBullets).toHaveLength(2);
  });

  it('uses the target job title as the headline', () => {
    expect(skeleton.headline).toBe('Senior MLOps Engineer');
  });

  it('takes header contact lines verbatim from the raw CV, including location', () => {
    expect(skeleton.contacts).toContain('Birmingham, UK');
    expect(skeleton.contacts).toContain('mtb@example.com');
    // The old professional headline is NOT a contact line.
    expect(skeleton.contacts).not.toContain('MLOps Engineer');
  });

  it('extracts education lines verbatim from a compound raw section header', () => {
    expect(skeleton.educationLines).toEqual([
      'BSc Information Technology, University of Cape Coast, 2018',
      'Certified Kubernetes Administrator (CKA)',
      'UK Global Talent Endorsement - Tech Nation',
    ]);
  });

  it('falls back to parsed education + certifications when raw text has no education section', () => {
    const skel = tailor.buildCvSkeleton({ ...cvData, rawText: '' }, jdData);
    expect(skel.educationLines).toContain('BSc Information Technology, University of Cape Coast, 2018');
    expect(skel.educationLines).toContain('Certified Kubernetes Administrator (CKA)');
  });

  it('never swallows experience content that follows the education section in the raw CV (regression)', () => {
    // Real defect: the stored CV's raw text (multi-page PDF extraction, or a
    // previously exported CV re-uploaded as the source) continued with
    // experience entries after the education header, with no section header
    // in between. The extractor copied them verbatim into the locked
    // education list, so the rendered CV showed Semgrep/Sourcegraph entries
    // bulleted under EDUCATION.
    const rawWithTrailingExperience = [
      'Michael T Bali',
      'mtb@example.com',
      '',
      'EDUCATION, CERTIFICATIONS & RECOGNITION',
      'BSc Information Technology, University of Cape Coast, 2018',
      'Certified Kubernetes Administrator (CKA)',
      'UK Global Talent Endorsement - Tech Nation',
      'Member of the British Computer Society (MBCS); British Computer Society Certificate in IT',
      'Strategy Execution for Public Leadership, Harvard Online, 2025',
      'Semgrep | USA Feb 2024 - Jun 2025',
      'Senior Customer Success Engineer IC4',
      'Resolved complex Tier 3/4 security platform issues across CI/CD pipelines, developer environments, APIs, containers, and enterprise-scale',
      'integrations.',
      'Sourcegraph | USA / Remote Jul 2021 - Feb 2024',
      'Senior Technical Support Engineer',
      'Delivered advanced customer-facing DevOps and platform support for enterprise SaaS deployments, improving resolution of complex',
      'production and integration issues.',
    ].join('\n');

    const skel = tailor.buildCvSkeleton({ ...cvData, rawText: rawWithTrailingExperience }, jdData);
    expect(skel.educationLines).toEqual([
      'BSc Information Technology, University of Cape Coast, 2018',
      'Certified Kubernetes Administrator (CKA)',
      'UK Global Talent Endorsement - Tech Nation',
      'Member of the British Computer Society (MBCS); British Computer Society Certificate in IT',
      'Strategy Execution for Public Leadership, Harvard Online, 2025',
    ]);
    const joined = skel.educationLines.join('\n');
    expect(joined).not.toContain('Semgrep');
    expect(joined).not.toContain('Sourcegraph');
    expect(joined).not.toContain('Tier 3/4');
  });

  it('stops at an unknown company header carrying a date range, even when cvData did not parse that entry', () => {
    const raw = [
      'EDUCATION / CERTIFICATIONS',
      'BSc Information Technology, University of Cape Coast, 2018',
      'SomeNewCo | Remote Jan 2020 - Present',
      'Staff Engineer',
    ].join('\n');
    const skel = tailor.buildCvSkeleton({ ...cvData, rawText: raw }, jdData);
    expect(skel.educationLines).toEqual(['BSc Information Technology, University of Cape Coast, 2018']);
  });
});

describe('skeleton sanitisation of a corrupted CV parse (regression, from live output)', () => {
  // Real defect: the source CV was itself a previously exported (corrupted)
  // CV, so the parser produced duplicate role entries (one with the location
  // in the title field and truncated bullets), a role with company and dates
  // swapped into each other's fields, and hard-wrapped bullet fragments as
  // separate responsibilities. The skeleton rendered all of it verbatim.
  const corruptedCvData = {
    contactInfo: { name: 'Michael T Bali', email: 'mtb@example.com' },
    experience: [
      {
        company: 'DualMind Tech Consulting Ltd | Birmingham, UK',
        title: 'MLOps / DevOps Engineer',
        dates: 'Sep 2025 - Present',
        responsibilities: ['Designed end-to-end MLOps workflows covering model training, artifact versioning, deployment, serving, scaling, monitoring, and lifecycle management for cloud-native ML workloads.'],
      },
      {
        // Duplicate parse of the same role: location as title, truncated bullet.
        company: 'DualMind Tech Consulting Ltd',
        title: 'Birmingham, UK',
        dates: 'Sep 2025 - Present',
        responsibilities: ['Designed end-to-end MLOps workflows covering model training, artifact versioning, deployment, serving, scaling, monitoring, and lifecycle'],
      },
      {
        company: 'Semgrep | USA',
        title: 'Senior Customer Success Engineer',
        dates: 'Feb 2024 - Jun 2025',
        sourceId: 'experience:2',
        responsibilities: [
          // Hard-wrapped fragment split into its own bullet.
          'Resolved complex Tier 3/4 security platform issues across CI/CD pipelines, developer environments, APIs, containers, and enterprise-scale',
          'integrations.',
        ],
        responsibilityEvidence: [
          { sourceId: 'experience:2:responsibility:0' },
          { sourceId: 'experience:2:responsibility:1' },
        ],
      },
      {
        // Company and dates swapped into each other's fields, no title.
        company: 'Feb 2019 - May 2020',
        title: '',
        dates: 'Bincom ICT Solutions | Nigeria',
        responsibilities: ['Developed reusable, testable Python code for production systems.'],
      },
    ],
    rawText: '',
  };
  const skeleton = tailor.buildCvSkeleton(corruptedCvData, jdData);

  it('merges duplicate parses of the same role, preferring the copy with a real title and complete bullets', () => {
    const dualMind = skeleton.roles.filter(r => r.company.includes('DualMind'));
    expect(dualMind).toHaveLength(1);
    expect(dualMind[0].title).toBe('MLOps / DevOps Engineer');
    expect(dualMind[0].company).toBe('DualMind Tech Consulting Ltd | Birmingham, UK');
    // The truncated duplicate bullet is absorbed by the complete one.
    expect(dualMind[0].originalBullets).toHaveLength(1);
    expect(dualMind[0].originalBullets[0]).toContain('cloud-native ML workloads');
  });

  it('never uses a location as a job title', () => {
    expect(skeleton.roles.some(r => r.title === 'Birmingham, UK')).toBe(false);
  });

  it('swaps company and dates back when the parser scrambled them', () => {
    const bincom = skeleton.roles.find(r => r.company.includes('Bincom'));
    expect(bincom.company).toBe('Bincom ICT Solutions | Nigeria');
    expect(bincom.dates).toBe('Feb 2019 - May 2020');
  });

  it('rejoins hard-wrapped bullet fragments split into separate responsibilities', () => {
    const semgrep = skeleton.roles.find(r => r.company.includes('Semgrep'));
    expect(semgrep.originalBullets).toHaveLength(1);
    expect(semgrep.originalBullets[0]).toContain('enterprise-scale integrations.');
    expect(semgrep.originalBulletEvidence[0].sourceIds).toEqual([
      'experience:2:responsibility:0',
      'experience:2:responsibility:1',
    ]);
    expect(semgrep.allowedSourceIds).toEqual(semgrep.originalBulletEvidence[0].sourceIds);
  });

  it('removes a trailing PDF fragment after the last complete source sentence', () => {
    const skeleton = tailor.buildCvSkeleton({
      contactInfo: { name: 'X' },
      experience: [{
        company: 'Example Co',
        title: 'Software Engineer',
        dates: 'Jan 2020 - Dec 2021',
        responsibilities: [
          'Used iterative delivery to improve the product based on user feedback. Additionally, I analysed recurring themes, prioritizing',
        ],
      }],
      rawText: '',
    }, jdData);
    expect(skeleton.roles[0].originalBullets).toEqual([
      'Used iterative delivery to improve the product based on user feedback.',
    ]);
  });

  it('keeps genuinely distinct stints at the same company separate', () => {
    const twoStints = tailor.buildCvSkeleton({
      contactInfo: { name: 'X' },
      experience: [
        { company: 'Sourcegraph | UK', title: 'Platform Engineer', dates: 'Feb 2026 - Present', responsibilities: ['Did platform work.'] },
        { company: 'Sourcegraph | USA / Remote', title: 'Senior Technical Support Engineer', dates: 'Jul 2021 - Feb 2024', responsibilities: ['Did support work.'] },
      ],
      rawText: '',
    }, jdData);
    expect(twoStints.roles).toHaveLength(2);
  });
});

describe('parseStructuredContent', () => {
  it('parses clean JSON', () => {
    expect(tailor.parseStructuredContent('{"summary":"x"}')).toEqual({ summary: 'x' });
  });

  it('parses fenced JSON', () => {
    expect(tailor.parseStructuredContent('```json\n{"summary":"x"}\n```')).toEqual({ summary: 'x' });
  });

  it('parses JSON wrapped in prose', () => {
    expect(tailor.parseStructuredContent('Here is the result:\n{"summary":"x"}\nHope that helps!'))
      .toEqual({ summary: 'x' });
  });

  it('returns null for garbage, arrays, and empty input', () => {
    expect(tailor.parseStructuredContent('not json at all')).toBeNull();
    expect(tailor.parseStructuredContent('[1,2,3]')).toBeNull();
    expect(tailor.parseStructuredContent('')).toBeNull();
    expect(tailor.parseStructuredContent('{"broken": ')).toBeNull();
  });
});

describe('validateStructuredContent', () => {
  const skeleton = tailor.buildCvSkeleton(cvData, jdData);
  const opts = { matchMap: [], confirmedSkills: [], cvData };

  it('returns null for unusable input', () => {
    expect(tailor.validateStructuredContent(null, skeleton, opts)).toBeNull();
    expect(tailor.validateStructuredContent({ summary: '' }, { roles: [] }, opts)).toBeNull();
  });

  it('backfills a role the model dropped from its original bullets - a role can never disappear', () => {
    const content = tailor.validateStructuredContent({
      summary: 'Engineer.',
      competencies: [],
      roles: [{ id: 'role_0', focus: null, bullets: ['Designed and shipped ML workflows on Kubernetes clusters.'] }],
    }, skeleton, opts);
    const role1 = content.roles.find(r => r.id === 'role_1');
    expect(role1.bullets).toEqual(['Resolved complex Tier 3/4 security platform issues across CI/CD pipelines.']);
    expect(content.roles).toHaveLength(3);
  });

  it('retains meaningful source evidence when the model over-compresses a role', () => {
    const source = {
      ...cvData,
      experience: [{
        company: 'Mono',
        title: 'Team Lead, Technical Support & Integrations',
        dates: 'Feb 2021 - Present',
        responsibilities: Array.from({ length: 10 }, (_, index) =>
          `Delivered distinct supported production outcome number ${index + 1} for customers and engineering teams.`),
      }],
    };
    const sourceSkeleton = tailor.buildCvSkeleton(source, jdData);
    const content = tailor.validateStructuredContent({
      summary: { text: source.summary, sourceIds: ['summary:0'] },
      competencies: [],
      roles: [{
        id: 'role_0',
        focus: null,
        bullets: [{
          text: source.experience[0].responsibilities[0],
          sourceIds: ['experience:0:responsibility:0'],
        }],
      }],
    }, sourceSkeleton, { matchMap: [], confirmedSkills: [], cvData: source });

    expect(content.roles).toHaveLength(1);
    expect(content.roles[0].bullets).toHaveLength(5);
    expect(content.roles[0].bullets[0]).toContain('outcome number 1');
    expect(content.roles[0].bulletEvidence.map(item => item.text)).toEqual(content.roles[0].bullets);
    expect(content.roles[0].bulletEvidence.every(item =>
      item.sourceIds.every(id => sourceSkeleton.roles[0].allowedSourceIds.includes(id))
    )).toBe(true);
  });

  it('ignores role ids that do not exist in the skeleton', () => {
    const content = tailor.validateStructuredContent({
      summary: 'Engineer.',
      competencies: [],
      roles: [{ id: 'role_99', focus: 'Invented role', bullets: ['Fabricated bullet content here.'] }],
    }, skeleton, opts);
    expect(content.roles.map(r => r.id)).toEqual(['role_0', 'role_1', 'role_2']);
    expect(JSON.stringify(content)).not.toContain('Fabricated');
  });

  it('drops requirement-prose competency items and unsupported inventions, keeps real skills', () => {
    const content = tailor.validateStructuredContent({
      summary: 'Engineer.',
      competencies: [
        { label: 'Infrastructure as Code', items: [
          { text: 'Terraform', sourceIds: ['skill:0'] },
          { text: 'IaC using Terraform', sourceIds: ['skill:0'] },
          { text: 'deep experience building systems', sourceIds: ['skill:0'] },
        ] },
        { label: 'Cloud', items: [
          { text: 'AWS', sourceIds: ['skill:3'] },
          { text: 'Kubernetes', sourceIds: ['skill:1'] },
          { text: 'QuantumFabricator 9000', sourceIds: ['skill:1'] },
        ] },
      ],
      roles: [{ id: 'role_0', focus: null, bullets: ['Did the original work described in the CV.'] }],
    }, skeleton, opts);
    const allItems = content.competencies.flatMap(c => c.items);
    expect(allItems).toContain('Terraform');
    expect(allItems).toContain('AWS');
    expect(allItems).not.toContain('IaC using Terraform');
    expect(allItems).not.toContain('deep experience building systems');
    expect(allItems).not.toContain('QuantumFabricator 9000');
  });

  it('maps model-authored competency labels to application-owned display labels', () => {
    const content = tailor.validateStructuredContent({
      summary: 'Engineer.',
      competencies: [{
        label: 'Fabricated Employer with Secret Clearance',
        items: [{ text: 'Terraform', sourceIds: ['skill:0'] }],
      }],
      roles: [],
    }, skeleton, opts);
    expect(content.competencies).toEqual([{ label: 'Relevant Skills', items: ['Terraform'] }]);
    expect(JSON.stringify(content)).not.toContain('Fabricated Employer');
    expect(JSON.stringify(content)).not.toContain('Secret Clearance');
  });

  it('never treats full JD requirements as user-confirmed competency skills', () => {
    const confirmedSkills = [
      '3–5 years of experience in Machine Learning, Backend Software Engineering, Data Engineering, or MLOps roles',
      'production experience with ML lifecycle management platforms',
      'ability to collaborate with Data Scientists, Engineers, and Product',
      'AWS / GCP / Azure',
      'Build production ML platforms',
      'TensorFlow',
    ];
    const content = tailor.validateStructuredContent({
      summary: { text: cvData.summary, sourceIds: ['summary:0'] },
      competencies: [],
      roles: [],
    }, skeleton, { matchMap: [], confirmedSkills, cvData });

    expect(content.competencies).toEqual([{ label: 'Confirmed Skills', items: ['TensorFlow'] }]);
    expect(JSON.stringify(content)).not.toMatch(/years of experience|production experience|ability to collaborate|AWS \/ GCP|Build production/i);
    expect(JSON.stringify(content)).not.toContain('Additional Skills');
  });

  it('always includes user-confirmed skills even when the model omitted them', () => {
    const content = tailor.validateStructuredContent({
      summary: 'Engineer.',
      competencies: [{ label: 'Cloud', items: ['AWS', 'Kubernetes'] }],
      roles: [{ id: 'role_0', focus: null, bullets: ['Did the original work described in the CV.'] }],
    }, skeleton, { ...opts, confirmedSkills: ['Neptune.ai'] });
    const allItems = content.competencies.flatMap(c => c.items);
    expect(allItems).toContain('Neptune.ai');
  });

  it('drops an unsupported focus line rather than leaking model positioning', () => {
    const content = tailor.validateStructuredContent({
      summary: 'Engineer.',
      competencies: [],
      roles: [{ id: 'role_0', focus: 'Focus: Improving platform reliability', bullets: ['Kept the platform reliable throughout.'] }],
    }, skeleton, opts);
    expect(content.roles[0].focus).toBeNull();
  });

  it('rejects cross-role source ids instead of exposing them in accepted provenance', () => {
    const roleSourceId = skeleton.roles[0].allowedSourceIds[0];
    const crossRoleSourceId = skeleton.roles[1].allowedSourceIds[0];
    const original = skeleton.roles[0].originalBullets[0];
    const content = tailor.validateStructuredContent({
      summary: { text: 'Cloud, platform, and MLOps engineer with production support background.', sourceIds: ['summary:0'] },
      competencies: [],
      roles: [{
        id: 'role_0',
        focus: { text: original, sourceIds: [roleSourceId, crossRoleSourceId] },
        bullets: [{ text: original, sourceIds: [roleSourceId, crossRoleSourceId] }],
      }],
    }, skeleton, opts);

    expect(content.roles[0].focus).toBeNull();
    expect(content.roles[0].bulletEvidence.flatMap(item => item.sourceIds)).not.toContain(crossRoleSourceId);
  });

  it('dedupes near-identical and truncated-duplicate bullets within a role', () => {
    const content = tailor.validateStructuredContent({
      summary: 'Engineer.',
      competencies: [],
      roles: [{
        id: 'role_0',
        focus: null,
        bullets: [
          'Designed end-to-end MLOps workflows covering model training, deployment, and monitoring.',
          'Designed end-to-end MLOps workflows covering model training, deployment, and',
        ],
      }],
    }, skeleton, opts);
    expect(content.roles[0].bullets.filter(b => b.startsWith('Designed end-to-end'))).toHaveLength(1);
  });
});

describe('_dedupeContainedSkillItems', () => {
  it('collapses phrase-shaped variants into the listed tool, keeps compound product names', () => {
    expect(tailor._dedupeContainedSkillItems([
      'Terraform', 'IaC using Terraform', 'Azure', 'Azure DevOps',
      'reproducible training', 'reproducible training workflows',
    ])).toEqual(['Terraform', 'Azure', 'Azure DevOps', 'reproducible training']);
  });
});

describe('buildStructuredTailoringPrompt', () => {
  const matchMap = [
    { requirement: 'Kubernetes', allowedToMention: true, confirmedByUser: false, type: 'tool' },
    { requirement: 'Petabyte-scale datasets', allowedToMention: false, confirmedByUser: false, type: 'preferred' },
  ];
  const prompt = tailor.buildStructuredTailoringPrompt(cvData, jdData, matchMap, { confirmedSkills: ['Neptune.ai'] });

  it('returns prompts, temperature, and the skeleton', () => {
    expect(prompt.systemPrompt).toBeTruthy();
    expect(prompt.userPrompt).toBeTruthy();
    expect(prompt.temperature).toBeLessThanOrEqual(0.5);
    expect(prompt.skeleton.roles).toHaveLength(3);
  });

  it('instructs JSON-only output with the exact schema and forbids locked fields', () => {
    expect(prompt.systemPrompt).toContain('ONLY a single JSON object');
    expect(prompt.systemPrompt).toContain('"competencies"');
    expect(prompt.systemPrompt).toContain('"roles"');
    expect(prompt.systemPrompt).toMatch(/No section headers, dates, company names/);
  });

  it('lists every role id with its original bullets for grounding', () => {
    expect(prompt.userPrompt).toContain('role_0');
    expect(prompt.userPrompt).toContain('role_2');
    expect(prompt.userPrompt).toContain('Designed end-to-end MLOps workflows');
  });

  it('carries supported, unsupported, and confirmed requirements', () => {
    expect(prompt.userPrompt).toContain('✓ Kubernetes');
    expect(prompt.userPrompt).toContain('✗ Petabyte-scale datasets');
    expect(prompt.userPrompt).toContain('+ Neptune.ai');
  });
});

describe('buildStructuredAuditPrompt', () => {
  it('audits the same JSON shape against original bullets', () => {
    const skeleton = tailor.buildCvSkeleton(cvData, jdData);
    const content = { summary: 'x', competencies: [], roles: [{ id: 'role_0', focus: null, bullets: ['b'] }] };
    const prompt = tailor.buildStructuredAuditPrompt(skeleton, content, []);
    expect(prompt.systemPrompt).toContain('same JSON shape');
    expect(prompt.userPrompt).toContain('ORIGINAL ROLE BULLETS');
    expect(prompt.userPrompt).toContain(JSON.stringify(content));
  });
});

describe('renderTailoredCV', () => {
  const skeleton = tailor.buildCvSkeleton(cvData, jdData);

  it('renders the exact canonical Harvard shape (golden test)', () => {
    const content = {
      summary: 'Cloud, platform, and MLOps engineer targeting ML platform work.',
      competencies: [
        { label: 'Cloud & ML Platform', items: ['AWS', 'Kubernetes', 'MLflow'] },
        { label: 'Automation', items: ['Terraform', 'Python'] },
      ],
      roles: [
        { id: 'role_0', focus: 'Designing scalable ML workflows', bullets: ['Designed end-to-end MLOps workflows.'] },
        { id: 'role_1', focus: null, bullets: ['Resolved complex Tier 3/4 security platform issues.'] },
        { id: 'role_2', focus: null, bullets: ['Developed reusable, testable Python code.'] },
      ],
    };
    expect(tailor.renderTailoredCV(skeleton, content)).toBe([
      'Michael T Bali',
      'Senior MLOps Engineer',
      'mtb@example.com',
      '07401731548',
      'Birmingham, UK',
      'linkedin.com/in/michael-bali',
      '',
      'PROFESSIONAL SUMMARY',
      'Cloud, platform, and MLOps engineer targeting ML platform work.',
      '',
      'CORE COMPETENCIES',
      'Cloud & ML Platform: AWS, Kubernetes, MLflow',
      'Automation: Terraform, Python',
      '',
      'PROFESSIONAL EXPERIENCE',
      'DualMind Tech Consulting Ltd | Birmingham, UK',
      'Sep 2025 - Present',
      'MLOps / DevOps Engineer',
      'Focus: Designing scalable ML workflows',
      '• Designed end-to-end MLOps workflows.',
      '',
      'Semgrep | USA',
      'Feb 2024 - Jun 2025',
      'Senior Customer Success Engineer',
      '• Resolved complex Tier 3/4 security platform issues.',
      '',
      'Bincom ICT Solutions | Nigeria',
      'Feb 2019 - May 2020',
      'Python Developer',
      '• Developed reusable, testable Python code.',
      '',
      'EDUCATION, CERTIFICATIONS & RECOGNITION',
      '• BSc Information Technology, University of Cape Coast, 2018',
      '• Certified Kubernetes Administrator (CKA)',
      '• UK Global Talent Endorsement - Tech Nation',
      '',
    ].join('\n'));
  });

  it('omits empty sections instead of emitting bare headers', () => {
    const text = tailor.renderTailoredCV(
      { ...skeleton, educationLines: [] },
      { summary: '', competencies: [], roles: skeleton.roles.map(r => ({ id: r.id, focus: null, bullets: ['Did the work.'] })) }
    );
    expect(text).not.toContain('PROFESSIONAL SUMMARY');
    expect(text).not.toContain('CORE COMPETENCIES');
    expect(text).not.toContain('EDUCATION');
    expect(text).toContain('PROFESSIONAL EXPERIENCE');
  });
});

describe('locked projects in the structured CV harness', () => {
  const parsed = new CVParser().parse(MULTICOLUMN_CV_TEXT);
  const target = { jobTitle: 'Senior Developer Support Engineer', company: 'Example Cloud' };
  const skeleton = tailor.buildCvSkeleton(parsed, target);

  it('preserves parsed projects and globally recovered contacts outside model control', () => {
    expect(skeleton.contacts).toEqual(expect.arrayContaining([
      'alex@example.test',
      'https://www.linkedin.com/in/alex-morgan/',
      'https://alex.example.test',
    ]));
    expect(skeleton.contacts.join(' ')).not.toContain('deep experience');
    expect(skeleton.projects.map(project => project.name)).toEqual(['SprintBoard', 'PayCycle']);
    expect(skeleton.projects[0]).toMatchObject({
      url: 'https://sprintboard.example.test',
      skills: expect.arrayContaining(['Django', 'WebSockets']),
    });
    expect(skeleton.projects[0].originalBullets[1]).toContain('Django Channels');
    expect(skeleton.projects[0].originalBulletEvidence[0].sourceIds[0]).toMatch(/^project:0:bullet:/);
    for (const project of skeleton.projects) {
      for (const item of project.skillEvidence) {
        expect(parsed.sourceIndex[item.sourceIds[0]]?.text).toBe(item.text);
      }
    }
    expect(skeleton.roles.flatMap(role => role.allowedSourceIds).some(id => id.startsWith('project:'))).toBe(false);
  });

  it('ignores model-supplied projects and always renders locked project evidence', () => {
    const content = tailor.validateStructuredContent({
      summary: { text: parsed.summary, sourceIds: ['summary:0'] },
      competencies: [],
      roles: skeleton.roles.map(role => ({ id: role.id, focus: null, bullets: [] })),
      projects: [{ id: 'project_0', name: 'Fabricated Project', bullets: ['Invented revenue by 900%.'] }],
    }, skeleton, { cvData: parsed });
    expect(content).not.toHaveProperty('projects');
    const rendered = tailor.renderTailoredCV(skeleton, content);
    expect(rendered).toContain('Support engineer with deep experience diagnosing API integrations');
    expect(rendered).toContain('Works closely with Engineering and Product');
    expect(rendered).toContain('PROJECTS\nSprintBoard\nhttps://sprintboard.example.test');
    expect(rendered).toContain('Technologies: Django, WebSockets, Django Channels, PostgreSQL');
    expect(rendered).toContain('PayCycle');
    expect(rendered).not.toContain('Fabricated Project');
    expect(rendered).not.toContain('900%');

    const reparsed = new CVParser().parse(rendered);
    expect(reparsed.experience.map(role => role.company)).toEqual(parsed.experience.map(role => role.company));
    expect(reparsed.projects.map(project => project.name)).toEqual(['SprintBoard', 'PayCycle']);
    expect(reparsed.projects[0].bullets).toContain('Developed Django REST APIs and real-time updates using WebSockets and Django Channels.');
  });
});

describe('structured pipeline end-to-end with a mocked model response (adversarial)', () => {
  it('produces a clean CV even when the model response is fenced, disordered, and partially fabricated', () => {
    const matchMap = [{ requirement: 'Kubernetes', allowedToMention: true, confirmedByUser: false, type: 'tool' }];
    const prompt = tailor.buildStructuredTailoringPrompt(cvData, jdData, matchMap, { confirmedSkills: [] });

    // Everything a misbehaving model might do: markdown fences, roles out of
    // order, one role missing, a foreign role id, prose-shaped competency
    // items, an invented tool, dates/companies smuggled into a bullet.
    const mockModelResponse = [
      '```json',
      JSON.stringify({
        summary: { text: 'Cloud, platform, and MLOps engineer with production support background.', sourceIds: ['summary:0'] },
        competencies: [
          { label: 'Infrastructure as Code', items: [
            { text: 'Terraform', sourceIds: ['skill:0'] },
            { text: 'IaC using Terraform', sourceIds: ['skill:0'] },
          ] },
          { label: 'Cloud Platforms', items: [
            { text: 'AWS', sourceIds: ['skill:3'] },
            { text: 'Kubernetes', sourceIds: ['skill:1'] },
            { text: 'HyperCloud Ultra', sourceIds: ['skill:1'] },
          ] },
        ],
        roles: [
          { id: 'role_2', focus: null, bullets: ['Developed reusable, testable Python code for production systems.'] },
          { id: 'role_99', focus: 'Fake role', bullets: ['Fabricated achievement at a fabricated employer.'] },
          { id: 'role_0', focus: 'Focus: ML platform engineering', bullets: ['Designed end-to-end MLOps workflows on Kubernetes at DualMind (Sep 2025 - Present).'] },
        ],
      }),
      '```',
    ].join('\n');

    const content = tailor.validateStructuredContent(
      tailor.parseStructuredContent(mockModelResponse),
      prompt.skeleton,
      { matchMap, confirmedSkills: [], cvData }
    );
    const text = tailor.renderTailoredCV(prompt.skeleton, content);

    // Locked structure intact and in CV order, regardless of model disorder.
    expect(text.indexOf('DualMind Tech Consulting Ltd')).toBeLessThan(text.indexOf('Semgrep | USA'));
    expect(text.indexOf('Semgrep | USA')).toBeLessThan(text.indexOf('Bincom ICT Solutions'));
    expect(text).toContain('Semgrep | USA\nFeb 2024 - Jun 2025\nSenior Customer Success Engineer');
    // Dropped role backfilled from originals; fabricated role gone.
    expect(text).toContain('Resolved complex Tier 3/4 security platform issues');
    expect(text).not.toContain('Fabricated achievement');
    // Competency hygiene.
    expect(text).toContain('Terraform');
    expect(text).not.toContain('IaC using Terraform');
    expect(text).not.toContain('HyperCloud Ultra');
    // Unsupported focus positioning is dropped rather than leaked.
    expect(text).not.toContain('Focus: ML platform engineering');
    // Education verbatim at the end.
    expect(text).toContain('EDUCATION, CERTIFICATIONS & RECOGNITION\n• BSc Information Technology');
  });
});
