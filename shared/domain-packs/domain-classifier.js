import fs from 'node:fs';

const domainPackSnapshot = JSON.parse(
  fs.readFileSync(new URL('./domain-pack.snapshot.json', import.meta.url), 'utf8'),
);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#/&.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word/phrase matching only - naive substring matching let single
// words falsely match inside unrelated longer words (e.g. the term "doctor"
// matching inside "doctorate", or "act" inside "contact"/"react").
function includesTerm(haystack, term) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(normalizedTerm)}(?:$|\\s)`);
  return pattern.test(haystack);
}

function countMatches(text, terms = []) {
  const haystack = normalizeText(text);
  return (terms || []).filter(term => includesTerm(haystack, term));
}

function unique(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function jdTextFromData(jdData = {}) {
  return [
    jdData.jobTitle,
    jdData.company,
    ...(jdData.requiredSkills || []),
    ...(jdData.preferredSkills || []),
    ...(jdData.tools || []),
    ...(jdData.softSkills || []),
    ...(jdData.responsibilities || []),
    ...(jdData.dealBreakers || []),
    ...(jdData.atsKeywords || []),
  ].filter(Boolean).join('\n');
}

function cvTextFromData(cvData = {}) {
  return [
    cvData.summary,
    ...(cvData.skills || []),
    ...(cvData.achievements || []),
    ...(cvData.certifications || []),
    ...((cvData.experience || []).flatMap(exp => [
      exp.title,
      exp.company,
      ...(exp.responsibilities || []),
    ])),
  ].filter(Boolean).join('\n');
}

function isSparseJobContext(jobDescription, jdData = {}) {
  const text = normalizeText(jobDescription || jdTextFromData(jdData));
  const wordCount = text ? text.split(/\s+/).length : 0;
  const requirementCount = [
    ...(jdData.requiredSkills || []),
    ...(jdData.preferredSkills || []),
    ...(jdData.tools || []),
    ...(jdData.responsibilities || []),
  ].filter(Boolean).length;
  const hasParsedStructure = Boolean(jdData && Object.keys(jdData).length > 0);
  return wordCount > 0 && (wordCount < 80 || (hasParsedStructure && requirementCount < 3));
}

function ruleApplies(rule, profile) {
  return (rule.appliesToRiskLevels || []).includes(profile.riskLevel);
}

export function classifyDomainRisk({
  cvText = '',
  jobDescription = '',
  jobTitle = '',
  cvData = null,
  jdData = null,
  domainPack = domainPackSnapshot,
} = {}) {
  const profiles = Array.isArray(domainPack.domainProfiles) ? domainPack.domainProfiles : [];
  const rules = Array.isArray(domainPack.credentialRules) ? domainPack.credentialRules : [];
  const jdText = [jobTitle, jobDescription, jdTextFromData(jdData || {})].filter(Boolean).join('\n');
  const cvEvidenceText = [cvText, cvTextFromData(cvData || {})].filter(Boolean).join('\n');

  const scoredProfiles = profiles.map(profile => {
    const keywordMatches = countMatches(jdText, profile.keywords);
    // A keyword appearing in the job title itself is a much higher-precision
    // signal than the same word appearing once in body text ("Attorney" as
    // the job title vs. "pilot" mentioned once in a Product Manager JD about
    // a pilot program) - weight title matches like credential matches so a
    // JD genuinely titled for a regulated role isn't held to the same
    // corroboration bar as an incidental body-text mention.
    const titleKeywordMatches = countMatches(jobTitle, profile.keywords);
    const credentialMatches = countMatches(jdText, profile.credentialKeywords);
    const cvCredentialMatches = countMatches(cvEvidenceText, profile.credentialKeywords);
    const score = keywordMatches.length + titleKeywordMatches.length + credentialMatches.length * 2;
    return {
      id: profile.id,
      label: profile.label,
      riskLevel: profile.riskLevel,
      evidenceStrictness: profile.evidenceStrictness,
      score,
      keywordMatches: unique(keywordMatches).slice(0, 8),
      credentialMatches: unique(credentialMatches).slice(0, 8),
      cvCredentialMatches: unique(cvCredentialMatches).slice(0, 8),
      confirmationPrompts: unique(profile.confirmationPrompts).slice(0, 3),
      rules: rules.filter(rule => ruleApplies(rule, profile)).map(rule => ({
        id: rule.id,
        severity: rule.severity,
        description: rule.description,
      })),
    };
  // score >= 2, not > 0: a single incidental keyword mention (e.g. "pilot
  // program" in a Product Manager JD, or one boilerplate phrase like "other
  // duties as assigned") should not be enough to flag a regulated domain and
  // surface a review banner. Credential-keyword hits are weighted x2 and so
  // still trigger correctly on their own (a genuine credential mention is a
  // strong signal); this only raises the bar for weak, single-keyword hits.
  }).filter(profile => profile.score >= 2)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  const primary = scoredProfiles[0] || null;
  const sparse = isSparseJobContext(jobDescription, jdData || {});
  const credentialWarnings = scoredProfiles.flatMap(profile => {
    const needsCredentialConfirmation = profile.credentialMatches.length > 0 && profile.cvCredentialMatches.length === 0;
    if (!needsCredentialConfirmation) return [];
    return [{
      profileId: profile.id,
      severity: profile.riskLevel === 'regulated' ? 'block' : 'confirm',
      message: `${profile.label} credential requested by the JD is not clearly supported by the CV.`,
      missingCredentials: profile.credentialMatches,
      confirmationPrompts: profile.confirmationPrompts,
    }];
  });

  const reviewPrompts = unique([
    ...(primary?.confirmationPrompts || []),
    ...credentialWarnings.flatMap(item => item.confirmationPrompts || []),
    ...(sparse ? ['The job description is sparse. Confirm role scope, must-have requirements, and location-specific constraints before sending.'] : []),
  ]).slice(0, 6);

  return {
    detected: Boolean(primary || sparse),
    primaryProfile: primary ? {
      id: primary.id,
      label: primary.label,
      riskLevel: primary.riskLevel,
      evidenceStrictness: primary.evidenceStrictness,
      score: primary.score,
    } : (sparse ? {
      id: 'sparse_context',
      label: 'Sparse / vague job description',
      riskLevel: 'review',
      evidenceStrictness: 'confirm',
      score: 1,
    } : null),
    matchedProfiles: scoredProfiles.slice(0, 3),
    credentialWarnings,
    reviewPrompts,
    reviewRequired: credentialWarnings.length > 0 || Boolean(primary && primary.riskLevel !== 'general') || sparse,
    sparseContext: sparse,
  };
}
