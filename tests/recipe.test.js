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

  it('routes troubleshooting approach questions to a dedicated process prompt', () => {
    const prompt = buildPrompts({
      question: "How do you approach troubleshooting when you don't immediately know what's wrong?",
      length: 'medium',
      tone: 'natural',
      cvText: `${CV}

Built Python-based automation tools for diagnostics and environment validation.
Led root cause analysis for production issues and authored runbooks.
Used log analysis to reproduce and isolate customer platform issues.`,
      jobTitle: 'AI Architect',
      jobDescription: 'The role needs customer-facing technical troubleshooting, production reliability, documentation, and root cause analysis.',
      requirements: ['Troubleshooting', 'Root cause analysis', 'Customer-facing technical support'],
    });

    expect(prompt.systemPrompt).toMatch(/troubleshooting\/process question/i);
    expect(prompt.systemPrompt).toMatch(/define\/reproduce the issue, gather evidence, isolate variables, test hypotheses/i);
    expect(prompt.systemPrompt).toMatch(/AVOID:/);
    expect(prompt.userPrompt).toMatch(/one specific CV example/i);
    expect(prompt.userPrompt).toMatch(/no bullet list/i);
    expect(prompt.maxTokens).toBeLessThanOrEqual(380);
  });
});
