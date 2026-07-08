// Hand-labeled fixture for scripts/eval-evidence-retrieval.js. Models one CV's
// evidence pool against a set of JD requirements, several of which are
// deliberately worded as paraphrases with zero literal word overlap with the
// evidence - the exact case deterministic keyword matching misses and
// semantic embeddings are meant to catch.

export const EVAL_EVIDENCE_ITEMS = [
  { type: 'experience', label: 'Growth analytics', text: 'Built dashboards and reporting pipelines using SQL and Python for the growth team.' },
  { type: 'experience', label: 'Experimentation', text: 'Ran controlled experiments and conversion-rate optimization across checkout and signup flows.' },
  { type: 'experience', label: 'Cross-functional coordination', text: 'Coordinated priorities and communication across sales, support, and senior leadership.' },
  { type: 'experience', label: 'Product discovery', text: 'Conducted usability interviews and synthesized findings into the quarterly product roadmap.' },
  { type: 'experience', label: 'People management', text: 'Managed a squad of five engineers and mentored two into senior roles.' },
  { type: 'experience', label: 'Onboarding redesign', text: 'Led a cross-functional onboarding redesign that improved activation by 23%.' },
  { type: 'experience', label: 'Vendor management', text: 'Negotiated renewal terms directly with three SaaS vendors, cutting annual spend by 15%.' },
  { type: 'experience', label: 'Technical documentation', text: 'Wrote the technical design doc for the event-driven order pipeline and drove its adoption across three teams.' },
  { type: 'experience', label: 'On-call ownership', text: "Ran the biweekly on-call rotation and authored the incident postmortem template used company-wide." },
];

export const EVAL_REQUIREMENTS = [
  { requirement: 'SQL', type: 'required', priority: 3, expectedPromotable: true, note: 'Literal overlap with evidence #1 - baseline should catch this too.' },
  { requirement: 'A/B testing', type: 'required', priority: 3, expectedPromotable: true, note: 'Paraphrase of evidence #2 - zero literal word overlap.' },
  { requirement: 'Stakeholder management', type: 'required', priority: 2, expectedPromotable: true, note: 'Paraphrase of evidence #3 - zero literal word overlap.' },
  { requirement: 'User research', type: 'required', priority: 2, expectedPromotable: true, note: 'Paraphrase of evidence #4 - zero literal word overlap.' },
  { requirement: 'Team leadership', type: 'required', priority: 2, expectedPromotable: true, note: 'Paraphrase of evidence #5 - zero literal word overlap.' },
  { requirement: 'Kubernetes', type: 'tool', priority: 1, expectedPromotable: false, note: 'No supporting evidence anywhere in the CV.' },
  { requirement: 'GraphQL', type: 'tool', priority: 1, expectedPromotable: false, note: 'No supporting evidence anywhere in the CV.' },
  { requirement: 'Public speaking', type: 'required', priority: 1, expectedPromotable: false, note: 'No supporting evidence anywhere in the CV.' },
  { requirement: 'Vendor negotiation', type: 'required', priority: 2, expectedPromotable: true, note: 'Paraphrase of evidence #7 - zero literal word overlap.' },
  { requirement: 'Technical writing', type: 'required', priority: 2, expectedPromotable: true, note: 'Paraphrase of evidence #8 - partial literal overlap ("technical") but not exact.' },
  { requirement: 'Incident management', type: 'required', priority: 2, expectedPromotable: true, note: 'Paraphrase of evidence #9 - zero literal word overlap.' },
  { requirement: 'Salesforce administration', type: 'tool', priority: 1, expectedPromotable: false, note: 'No supporting evidence anywhere in the CV.' },
  { requirement: 'Machine learning model deployment', type: 'tool', priority: 1, expectedPromotable: false, note: 'No supporting evidence anywhere in the CV.' },
];
