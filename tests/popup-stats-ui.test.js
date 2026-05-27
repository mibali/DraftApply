import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const popupHtml = fs.readFileSync(new URL('../extension-ready/popup.html', import.meta.url), 'utf8');
const popupJs = fs.readFileSync(new URL('../extension-ready/popup.js', import.meta.url), 'utf8');
const contentJs = fs.readFileSync(new URL('../extension-ready/content.js', import.meta.url), 'utf8');
const contentCss = fs.readFileSync(new URL('../extension-ready/content.css', import.meta.url), 'utf8');
const backgroundJs = fs.readFileSync(new URL('../extension-ready/background.js', import.meta.url), 'utf8');

function loadExtractCvContactUrls() {
  const match = popupJs.match(/function extractCvContactUrls\(text\) \{[\s\S]*?\n  \}/);
  if (!match) throw new Error('extractCvContactUrls not found');
  const sandbox = {};
  vm.runInNewContext(`${match[0]}\nglobalThis.__extractCvContactUrls = extractCvContactUrls;`, sandbox);
  return sandbox.__extractCvContactUrls;
}

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

  it('persists tailored CV jobs so popup closure does not force a restart', () => {
    expect(popupJs).toContain("const TAILOR_JOB_KEY = 'tailorCvJob'");
    expect(popupJs).toContain('startTailorJobPolling');
    expect(popupJs).toContain('restoreTailorJob(job)');
    expect(backgroundJs).toContain("const TAILOR_JOB_KEY = 'tailorCvJob'");
    expect(backgroundJs).toContain("status: 'running'");
    expect(backgroundJs).toContain("status: 'done'");
    expect(backgroundJs).toContain('setTailorJobIfCurrent(jobId');
    expect(popupJs).toContain('let tailorToken = 0');
    expect(popupJs).toContain('if (myToken !== tailorToken) return');
  });

  it('stops polling stuck Tailor CV jobs and clears stale job state', () => {
    expect(popupJs).toContain('const TAILOR_JOB_MAX_POLL_MS = 3 * 60 * 1000');
    expect(popupJs).toContain('Date.now() - tailorJobPollStartedAt > TAILOR_JOB_MAX_POLL_MS');
    expect(popupJs).toContain('await chrome.storage.local.remove(TAILOR_JOB_KEY)');
    expect(popupJs).toContain('CV generation is taking longer than expected');
  });

  it('resets generated Tailor results when the saved CV changes but keeps the draft JD available', () => {
    const resetStart = popupJs.indexOf('async function resetTailorStateForCvChange');
    const resetEnd = popupJs.indexOf('\n  function showCVLoaded', resetStart);
    const resetFn = popupJs.slice(resetStart, resetEnd);

    expect(popupJs).toContain('resetTailorStateForCvChange');
    expect(popupJs).toContain('const cvChanged = Boolean(previous?.cvText && previous.cvText !== text)');
    expect(popupJs).toContain('Re-analyze any saved JD');
    expect(resetFn).not.toContain('TAILOR_DRAFT_KEY');
  });

  it('labels OpenRouter Tailor output as a fallback when Groq failed over', () => {
    expect(popupJs).toContain('fallbackFrom');
    expect(popupJs).toContain('fallback from');
  });

  it('explains Tailor CV warnings with a review-before-sending action', () => {
    expect(popupJs).toContain('formatTailorWarnings');
    expect(popupJs).toContain('Review before sending');
    expect(popupJs).toContain('tw-group-accuracy');
    expect(popupJs).toContain('tw-group-missing');
    expect(popupJs).toContain('tw-group-quality');
  });

  it('offers a manual JD CTA when page context is partial or missing', () => {
    expect(contentJs).toContain('Paste JD');
    expect(contentJs).toContain('paste JD manually');
    expect(contentJs).toContain('_showJdPasteArea');
    expect(contentCss).toContain('.da-paste-jd-btn');
    expect(contentCss).toContain('.da-jd-paste-area');
  });

  it('guards repeated URL fields against reusing the first shared label', () => {
    expect(contentJs).toContain('fieldsInAncestor > 1');
    expect(contentJs).toContain('labelTextWithoutControls');
    expect(contentJs).toContain("field.closest?.('label')");
  });

  it('extracts bare portfolio domains without treating emails as websites', () => {
    const extractCvContactUrls = loadExtractCvContactUrls();
    const urls = extractCvContactUrls(`Jane Doe
jane@example.xyz
linkedin.com/in/janedoe
github.com/janedoe
portfolio.xyz/work`);

    expect(urls.linkedin).toBe('https://linkedin.com/in/janedoe');
    expect(urls.github).toBe('https://github.com/janedoe');
    expect(urls.website).toBe('https://portfolio.xyz/work');
  });
});
