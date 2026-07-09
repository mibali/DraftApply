import { describe, expect, it } from 'vitest';
import { CVTailor } from '../shared/cv-tailor.js';

const tailor = new CVTailor();

describe('repairHardWrappedLines', () => {
  it('rejoins a hyphen-broken word across lines with no space', () => {
    const input = [
      'Strong production reliability background with hands-on experience building reproducible ML workflows, containerized inference services, cloud-',
      'native model serving, and scalable platform operations across AWS, Azure, and GCP.',
    ].join('\n');

    const output = tailor.repairHardWrappedLines(input);
    expect(output).toContain('cloud-native model serving');
    expect(output.split('\n')).toHaveLength(1);
  });

  it('rejoins short hyphen-broken fragments in generated summaries', () => {
    const input = [
      'Strong production reliability background with hands-on experience building reproducible ML workflows,',
      'containerized inference services, cloud-',
      'native model serving, and scalable platform operations across AWS, Azure, and GCP.',
    ].join('\n');

    const output = tailor.repairHardWrappedLines(input);
    expect(output).toContain('containerized inference services, cloud-native model serving');
    expect(output).not.toContain('cloud-\nnative');
  });

  it('rejoins a sentence wrapped mid-clause with a single space', () => {
    const input = [
      'Cloud, platform, and MLOps engineer with 7+ years of experience across production support, DevOps,',
      'kubernetes, CI/CD, and ML deployment.',
    ].join('\n');

    const output = tailor.repairHardWrappedLines(input);
    expect(output).toBe(
      'Cloud, platform, and MLOps engineer with 7+ years of experience across production support, DevOps, kubernetes, CI/CD, and ML deployment.'
    );
  });

  it('does not join bullets, headers, labels, dates, or contact lines', () => {
    const input = [
      'Delivered advanced troubleshooting for enterprise customers across cloud and SaaS platforms and beyond',
      '• led incident response for critical escalations',
      'PROFESSIONAL EXPERIENCE',
      'Focus: platform reliability and automation',
      'Feb 2019 - May 2020',
      'linkedin.com/in/example',
    ].join('\n');

    const output = tailor.repairHardWrappedLines(input);
    expect(output.split('\n')).toHaveLength(6);
  });

  it('does not join short header-block lines', () => {
    const input = ['Jordan Taylor', 'jordan@example.com', 'london, UK'].join('\n');
    expect(tailor.repairHardWrappedLines(input).split('\n')).toHaveLength(3);
  });

  it('does not merge a bare-domain LinkedIn/GitHub line onto a long preceding contact line (regression)', () => {
    const input = [
      'Jordan Taylor',
      'jordan.taylor@example.com | +44 7911 123456 | London, UK',
      'linkedin.com/in/jordantaylor',
    ].join('\n');

    const output = tailor.repairHardWrappedLines(input);
    expect(output.split('\n')).toHaveLength(3);
    expect(output).toContain('linkedin.com/in/jordantaylor');
    expect(output).not.toContain('UK linkedin.com');
  });

  it('still joins ordinary prose that references a repo URL mid-sentence (regression)', () => {
    const input = [
      'Built and open-sourced a reference implementation, hosted at',
      'github.com/janedoe/project for anyone who wanted to review the approach.',
    ].join('\n');

    const output = tailor.repairHardWrappedLines(input);
    expect(output.split('\n')).toHaveLength(1);
    expect(output).toContain('hosted at github.com/janedoe/project for anyone');
  });
});

describe('repositionOrphanFocusLines', () => {
  it('moves a Focus line stranded below bullets to above the bullet run', () => {
    const input = [
      'Microsoft (Tek-Experts) | Nigeria',
      'May 2020 - Mar 2021',
      'Cloud Support Engineer | Cloud Service SME',
      '• Provided advanced cloud and SaaS troubleshooting for corporate customers.',
      '• Managed critical escalations and stakeholder communication.',
      'Focus: MLOps and AI platform enablement, cloud infrastructure, platform reliability',
      '',
      'Bincom ICT Solutions | Nigeria',
    ].join('\n');

    const lines = tailor.repositionOrphanFocusLines(input).split('\n');
    const focusIdx = lines.findIndex(l => l.startsWith('Focus:'));
    const firstBulletIdx = lines.findIndex(l => l.startsWith('•'));
    expect(focusIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeLessThan(firstBulletIdx);
    expect(lines[focusIdx - 1]).toBe('Cloud Support Engineer | Cloud Service SME');
  });

  it('moves a Focus line above bullets even with blank lines between them', () => {
    const input = [
      'Microsoft (Tek-Experts) | Nigeria',
      'May 2020 - Mar 2021',
      'Cloud Support Engineer | Cloud Service SME',
      '• Provided advanced cloud and SaaS troubleshooting for corporate customers.',
      '',
      'Focus: MLOps and AI platform enablement, cloud infrastructure, platform reliability',
      '',
      'Bincom ICT Solutions | Nigeria',
    ].join('\n');

    const lines = tailor.repositionOrphanFocusLines(input).split('\n');
    const focusIdx = lines.findIndex(l => l.startsWith('Focus:'));
    const bulletIdx = lines.findIndex(l => l.startsWith('•'));
    expect(focusIdx).toBeLessThan(bulletIdx);
    expect(lines[focusIdx - 1]).toBe('Cloud Support Engineer | Cloud Service SME');
  });

  it('leaves correctly placed Focus lines untouched', () => {
    const input = [
      'Cloud Support Engineer',
      'Focus: platform reliability and automation',
      '• Provided advanced troubleshooting.',
    ].join('\n');

    expect(tailor.repositionOrphanFocusLines(input)).toBe(input);
  });
});

describe('repairDanglingBulletEndings', () => {
  it('removes dangling conjunctions from generated bullets', () => {
    const input = [
      '- Improved deployment and troubleshooting efficiency through Python scripting, automation, log analysis, and collaboration with Engineering and',
      '- Kept a complete sentence unchanged.',
    ].join('\n');

    const output = tailor.repairDanglingBulletEndings(input);
    expect(output).toContain('- Improved deployment and troubleshooting efficiency through Python scripting, automation, log analysis, and collaboration with Engineering.');
    expect(output).toContain('- Kept a complete sentence unchanged.');
  });
});

describe('mergeDuplicateSkillCategoryLines', () => {
  it('merges duplicate category labels into one line with the union of items', () => {
    const input = [
      'CORE COMPETENCIES',
      'Additional Technical Skills: reproducible training workflows, model promotion, batch and real-time inference, Great Expectations, Evidently AI, data validation',
      'Additional Technical Skills: drift detection, Lambda, AgentOps, CloudWatch',
    ].join('\n');

    const lines = tailor.mergeDuplicateSkillCategoryLines(input).split('\n');
    const categoryLines = lines.filter(l => l.startsWith('Additional Technical Skills:'));
    expect(categoryLines).toHaveLength(1);
    expect(categoryLines[0]).toContain('Great Expectations');
    expect(categoryLines[0]).toContain('drift detection');
    expect(categoryLines[0]).toContain('CloudWatch');
  });

  it('does not merge identical labels across different sections', () => {
    const input = [
      'CORE COMPETENCIES',
      'Programming: Python, Bash, SQL',
      'PROFESSIONAL EXPERIENCE',
      'Programming: JavaScript, TypeScript, Go',
    ].join('\n');

    const output = tailor.mergeDuplicateSkillCategoryLines(input);
    expect(output.split('\n')).toHaveLength(4);
  });

  it('never merges experience bullets across different jobs sharing a generic label (regression)', () => {
    const input = [
      'PROFESSIONAL EXPERIENCE',
      'Acme Corp',
      'Engineer A',
      '• Key results: reduced costs by 30%, improved reliability, cut deployment time by 50%',
      '',
      'Beta Inc',
      'Engineer B',
      '• Key results: automated testing pipeline, reduced QA cycle by 3 days, improved coverage to 85%',
    ].join('\n');

    const output = tailor.mergeDuplicateSkillCategoryLines(input);
    expect((output.match(/Key results:/g) || [])).toHaveLength(2);
    expect(output).toContain('reduced costs by 30%');
    expect(output).toContain('automated testing pipeline');
  });

  it('never merges across jobs even when the experience header is "Experience", not "Professional Experience" (regression)', () => {
    const input = [
      'CORE COMPETENCIES',
      'Programming: Python, SQL',
      '',
      'Experience',
      'Acme Corp',
      'Engineer A',
      '• Key results: reduced costs by 30%, improved reliability, cut deployment time by 50%',
      '',
      'Beta Inc',
      'Engineer B',
      '• Key results: automated testing pipeline, reduced QA cycle by 3 days, improved coverage to 85%',
    ].join('\n');

    const output = tailor.mergeDuplicateSkillCategoryLines(input);
    expect((output.match(/Key results:/g) || [])).toHaveLength(2);
  });

  it('ignores Focus lines and non-list label lines', () => {
    const input = [
      'Focus: MLOps and AI platform enablement, cloud infrastructure',
      'Focus: platform reliability, automation',
      'Email: jordan@example.com',
    ].join('\n');

    expect(tailor.mergeDuplicateSkillCategoryLines(input)).toBe(input);
  });
});

describe('_findTitleLineIndex composite pipe titles', () => {
  it('matches a rendered composite title from its primary segment', () => {
    const lines = [
      'PROFESSIONAL EXPERIENCE',
      'Microsoft (Tek-Experts) | Nigeria',
      'Cloud Support Engineer | Cloud Service SME',
      '• Provided advanced troubleshooting.',
    ];
    expect(tailor._findTitleLineIndex(lines, 'Cloud Support Engineer')).toBe(2);
  });

  it('matches a plain rendered title from a composite parsed title', () => {
    const lines = [
      'PROFESSIONAL EXPERIENCE',
      'Bincom ICT Solutions',
      'Python Developer',
      '• Developed reusable, testable Python code.',
    ];
    expect(tailor._findTitleLineIndex(lines, 'Python Developer | Backend Team')).toBe(2);
  });
});

describe('finalizeTailoredCV integration of format fixes', () => {
  it('applies wrap repair, focus repositioning, and category dedupe end-to-end', () => {
    const rawText = [
      'Jordan Taylor',
      'jordan@example.com',
      '',
      'PROFESSIONAL SUMMARY',
      'Cloud, platform, and MLOps engineer with 7+ years of experience building reproducible ML workflows, cloud-',
      'native model serving, and scalable platform operations across AWS, Azure, and GCP.',
      '',
      'CORE COMPETENCIES',
      'Cloud & Architecture: AWS, Azure, GCP',
      'Additional Technical Skills: Great Expectations, Evidently AI, data validation',
      'Additional Technical Skills: drift detection, Lambda, CloudWatch',
      '',
      'PROFESSIONAL EXPERIENCE',
      'Microsoft (Tek-Experts) | Nigeria',
      'May 2020 - Mar 2021',
      'Cloud Support Engineer | Cloud Service SME',
      '• Provided advanced cloud and SaaS troubleshooting for corporate customers.',
      'Focus: MLOps and AI platform enablement, cloud infrastructure, platform reliability',
    ].join('\n');

    const output = tailor.finalizeTailoredCV(rawText, {
      cvData: { experience: [] },
      jdData: { jobTitle: 'MLOps Engineer' },
      matchMap: [],
      confirmedSkills: [],
    });

    expect(output).toContain('cloud-native model serving');
    expect(output.match(/Additional Technical Skills:/g)).toHaveLength(1);
    const lines = output.split('\n');
    const focusIdx = lines.findIndex(l => l.trim().startsWith('Focus:'));
    const bulletIdx = lines.findIndex(l => l.trim().startsWith('•'));
    expect(focusIdx).toBeLessThan(bulletIdx);
  });
});

describe('dedupeNearDuplicateExperienceBullets', () => {
  it('removes a truncated duplicate of an already-present bullet, keeping the complete one', () => {
    const cvData = {
      experience: [
        { company: 'Sourcegraph', title: 'Senior Customer Success Engineer', dates: 'Feb 2024 - Jun 2025', responsibilities: [] },
      ],
    };
    const input = [
      'Sourcegraph',
      'Feb 2024 - Jun 2025',
      'Senior Customer Success Engineer',
      '• Resolved complex Tier 3/4 security platform issues across CI/CD pipelines, developer environments, APIs, containers, and enterprise-scale integrations.',
      '• Reduced customer integration failures by diagnosing GitHub Actions, GitLab CI, Jenkins, CircleCI, Buildkite, API, and container configuration issues.',
      '• Resolved complex Tier 3/4 security platform issues across CI/CD pipelines, developer environments, APIs, containers, and enterprise-scale',
    ].join('\n');

    const output = tailor.dedupeNearDuplicateExperienceBullets(input, cvData);
    const bullets = output.split('\n').filter(l => l.startsWith('•'));
    expect(bullets).toHaveLength(2);
    expect(output).toContain('enterprise-scale integrations.');
  });

  it('does not remove genuinely distinct bullets', () => {
    const cvData = {
      experience: [
        { company: 'Acme', title: 'Engineer', dates: 'Jan 2020 - Present', responsibilities: [] },
      ],
    };
    const input = [
      'Acme',
      'Jan 2020 - Present',
      'Engineer',
      '• Built the payments pipeline.',
      '• Reduced deployment time by 40%.',
      '• Mentored two junior engineers.',
    ].join('\n');

    const output = tailor.dedupeNearDuplicateExperienceBullets(input, cvData);
    expect(output.split('\n').filter(l => l.startsWith('•'))).toHaveLength(3);
  });

  it('does not remove duplicate-looking bullets across different roles', () => {
    const cvData = {
      experience: [
        { company: 'Acme', title: 'Engineer A', dates: 'Jan 2020 - Jan 2021', responsibilities: [] },
        { company: 'Beta', title: 'Engineer B', dates: 'Jan 2021 - Present', responsibilities: [] },
      ],
    };
    const input = [
      'Acme',
      'Jan 2020 - Jan 2021',
      'Engineer A',
      '• Resolved complex Tier 3/4 security platform issues across CI/CD pipelines and enterprise-scale integrations.',
      '',
      'Beta',
      'Jan 2021 - Present',
      'Engineer B',
      '• Resolved complex Tier 3/4 security platform issues across CI/CD pipelines and enterprise-scale integrations.',
    ].join('\n');

    const output = tailor.dedupeNearDuplicateExperienceBullets(input, cvData);
    expect(output.split('\n').filter(l => l.startsWith('•'))).toHaveLength(2);
  });
});

describe('entry-boundary detection with composite pipe titles (regression)', () => {
  // Root cause of a real bug: _findRoleEntryEnd/_findExperienceEntryEnd did
  // their own exact-match title/company checks, which fail for composite
  // "Title | Subtitle" lines. That made a role's computed "entry end"
  // overshoot into the NEXT role's block, so normaliseRoleFocusPlacement
  // scooped up a later role's Focus line while processing an earlier one -
  // and since it only re-inserts the first found Focus line while removing
  // all matched ones, the later role's Focus line was silently destroyed.
  const cvData = {
    experience: [
      { company: 'Rise8', title: 'DevOps Engineer', dates: 'Mar 2021 - Jun 2021', responsibilities: [] },
      { company: 'Microsoft (Tek-Experts)', title: 'Cloud Support Engineer', dates: 'May 2020 - Mar 2021', responsibilities: [] },
      { company: 'Bincom ICT Solutions', title: 'Python Developer', dates: 'Feb 2019 - May 2020', responsibilities: [] },
    ],
  };
  const text = [
    'DevOps Engineer',
    'Focus: cloud infrastructure, platform reliability',
    '• Improved deployment reliability using Kubernetes and Docker.',
    'Rise8',
    '',
    'Cloud Support Engineer | Cloud Service SME',
    '• Provided advanced cloud and SaaS troubleshooting for corporate customers.',
    'Focus: MLOps and AI platform enablement, cloud infrastructure, platform reliability',
    '',
    'Bincom ICT Solutions',
    'Python Developer',
    '• Developed reusable, testable Python code for production systems.',
  ].join('\n');

  it('_findRoleEntryEnd stops at a composite pipe-titled next role, not past it', () => {
    const lines = text.split('\n');
    const titleKeys = new Set(cvData.experience.map(exp => tailor._normaliseText(exp.title)));
    const devOpsTitleIdx = 0;
    const entryEnd = tailor._findRoleEntryEnd(lines, devOpsTitleIdx, titleKeys);
    // Must stop at "Cloud Support Engineer | Cloud Service SME" (index 5),
    // not run past it to "Python Developer" (index 10).
    expect(entryEnd).toBe(5);
  });

  it('does not lose a later composite-titled role Focus line while repositioning an earlier one', () => {
    const output = tailor.normaliseRoleFocusPlacement(text, cvData);
    const focusLines = output.split('\n').filter(l => l.trim().startsWith('Focus:'));
    expect(focusLines).toHaveLength(2);
    expect(output).toContain('Focus: MLOps and AI platform enablement');
  });
});

describe('full finalizeTailoredCV pipeline on a realistic multi-entry CV (regression)', () => {
  it('correctly reorders company/dates/title, keeps Focus lines, and removes duplicate bullets across all entries', () => {
    const cvData = {
      experience: [
        { company: 'Sourcegraph | USA / Remote', title: 'Senior Customer Success Engineer', dates: 'Feb 2024 - Jun 2025', responsibilities: ['Resolved complex Tier 3/4 security platform issues across CI/CD pipelines, developer environments, APIs, containers, and enterprise-scale integrations.'] },
        { company: 'Microsoft (Tek-Experts)', title: 'Cloud Support Engineer', dates: 'May 2020 - Mar 2021', responsibilities: ['Provided advanced cloud and SaaS troubleshooting for corporate customers, including critical escalations, action plans, stakeholder communication, and expectation management.'] },
        { company: 'Bincom ICT Solutions', title: 'Python Developer', dates: 'Feb 2019 - May 2020', responsibilities: ['Developed reusable, testable Python code for production systems while contributing to incident response, post-mortem analysis, and cross-functional software delivery.'] },
      ],
    };
    const rawText = [
      'Jordan Taylor', 'Senior Platform Engineer', '', 'PROFESSIONAL EXPERIENCE',
      // Reversed order + split date, matching what was observed live.
      'Feb 2024 -                    Jun 2025',
      'Senior Customer Success Engineer IC4',
      'Focus: cloud infrastructure, platform reliability',
      '• Resolved complex Tier 3/4 security platform issues across CI/CD pipelines, developer environments, APIs, containers, and enterprise-scale integrations.',
      '• Resolved complex Tier 3/4 security platform issues across CI/CD pipelines, developer environments, APIs, containers, and enterprise-scale',
      'Sourcegraph | USA / Remote', '',
      // Correct order, composite pipe title, Focus stranded after the bullet.
      'Microsoft (Tek-Experts) | Nigeria',
      'May 2020 - Mar 2021',
      'Cloud Support Engineer | Cloud Service SME',
      '• Provided advanced cloud and SaaS troubleshooting for corporate customers, including critical escalations, action plans, stakeholder communication, and expectation management.',
      'Focus: MLOps and AI platform enablement, cloud infrastructure, platform reliability', '',
      'Bincom ICT Solutions | Nigeria',
      'Feb 2019 - May 2020',
      'Python Developer',
      '• Developed reusable, testable Python code for production systems while contributing to incident response, post-mortem analysis, and cross-functional software delivery.',
    ].join('\n');

    const output = tailor.finalizeTailoredCV(rawText, {
      cvData, jdData: { jobTitle: 'Senior Platform Engineer' }, matchMap: [], confirmedSkills: [],
    });

    // Entry 1: reversed/malformed order fully restored.
    expect(output).toContain('Sourcegraph | USA / Remote\nFeb 2024 - Jun 2025\nSenior Customer Success Engineer');
    expect(output).not.toMatch(/Feb 2024 -\s{2,}Jun 2025/);
    expect((output.match(/Sourcegraph/g) || [])).toHaveLength(1);
    expect((output.match(/enterprise-scale integrations\./g) || [])).toHaveLength(1);

    // Entry 2: Focus line survives being stranded after the bullet, even
    // with a composite pipe title, even when an earlier entry was malformed.
    const lines = output.split('\n');
    const msTitleIdx = lines.findIndex(l => l.trim() === 'Cloud Support Engineer');
    expect(msTitleIdx).toBeGreaterThan(-1);
    expect(lines[msTitleIdx + 1]).toBe('Focus: MLOps and AI platform enablement, cloud infrastructure, platform reliability');

    // Entry 3: unaffected by the earlier entries' corruption.
    expect(output).toContain('Bincom ICT Solutions\nFeb 2019 - May 2020\nPython Developer');
  });
});

describe('_isLikelySectionHeader compound headings (regression)', () => {
  // _findRoleEntryEnd/_findExperienceEntryEnd stop scanning a role's block at
  // the first recognised section header. The anchored regex only matched bare
  // section names ("Education"), so a compound heading like "EDUCATION,
  // CERTIFICATIONS & RECOGNITION" was invisible to it - the last experience
  // entry's window silently extended to end-of-document, swallowing whatever
  // came after that heading as if it still belonged to that role.
  it('recognises a compound ALL-CAPS heading as a section boundary', () => {
    expect(tailor._isLikelySectionHeader('EDUCATION, CERTIFICATIONS & RECOGNITION')).toBe(true);
    expect(tailor._isLikelySectionHeader('TECHNICAL LEADERSHIP, ACHIEVEMENTS & INNOVATION')).toBe(true);
  });

  it('does not treat a bare all-caps company acronym as a section boundary', () => {
    expect(tailor._isLikelySectionHeader('IBM')).toBe(false);
    expect(tailor._isLikelySectionHeader('NASA')).toBe(false);
  });

  it('stops an experience entry window at a compound section heading', () => {
    const cvData = { experience: [{ company: 'Bincom ICT Solutions', title: 'Python Developer', dates: 'Feb 2019 - May 2020', responsibilities: [] }] };
    const lines = [
      'Bincom ICT Solutions', 'Feb 2019 - May 2020', 'Python Developer',
      '• Developed reusable, testable Python code for production systems.',
      '', 'EDUCATION, CERTIFICATIONS & RECOGNITION', 'BSc Information Technology',
    ];
    const titleKeys = new Set(cvData.experience.map(exp => tailor._normaliseText(exp.title)));
    const entryEnd = tailor._findRoleEntryEnd(lines, 2, titleKeys);
    expect(lines[entryEnd]).toBe('EDUCATION, CERTIFICATIONS & RECOGNITION');
  });
});

describe('repositionOrphanFocusLines drops Focus lines stranded under a section header (regression)', () => {
  it('removes a Focus line that ended up directly under a later section heading instead of a role', () => {
    const text = [
      'Bincom ICT Solutions', 'Feb 2019 - May 2020', 'Python Developer',
      '• Developed reusable, testable Python code for production systems.',
      '',
      'EDUCATION, CERTIFICATIONS & RECOGNITION',
      'Focus: cloud infrastructure, platform reliability, CI/CD and release engineering, observability and monitoring, and engineering enablement',
      '• BSc Information Technology, University of Cape Coast, 2018',
    ].join('\n');

    const output = tailor.repositionOrphanFocusLines(text);
    expect(output).not.toMatch(/Focus:/);
    expect(output).toContain('EDUCATION, CERTIFICATIONS & RECOGNITION\n• BSc Information Technology');
  });

  it('still repositions a Focus line correctly stranded below a bullet run', () => {
    const text = [
      'Bincom ICT Solutions', 'Feb 2019 - May 2020', 'Python Developer',
      '• Developed reusable, testable Python code for production systems.',
      'Focus: backend systems and production reliability',
    ].join('\n');

    const output = tailor.repositionOrphanFocusLines(text);
    const lines = output.split('\n');
    expect(lines[3]).toBe('Focus: backend systems and production reliability');
  });
});

describe('restoreLockedExperienceDates handles multiple stints at the same employer (regression)', () => {
  // Real CVs commonly list an internal promotion as two experience entries
  // sharing one company, with the model writing the company name only once
  // (above the first/most-recent stint). The original implementation only
  // ever looked for a company line per entry; once the shared line was
  // consumed restoring the first stint, the second stint's company search
  // always failed and the entry was left completely unrestructured -
  // producing exactly the malformed split-date/no-company block seen live.
  it('restores a complete company/dates/title block for both stints instead of leaving the second one malformed', () => {
    const cvData = {
      experience: [
        { company: 'Sourcegraph | USA / Remote', title: 'Senior Customer Success Engineer', dates: 'Feb 2024 - Jun 2025', responsibilities: [] },
        { company: 'Sourcegraph | USA / Remote', title: 'Senior Technical Support Engineer', dates: 'Jul 2021 - Feb 2024', responsibilities: [] },
      ],
    };
    const rawText = [
      'Feb 2024 -                    Jun 2025',
      'Senior Customer Success Engineer IC4',
      '• Resolved complex Tier 3/4 security platform issues.',
      'Sourcegraph | USA / Remote',
      'Jul 2021 - Feb 2024',
      'Senior Technical Support Engineer',
      '• Delivered advanced customer-facing DevOps and platform support.',
    ].join('\n');

    const output = tailor.restoreLockedExperienceDates(rawText, cvData);
    expect(output).toContain('Sourcegraph | USA / Remote\nFeb 2024 - Jun 2025\nSenior Customer Success Engineer');
    expect(output).toContain('Sourcegraph | USA / Remote\nJul 2021 - Feb 2024\nSenior Technical Support Engineer');
    expect((output.match(/Sourcegraph \| USA \/ Remote/g) || [])).toHaveLength(2);
  });
});

describe('_findRoleEntryEnd stops at an intervening role whose title carries an unrecognised suffix (regression)', () => {
  // A role's own title is found with a startsWith fallback (_findTitleLineIndex
  // already tolerates a suffix like " IC4" or " - Transitioned from X"), but
  // _findRoleEntryEnd used to check ONLY exact/pipe-segment title matches when
  // deciding where a role's content window ends. A later role whose OWN title
  // line also carried an unrecognised suffix was invisible as a boundary, so
  // an earlier role's window silently swallowed that entire intervening role's
  // company line, dates, title, and bullets - corrupting Focus placement and,
  // via downstream bullet-processing that shares this same window, bullet
  // content itself.
  const cvData = {
    experience: [
      { company: 'Sourcegraph | UK', title: 'DevOps & Platform Engineer IC4', dates: 'Feb 2026 - Present', responsibilities: [] },
      { company: 'Semgrep | USA', title: 'Senior Customer Success Engineer', dates: 'Feb 2024 - Jun 2025', responsibilities: [] },
      { company: 'Sourcegraph | USA / Remote', title: 'Senior Technical Support Engineer', dates: 'Jul 2021 - Feb 2024', responsibilities: [] },
    ],
  };
  const lines = [
    'Sourcegraph | UK', 'Feb 2026 - Present',
    'DevOps & Platform Engineer IC4 - Transitioned from Senior Technical Support Engineer',
    'Focus: Improving platform reliability',
    '• Improved platform reliability by leading mitigation of high-impact production incidents.',
    '• Partnered with SRE and Engineering teams to improve architecture, scalability, telemetry coverage, and operational resilience.',
    'Semgrep | USA', 'Feb 2024 - Jun 2025', 'Senior Customer Success Engineer IC4',
    '• Resolved complex Tier 3/4 security platform issues.',
    'Sourcegraph | USA / Remote', 'Jul 2021 - Feb 2024', 'Senior Technical Support Engineer',
    '• Delivered advanced customer-facing DevOps and platform support.',
  ];

  it('stops the first role window at the intervening role\'s company line, not past its entire block', () => {
    const titleKeys = new Set(cvData.experience.map(exp => tailor._normaliseText(exp.title)));
    const companyKeys = new Set(cvData.experience.map(exp => tailor._normaliseText(exp.company)));
    const entryEnd = tailor._findRoleEntryEnd(lines, 2, titleKeys, companyKeys, tailor._normaliseText('Sourcegraph | UK'));
    expect(lines[entryEnd]).toBe('Semgrep | USA');
  });

  it('keeps every role\'s Focus line and bullets intact through the full pipeline despite the suffixed titles', () => {
    const text = lines.join('\n');
    const output = tailor.normaliseRoleFocusPlacement(text, cvData);
    expect(output.split('\n').filter(l => l.trim().startsWith('Focus:'))).toHaveLength(1);
    expect(output).toContain('Resolved complex Tier 3/4 security platform issues.');
    expect(output).toContain('Delivered advanced customer-facing DevOps and platform support.');
  });
});
