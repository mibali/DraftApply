import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
let groups;
beforeAll(() => {
  groups = _require('../shared/data-sources/semantic-concepts.json');
});

// ── helpers ───────────────────────────────────────────────────────────────────

function normalise(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findAliases(req) {
  const r = normalise(req);
  const matches = [];
  for (const group of groups) {
    const norms = group.map(normalise);
    if (norms.some(item => r === item || r.includes(item) || item.includes(r))) {
      matches.push(...group);
    }
  }
  return [...new Set(matches)].filter(a => normalise(a) !== r);
}

function inSameGroup(termA, termB) {
  const a = normalise(termA);
  const b = normalise(termB);
  return groups.some(group => {
    const norms = group.map(normalise);
    return norms.includes(a) && norms.includes(b);
  });
}

// ── structural integrity ──────────────────────────────────────────────────────

describe('semantic-concepts.json structure', () => {
  it('loads as a non-empty array', () => {
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(50);
  });

  it('every group is a non-empty array of non-empty strings', () => {
    for (const group of groups) {
      expect(Array.isArray(group)).toBe(true);
      expect(group.length).toBeGreaterThan(0);
      for (const term of group) {
        expect(typeof term).toBe('string');
        expect(term.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has no duplicate terms within a single group', () => {
    for (const group of groups) {
      const norms = group.map(normalise);
      const unique = new Set(norms);
      expect(unique.size).toBe(norms.length);
    }
  });
});

// ── backward-compatibility: groups from original hardcoded list ───────────────

describe('semantic-concepts.json backward compatibility', () => {
  const LEGACY_PAIRS = [
    ['postgresql', 'postgres'],
    ['kubernetes', 'k8s'],
    ['github actions', 'gha'],
    ['google analytics', 'ga4'],
    ['ci cd', 'pipeline automation'],
    ['technical demos', 'client presentations'],
    ['poc', 'proof of concept'],
    ['pov', 'proof of value'],
    ['presales', 'solution consulting'],
    ['stakeholder management', 'executive communication'],
    ['product metrics', 'kpi'],
    ['roadmap ownership', 'backlog prioritisation'],
    ['go to market', 'gtm'],
    ['customer onboarding', 'enablement'],
    ['renewal', 'churn prevention'],
    ['crm', 'salesforce'],
    ['financial modelling', 'forecasting'],
    ['regulatory compliance', 'audit support'],
  ];

  for (const [a, b] of LEGACY_PAIRS) {
    it(`"${a}" and "${b}" are in the same group`, () => {
      expect(inSameGroup(a, b)).toBe(true);
    });
  }
});

// ── bidirectional matching ────────────────────────────────────────────────────

describe('bidirectional alias lookup', () => {
  it('executive communication finds stakeholder management group', () => {
    const aliases = findAliases('executive communication');
    const lower = aliases.map(a => a.toLowerCase());
    expect(lower.some(a => a.includes('stakeholder'))).toBe(true);
  });

  it('stakeholder alignment finds product strategy group', () => {
    const aliases = findAliases('stakeholder alignment');
    const lower = aliases.map(a => a.toLowerCase());
    expect(lower.some(a => a.includes('product strategy') || a.includes('strategic alignment'))).toBe(true);
  });

  it('CI/CD finds continuous integration group', () => {
    const aliases = findAliases('CI/CD');
    const lower = aliases.map(a => a.toLowerCase());
    expect(lower.some(a => a.includes('continuous integration') || a.includes('cicd'))).toBe(true);
  });

  it('reduced deployment time finds CI/CD improvement', () => {
    const aliases = findAliases('reduced deployment time');
    const lower = aliases.map(a => a.toLowerCase());
    expect(lower.some(a => a.includes('ci') || a.includes('deployment'))).toBe(true);
  });

  it('ETL finds data pipeline group', () => {
    const aliases = findAliases('ETL pipeline');
    const lower = aliases.map(a => a.toLowerCase());
    expect(lower.some(a => a.includes('data pipeline') || a.includes('elt'))).toBe(true);
  });

  it('churn prevention finds renewal and retention', () => {
    const aliases = findAliases('churn prevention');
    const lower = aliases.map(a => a.toLowerCase());
    expect(lower.some(a => a.includes('retention') || a.includes('renewal'))).toBe(true);
  });

  it('deployment time reduction (rearranged) still finds the group', () => {
    const aliases = findAliases('deployment time reduction');
    expect(aliases.length).toBeGreaterThan(0);
  });
});

// ── key domain coverage ───────────────────────────────────────────────────────

describe('domain coverage', () => {
  const MUST_HAVE_TERMS = [
    'kubernetes', 'docker', 'terraform', 'aws', 'gcp', 'azure',
    'python', 'javascript', 'react', 'kafka',
    'machine learning', 'llm', 'nlp',
    'agile', 'tdd', 'git',
    'stakeholder management', 'team leadership', 'mentoring',
    'roadmap ownership', 'go to market', 'user research',
    'presales', 'customer onboarding', 'renewal',
    'financial modelling', 'roi', 'regulatory compliance',
    'seo', 'crm', 'employee engagement',
    'observability', 'performance optimisation',
  ];

  for (const term of MUST_HAVE_TERMS) {
    it(`"${term}" is present in at least one group`, () => {
      const aliases = findAliases(term);
      // Either the term itself is in a group (has aliases) OR it appears verbatim
      const presentDirectly = groups.some(g => g.map(normalise).includes(normalise(term)));
      expect(presentDirectly || aliases.length > 0).toBe(true);
    });
  }
});
