(function () {
  const STATS_KEY = 'draftapplyProductivityStats';
  const ACTIONS = ['answersInserted', 'cvExports', 'cvsTailored'];
  const ACTION_LABELS = {
    answersInserted: 'Insert Answer',
    cvExports: 'CV Export',
    cvsTailored: 'Tailor CV',
  };

  function getStorage(storage) {
    if (storage) return storage;
    return globalThis.chrome?.storage?.local;
  }

  function emptyStats() {
    return {
      version: 1,
      totals: {
        answersInserted: 0,
        cvExports: 0,
        cvsTailored: 0,
      },
      days: {},
    };
  }

  function normalizeStats(raw) {
    const stats = emptyStats();
    const source = raw && typeof raw === 'object' ? raw : {};
    for (const action of ACTIONS) {
      const value = Number(source.totals?.[action] || 0);
      stats.totals[action] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }

    if (source.days && typeof source.days === 'object') {
      for (const [day, bucket] of Object.entries(source.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !bucket || typeof bucket !== 'object') continue;
        stats.days[day] = {};
        for (const action of ACTIONS) {
          const value = Number(bucket[action] || 0);
          stats.days[day][action] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
        }
      }
    }

    return stats;
  }

  function localDayKey(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function addLocalDays(date, offset) {
    const next = new Date(date);
    next.setHours(12, 0, 0, 0);
    next.setDate(next.getDate() + offset);
    return next;
  }

  function bucketTotal(bucket = {}) {
    return ACTIONS.reduce((sum, action) => sum + Number(bucket[action] || 0), 0);
  }

  function formatCount(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function formatTime(minutes) {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
  }

  function estimatedMinutesSaved(stats) {
    return (stats.totals.answersInserted * 3) + (stats.totals.cvExports * 20);
  }

  function thisWeekCount(stats, today = new Date()) {
    let count = 0;
    for (let i = 0; i < 7; i += 1) {
      const day = localDayKey(addLocalDays(today, -i));
      count += bucketTotal(stats.days[day]);
    }
    return count;
  }

  function assistStreakDays(stats, today = new Date()) {
    let streak = 0;
    for (let i = 0; i < 365; i += 1) {
      const day = localDayKey(addLocalDays(today, -i));
      if (bucketTotal(stats.days[day]) === 0) break;
      streak += 1;
    }
    return streak;
  }

  function topAction(stats) {
    let best = ACTIONS[0];
    for (const action of ACTIONS.slice(1)) {
      if (stats.totals[action] > stats.totals[best]) best = action;
    }
    return stats.totals[best] > 0 ? best : null;
  }

  function summarize(rawStats, today = new Date()) {
    const stats = normalizeStats(rawStats);
    const minutes = estimatedMinutesSaved(stats);
    const hasActivity = ACTIONS.some(action => stats.totals[action] > 0);
    const top = topAction(stats);

    return {
      answersInserted: stats.totals.answersInserted,
      cvExports: stats.totals.cvExports,
      cvsTailored: stats.totals.cvsTailored,
      estimatedMinutesSaved: minutes,
      timeSavedLabel: formatTime(minutes),
      thisWeekCount: thisWeekCount(stats, today),
      assistStreakDays: assistStreakDays(stats, today),
      topAction: top,
      topActionLabel: top ? ACTION_LABELS[top] : 'None yet',
      summaryText: hasActivity
        ? `${formatCount(stats.totals.answersInserted, 'answer')} inserted • ${stats.totals.cvExports} CV ${stats.totals.cvExports === 1 ? 'export' : 'exports'} • ${formatTime(minutes)} saved`
        : 'No activity yet',
    };
  }

  async function read(options = {}) {
    const storage = getStorage(options.storage);
    if (!storage) return emptyStats();
    const result = await storage.get(STATS_KEY);
    return normalizeStats(result?.[STATS_KEY]);
  }

  async function track(action, options = {}) {
    if (!ACTIONS.includes(action)) return read(options);
    const storage = getStorage(options.storage);
    if (!storage) return emptyStats();

    const amount = Math.max(1, Math.floor(Number(options.amount || 1)));
    const stats = await read({ storage });
    const day = localDayKey(options.date || new Date());

    stats.totals[action] += amount;
    stats.days[day] = stats.days[day] || {};
    for (const key of ACTIONS) stats.days[day][key] = Number(stats.days[day][key] || 0);
    stats.days[day][action] += amount;

    await storage.set({ [STATS_KEY]: stats });
    return stats;
  }

  async function reset(options = {}) {
    const storage = getStorage(options.storage);
    if (!storage) return;
    await storage.remove(STATS_KEY);
  }

  globalThis.DraftApplyStats = {
    STATS_KEY,
    ACTIONS,
    localDayKey,
    normalizeStats,
    summarize,
    read,
    track,
    reset,
  };
})();
