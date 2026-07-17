import { describe, expect, it } from 'vitest';
import { validateAnswerStructure } from '../shared/answer-structure-validator.js';

describe('answer structure validation', () => {
  it('accepts a complete STAR answer', () => {
    const answer = 'During a difficult migration, the challenge was stakeholder resistance. I needed to secure agreement on the rollout. I aligned the teams through workshops and introduced a phased plan. The result improved adoption and enabled delivery on schedule.';
    expect(validateAnswerStructure(answer, 'Tell me about a time you influenced stakeholders').status).toBe('pass');
  });
  it('flags an incomplete behavioral answer', () => {
    expect(validateAnswerStructure('I communicate clearly and work well with people.', 'Tell me about a time you influenced stakeholders').issues).toContain('star_missing_result');
  });
  it('requires direct yes or no', () => {
    expect(validateAnswerStructure('I have relevant experience.', 'Have you managed customers?').issues).toContain('missing_direct_yes_no');
  });
  it('checks technical contribution, decision, and outcome', () => {
    const answer = 'I designed the API gateway and chose asynchronous processing because it isolated slow dependencies. This improved reliability and reduced latency.';
    expect(validateAnswerStructure(answer, 'Describe your experience designing API architectures').status).toBe('pass');
  });
});
