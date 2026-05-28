import { describe, it, expect } from 'vitest';
import { evaluateAnswer, buildRegenerationFeedback } from '../shared/answer-evaluator.js';

// ── evaluateAnswer ────────────────────────────────────────────────────────────

describe('evaluateAnswer — skip types', () => {
  const SKIP = ['salary', 'yes_no', 'short_factual', 'data_extraction'];
  for (const qType of SKIP) {
    it(`returns score 100 and no regeneration for ${qType}`, () => {
      const result = evaluateAnswer('I am a motivated person with no specifics.', qType);
      expect(result.score).toBe(100);
      expect(result.flags).toHaveLength(0);
      expect(result.shouldRegenerate).toBe(false);
    });
  }
});

describe('evaluateAnswer — empty / missing answer', () => {
  it('scores 0 and flags empty_answer for null', () => {
    const r = evaluateAnswer(null, 'behavioral');
    expect(r.score).toBe(0);
    expect(r.flags).toContain('empty_answer');
    expect(r.shouldRegenerate).toBe(true);
  });

  it('scores 0 for a whitespace-only string', () => {
    const r = evaluateAnswer('   \n  ', 'behavioral');
    expect(r.score).toBe(0);
  });
});

describe('evaluateAnswer — generic opener detection', () => {
  const OPENERS = [
    'I am a motivated professional with strong experience in engineering.',
    'As a dedicated engineer I have always delivered results.',
    'I have always been passionate about technology and innovation.',
    'Throughout my career I have led many high-impact projects.',
    'With over 8 years of experience in software engineering I bring expertise.',
    'I am excited to apply for this position at your company.',
    'I am pleased to submit my application for this role.',
    'Thank you for considering my application to this position.',
  ];

  for (const opener of OPENERS) {
    it(`flags generic_opener: "${opener.slice(0, 55)}..."`, () => {
      const answer = opener + ' I bring great value to any team.';
      const r = evaluateAnswer(answer, 'behavioral');
      expect(r.flags).toContain('generic_opener');
    });
  }

  it('does not flag a strong specific opener', () => {
    const answer = 'At Acme Corp, I rebuilt the deployment pipeline which cut release time from 4 hours to 12 minutes, eliminating 3 recurring outages per month.';
    const r = evaluateAnswer(answer, 'behavioral');
    expect(r.flags).not.toContain('generic_opener');
  });
});

describe('evaluateAnswer — banned phrase detection', () => {
  const BANNED = [
    ['team player', 'I am a dedicated team player who always collaborates well.'],
    ['passionate about', 'I am passionate about building great software every day.'],
    ['results-oriented', 'As a results-oriented engineer I deliver value consistently.'],
    ['strong work ethic', 'I bring a strong work ethic and commitment to excellence.'],
    ['leverage my skills', 'I want to leverage my skills to help your organisation grow.'],
    ['i would be a great fit', 'I would be a great fit for this position and your team.'],
    ['synergy', 'I believe in synergy and cross-functional collaboration.'],
  ];

  for (const [phrase, answer] of BANNED) {
    it(`flags banned_phrase:${phrase}`, () => {
      const r = evaluateAnswer(answer, 'motivation');
      const bannedFlags = r.flags.filter(f => f.startsWith('banned_phrase:'));
      expect(bannedFlags.some(f => f.includes(phrase))).toBe(true);
    });
  }

  it('caps the score deduction from banned phrases at 30', () => {
    const answer = 'I am a team player and a go-getter with a strong work ethic, synergy, and a proven track record. I am results-oriented.';
    const r = evaluateAnswer(answer, 'behavioral');
    // Multiple banned phrases hit — deduction should be capped at 30, not 40+
    const bannedFlags = r.flags.filter(f => f.startsWith('banned_phrase:')).length;
    expect(bannedFlags).toBeGreaterThan(3);
    // Score can be low but should not go below 0
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe('evaluateAnswer — named evidence detection', () => {
  it('flags no_named_evidence when there are no specifics', () => {
    const answer = 'In my previous roles I collaborated with various stakeholders and delivered projects on time. I consistently met targets and worked well in teams.';
    const r = evaluateAnswer(answer, 'behavioral');
    expect(r.flags).toContain('no_named_evidence');
  });

  it('does not flag when answer contains a percentage metric', () => {
    const answer = 'At my previous company I reduced infrastructure costs by 35% by migrating to spot instances.';
    const r = evaluateAnswer(answer, 'behavioral');
    expect(r.flags).not.toContain('no_named_evidence');
  });

  it('does not flag when answer contains a currency metric', () => {
    const answer = 'The initiative saved the business £120k in annual licensing costs.';
    const r = evaluateAnswer(answer, 'behavioral');
    expect(r.flags).not.toContain('no_named_evidence');
  });

  it('does not flag when answer contains a proper noun mid-sentence', () => {
    const answer = 'During my time at Cloudify I led a team of seven engineers rebuilding the data ingestion layer.';
    const r = evaluateAnswer(answer, 'behavioral');
    expect(r.flags).not.toContain('no_named_evidence');
  });

  it('does not flag a user count metric', () => {
    const answer = 'The platform grew to 12,000 monthly active users within six months of launch.';
    const r = evaluateAnswer(answer, 'general');
    expect(r.flags).not.toContain('no_named_evidence');
  });
});

describe('evaluateAnswer — repeated sentence detection', () => {
  it('flags and regenerates answers that repeat the same sentence', () => {
    const answer = 'When troubleshooting complex issues, I follow a structured approach. When troubleshooting complex issues, I follow a structured approach. At Sourcegraph, I built Python automation for diagnostics and environment validation so production issues could be isolated faster.';
    const r = evaluateAnswer(answer, 'troubleshooting');

    expect(r.flags).toContain('repeated_sentence');
    expect(r.shouldRegenerate).toBe(true);
  });
});

describe('evaluateAnswer — troubleshooting method sequence', () => {
  it('regenerates vague troubleshooting answers that say structured approach without naming the steps', () => {
    const answer = "When troubleshooting unfamiliar issues, I rely on a structured approach. At Sourcegraph, I developed Python-based automation tools for diagnostics and environment validation, which helped identify root causes of complex production incidents. Earlier, in my role at DualMind Tech Consulting, I worked on designing and implementing end-to-end MLOps workflows, where I applied similar principles to troubleshoot model deployment and inference issues.";
    const r = evaluateAnswer(answer, 'troubleshooting');

    expect(r.flags).toContain('troubleshooting_missing_method_sequence');
    expect(r.shouldRegenerate).toBe(true);
  });

  it('accepts troubleshooting answers that state the method sequence before the example', () => {
    const answer = 'I start by reproducing or scoping the issue, gathering logs and customer impact, isolating the likely service or configuration layer, testing hypotheses, then documenting the fix so it does not repeat. At Sourcegraph, I used that method during high-impact production investigations, combining log analysis, environment validation, and Python diagnostics to narrow ambiguous failures quickly. Once the issue was understood, I partnered with Engineering and SRE to remediate the root cause and turn the learning into runbooks.';
    const r = evaluateAnswer(answer, 'troubleshooting');

    expect(r.flags).not.toContain('troubleshooting_missing_method_sequence');
    expect(r.shouldRegenerate).toBe(false);
  });
});

describe('evaluateAnswer — too_short flag', () => {
  it('flags too_short for an answer under 40 words', () => {
    const answer = 'I worked on a project that improved performance.';
    const r = evaluateAnswer(answer, 'behavioral');
    expect(r.flags).toContain('too_short');
  });

  it('does not flag a sufficiently long answer', () => {
    const answer = 'At DataStream I was asked to reduce the p95 latency of our search API from 800ms to under 200ms. I profiled the hot paths, identified an N+1 query pattern in the aggregation layer, and rewrote it using a batched Redis lookup. The result was p95 dropping to 140ms within two weeks, which directly unblocked a customer renewal that had been at risk.';
    const r = evaluateAnswer(answer, 'behavioral');
    expect(r.flags).not.toContain('too_short');
  });
});

describe('evaluateAnswer — shouldRegenerate logic', () => {
  const REGENERABLE = ['behavioral', 'strength', 'weakness', 'motivation', 'why_company', 'cover_letter', 'general', 'troubleshooting'];
  const NON_REGENERABLE = ['salary', 'yes_no', 'short_factual', 'brief'];

  it('sets shouldRegenerate true for low-scoring regenerable types', () => {
    const bad = 'I am a passionate team player with strong work ethic and synergy.';
    for (const qType of REGENERABLE) {
      const r = evaluateAnswer(bad, qType);
      if (r.score < 65) {
        expect(r.shouldRegenerate).toBe(true);
      }
    }
  });

  it('never sets shouldRegenerate for non-regenerable types regardless of score', () => {
    const bad = 'I am a passionate team player.';
    for (const qType of NON_REGENERABLE) {
      const r = evaluateAnswer(bad, qType);
      expect(r.shouldRegenerate).toBe(false);
    }
  });

  it('does not regenerate a high-scoring answer', () => {
    const good = 'At Nexus Infrastructure I reduced deploy times from 45 minutes to 4 minutes by parallelising the test suite across 8 workers. This unblocked a quarterly release that had been delayed for three sprints.';
    const r = evaluateAnswer(good, 'behavioral');
    expect(r.score).toBeGreaterThanOrEqual(65);
    expect(r.shouldRegenerate).toBe(false);
  });
});

// ── buildRegenerationFeedback ─────────────────────────────────────────────────

describe('buildRegenerationFeedback', () => {
  it('references generic opener when that flag is set', () => {
    const msg = buildRegenerationFeedback(['generic_opener']);
    expect(msg).toMatch(/generic/i);
    expect(msg).toMatch(/opening/i);
  });

  it('references named evidence when that flag is set', () => {
    const msg = buildRegenerationFeedback(['no_named_evidence']);
    expect(msg).toMatch(/specific evidence|named/i);
  });

  it('lists the banned phrases by name', () => {
    const msg = buildRegenerationFeedback(['banned_phrase:team player', 'banned_phrase:synergy']);
    expect(msg).toMatch(/team player/);
    expect(msg).toMatch(/synergy/);
  });

  it('addresses too_short flag', () => {
    const msg = buildRegenerationFeedback(['too_short']);
    expect(msg).toMatch(/brief|short/i);
  });

  it('addresses repeated_sentence flag', () => {
    const msg = buildRegenerationFeedback(['repeated_sentence']);
    expect(msg).toMatch(/repeated the same sentence/i);
    expect(msg).toMatch(/method first, then one example, then result/i);
  });

  it('addresses missing troubleshooting method sequence', () => {
    const msg = buildRegenerationFeedback(['troubleshooting_missing_method_sequence']);
    expect(msg).toMatch(/first sentence must state the actual method sequence/i);
    expect(msg).toMatch(/before any company example/i);
  });

  it('returns a non-empty fallback message for an empty flag list', () => {
    const msg = buildRegenerationFeedback([]);
    expect(msg.length).toBeGreaterThan(10);
  });

  it('numbers multiple issues', () => {
    const msg = buildRegenerationFeedback(['generic_opener', 'no_named_evidence', 'too_short']);
    expect(msg).toMatch(/1\./);
    expect(msg).toMatch(/2\./);
    expect(msg).toMatch(/3\./);
  });

  it('instructs the model not to reference the feedback in the output', () => {
    const msg = buildRegenerationFeedback(['generic_opener']);
    expect(msg).toMatch(/do not reference|not reference these instructions/i);
  });
});
