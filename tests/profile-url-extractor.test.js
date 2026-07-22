import { describe, expect, it } from 'vitest';
import { extractProfileUrl } from '../shared/profile-url-extractor.js';

describe('profile URL extraction', () => {
  const cv = `Profiles
LinkedIn: linkedin.com/in/michael-bali
GitHub: https://github.com/mibali
GitLab: gitlab.com/michael_bali
Behance: behance.net/michaelbali
Dribbble: dribbble.com/michaelbali
Kaggle: kaggle.com/michaelbali
Stack Overflow: stackoverflow.com/users/1234567
Portfolio: www.michaelbali.dev/work`;

  it.each([
    ['LinkedIn profile URL', 'https://linkedin.com/in/michael-bali'],
    ['GitHub link', 'https://github.com/mibali'],
    ['GitLab profile', 'https://gitlab.com/michael_bali'],
    ['Behance URL', 'https://behance.net/michaelbali'],
    ['Dribbble profile', 'https://dribbble.com/michaelbali'],
    ['Kaggle profile URL', 'https://kaggle.com/michaelbali'],
    ['Stack Overflow profile', 'https://stackoverflow.com/users/1234567'],
    ['Portfolio website', 'https://www.michaelbali.dev/work'],
    ['Professional profile URL', 'https://www.michaelbali.dev/work'],
    ['Developer profile', 'https://www.michaelbali.dev/work'],
  ])('extracts %s', (question, expected) => {
    expect(extractProfileUrl(question, cv)).toBe(expected);
  });

  it('does not guess a URL for an unrelated narrative question', () => {
    expect(extractProfileUrl('Why are you interested in this role?', cv)).toBeNull();
  });
});
