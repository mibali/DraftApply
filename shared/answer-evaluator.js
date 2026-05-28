/**
 * Heuristic answer quality evaluator.
 *
 * Pattern-based scoring — no LLM call. Returns a 0–100 score and a list of
 * flags. Low scores (< 65) signal that a regeneration attempt is worthwhile.
 *
 * Skipped for question types where genericness is acceptable or unavoidable
 * (salary, yes/no, short factual, data extraction).
 */

const SKIP_TYPES = new Set(['salary', 'yes_no', 'short_factual', 'data_extraction']);

const GENERIC_OPENERS = [
  /^i am (a |an )?(motivated|passionate|dedicated|driven|experienced|skilled|seasoned|hardworking|results-driven|detail-oriented|dynamic|enthusiastic)/i,
  /^as (a |an )?(motivated|passionate|dedicated|driven|experienced|skilled|seasoned|hardworking|results-driven|detail-oriented|dynamic|enthusiastic)/i,
  /^i have (always |consistently )?(been )?(passionate|motivated|dedicated|driven|committed)/i,
  /^i would (like to |love to )?say that/i,
  /^i am (very |quite |extremely )?interested/i,
  /^i believe (i |that i )?(would be|am) (a )?(great|good|excellent|strong|ideal|perfect)/i,
  /^throughout my career/i,
  /^with (my |over |more than )?(\d+ years?|extensive|significant|broad|deep) (of )?(experience|background)/i,
  /^i am (writing|reaching out) (to express|because)/i,
  /^thank you for (the opportunity|considering|this|your)/i,
  /^i am pleased to/i,
  /^i am excited to/i,
];

const BANNED_PHRASES = [
  'team player',
  'go-getter',
  'self-starter',
  'think outside the box',
  'results-oriented',
  'detail-oriented',
  'hard worker',
  'strong work ethic',
  'passionate about',
  'fast learner',
  'quick learner',
  'people person',
  'synergy',
  'leverage my skills',
  'leverage my experience',
  'add value to',
  'i am the ideal candidate',
  'i would be a great fit',
  'i would be an excellent fit',
  'i would be a perfect fit',
  'perfect fit for',
  'i am confident that i',
  'needless to say',
  'as per',
  'to whom it may concern',
];

const WORD_COUNT_MIN = 40;

/**
 * Check if the answer contains any named evidence:
 * company/project names, quantified metrics (£/$, %, x faster, N users), or
 * proper nouns mid-sentence (not at start of sentence).
 */
function hasNamedEvidence(answer) {
  // Quantified metrics: numbers with units or symbols
  if (/\b\d[\d,.]*\s*(%|x\b|×|\$|£|€|k\b|m\b|bn\b|users?|customers?|clients?|teams?|engineers?|months?|weeks?)/i.test(answer)) return true;
  // Explicit metric phrases
  if (/\b(reduced|increased|improved|grew|saved|delivered|shipped|scaled|cut|doubled|tripled|halved)\b.{0,60}\b(\d|%)/i.test(answer)) return true;
  // Capitalized proper noun mid-sentence (not sentence-start): two consecutive caps words
  const midSentenceProper = /(?<=[a-z,;]\s)[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*/g;
  const properMatches = answer.match(midSentenceProper) || [];
  // Exclude generic filler caps (I, We, My, Our, This, That)
  const filler = new Set(['I', 'We', 'My', 'Our', 'This', 'That', 'It', 'They', 'He', 'She', 'The', 'A', 'An']);
  const realProper = properMatches.filter(m => !filler.has(m.split(' ')[0]));
  if (realProper.length >= 1) return true;
  return false;
}

function hasRepeatedSentence(answer) {
  const sentences = String(answer || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(s => s.length >= 25);

  const seen = new Set();
  for (const sentence of sentences) {
    if (seen.has(sentence)) return true;
    seen.add(sentence);
  }
  return false;
}

function hasTroubleshootingMethodSequence(answer) {
  const firstSentence = String(answer || '')
    .split(/(?<=[.!?])\s+/)[0]
    ?.toLowerCase() || '';

  const stepGroups = [
    /\b(define|clarify|scope|scoping|reproduce|reproducing|replicate|confirm)\b/,
    /\b(gather|gathering|collect|collecting|review|reviewing|inspect|inspecting|analy[sz]e|analy[sz]ing)\b.{0,40}\b(logs?|metrics?|evidence|signals?|context|impact|symptoms?|recent changes?)\b/,
    /\b(isolate|isolating|narrow|narrowing|segment|segmenting|compare|comparing)\b.{0,40}\b(variable|component|layer|service|failure|cause|path)\b/,
    /\b(test|testing|validate|validating|verify|verifying)\b.{0,40}\b(hypothes[ie]s|assumption|fix|change|failure point|root cause)\b/,
    /\b(fix|fixing|resolve|resolving|mitigate|mitigating|remediate|remediating|patch|patching)\b/,
    /\b(document|documenting|runbook|prevent|preventing|recurrence|repeat|follow-up|postmortem|post-mortem)\b/,
  ];

  return stepGroups.filter(re => re.test(firstSentence)).length >= 3;
}

/**
 * Evaluate the quality of a generated answer.
 *
 * @param {string} answer - The generated answer text
 * @param {string} questionType - Question type from recipe metadata
 * @returns {{ score: number, flags: string[], shouldRegenerate: boolean }}
 */
export function evaluateAnswer(answer, questionType) {
  if (SKIP_TYPES.has(questionType)) {
    return { score: 100, flags: [], shouldRegenerate: false };
  }

  if (!answer || !answer.trim()) {
    return { score: 0, flags: ['empty_answer'], shouldRegenerate: true };
  }

  const trimmed = answer.trim();
  const lower = trimmed.toLowerCase();
  const wordCount = trimmed.split(/\s+/).length;
  const flags = [];
  let score = 100;

  // Too short
  if (wordCount < WORD_COUNT_MIN) {
    flags.push('too_short');
    score -= 20;
  }

  // Generic opener
  if (GENERIC_OPENERS.some(re => re.test(trimmed))) {
    flags.push('generic_opener');
    score -= 20;
  }

  // Banned phrases (cap deduction at 30)
  let bannedHits = 0;
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      flags.push(`banned_phrase:${phrase}`);
      bannedHits++;
    }
  }
  score -= Math.min(bannedHits * 10, 30);

  // Repeated sentence / obvious loop
  if (hasRepeatedSentence(trimmed)) {
    flags.push('repeated_sentence');
    score -= 25;
  }

  // Troubleshooting answers should state the actual diagnostic sequence before
  // jumping into examples. "I use a structured approach" alone reads vague.
  if (questionType === 'troubleshooting' && !hasTroubleshootingMethodSequence(trimmed)) {
    flags.push('troubleshooting_missing_method_sequence');
    score -= 40;
  }

  // No named evidence
  if (!hasNamedEvidence(trimmed)) {
    flags.push('no_named_evidence');
    score -= 25;
  }

  score = Math.max(0, score);

  // Regenerate if score below threshold and the question type benefits from it
  const regenerableTypes = new Set(['behavioral', 'strength', 'weakness', 'motivation', 'why_company', 'cover_letter', 'general', 'troubleshooting']);
  const criticalRegenerationFlags = new Set(['troubleshooting_missing_method_sequence']);
  const hasCriticalFlag = flags.some(flag => criticalRegenerationFlags.has(flag));
  const shouldRegenerate = regenerableTypes.has(questionType) && (score < 65 || hasCriticalFlag);

  return { score, flags, shouldRegenerate };
}

/**
 * Build a targeted correction message for the retry turn.
 * This tells the model *exactly* what was wrong so it can fix it,
 * rather than just attempting the same prompt at a higher temperature.
 *
 * @param {string[]} flags - Flags from evaluateAnswer()
 * @returns {string} User-turn message to send as the retry prompt
 */
export function buildRegenerationFeedback(flags) {
  const issues = [];

  if (flags.includes('generic_opener')) {
    issues.push('Your opening was too generic. Start with a specific action or outcome — not a self-description. Good: "At [Company], I built X which did Y." Bad: "I am a motivated professional..."');
  }
  if (flags.includes('no_named_evidence')) {
    issues.push('Your answer contained no specific evidence. Name the actual company, project, team size, or metric from your CV. Every substantive claim needs a named anchor.');
  }
  const bannedHits = flags.filter(f => f.startsWith('banned_phrase:'));
  if (bannedHits.length > 0) {
    const phrases = bannedHits.map(f => `"${f.slice('banned_phrase:'.length)}"`).join(', ');
    issues.push(`Remove these filler phrases: ${phrases}. Replace each with a specific fact or example instead.`);
  }
  if (flags.includes('too_short')) {
    issues.push('Your answer was too brief. Include the situation, what you specifically did, and the concrete outcome.');
  }
  if (flags.includes('repeated_sentence')) {
    issues.push('Your answer repeated the same sentence. Rewrite it once, with a smooth flow: method first, then one example, then result.');
  }
  if (flags.includes('troubleshooting_missing_method_sequence')) {
    issues.push('For a troubleshooting question, the first sentence must state the actual method sequence before any company example. Start with steps such as reproducing or scoping the issue, gathering logs/impact, isolating variables, testing hypotheses, fixing, and documenting prevention.');
  }

  if (issues.length === 0) {
    return 'Rewrite your answer with more specific evidence — name real companies, projects, and outcomes from your CV.';
  }

  return `Your previous answer had quality issues. Rewrite it now from scratch, fixing each of these:

${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

Output only the rewritten answer. Do not reference these instructions or your previous attempt.`;
}

export default { evaluateAnswer, buildRegenerationFeedback };
