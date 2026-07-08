import { CVParser } from './cv-parser.js';
import { JDParser } from './jd-parser.js';
import { CVTailor } from './cv-tailor.js';

export const APPLICATION_ANSWER_AGENTS = [
  'Question Classifier Agent',
  'CV Grounding Agent',
  'Job Context Matcher',
  'Answer Drafting Agent',
  'Tone & Length Agent',
  'Truthfulness Guard Agent',
  'Final Answer Formatter',
];

export const TAILORED_CV_AGENTS = [
  'JD Analysis Agent',
  'CV Parsing Agent',
  'Match Scoring Agent',
  'Gap Analysis Agent',
  'Keyword Optimisation Agent',
  'CV Rewrite Agent',
  'ATS Formatting Agent',
  'Truthfulness Guard Agent',
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
  'have', 'has', 'will', 'would', 'should', 'can', 'could', 'role', 'job',
  'application', 'question', 'experience', 'skills', 'skill', 'work', 'team',
  'company', 'candidate', 'using', 'use', 'about', 'into', 'what', 'when',
  'where', 'why', 'how', 'tell', 'describe', 'give', 'example',
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
}

function unique(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

export function questionClassifierAgent(question = '') {
  const q = String(question || '').toLowerCase();
  if (/cover\s*letter|motivation\s+letter|letter\s+of\s+interest/.test(q)) return 'cover_letter';
  if (/why\s+(do|would|are)|what\s+(interests?|attracts?|draws?)/.test(q)) return 'motivation_or_why';
  if (/tell\s+me\s+about\s+a\s+time|describe\s+a\s+(time|situation)|give\s+.*example/.test(q)) return 'behavioral';
  if (/salary|compensation|pay|rate/.test(q)) return 'salary';
  if (/notice\s*period|start\s+date|availability|visa|right\s+to\s+work|authori[sz]ation/.test(q)) return 'short_factual';
  if (/^(are|do|have|can|will|would|is|did)\s+you\b/i.test(String(question || '').trim())) return 'yes_no';
  return 'general';
}

export function cvParsingAgent(cvText, existingCvData = null, parser = new CVParser()) {
  return existingCvData || parser.parse(cvText || '');
}

export function candidateEvidenceMapAgent(cvData = {}) {
  const evidenceItems = [];

  if (cvData.summary) {
    evidenceItems.push({ type: 'summary', label: 'Professional Summary', text: cvData.summary });
  }

  for (const achievement of cvData.achievements || []) {
    evidenceItems.push({ type: 'achievement', label: 'Achievement', text: achievement });
  }

  for (const skill of cvData.skills || []) {
    evidenceItems.push({ type: 'skill', label: 'Skill', text: skill });
  }

  for (const exp of cvData.experience || []) {
    const role = [exp.title, exp.company].filter(Boolean).join(' at ') || 'Experience';
    for (const bullet of exp.responsibilities || []) {
      evidenceItems.push({ type: 'experience', label: role, text: bullet });
    }
  }

  for (const cert of cvData.certifications || []) {
    evidenceItems.push({ type: 'certification', label: 'Certification', text: cert });
  }

  return {
    candidateName: cvData.contactInfo?.name || '',
    recentRoles: (cvData.experience || [])
      .slice(0, 3)
      .map(exp => [exp.title, exp.company].filter(Boolean).join(' at '))
      .filter(Boolean),
    evidenceItems,
    skills: unique(cvData.skills),
    achievements: unique(cvData.achievements),
  };
}

export function jdAnalysisAgent(jobDescription, jobTitle = '', company = '', existingJdData = null, parser = new JDParser()) {
  return existingJdData || parser.parse(jobDescription || '', jobTitle, company);
}

export function roleRequirementMapAgent(jdData = {}) {
  const requirements = [
    ...(jdData.requiredSkills || []).map(requirement => ({ requirement, type: 'required', priority: 3 })),
    ...(jdData.preferredSkills || []).map(requirement => ({ requirement, type: 'preferred', priority: 2 })),
    ...(jdData.tools || []).map(requirement => ({ requirement, type: 'tool', priority: 2 })),
    ...(jdData.softSkills || []).map(requirement => ({ requirement, type: 'soft', priority: 1 })),
  ];

  const seen = new Set();
  return {
    jobTitle: jdData.jobTitle || '',
    company: jdData.company || '',
    seniority: jdData.seniority || '',
    requirements: requirements.filter(item => {
      const key = normalizeText(item.requirement);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    responsibilities: unique(jdData.responsibilities),
    atsKeywords: unique(jdData.atsKeywords),
    tools: unique(jdData.tools),
    dealBreakers: unique(jdData.dealBreakers),
  };
}

export function cvGroundingAgent(question = '', evidenceMap = {}, limit = 6) {
  const queryTokens = tokenize(question);
  const scored = (evidenceMap.evidenceItems || [])
    .map(item => {
      const textTokens = new Set(tokenize(`${item.label} ${item.text}`));
      const overlap = queryTokens.filter(token => textTokens.has(token)).length;
      const metricBoost = /\b(\d+%|\d+\s*(users?|customers?|weeks?|months?|engineers?)|reduced|increased|improved|saved|grew)\b/i.test(item.text) ? 2 : 0;
      const typeBoost = item.type === 'achievement' ? 2 : item.type === 'experience' ? 1 : 0;
      return { ...item, score: overlap * 3 + metricBoost + typeBoost };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.text).length - String(b.text).length)
    .slice(0, limit);

  return {
    queryType: questionClassifierAgent(question),
    evidence: scored.map(({ score, ...item }) => item),
  };
}

export function jobContextMatcherAgent(question = '', roleRequirementMap = {}, matchMap = [], limit = 6) {
  const questionTokens = tokenize(question);
  const scoredRequirements = (roleRequirementMap.requirements || [])
    .map(item => {
      const reqTokens = new Set(tokenize(item.requirement));
      const overlap = questionTokens.filter(token => reqTokens.has(token)).length;
      const match = (matchMap || []).find(entry => normalizeText(entry.requirement) === normalizeText(item.requirement));
      return {
        ...item,
        status: match?.status || 'unknown',
        allowedToMention: Boolean(match?.allowedToMention),
        evidence: Array.isArray(match?.evidence) ? match.evidence.slice(0, 3) : [],
        score: overlap * 3 + item.priority + (match?.allowedToMention ? 2 : 0),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    matchedRequirements: scoredRequirements.map(({ score, ...item }) => item),
  };
}

export function matchScoringAgent(matchMap = [], tailor = new CVTailor()) {
  return tailor.buildMatchSummary(matchMap);
}

export function gapAnalysisAgent(matchMap = []) {
  const missing = (matchMap || []).filter(item => item.status === 'missing');
  const partial = (matchMap || []).filter(item => item.status === 'partial_match');
  const confirmed = (matchMap || []).filter(item => item.status === 'user_confirmed');

  return {
    missingRequirements: missing.map(item => item.requirement),
    transferableRequirements: partial.map(item => item.requirement),
    confirmedAdditions: confirmed.map(item => item.requirement),
    confirmationRequired: missing.map(item => ({
      skill: item.requirement,
      type: item.type,
      reason: 'Mentioned in the JD but not confirmed in the CV.',
    })),
  };
}

export function keywordOptimisationAgent(matchMap = [], jdData = {}) {
  const allowed = new Set((matchMap || [])
    .filter(item => item.allowedToMention)
    .map(item => normalizeText(item.requirement)));

  const supportedKeywords = unique([
    ...(jdData.tools || []),
    ...(jdData.atsKeywords || []),
    ...(jdData.requiredSkills || []),
  ]).filter(keyword => {
    const key = normalizeText(keyword);
    return allowed.has(key) || [...allowed].some(allowedKey => allowedKey.includes(key) || key.includes(allowedKey));
  });

  const riskyKeywords = unique([
    ...(jdData.tools || []),
    ...(jdData.requiredSkills || []),
  ]).filter(keyword => !supportedKeywords.some(supported => normalizeText(supported) === normalizeText(keyword)));

  return {
    supportedKeywords: supportedKeywords.slice(0, 20),
    riskyKeywords: riskyKeywords.slice(0, 20),
  };
}

export function atsFormattingAgent(jdData = {}, matchMap = []) {
  return {
    targetTitle: jdData.jobTitle || '',
    recommendedSections: ['Professional Summary', 'Core Competencies', 'Professional Experience', 'Education'],
    requiredVisibleEvidence: (matchMap || [])
      .filter(item => item.allowedToMention)
      .slice(0, 8)
      .map(item => item.requirement),
    formattingRules: [
      'Use simple section headings.',
      'Keep bullets concise and ATS-readable.',
      'Do not paste long JD requirement sentences into skills.',
      'Preserve employer names, titles, dates, education, and certifications.',
    ],
  };
}

export function truthfulnessGuardAgent(matchMap = []) {
  return {
    unsupportedClaims: (matchMap || [])
      .filter(item => !item.allowedToMention)
      .map(item => item.requirement),
    allowedClaims: (matchMap || [])
      .filter(item => item.allowedToMention)
      .map(item => ({
        requirement: item.requirement,
        evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 3) : [],
        confirmedByUser: Boolean(item.confirmedByUser),
      })),
    rules: [
      'Do not claim unsupported tools, credentials, employers, dates, or metrics.',
      'User-confirmed skills may be added only when explicitly confirmed.',
      'Transferable experience must be framed honestly.',
    ],
  };
}

export function normalizeMatchReport(summary = {}, matchMap = []) {
  const unsupported = Array.isArray(summary.unsupportedRequirements)
    ? summary.unsupportedRequirements
    : Array.isArray(summary.missingSkills)
      ? summary.missingSkills.map(item => typeof item === 'string' ? item : item?.skill).filter(Boolean)
      : [];

  const missingSkills = unsupported.map(skill => {
    const match = (matchMap || []).find(item => item?.requirement === skill);
    return {
      skill,
      importance: match?.importance || (match?.required ? 'high' : 'medium'),
      reason: match?.reason || 'Mentioned in the JD but not confirmed in the CV.',
      canAskUserToConfirm: true,
    };
  });

  return {
    ...summary,
    unsupportedRequirements: unsupported,
    missingSkills,
    transferableMatches: summary.transferableMatches || summary.partialMatches || [],
  };
}

export function rebuildTailoredCvAgentContext(context = {}, matchMap = [], tailor = new CVTailor()) {
  const effectiveMatchMap = Array.isArray(matchMap) ? matchMap : [];
  const rawMatchReport = matchScoringAgent(effectiveMatchMap, tailor);

  return {
    ...context,
    matchMap: effectiveMatchMap,
    matchReport: normalizeMatchReport(rawMatchReport, effectiveMatchMap),
    gapAnalysis: gapAnalysisAgent(effectiveMatchMap),
    keywordOptimisation: keywordOptimisationAgent(effectiveMatchMap, context.jdData),
    atsFormatting: atsFormattingAgent(context.jdData, effectiveMatchMap),
    truthfulness: truthfulnessGuardAgent(effectiveMatchMap),
  };
}

export function runApplicationAnswerAgents({
  question = '',
  cvText = '',
  jobDescription = '',
  jobTitle = '',
  company = '',
  cvData = null,
  jdData = null,
  matchMap = [],
  cvParser = new CVParser(),
  jdParser = new JDParser(),
  tailor = new CVTailor(),
} = {}) {
  const parsedCv = cvParsingAgent(cvText, cvData, cvParser);
  const parsedJd = jobDescription
    ? jdAnalysisAgent(jobDescription, jobTitle, company, jdData, jdParser)
    : jdData;
  const effectiveMatchMap = (matchMap && matchMap.length)
    ? matchMap
    : parsedJd
      ? tailor.buildMatchMap(parsedCv, parsedJd)
      : [];
  const candidateEvidenceMap = candidateEvidenceMapAgent(parsedCv);
  const roleRequirementMap = parsedJd ? roleRequirementMapAgent(parsedJd) : null;
  const cvGrounding = cvGroundingAgent(question, candidateEvidenceMap);
  const jobContextMatch = roleRequirementMap
    ? jobContextMatcherAgent(question, roleRequirementMap, effectiveMatchMap)
    : { matchedRequirements: [] };

  return {
    workflow: 'applicationAnswer',
    agentChain: APPLICATION_ANSWER_AGENTS,
    questionType: cvGrounding.queryType,
    cvData: parsedCv,
    jdData: parsedJd,
    matchMap: effectiveMatchMap,
    candidateEvidenceMap,
    roleRequirementMap,
    relevantEvidence: cvGrounding.evidence,
    matchedRequirements: jobContextMatch.matchedRequirements,
    truthfulness: truthfulnessGuardAgent(effectiveMatchMap),
  };
}

export function runTailoredCvAgents({
  cvText = '',
  jobDescription = '',
  jobTitle = '',
  company = '',
  confirmedSkills = [],
  cvData = null,
  jdData = null,
  cvParser = new CVParser(),
  jdParser = new JDParser(),
  tailor = new CVTailor(),
} = {}) {
  const parsedCv = cvParsingAgent(cvText, cvData, cvParser);
  const parsedJd = jdAnalysisAgent(jobDescription, jobTitle, company, jdData, jdParser);
  const matchMap = tailor.buildMatchMap(parsedCv, parsedJd, confirmedSkills);

  return rebuildTailoredCvAgentContext({
    workflow: 'tailoredCv',
    agentChain: TAILORED_CV_AGENTS,
    cvData: parsedCv,
    jdData: parsedJd,
    candidateEvidenceMap: candidateEvidenceMapAgent(parsedCv),
    roleRequirementMap: roleRequirementMapAgent(parsedJd),
  }, matchMap, tailor);
}
