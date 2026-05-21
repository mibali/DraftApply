import { SALARY_BENCHMARKS } from './salary-benchmarks.js';

export class SalaryBenchmarkService {
  constructor(snapshot = SALARY_BENCHMARKS) {
    this.snapshot = snapshot || SALARY_BENCHMARKS;
  }

  lookup({ jobTitle = '', question = '', jobDescription = '', roleProfile = null, country = '' } = {}) {
    const inferredCountry = this._normaliseCountry(country) ||
      this._inferCountry(`${question}\n${jobDescription}`);
    const roleKeys = this._roleKeys(jobTitle, roleProfile);
    const rows = Array.isArray(this.snapshot.benchmarks) ? this.snapshot.benchmarks : [];

    return rows.find(row => {
      if (!row || !this._isUsableRow(row)) return false;
      const rowCountry = this._normaliseCountry(row.country);
      if (inferredCountry && rowCountry && rowCountry !== inferredCountry) return false;
      const rowKeys = [
        row.roleProfileId,
        row.domain,
        ...(Array.isArray(row.titleAliases) ? row.titleAliases : []),
      ].map(value => this._normaliseKey(value)).filter(Boolean);
      return roleKeys.some(key => rowKeys.includes(key));
    }) || null;
  }

  formatForPrompt(benchmark) {
    if (!benchmark || !this._isUsableRow(benchmark)) return '';
    const currency = benchmark.currency || 'local currency';
    const annual = benchmark.annual || {};
    const parts = [
      Number.isFinite(annual.p25) ? `p25 ${this._formatMoney(annual.p25, currency)}` : '',
      Number.isFinite(annual.median) ? `median ${this._formatMoney(annual.median, currency)}` : '',
      Number.isFinite(annual.p75) ? `p75 ${this._formatMoney(annual.p75, currency)}` : '',
    ].filter(Boolean);
    if (parts.length === 0) return '';
    const source = benchmark.sourceName || benchmark.sourceId || 'official salary snapshot';
    const asOf = benchmark.asOf ? `, as of ${benchmark.asOf}` : '';
    return `Official salary benchmark (${source}${asOf}): ${parts.join(', ')} annual. Use this as an anchor, adjusted for seniority and location.`;
  }

  hasOfficialSnapshot() {
    const rows = Array.isArray(this.snapshot.benchmarks) ? this.snapshot.benchmarks : [];
    return rows.some(row => this._isUsableRow(row));
  }

  _roleKeys(jobTitle, roleProfile) {
    const keys = [
      roleProfile?.id,
      roleProfile?.domain,
      jobTitle,
      ...this._titleAliases(jobTitle),
    ];
    return [...new Set(keys.map(value => this._normaliseKey(value)).filter(Boolean))];
  }

  _titleAliases(title) {
    const t = String(title || '').toLowerCase();
    const aliases = [];
    if (/\b(product\s+manager|pm)\b/.test(t)) aliases.push('product_management');
    if (/\b(solution|solutions)\s+(architect|engineer|consultant)\b/.test(t)) aliases.push('solution_engineering');
    if (/\b(devops|platform|site\s+reliability|sre)\b/.test(t)) aliases.push('devops_sre');
    if (/\b(data\s+engineer|analytics\s+engineer)\b/.test(t)) aliases.push('data_engineering');
    if (/\b(marketing|growth|campaign)\b/.test(t)) aliases.push('marketing');
    if (/\b(customer\s+success|technical\s+account|tam)\b/.test(t)) aliases.push('customer_success');
    if (/\b(finance|accountant|controller|fp&a)\b/.test(t)) aliases.push('finance');
    return aliases;
  }

  _inferCountry(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(gbp|£|uk|united kingdom|london|england|scotland|wales|birmingham|manchester)\b/.test(t)) return 'UK';
    if (/\b(usd|\$|usa|united states|new york|san francisco|california|texas)\b/.test(t)) return 'US';
    if (/\b(eur|€|europe|germany|france|netherlands|ireland|spain|italy)\b/.test(t)) return 'EU';
    return '';
  }

  _normaliseCountry(country) {
    const c = String(country || '').trim().toLowerCase();
    if (!c) return '';
    if (['uk', 'gb', 'gbr', 'united kingdom', 'england', 'scotland', 'wales'].includes(c)) return 'UK';
    if (['us', 'usa', 'united states', 'united states of america'].includes(c)) return 'US';
    if (['eu', 'europe', 'european union'].includes(c)) return 'EU';
    return c.toUpperCase();
  }

  _normaliseKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  _isUsableRow(row) {
    const annual = row?.annual || {};
    return Boolean(row.roleProfileId || row.domain || row.titleAliases?.length) &&
      Boolean(row.currency) &&
      [annual.p25, annual.median, annual.p75].some(Number.isFinite) &&
      Boolean(row.sourceId || row.sourceName);
  }

  _formatMoney(value, currency) {
    const prefix = currency === 'GBP' ? '£'
      : currency === 'USD' ? '$'
        : currency === 'EUR' ? '€'
          : `${currency} `;
    return `${prefix}${Math.round(value).toLocaleString('en-GB')}`;
  }
}

export default SalaryBenchmarkService;
