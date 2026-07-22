import { describe, expect, it } from 'vitest';
import {
  extractAnnotationLabel, extractLinkAnnotationsFromHtml, linkLabelFromUrl,
} from '../render-proxy/link-annotations.js';

// pdf.js text items expose { str, transform: [a, b, c, d, x, y] }; only
// indices 4 and 5 (x, y) matter for position correlation.
function item(str, x, y) {
  return { str, transform: [1, 0, 0, 1, x, y] };
}

describe('extractAnnotationLabel: recovers real anchor text from a PDF link rectangle', () => {
  it('joins only the text items whose position falls inside the rect, in left-to-right order', () => {
    // "Published " then the hyperlinked phrase, then " on the blog." - the
    // annotation rect covers only the middle phrase.
    const items = [
      item('Published ', 72, 700),
      item('How Support Engineers Use Deep Search', 128, 700),
      item(' on the blog.', 400, 700),
    ];
    const rect = [125, 697, 345, 711];
    expect(extractAnnotationLabel(rect, items)).toBe('How Support Engineers Use Deep Search');
  });

  it('sorts matched items by x position regardless of array order (defends against out-of-order content streams)', () => {
    const items = [
      item('Search', 200, 700),
      item('How ', 100, 700),
      item('Deep ', 160, 700),
    ];
    const rect = [90, 697, 260, 711];
    expect(extractAnnotationLabel(rect, items)).toBe('How Deep Search');
  });

  it('returns empty when no text item falls inside the rect (e.g. an image-based link)', () => {
    const items = [item('Unrelated caption', 500, 500)];
    expect(extractAnnotationLabel([10, 10, 50, 20], items)).toBe('');
  });

  it('is tolerant of small coordinate rounding at the rect edges', () => {
    const items = [item('LinkedIn', 100.4, 700.2)];
    // Rect exactly at the item's nominal position, minus rounding.
    expect(extractAnnotationLabel([100, 700, 160, 712], items)).toBe('LinkedIn');
  });

  it('returns empty for a pathologically long match instead of a garbage label', () => {
    const items = [item('x'.repeat(200), 0, 0)];
    expect(extractAnnotationLabel([0, 0, 999, 10], items)).toBe('');
  });

  it('fails closed on malformed input', () => {
    expect(extractAnnotationLabel(null, [])).toBe('');
    expect(extractAnnotationLabel([1, 2], [item('x', 1, 1)])).toBe('');
    expect(extractAnnotationLabel([0, 0, 10, 10], null)).toBe('');
    expect(extractAnnotationLabel([0, 0, 10, 10], [{ str: 'x' }])).toBe('');
  });
});

describe('linkLabelFromUrl: domain-based fallback when no text overlaps the rect', () => {
  it('names well-known platforms', () => {
    expect(linkLabelFromUrl('https://www.linkedin.com/in/janedoe')).toBe('LinkedIn');
    expect(linkLabelFromUrl('https://github.com/janedoe')).toBe('GitHub');
  });

  it('falls back to the bare hostname for anything else', () => {
    expect(linkLabelFromUrl('https://sourcegraph.com/blog/example')).toBe('sourcegraph.com');
  });
});

describe('extractLinkAnnotationsFromHtml: DOCX already carries real anchor text', () => {
  it('extracts the anchor text mammoth preserves, not a domain guess', () => {
    const html = '<p>Published <a href="https://sourcegraph.com/blog/example">How Support Engineers Use Deep Search</a> on the blog.</p>';
    expect(extractLinkAnnotationsFromHtml(html)).toEqual([
      { text: 'How Support Engineers Use Deep Search', url: 'https://sourcegraph.com/blog/example' },
    ]);
  });

  it('deduplicates identical label+url pairs and drops non-http links', () => {
    const html = '<a href="https://x.com/a">Label</a><a href="https://x.com/a">Label</a><a href="mailto:x@example.com">Email</a>';
    expect(extractLinkAnnotationsFromHtml(html)).toEqual([{ text: 'Label', url: 'https://x.com/a' }]);
  });
});
