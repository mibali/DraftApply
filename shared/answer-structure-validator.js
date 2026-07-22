import { classifyApplicationQuestion } from './question-classifier.js';

export function validateAnswerStructure(answer = '', question = '', explicitType = '') {
  const text = String(answer || '').trim();
  const classification = classifyApplicationQuestion(question);
  const type = explicitType || classification.type;
  const issues = [];
  if (!text) return { status: 'block', type, issues: ['empty_answer'] };

  if (type === 'yes_no' && !/^(yes|no)\b/i.test(text)) issues.push('missing_direct_yes_no');
  if (['short_factual', 'personal_factual', 'sensitive_voluntary', 'data_extraction'].includes(type)
      && text.split(/\s+/).length > 45) issues.push('factual_answer_too_long');
  if (type === 'behavioral') {
    if (!/\b(?:when|at|during|while|in my role|the situation|the challenge)\b/i.test(text)) issues.push('star_missing_situation');
    if (!/\b(?:i needed|i had to|my task|my goal|responsible for)\b/i.test(text)) issues.push('star_missing_task');
    if (!/\bI\s+(?:led|built|created|implemented|worked|analysed|analyzed|designed|resolved|introduced|coordinated|persuaded|aligned|developed)\b/i.test(text)) issues.push('star_missing_action');
    if (!/\b(?:result|outcome|reduced|increased|improved|saved|delivered|achieved|enabled|led to)\b/i.test(text)) issues.push('star_missing_result');
  }
  if (type === 'technical') {
    if (!/\bI\s+(?:built|designed|implemented|used|configured|developed|deployed|integrated|migrated|debugged)\b/i.test(text)) issues.push('technical_missing_contribution');
    if (!/\b(?:because|trade-?off|decision|chose|instead|to ensure|so that)\b/i.test(text)) issues.push('technical_missing_decision');
    if (!/\b(?:result|reduced|increased|improved|enabled|delivered|scaled|reliable|latency|availability)\b/i.test(text)) issues.push('technical_missing_outcome');
  }
  if (classification.multiPart) {
    const parts = String(question).split(/\?|(?:,|;)\s+and\s+/i).filter(part => part.trim().length > 8);
    const paragraphs = text.split(/\n+|(?<=\.)\s+/).filter(Boolean);
    if (parts.length >= 2 && paragraphs.length < 2) issues.push('multi_part_incomplete');
  }
  if (type === 'why_company' && !/\b(?:role|company|team|mission|product|customer|work)\b/i.test(text)) issues.push('motivation_missing_role_reason');
  if (type === 'cover_letter' && text.split(/\s+/).length < 80) issues.push('cover_letter_too_short');

  return { status: issues.length ? 'review' : 'pass', type, issues };
}

export default validateAnswerStructure;
