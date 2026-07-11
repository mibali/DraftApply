import { describe, expect, it } from 'vitest';
import { CVTailor } from '../shared/cv-tailor.js';
import { evaluateCvQualityCase, evaluateCvQualityCorpus } from '../shared/cv-quality-evaluator.js';
import { CV_QUALITY_CORPUS } from './fixtures/cv-quality-corpus.js';

describe('CV generation quality evaluation corpus', () => {
  it.each(CV_QUALITY_CORPUS)('$id passes every deterministic quality gate', fixture => {
    const result = evaluateCvQualityCase(fixture);
    expect(result.failures).toEqual([]);
    expect(result.metrics).toEqual({
      parseAccuracy: 1,
      contentRetention: 1,
      supportedAtsCoverage: 1,
      formattingIntegrity: 1,
      groundingIntegrity: 1,
      unsupportedClaimRate: 0,
    });
    expect(result.pass).toBe(true);
  });

  it('publishes aggregate metrics suitable for a CI quality gate', () => {
    const report = evaluateCvQualityCorpus(CV_QUALITY_CORPUS);
    expect(report.pass).toBe(true);
    expect(report.cases).toHaveLength(5);
    expect(report.aggregate).toEqual({
      parseAccuracy: 1,
      contentRetention: 1,
      supportedAtsCoverage: 1,
      formattingIntegrity: 1,
      groundingIntegrity: 1,
      unsupportedClaimRate: 0,
    });
  });

  it('fails the complete evaluation when an injected sentinel survives rendering', () => {
    const tailor = new CVTailor();
    const render = tailor.renderTailoredCV.bind(tailor);
    tailor.renderTailoredCV = (...args) => `${render(...args)}\nSENTINEL_UNSUPPORTED_BULLET`;
    const result = evaluateCvQualityCase(CV_QUALITY_CORPUS[0], { tailor });
    expect(result.pass).toBe(false);
    expect(result.metrics.unsupportedClaimRate).toBeGreaterThan(0);
    expect(result.counts.unsupportedClaims).toBe(1);
  });
});
