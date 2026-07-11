import { describe, expect, it } from 'vitest';
import {
  buildEvidenceRetrievalInputs,
  cosineSimilarity,
  rerankMatchMapWithEmbeddings,
} from '../shared/evidence-retrieval.js';
import { candidateEvidenceMapAgent } from '../shared/agent-workflows.js';
import { CVParser } from '../shared/cv-parser.js';

describe('embedding evidence retrieval', () => {
  it('builds compact evidence and requirement inputs for embedding models', () => {
    const inputs = buildEvidenceRetrievalInputs({
      evidenceItems: [
        { sourceId: 'experience:0:responsibility:0', type: 'experience', label: 'PM at Acme', text: 'Led SQL analytics and experimentation projects.' },
      ],
    }, {
      requirements: [
        { requirement: 'A/B testing', type: 'required', priority: 3 },
      ],
    });

    expect(inputs.evidenceItems).toHaveLength(1);
    expect(inputs.requirements).toHaveLength(1);
    expect(inputs.texts).toHaveLength(2);
    expect(inputs.texts[0]).toContain('PM at Acme');
    expect(inputs.evidenceItems[0].sourceId).toBe('experience:0:responsibility:0');
    expect(inputs.evidenceItems[0].id).toBe('experience:0:responsibility:0');
  });

  it('preserves parser source IDs through candidate and embedding inputs', () => {
    const cv = new CVParser().parse(`Alex Morgan

EXPERIENCE
Engineer | Acme | 2022 - Present
- Built reliable data services for enterprise customers

EDUCATION
BSc Computing`);
    const candidateMap = candidateEvidenceMapAgent(cv);
    const inputs = buildEvidenceRetrievalInputs(candidateMap, {
      requirements: [{ requirement: 'Reliable data services' }],
    });
    const candidateEvidence = candidateMap.evidenceItems.find(item => item.type === 'experience');
    const embeddingEvidence = inputs.evidenceItems.find(item => item.type === 'experience');

    expect(candidateEvidence.sourceId).toBe(cv.evidenceIndex[0].sourceId);
    expect(embeddingEvidence.sourceId).toBe(cv.evidenceIndex[0].sourceId);
  });

  it('calculates cosine similarity for normalized evidence matching', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('ranks evidence without changing status or mention authorization at high similarity', () => {
    const matchMap = [
      { requirement: 'A/B testing', type: 'required', status: 'missing', evidence: [], allowedToMention: false },
      { requirement: 'GraphQL', type: 'tool', status: 'missing', evidence: [], allowedToMention: false },
    ];
    const retrievalInputs = {
      evidenceItems: [
        { sourceId: 'experience:0:responsibility:0', text: 'Led experimentation and conversion testing for signup flows.' },
      ],
      requirements: [
        { requirement: 'A/B testing' },
        { requirement: 'GraphQL' },
      ],
    };
    const embeddings = [
      [1, 0],
      [0.99, 0.01],
      [0, 1],
    ];

    const result = rerankMatchMapWithEmbeddings(matchMap, retrievalInputs, embeddings, {
      promoteThreshold: 0.9,
      enrichThreshold: 0.5,
    });

    expect(result.retrieval.status).toBe('active');
    expect(result.retrieval.promotedCount).toBe(0);
    expect(result.retrieval.authorizationMode).toBe('ranking-only');
    expect(result.matchMap[0].status).toBe('missing');
    expect(result.matchMap[0].allowedToMention).toBe(false);
    expect(result.matchMap[0].evidence).toEqual([]);
    expect(result.matchMap[0].retrievalEvidence[0]).toMatchObject({
      sourceId: 'experience:0:responsibility:0',
      similarity: expect.any(Number),
    });
    expect(result.matchMap[1].status).toBe('missing');
  });

  it('returns the original map when embeddings do not match inputs', () => {
    const matchMap = [{ requirement: 'SQL', status: 'missing', evidence: [], allowedToMention: false }];
    const result = rerankMatchMapWithEmbeddings(matchMap, {
      evidenceItems: [{ text: 'Built dashboards.' }],
      requirements: [{ requirement: 'SQL' }],
    }, []);

    expect(result.matchMap).toBe(matchMap);
    expect(result.retrieval.status).toBe('skipped');
  });

  it('falls back without mutation for malformed or inconsistent vectors', () => {
    const matchMap = [{ requirement: 'SQL', status: 'missing', evidence: [], allowedToMention: false }];
    const result = rerankMatchMapWithEmbeddings(matchMap, {
      evidenceItems: [{ text: 'Built SQL dashboards.' }],
      requirements: [{ requirement: 'SQL' }],
    }, [[1, Number.NaN], [1]]);

    expect(result.matchMap).toBe(matchMap);
    expect(result.retrieval.status).toBe('skipped');
    expect(result.retrieval.reason).toMatch(/malformed|inconsistent/i);
  });
});
