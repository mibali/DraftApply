const SCHEMA_VERSION = '1.0';

const STOP = new Set('a an and are as at be by for from has have i in is it my of on or our that the their this to was we were with'.split(' '));
const PERSONAL_STATE = /\b(authori[sz]ed to work|work authori[sz]ation|right to work|require sponsorship|need sponsorship|available to start|notice period|security clearance)\b/i;
const CREDENTIAL = /\b(certified|certification|certificate|degree|bsc|ba|bs|msc|ma|ms|phd|licen[cs](?:e|ed)|clearance)\b/i;
const PREPARATION = /\b(prepar(?:ing|ation)|studying|pursuing|working towards?|eligible|eligibility|endorsed|candidate|pending|scheduled|awaiting)\b/i;
const METRIC = /(?:[$£€]\s*\d[\d,.]*|\b\d+(?:\.\d+)?\s*(?:%|x\b|×|k\b|m\b|million\b|billion\b|users?\b|customers?\b|months?\b|years?\b))/gi;
const SUBJECTIVE = /\b(?:want|would like|interested|drawn|excited|motivated|value|believe|hope|enjoy|appeal)\b/i;
const FIRST_PERSON = /\b(?:i|my|we|our)\b/i;
// The contraction branch must REQUIRE the apostrophe (plus an explicit list
// of apostrophe-less typed forms): an optional apostrophe made every word
// ending in "nt" (experiment, deployment, environment, management) count as
// a negation, which failed negation-parity for almost every CV bullet and
// silently rejected grounded claims.
const NEGATION = /\b(?:no|not|never|without|lack(?:s|ed|ing)?|cannot|\w+n[’']t|(?:ca|wo|do|does|did|is|was|are|were|has|have|had|could|should|would|ai)nt)\b/i;

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9%$£€+#.]+/g, ' ').trim();
}

function tokens(value) {
  // normalise() keeps dots for dotted names (Node.js, Neptune.ai), which
  // leaves sentence-final words carrying their full stop ("logging.") and
  // never matching the same word inside evidence. Trailing dots are
  // punctuation, not part of the token.
  return normalise(value).split(/\s+/)
    .map(token => token.replace(/\.+$/, ''))
    .filter(token => token.length > 2 && !STOP.has(token));
}

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

function metrics(text) {
  return [...String(text || '').matchAll(METRIC)].map(match => normalise(match[0]));
}

/** Build a canonical, additive evidence view from parsed or legacy CV data. */
export function buildGroundingContext(cvData = {}, { confirmedFacts = [], targetCompany = '' } = {}) {
  const records = [];
  const add = (record) => {
    if (!record.text) return;
    const existingIndex = records.findIndex(item => item.sourceId === record.sourceId);
    const normalized = { ...record, text: String(record.text).trim() };
    if (existingIndex !== -1) {
      const existing = records[existingIndex];
      if (normalise(existing.text) !== normalise(normalized.text)) return;
      records[existingIndex] = Object.freeze({ ...existing, ...normalized });
      return;
    }
    records.push(Object.freeze(normalized));
  };
  for (const record of cvData.evidenceIndex || []) add(record);
  // Contact fields are parsed from the bounded CV header by CVParser. Treat
  // them as first-class evidence instead of forcing consumers to re-scan raw
  // prose (which can mistake section headings or employer links for identity).
  const contactInfo = cvData.contactInfo || {};
  for (const [field, value] of Object.entries(contactInfo)) {
    if (typeof value === 'string' && value.trim()) add({
      sourceId: `contact:${field}`,
      type: 'contact',
      field,
      text: value.trim(),
    });
  }
  (cvData.experience || []).forEach((role, roleIndex) => {
    const roleSourceId = role.sourceId || `experience:${roleIndex}`;
    (role.responsibilities || []).forEach((text, index) => add({
      sourceId: role.responsibilityEvidence?.[index]?.sourceId || `${roleSourceId}:responsibility:${index}`,
      roleSourceId, roleIndex, type: 'experience_responsibility', text,
      company: role.company || '', title: role.title || '', dates: role.dates || '',
    }));
  });
  (cvData.projects || []).forEach((project, projectIndex) => {
    const projectSourceId = project.sourceId || `project:${projectIndex}`;
    add({ sourceId: projectSourceId, projectSourceId, projectIndex, type: 'project', text: `${project.name || ''} ${project.url || ''}`.trim(), name: project.name || '', url: project.url || '' });
    (project.bullets || []).forEach((text, index) => add({ sourceId: project.bulletEvidence?.[index]?.sourceId || `${projectSourceId}:bullet:${index}`, projectSourceId, projectIndex, type: 'project_bullet', text }));
    (project.skills || []).forEach((text, index) => add({ sourceId: project.skillEvidence?.[index]?.sourceId || `${projectSourceId}:skill:${index}`, projectSourceId, projectIndex, type: 'project_skill', text }));
  });
  if (cvData.summary) add({ sourceId: 'summary:0', type: 'summary', text: cvData.summary });
  for (const [type, values] of [['skill', cvData.skills], ['achievement', cvData.achievements], ['certification', cvData.certifications]]) {
    (values || []).forEach((text, index) => add({ sourceId: `${type}:${index}`, type, text }));
  }
  (cvData.education || []).forEach((edu, index) => add({
    sourceId: `education:${index}`, type: 'education',
    text: typeof edu === 'string' ? edu : [edu.degree, edu.institution, edu.dates].filter(Boolean).join(', '),
  }));
  (confirmedFacts || []).forEach((text, index) => add({ sourceId: `user-confirmed:${index}`, type: 'user_confirmed', text }));
  const sourceIndex = Object.fromEntries(records.map(record => [record.sourceId, record]));
  return { schemaVersion: SCHEMA_VERSION, records, sourceIndex, targetCompany: String(targetCompany || '') };
}

export function selectEvidence(context, text, { roleSourceId = null, limit = 6 } = {}) {
  const wanted = new Set(tokens(text));
  return (context?.records || [])
    .filter(record => !roleSourceId || record.roleSourceId === roleSourceId)
    .map(record => ({ record, score: tokens(record.text).filter(token => wanted.has(token)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, limit).map(item => item.record);
}

export function isTextSupported(text, context, { roleSourceId = null, allowedSourceIds = null, sourceIds = [], requireSourceIds = false, minOverlapRatio = 0.85 } = {}) {
  const allowed = Array.isArray(allowedSourceIds) ? new Set(allowedSourceIds) : null;
  const roleCandidates = (context?.records || []).filter(record => !roleSourceId || record.roleSourceId === roleSourceId);
  const validProposedSourceIds = sourceIds.filter(id => context?.sourceIndex?.[id]
    && (!roleSourceId || context.sourceIndex[id].roleSourceId === roleSourceId)
    && (!allowed || allowed.has(id)));
  let candidates = sourceIds.length > 0
    ? validProposedSourceIds.map(id => context.sourceIndex[id])
    : roleCandidates;
  if ((requireSourceIds && validProposedSourceIds.length === 0) || candidates.length === 0) {
    return { supported: false, validProposedSourceIds };
  }
  if (validProposedSourceIds.length > 1) {
    candidates = [{
      ...candidates[0],
      text: candidates.map(record => record.text).join(' '),
    }, ...candidates];
  }
  const claimMetrics = metrics(text);
  const claimTokens = tokens(text);
  const employerClaim = /\b(?:worked|work|employed|served|role)\b.{0,35}\b(?:at|for|with)\s+([A-Z][\w&.-]+)/i.exec(String(text || ''))?.[1]
    || /(?:^|[.!?]\s+)At\s+([A-Z][\w&.-]+)/.exec(String(text || ''))?.[1];
  const supported = candidates.some(record => {
    const evidence = normalise(`${record.text} ${record.company || ''} ${record.title || ''} ${record.dates || ''}`);
    if (NEGATION.test(text) !== NEGATION.test(record.text)) return false;
    if (claimMetrics.some(metric => !metrics(evidence).includes(metric))) return false;
    if (CREDENTIAL.test(text) && !CREDENTIAL.test(evidence)) return false;
    if (CREDENTIAL.test(text) && !PREPARATION.test(text) && PREPARATION.test(record.text)) return false;
    if (employerClaim && (!record.company || !normalise(record.company).includes(normalise(employerClaim)))) return false;
    const evidenceTokens = new Set(tokens(evidence));
    const overlap = claimTokens.filter(token => evidenceTokens.has(token)).length;
    return claimTokens.length > 0 && overlap >= Math.max(1, Math.ceil(claimTokens.length * minOverlapRatio));
  });
  return { supported, validProposedSourceIds };
}

export function extractGroundingClaims(answer, { question = '', questionType = '' } = {}) {
  const claims = [];
  for (const sentence of splitSentences(answer)) {
    if (/^\s*(?:yes|no)[,.!]?\s*$/i.test(sentence)) continue;
    const before = claims.length;
    const foundMetrics = metrics(sentence);
    if (foundMetrics.length) claims.push({ type: 'metric', text: sentence, values: foundMetrics });
    if (PERSONAL_STATE.test(sentence)) claims.push({ type: 'personal_state', text: sentence });
    if (CREDENTIAL.test(sentence)) claims.push({ type: 'credential', text: sentence });
    if (/\b(?:worked|work|employed|served|role)\b.{0,35}\b(?:at|for|with)\s+[A-Z][\w&.-]+/i.test(sentence)) claims.push({ type: 'employment_history', text: sentence });
    if (/\b(?:19|20)\d{2}\b|\b\d+\s+years?\b/i.test(sentence) && !foundMetrics.length) claims.push({ type: 'date_tenure', text: sentence });
    if (claims.length === before && SUBJECTIVE.test(sentence)) {
      claims.push({ type: 'subjective', text: sentence });
    } else if (claims.length === before) {
      claims.push({ type: 'factual_assertion', text: sentence });
    }
  }
  if (questionType === 'yes_no' || /^(are|do|have|can|will|would|is|did)\s+you\b/i.test(question.trim())) {
    const value = /^\s*(yes|no)\b/i.exec(answer)?.[1]?.toLowerCase();
    claims.push({ type: 'yes_no', text: answer.trim(), value: value || 'unknown' });
  }
  return claims.map((claim, index) => ({ id: `claim:${index}`, ...claim }));
}

/** Deterministic grounding only; style scoring remains in answer-evaluator.js. */
export function validateApplicationAnswer(answer, options = {}) {
  const context = options.context || buildGroundingContext(options.cvData, options);
  const claims = extractGroundingClaims(answer, options);
  const violations = [];
  const checked = claims.map(claim => {
    const personalQuestion = PERSONAL_STATE.test(`${options.question || ''} ${claim.text}`);
    const proposition = String(options.question || '')
      .replace(/^(?:are|do|have|can|will|would|is|did)\s+you\s+/i, '')
      .replace(/\b(?:experience|experienced|before|currently|ever|with|in|the|a|an)\b/gi, ' ')
      .replace(/[?!.]+$/g, '')
      .trim();
    const supportText = claim.type === 'yes_no' ? proposition : claim.text;
    let supported = claim.type === 'yes_no'
      ? selectEvidence(context, proposition, { limit: 1 }).some(record => {
          const propositionTokens = tokens(proposition);
          const evidenceTokens = new Set(tokens(`${record.text} ${record.company || ''} ${record.title || ''}`));
          if (NEGATION.test(record.text)) return false;
          if (CREDENTIAL.test(proposition) && PREPARATION.test(record.text)) return false;
          return propositionTokens.length > 0 && propositionTokens.every(token => evidenceTokens.has(token));
        })
      : isTextSupported(supportText, context, {
          // Ordinary prose is expected to paraphrase the CV. Protected facts
          // (metrics, employers, credentials, dates and personal state) keep
          // the strict threshold and their dedicated checks above.
          minOverlapRatio: claim.type === 'factual_assertion' ? 0.55 : 0.85,
        }).supported;
    const personalConfirmed = !personalQuestion || (context.records || []).some(record =>
      record.type === 'user_confirmed' && isTextSupported(supportText || claim.text, {
        records: [record], sourceIndex: { [record.sourceId]: record },
      }).supported
    );
    const personalUnknown = personalQuestion && !personalConfirmed;
    if (claim.type === 'subjective') supported = true;
    if (claim.type === 'yes_no' && claim.value === 'yes' && (context.records || []).some(record =>
      /\b(?:not|never|no)\b/i.test(record.text) && selectEvidence({ ...context, records: [record] }, supportText, { limit: 1 }).length
    )) supported = false;
    if (claim.type === 'employment_history' && options.questionType === 'why_company' && context.targetCompany
      && normalise(claim.text).includes(normalise(context.targetCompany)) && !/\b(worked|employed|served)\b/i.test(claim.text)) supported = true;
    if (claim.type === 'credential' && PREPARATION.test(claim.text)) supported = isTextSupported(claim.text, context).supported;
    if (claim.type === 'yes_no' && claim.value !== 'yes') supported = false;
    // Model-authored factual prose must fail closed. `review` is reserved for
    // non-factual structure/style validators; looking at an unsupported fact
    // is not the same as correcting it. The UI still lets a person edit the
    // draft, at which point it is explicitly treated as user-authored text.
    const disposition = supported ? 'supported' : 'unsupported';
    if (disposition !== 'supported') violations.push({
      claimId: claim.id,
      code: personalUnknown ? 'unknown_personal_state' : `unsupported_${claim.type}`,
      severity: 'block',
    });
    return { ...claim, disposition };
  });
  const unsupportedClaims = checked.filter(claim => claim.disposition === 'unsupported').length;
  const reviewClaims = checked.filter(claim => claim.disposition === 'review').length;
  // Unsupported credential claims are blocked, so none reach the allowed
  // output. Keep both attempted and allowed counts observable rather than
  // reporting a constant that could hide a validator regression.
  const blockedCredentialClaims = checked.filter(claim => claim.type === 'credential' && claim.disposition === 'unsupported').length;
  const credentialFalsePositives = checked.filter(claim => claim.type === 'credential' && claim.disposition === 'unsupported' && claim.allowed === true).length;
  if (checked.length === 0) violations.push({ claimId: null, code: 'no_validated_claims', severity: 'block' });
  return {
    schemaVersion: SCHEMA_VERSION,
    status: checked.length === 0 || unsupportedClaims ? 'block' : reviewClaims ? 'review' : 'pass',
    claims: checked, violations,
    counts: {
      claims: checked.length,
      supportedClaims: checked.length - unsupportedClaims - reviewClaims,
      unsupportedClaims,
      reviewClaims,
      blockedCredentialClaims,
      credentialFalsePositives,
    },
  };
}

export default { buildGroundingContext, selectEvidence, extractGroundingClaims, validateApplicationAnswer, isTextSupported };
