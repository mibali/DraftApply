import { describe, expect, it } from 'vitest';
import { classifyApplicationQuestion } from '../shared/question-classifier.js';

describe('application question taxonomy', () => {
  it.each([
    ['LinkedIn profile URL', 'data_extraction'],
    ['What salary are you expecting?', 'salary'],
    ['What is your notice period?', 'personal_factual'],
    ['What is your ethnicity?', 'sensitive_voluntary'],
    ['Please provide a cover letter', 'cover_letter'],
    ['Why do you want to join our company?', 'why_company'],
    ['How do you approach troubleshooting production incidents?', 'troubleshooting'],
    ['Tell me about a time you influenced a difficult stakeholder', 'behavioral'],
    ['Describe your experience designing cloud API architectures', 'technical'],
    ['What is your greatest strength?', 'strength_weakness'],
    ['What motivates you in your career?', 'motivation'],
    ['Have you managed enterprise customers?', 'yes_no'],
    ['Briefly summarize your relevant background', 'brief'],
    ['What makes you a strong candidate?', 'general'],
  ])('classifies %s', (question, expected) => {
    expect(classifyApplicationQuestion(question).type).toBe(expected);
  });

  it('detects multi-part questions and requires every part to be answered', () => {
    const result = classifyApplicationQuestion('Why this role, and how does your experience prepare you for it?');
    expect(result.multiPart).toBe(true);
    expect(result.requiresJobContext).toBe(true);
  });

  it('marks personal and sensitive questions as requiring user facts', () => {
    expect(classifyApplicationQuestion('Do you need visa sponsorship?').requiresUserFact).toBe(true);
    expect(classifyApplicationQuestion('What is your disability status?').voluntary).toBe(true);
  });
});
