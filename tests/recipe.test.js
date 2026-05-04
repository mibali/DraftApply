import { describe, expect, it } from 'vitest';
import { buildPrompts } from '../render-proxy/recipe/index.js';

const CV = `Michael T Bali
Infra & MLOps Engineer
Birmingham, UK
mtbdesigns01@gmail.com

Professional Experience
Sourcegraph
Senior Technical Support Engineer

Semgrep
Senior Technical Support Engineer`;

describe('render proxy recipe', () => {
  it('routes monthly salary questions to a direct salary prompt', () => {
    const prompt = buildPrompts({
      question: 'What are your monthly salary expectations? (in USD)*',
      length: 'short',
      tone: 'natural',
      cvText: CV,
      jobTitle: 'Machine Learning Operations Engineer (MLOps)',
      jobDescription: 'We need an MLOps engineer for production ML systems.',
      requirements: ['MLOps', 'Kubernetes', 'Python', 'Cloud'],
      maxChars: 255,
    });

    expect(prompt.systemPrompt).toMatch(/SALARY \/ COMPENSATION question/);
    expect(prompt.systemPrompt).toMatch(/\$X-\$Y per month/);
    expect(prompt.systemPrompt).toMatch(/Do NOT mention previous employers/);
    expect(prompt.userPrompt).toMatch(/concrete USD monthly salary range/);
    expect(prompt.userPrompt).toMatch(/255 characters or fewer/);
    expect(prompt.maxTokens).toBeLessThanOrEqual(90);
  });

  it('does not treat a bare salary field as CV data extraction', () => {
    const prompt = buildPrompts({
      question: 'Salary expectations',
      cvText: CV,
    });

    expect(prompt.systemPrompt).not.toMatch(/data extraction assistant/i);
    expect(prompt.systemPrompt).toMatch(/SALARY \/ COMPENSATION question/);
  });
});
