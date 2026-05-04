import { describe, expect, it } from 'vitest';
import { CVParser } from '../shared/cv-parser.js';

describe('CVParser contact extraction', () => {
  it('does not treat an email domain as a personal website', () => {
    const cv = new CVParser().parse(`Michael T Bali
Birmingham, UK
mtbdesigns01@gmail.com | 07401731548
http://linkedin.com/in/michael-temitope-bali-830640171

Infra & MLOps Engineer`);

    expect(cv.contactInfo.email).toBe('mtbdesigns01@gmail.com');
    expect(cv.contactInfo.website).toBe('');
  });

  it('extracts an explicit website URL when one is present', () => {
    const cv = new CVParser().parse(`Jane Doe
jane@example.com
www.janedoe.dev

Platform Engineer`);

    expect(cv.contactInfo.website).toBe('www.janedoe.dev');
  });
});
