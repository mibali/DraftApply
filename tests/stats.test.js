import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadStatsHelper() {
  const code = fs.readFileSync(new URL('../extension-ready/stats.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.runInNewContext(code, sandbox);
  return sandbox.DraftApplyStats;
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      if (typeof key === 'string') return { [key]: data[key] };
      if (Array.isArray(key)) {
        return key.reduce((result, item) => {
          result[item] = data[item];
          return result;
        }, {});
      }
      return { ...data };
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    },
  };
}

describe('productivity stats helper', () => {
  it('formats the collapsed summary with answers, CV exports, and time saved', () => {
    const stats = loadStatsHelper();
    const summary = stats.summarize({
      totals: { answersInserted: 12, cvExports: 2, cvsTailored: 4 },
      days: {},
    });

    expect(summary.summaryText).toBe('12 answers inserted • 2 CV exports • 1h 16m saved');
  });

  it('shows the empty state before any local activity', () => {
    const stats = loadStatsHelper();

    expect(stats.summarize().summaryText).toBe('No activity yet');
  });

  it('calculates time saved from inserted answers and CV exports only', () => {
    const stats = loadStatsHelper();
    const summary = stats.summarize({
      totals: { answersInserted: 3, cvExports: 2, cvsTailored: 99 },
      days: {},
    });

    expect(summary.estimatedMinutesSaved).toBe(49);
    expect(summary.timeSavedLabel).toBe('49m');
  });

  it('counts this week as the last 7 local calendar days', () => {
    const stats = loadStatsHelper();
    const today = new Date(2026, 4, 4, 12);
    const summary = stats.summarize({
      totals: { answersInserted: 20, cvExports: 20, cvsTailored: 20 },
      days: {
        '2026-05-04': { answersInserted: 2 },
        '2026-05-03': { cvExports: 1 },
        '2026-04-28': { cvsTailored: 3 },
        '2026-04-27': { answersInserted: 50 },
      },
    }, today);

    expect(summary.thisWeekCount).toBe(6);
  });

  it('counts the assist streak from consecutive active local days', () => {
    const stats = loadStatsHelper();
    const today = new Date(2026, 4, 4, 12);
    const summary = stats.summarize({
      totals: { answersInserted: 6, cvExports: 0, cvsTailored: 0 },
      days: {
        '2026-05-04': { answersInserted: 1 },
        '2026-05-03': { answersInserted: 1 },
        '2026-05-02': { answersInserted: 1 },
        '2026-04-30': { answersInserted: 3 },
      },
    }, today);

    expect(summary.assistStreakDays).toBe(3);
  });

  it('chooses a deterministic top action when totals tie', () => {
    const stats = loadStatsHelper();
    const summary = stats.summarize({
      totals: { answersInserted: 4, cvExports: 4, cvsTailored: 4 },
      days: {},
    });

    expect(summary.topAction).toBe('answersInserted');
    expect(summary.topActionLabel).toBe('Insert Answer');
  });

  it('reset clears only the stats storage key', async () => {
    const stats = loadStatsHelper();
    const storage = fakeStorage({
      [stats.STATS_KEY]: { totals: { answersInserted: 1 } },
      cvText: 'keep me',
      tailorCvDraft: 'also keep me',
    });

    await stats.reset({ storage });

    expect(storage.data[stats.STATS_KEY]).toBeUndefined();
    expect(storage.data.cvText).toBe('keep me');
    expect(storage.data.tailorCvDraft).toBe('also keep me');
  });

  it('tracks actions into local daily buckets', async () => {
    const stats = loadStatsHelper();
    const storage = fakeStorage();

    await stats.track('answersInserted', {
      storage,
      date: new Date(2026, 4, 4, 9),
    });

    const stored = storage.data[stats.STATS_KEY];
    expect(stored.totals.answersInserted).toBe(1);
    expect(stored.days['2026-05-04'].answersInserted).toBe(1);
  });
});
