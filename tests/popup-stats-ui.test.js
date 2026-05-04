import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const popupHtml = fs.readFileSync(new URL('../extension-ready/popup.html', import.meta.url), 'utf8');
const popupJs = fs.readFileSync(new URL('../extension-ready/popup.js', import.meta.url), 'utf8');

describe('popup productivity stats UI', () => {
  it('renders the empty collapsed state', () => {
    expect(popupHtml).toContain('id="stats-summary">No activity yet</span>');
  });

  it('keeps the detailed stats and reset affordance hidden behind expansion', () => {
    expect(popupHtml).toContain('id="stats-details" hidden');
    expect(popupHtml).toContain('id="stats-reset-btn"');
    expect(popupHtml).toContain('Reset stats');
  });

  it('includes the selected expanded stats', () => {
    expect(popupHtml).toContain('Answers inserted');
    expect(popupHtml).toContain('CV exports');
    expect(popupHtml).toContain('CVs tailored');
    expect(popupHtml).toContain('Time saved');
    expect(popupHtml).toContain('This week');
    expect(popupHtml).toContain('Top action');
    expect(popupHtml).toContain('Assist streak');
  });

  it('uses the helper summary text for the collapsed one-line card', () => {
    expect(popupJs).toContain('elements.statsSummary.textContent = summary.summaryText');
    expect(popupJs).toContain("window.DraftApplyStats?.track?.('cvExports')");
    expect(popupJs).toContain("window.DraftApplyStats?.track?.('cvsTailored')");
  });
});
