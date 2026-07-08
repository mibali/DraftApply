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

  it('leaves correctly placed Focus lines untouched', () => {
    const input = [
      'Cloud Support Engineer',
      'Focus: platform reliability and automation',
      '• Provided advanced troubleshooting.',
    ].join('\n');

    expect(tailor.repositionOrphanFocusLines(input)).toBe(input);
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
