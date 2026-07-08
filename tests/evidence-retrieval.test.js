import { describe, expect, it } from 'vitest';
import {
  buildEvidenceRetrievalInputs,
  cosineSimilarity,
  rerankMatchMapWithEmbeddings,
} from '../shared/evidence-retrieval.js';

describe('embedding evidence retrieval', () => {
  it('builds compact evidence and requirement inputs for embedding models', () => {
    const inputs = buildEvidenceRetrievalInputs({
      evidenceItems: [
        { type: 'experience', label: 'PM at Acme', text: 'Led SQL analytics and experimentation projects.' },
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
  });

  it('calculates cosine similarity for normalized evidence matching', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('promotes missing requirements only when embedding similarity clears the threshold', () => {
    const matchMap = [
      { requirement: 'A/B testing', type: 'required', status: 'missing', evidence: [], allowedToMention: false },
      { requirement: 'GraphQL', type: 'tool', status: 'missing', evidence: [], allowedToMention: false },
    ];
    const retrievalInputs = {
      evidenceItems: [
        { text: 'Led experimentation and conversion testing for signup flows.' },
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
    expect(result.retrieval.promotedCount).toBe(1);
    expect(result.matchMap[0].status).toBe('partial_match');
    expect(result.matchMap[0].allowedToMention).toBe(true);
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
});
