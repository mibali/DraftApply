import { describe, expect, it } from 'vitest';
import { SalaryBenchmarkService } from '../shared/salary-benchmark-service.js';
import { SALARY_BENCHMARKS } from '../shared/salary-benchmarks.js';

describe('SalaryBenchmarkService', () => {
  it('ships official-source metadata without hand-entered salary rows', () => {
    expect(SALARY_BENCHMARKS.sources.map(source => source.id)).toEqual(
      expect.arrayContaining(['ons-ashe', 'bls-oews', 'esco'])
    );
    expect(SALARY_BENCHMARKS.benchmarks).toEqual([]);
    expect(new SalaryBenchmarkService().hasOfficialSnapshot()).toBe(false);
  });

  it('formats usable benchmark rows for salary prompts when the monthly snapshot exists', () => {
    const service = new SalaryBenchmarkService({
      ...SALARY_BENCHMARKS,
      benchmarks: [{
        country: 'UK',
        roleProfileId: 'solution_engineering',
        currency: 'GBP',
        annual: { p25: 75000, median: 90000, p75: 110000 },
        sourceId: 'ons-ashe',
        sourceName: 'ONS ASHE',
        asOf: '2026-04',
      }],
    });

    const benchmark = service.lookup({
      jobTitle: 'Senior Solution Architect',
      question: 'What are your salary expectations in GBP?',
      roleProfile: { id: 'solution_engineering' },
    });

    expect(service.formatForPrompt(benchmark)).toContain('Official salary benchmark');
    expect(service.formatForPrompt(benchmark)).toContain('£90,000');
    expect(service.hasOfficialSnapshot()).toBe(true);
  });

  it('returns null rather than inventing data when no official benchmark row exists', () => {
    const service = new SalaryBenchmarkService();
    expect(service.lookup({ jobTitle: 'Marketing Manager', question: 'Expected salary?' })).toBeNull();
  });
});
