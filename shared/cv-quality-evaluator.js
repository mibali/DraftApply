import { CVParser } from './cv-parser.js';
import { CVTailor } from './cv-tailor.js';
import { isTextSupported } from './grounding-harness.js';

const FORMAT_LEAK_MARKERS = [
  '```',
  '[object Object]',
  'undefined',
  'SUPPORTED REQUIREMENTS',
  'AUDIT INSTRUCTION',
];

const FORBIDDEN_SENTINELS = [
  'SENTINEL_UNSUPPORTED_SUMMARY',
  'SENTINEL_UNSUPPORTED_LABEL',
  'SENTINEL_UNSUPPORTED_SKILL',
  'SENTINEL_UNSUPPORTED_FOCUS',
  'SENTINEL_UNSUPPORTED_BULLET',
  'SENTINEL_UNKNOWN_ROLE',
  'SENTINEL_MODEL_PROJECT',
];

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

function includesNormalised(haystack, needle) {
  return normalise(haystack).includes(normalise(needle));
}

function ratio(passed, total) {
  return total ? passed / total : 1;
}

function buildAdversarialModelResponse(cvData, skeleton) {
  const skillRecords = (cvData.evidenceIndex || []).filter(record => record.type === 'skill').slice(0, 12);
  const competencies = skillRecords.length ? [{
    label: 'Relevant Skills',
    items: [
      ...skillRecords.map(record => ({ text: record.text, sourceIds: [record.sourceId] })),
      { text: 'SENTINEL_UNSUPPORTED_SKILL', sourceIds: skillRecords[0] ? [skillRecords[0].sourceId] : [] },
    ],
  }] : [];
  if (competencies[0]) competencies[0].label = 'SENTINEL_UNSUPPORTED_LABEL';
  const roles = skeleton.roles.map(role => ({
    id: role.id,
    focus: role.originalBullets[0] ? {
      text: 'SENTINEL_UNSUPPORTED_FOCUS',
      sourceIds: role.originalBulletEvidence[0]?.sourceIds || [],
    } : null,
    bullets: [
      ...role.originalBullets.map((text, index) => ({
        text,
        sourceIds: role.originalBulletEvidence[index]?.sourceIds || [],
      })),
      { text: 'SENTINEL_UNSUPPORTED_BULLET', sourceIds: role.allowedSourceIds.slice(0, 1) },
    ],
  }));
  roles.reverse();
  roles.push({ id: 'role_99', focus: null, bullets: [{ text: 'SENTINEL_UNKNOWN_ROLE', sourceIds: [] }] });

  return `Here is the tailored CV:\n\`\`\`json\n${JSON.stringify({
    summary: cvData.summary ? { text: `${cvData.summary} SENTINEL_UNSUPPORTED_SUMMARY`, sourceIds: ['summary:0'] } : null,
    competencies,
    roles,
    projects: [{ id: 'project_99', name: 'SENTINEL_MODEL_PROJECT', bullets: ['SENTINEL_MODEL_PROJECT'] }],
  })}\n\`\`\``;
}

export function scoreForbiddenSentinels(rendered, sentinels = FORBIDDEN_SENTINELS) {
  const surviving = sentinels.filter(sentinel => String(rendered || '').includes(sentinel));
  return { injected: sentinels.length, surviving, rate: ratio(surviving.length, sentinels.length) };
}

function scoreExpectedParse(cvData, expected) {
  const checks = [];
  checks.push({ label: `name: ${expected.name}`, pass: normalise(cvData.contactInfo?.name) === normalise(expected.name) });
  for (const [company, title, dates] of expected.roles || []) {
    const role = (cvData.experience || []).find(item => normalise(item.company) === normalise(company));
    checks.push({ label: `role company: ${company}`, pass: Boolean(role) });
    checks.push({ label: `role title: ${title}`, pass: normalise(role?.title) === normalise(title) });
    checks.push({ label: `role dates: ${dates}`, pass: normalise(role?.dates) === normalise(dates) });
  }
  checks.push({ label: 'exact role count', pass: (cvData.experience || []).length === (expected.roles || []).length });
  for (const skill of expected.skills || []) {
    checks.push({ label: `skill: ${skill}`, pass: (cvData.skills || []).some(item => normalise(item) === normalise(skill)) });
  }
  for (const project of expected.projects || []) {
    const parsed = (cvData.projects || []).find(item => normalise(item.name) === normalise(project.name));
    checks.push({ label: `project: ${project.name}`, pass: Boolean(parsed) });
    checks.push({ label: `project URL: ${project.url}`, pass: normalise(parsed?.url) === normalise(project.url) });
  }
  checks.push({ label: 'exact project count', pass: (cvData.projects || []).length === (expected.projects || []).length });
  return { score: ratio(checks.filter(check => check.pass).length, checks.length), checks };
}

function scoreGrounding(content, cvData) {
  const checks = [];
  if (content.summary) {
    checks.push({
      label: 'summary evidence',
      pass: content.summaryEvidence.length > 0 && isTextSupported(content.summary, {
        records: content.summaryEvidence.map(id => cvData.sourceIndex?.[id]).filter(Boolean),
        sourceIndex: cvData.sourceIndex || {},
      }, { sourceIds: content.summaryEvidence, requireSourceIds: true }).supported,
    });
  }
  for (const category of content.competencyEvidence || []) {
    for (const item of category.items || []) {
      checks.push({
        label: `competency evidence: ${item.text}`,
        pass: item.sourceIds.length > 0 && isTextSupported(item.text, {
          records: item.sourceIds.map(id => cvData.sourceIndex?.[id]).filter(Boolean),
          sourceIndex: cvData.sourceIndex || {},
        }, { sourceIds: item.sourceIds, requireSourceIds: true }).supported,
      });
    }
  }
  for (const role of content.roles || []) {
    if (role.focus) {
      checks.push({
        label: `${role.id} focus evidence`,
        pass: role.focusEvidence.length > 0 && isTextSupported(role.focus, {
          records: role.focusEvidence.map(id => cvData.sourceIndex?.[id]).filter(Boolean),
          sourceIndex: cvData.sourceIndex || {},
        }, { sourceIds: role.focusEvidence, requireSourceIds: true }).supported,
      });
    }
    for (const item of role.bulletEvidence || []) {
      checks.push({
        label: `${role.id} bullet evidence`,
        pass: item.sourceIds.length > 0 && isTextSupported(item.text, {
          records: (item.sourceIds || []).map(id => cvData.sourceIndex?.[id]).filter(Boolean),
          sourceIndex: cvData.sourceIndex || {},
        }, { sourceIds: item.sourceIds, requireSourceIds: true }).supported,
      });
    }
  }
  return { score: ratio(checks.filter(check => check.pass).length, checks.length), checks };
}

export function evaluateCvQualityCase(fixture, { tailor = new CVTailor() } = {}) {
  const cvData = new CVParser().parse(fixture.cvText);
  const matchMap = tailor.buildMatchMap(cvData, fixture.jdData);
  const skeleton = tailor.buildCvSkeleton(cvData, fixture.jdData);
  const rawModelResponse = buildAdversarialModelResponse(cvData, skeleton);
  const parsedModelContent = tailor.parseStructuredContent(rawModelResponse);
  const content = tailor.validateStructuredContent(parsedModelContent, skeleton, { matchMap, cvData });
  const rendered = content ? tailor.renderTailoredCV(skeleton, content) : '';

  const parsing = scoreExpectedParse(cvData, fixture.expected);
  const retentionChecks = (fixture.expected.retained || []).map(value => ({
    label: `retained: ${value}`,
    pass: includesNormalised(rendered, value),
  }));
  for (const [company, title, dates] of fixture.expected.roles || []) {
    for (const value of [company, title, dates]) retentionChecks.push({
      label: `rendered locked role field: ${value}`,
      pass: includesNormalised(rendered, value),
    });
  }
  for (const project of fixture.expected.projects || []) {
    for (const value of [project.name, project.url]) retentionChecks.push({
      label: `rendered locked project field: ${value}`,
      pass: includesNormalised(rendered, value),
    });
  }
  const atsChecks = (fixture.expected.supportedKeywords || []).map(value => ({
    label: `supported keyword: ${value}`,
    pass: includesNormalised(cvData.rawText, value) && includesNormalised(rendered, value),
  }));
  const rolePositions = (fixture.expected.roles || []).map(([company]) => rendered.indexOf(company));
  const formattingChecks = [
    { label: 'candidate name is first line', pass: rendered.split('\n')[0] === fixture.expected.name },
    { label: 'target headline is second line', pass: rendered.split('\n')[1] === fixture.jdData.jobTitle },
    { label: 'professional experience section exists', pass: skeleton.roles.length === 0 || /^PROFESSIONAL EXPERIENCE$/m.test(rendered) },
    { label: 'projects section matches source shape', pass: skeleton.projects.length === 0 || /^PROJECTS$/m.test(rendered) },
    { label: 'roles retain source order', pass: rolePositions.every((position, index) => position >= 0 && (index === 0 || position > rolePositions[index - 1])) },
    { label: 'no control or serialization leakage', pass: FORMAT_LEAK_MARKERS.every(marker => !rendered.includes(marker)) },
    { label: 'no empty bullet lines', pass: !/^•\s*$/m.test(rendered) },
  ];
  const grounding = content ? scoreGrounding(content, cvData) : { score: 0, checks: [{ label: 'validated content exists', pass: false }] };
  const forbidden = scoreForbiddenSentinels(rendered);
  const unsupportedClaims = forbidden.surviving.length;

  const metrics = {
    parseAccuracy: parsing.score,
    contentRetention: ratio(retentionChecks.filter(check => check.pass).length, retentionChecks.length),
    supportedAtsCoverage: ratio(atsChecks.filter(check => check.pass).length, atsChecks.length),
    formattingIntegrity: ratio(formattingChecks.filter(check => check.pass).length, formattingChecks.length),
    groundingIntegrity: grounding.score,
    unsupportedClaimRate: forbidden.rate,
  };
  return {
    id: fixture.id,
    layout: fixture.layout,
    metrics,
    pass: Object.entries(metrics).every(([name, value]) => name === 'unsupportedClaimRate' ? value === 0 : value === 1),
    failures: [...parsing.checks, ...retentionChecks, ...atsChecks, ...formattingChecks, ...grounding.checks]
      .filter(check => !check.pass).map(check => check.label),
    counts: {
      parsedRoles: cvData.experience.length,
      parsedProjects: cvData.projects.length,
      parsedSkills: cvData.skills.length,
      acceptedBullets: (content?.roles || []).reduce((sum, role) => sum + role.bullets.length, 0),
      validatedClaims: grounding.checks.length,
      unsupportedClaims,
      injectedUnsupportedClaims: forbidden.injected,
    },
  };
}

export function evaluateCvQualityCorpus(fixtures) {
  const cases = fixtures.map(fixture => evaluateCvQualityCase(fixture));
  const metricNames = Object.keys(cases[0]?.metrics || {});
  const aggregate = Object.fromEntries(metricNames.map(name => [
    name,
    cases.reduce((sum, item) => sum + item.metrics[name], 0) / (cases.length || 1),
  ]));
  return { pass: cases.every(item => item.pass), aggregate, cases };
}

export default { evaluateCvQualityCase, evaluateCvQualityCorpus };
