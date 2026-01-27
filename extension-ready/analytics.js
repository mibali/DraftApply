/**
 * DraftApply Analytics Tracker
 * 
 * Tracks:
 * - Applications started/completed
 * - Questions answered per application
 * - Time spent on each application
 */

class AnalyticsTracker {
  constructor() {
    this.storageKey = 'draftapply_analytics';
    this.sessionKey = 'draftapply_session';
  }

  async getStats() {
    const result = await chrome.storage.local.get(this.storageKey);
    return result[this.storageKey] || this.getDefaultStats();
  }

  getDefaultStats() {
    return {
      totalApplications: 0,
      totalQuestionsAnswered: 0,
      applications: [], // Array of application records
      createdAt: Date.now()
    };
  }

  async saveStats(stats) {
    await chrome.storage.local.set({ [this.storageKey]: stats });
  }

  async getSession() {
    const result = await chrome.storage.local.get(this.sessionKey);
    return result[this.sessionKey] || null;
  }

  async saveSession(session) {
    await chrome.storage.local.set({ [this.sessionKey]: session });
  }

  async clearSession() {
    await chrome.storage.local.remove(this.sessionKey);
  }

  /**
   * Start tracking a new application
   */
  async startApplication(url, company, jobTitle) {
    const domain = new URL(url).hostname;
    
    const session = {
      id: `app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      url,
      domain,
      company: company || null,
      jobTitle: jobTitle || null,
      startedAt: Date.now(),
      questionsAnswered: 0,
      questions: [],
      completed: false
    };

    await this.saveSession(session);
    return session;
  }

  /**
   * Track a question being answered
   */
  async trackQuestionAnswered(question, answerLength) {
    let session = await this.getSession();
    
    if (!session) {
      // Auto-start session if none exists
      session = await this.startApplication(
        typeof location !== 'undefined' ? location.href : 'unknown',
        null,
        null
      );
    }

    session.questionsAnswered++;
    session.questions.push({
      question: question.slice(0, 100), // Truncate for storage
      answerLength,
      answeredAt: Date.now()
    });

    await this.saveSession(session);

    // Also update global stats
    const stats = await this.getStats();
    stats.totalQuestionsAnswered++;
    await this.saveStats(stats);

    return session;
  }

  /**
   * Mark current application as completed
   */
  async completeApplication() {
    const session = await this.getSession();
    if (!session) return null;

    session.completed = true;
    session.completedAt = Date.now();
    session.duration = session.completedAt - session.startedAt;

    // Save to application history
    const stats = await this.getStats();
    stats.totalApplications++;
    stats.applications.push({
      id: session.id,
      domain: session.domain,
      company: session.company,
      jobTitle: session.jobTitle,
      questionsAnswered: session.questionsAnswered,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      duration: session.duration
    });

    // Keep only last 100 applications
    if (stats.applications.length > 100) {
      stats.applications = stats.applications.slice(-100);
    }

    await this.saveStats(stats);
    await this.clearSession();

    return session;
  }

  /**
   * Get formatted analytics summary
   */
  async getSummary() {
    const stats = await this.getStats();
    const session = await this.getSession();

    const avgTimeMs = stats.applications.length > 0
      ? stats.applications.reduce((sum, app) => sum + (app.duration || 0), 0) / stats.applications.length
      : 0;

    const avgQuestions = stats.applications.length > 0
      ? stats.applications.reduce((sum, app) => sum + app.questionsAnswered, 0) / stats.applications.length
      : 0;

    return {
      totalApplications: stats.totalApplications,
      totalQuestionsAnswered: stats.totalQuestionsAnswered,
      averageTimeMinutes: Math.round(avgTimeMs / 60000 * 10) / 10,
      averageQuestionsPerApp: Math.round(avgQuestions * 10) / 10,
      recentApplications: stats.applications.slice(-10).reverse(),
      currentSession: session,
      hasActiveSession: !!session
    };
  }

  /**
   * Reset all analytics
   */
  async reset() {
    await chrome.storage.local.remove([this.storageKey, this.sessionKey]);
  }
}

// Export singleton
const analytics = new AnalyticsTracker();
