/**
 * Standardised role intelligence layer.
 *
 * Seeded from the structure used by official occupation taxonomies such as
 * O*NET/ESCO: aliases, core tasks, skill groupings, credibility signals, and
 * unsupported-claim risks. Keep this file deterministic and dependency-free so
 * the extension/proxy can use the same career-positioning logic everywhere.
 */

export const ROLE_PROFILES = [
  {
    id: 'solution_architect',
    family: 'Solution Architecture',
    domain: 'solution_engineering',
    aliases: ['solution architect', 'solutions architect', 'cloud solution architect', 'technical architect', 'enterprise architect', 'salesforce architect'],
    titlePatterns: [/\bsolutions?\s+architect\b/i, /\bcloud\s+solution\s+architect\b/i, /\btechnical\s+architect\b/i, /\benterprise\s+architect\b/i],
    credibilitySignals: ['solution design', 'requirements analysis', 'stakeholder alignment', 'architecture decisions', 'integration planning', 'technical discovery', 'implementation roadmap'],
    evidencePatterns: [/\barchitect(?:ed|ure|ural)?\b/i, /\bsolution design\b/i, /\brequirements?\b/i, /\bstakeholder\b/i, /\bcustomer[- ]facing\b/i, /\bintegration\b/i, /\bimplementation\b/i, /\broadmap\b/i, /\bpoc|pov|proof of concept|proof of value\b/i],
    riskClaims: ['MEDDPICC', 'RFP/RFI ownership', 'sales quota', 'revenue ownership', 'executive buyer management', 'POC/POV ownership'],
    transferableEvidence: ['production support -> customer-facing technical problem solving', 'DevOps delivery -> cloud architecture implementation evidence', 'incident response -> reliability advisory'],
    skillCategories: [
      { label: 'Solution Architecture', skills: ['Solution Design', 'Architecture Decisions', 'Integration Planning', 'Technical Discovery'] },
      { label: 'Cloud & Platform Delivery', skills: ['AWS', 'Azure', 'GCP', 'Kubernetes', 'Docker', 'Terraform'] },
      { label: 'Customer & Stakeholder Engagement', skills: ['Requirements Analysis', 'Stakeholder Alignment', 'Executive Communication', 'Customer-Facing Delivery'] },
      { label: 'Technical Validation', skills: ['POC/POV Support', 'Technical Demos', 'Implementation Planning', 'API Integration'] },
      { label: 'Programming & Automation', skills: ['Python', 'Go', 'Bash', 'REST APIs', 'Scripting'] },
    ],
    positioning: 'Position the CV around supported architecture/design authority, requirements-to-solution translation, stakeholder alignment, and implementation planning. Use pre-sales or sales-methodology language only when the CV or user confirmation supports it.',
  },
  {
    id: 'product_manager',
    family: 'Product Management',
    domain: 'product_management',
    aliases: ['product manager', 'senior product manager', 'product owner', 'technical product manager', 'group product manager'],
    titlePatterns: [/\bproduct\s+(manager|owner|lead)\b/i, /\btechnical\s+product\s+manager\b/i],
    credibilitySignals: ['roadmap ownership', 'user/customer discovery', 'prioritisation', 'product metrics', 'cross-functional delivery', 'go-to-market alignment'],
    evidencePatterns: [/\broadmap\b/i, /\bprioriti[sz]/i, /\buser research\b/i, /\bcustomer discovery\b/i, /\bmetrics?\b/i, /\blaunch(?:ed)?\b/i, /\bgo[- ]to[- ]market\b/i, /\bcross[- ]functional\b/i],
    riskClaims: ['P&L ownership', 'pricing strategy', 'revenue ownership', 'direct people management', 'market research ownership'],
    transferableEvidence: ['engineering delivery -> technical product execution', 'support escalations -> customer pain-point discovery', 'analytics/reporting -> product metrics evidence'],
    skillCategories: [
      { label: 'Product Strategy', skills: ['Roadmapping', 'Prioritisation', 'Product Discovery', 'Market Analysis'] },
      { label: 'Delivery & Execution', skills: ['Agile Delivery', 'Backlog Management', 'Launch Planning', 'Cross-functional Delivery'] },
      { label: 'Customer & User Insight', skills: ['Customer Discovery', 'User Research', 'Feedback Synthesis', 'Stakeholder Interviews'] },
      { label: 'Metrics & Analytics', skills: ['Product Metrics', 'Experimentation', 'Reporting', 'Data Analysis'] },
      { label: 'Technical Collaboration', skills: ['Technical Requirements', 'API Concepts', 'Engineering Collaboration', 'Systems Thinking'] },
    ],
    positioning: 'Position the CV around product judgment, discovery, prioritisation, measurable outcomes, and cross-functional execution. Do not claim roadmap, revenue, or launch ownership unless the CV proves it.',
  },
  {
    id: 'engineering_manager',
    family: 'Engineering Management',
    domain: 'software_engineering',
    aliases: ['engineering manager', 'software engineering manager', 'development manager', 'head of engineering', 'technical lead manager'],
    titlePatterns: [/\bengineering\s+manager\b/i, /\bsoftware\s+engineering\s+manager\b/i, /\bhead\s+of\s+engineering\b/i, /\btechnical\s+lead\s+manager\b/i],
    credibilitySignals: ['people leadership', 'delivery ownership', 'mentoring', 'hiring', 'performance management', 'technical direction'],
    evidencePatterns: [/\bmanaged\b/i, /\bmentored\b/i, /\bhiring\b/i, /\bperformance\b/i, /\bteam\b/i, /\bdelivery\b/i, /\broadmap\b/i, /\btechnical leadership\b/i],
    riskClaims: ['line management', 'hiring ownership', 'budget ownership', 'performance reviews', 'org strategy'],
    transferableEvidence: ['technical lead work -> engineering leadership', 'incident leadership -> delivery accountability', 'mentoring/support docs -> team enablement'],
    skillCategories: [
      { label: 'People Leadership', skills: ['Mentoring', 'Coaching', 'Hiring', 'Performance Management'] },
      { label: 'Delivery Leadership', skills: ['Roadmap Delivery', 'Planning', 'Risk Management', 'Execution'] },
      { label: 'Technical Direction', skills: ['Architecture Review', 'Code Quality', 'Reliability', 'Engineering Standards'] },
      { label: 'Cross-functional Management', skills: ['Stakeholder Management', 'Communication', 'Prioritisation', 'Conflict Resolution'] },
      { label: 'Operational Excellence', skills: ['Incident Response', 'Process Improvement', 'Metrics', 'Documentation'] },
    ],
    positioning: 'Position the CV around leadership, delivery accountability, mentoring, technical direction, and team outcomes. Avoid people-management claims unless the original CV shows direct management or user-confirmed leadership.',
  },
  {
    id: 'software_engineer',
    family: 'Software Engineering',
    domain: 'software_engineering',
    aliases: ['software engineer', 'frontend engineer', 'backend engineer', 'full stack engineer', 'web developer', 'application developer'],
    titlePatterns: [/\bsoftware\s+engineer\b/i, /\bfrontend\b/i, /\bfront[- ]end\b/i, /\bbackend\b/i, /\bback[- ]end\b/i, /\bfull[- ]stack\b/i, /\bweb\s+developer\b/i],
    credibilitySignals: ['feature delivery', 'code quality', 'system design', 'testing', 'performance', 'collaboration'],
    evidencePatterns: [/\bbuilt\b/i, /\bdeveloped\b/i, /\bimplemented\b/i, /\bapi\b/i, /\btested\b/i, /\bperformance\b/i, /\bscalab/i, /\bcode\b/i],
    riskClaims: ['architecture ownership', 'team leadership', 'production scale', 'security ownership'],
    transferableEvidence: ['support automation -> software delivery', 'DevOps scripting -> backend/tooling engineering', 'dashboards -> frontend/product engineering'],
    skillCategories: [
      { label: 'Software Delivery', skills: ['Feature Development', 'Code Review', 'Testing', 'Debugging'] },
      { label: 'Frontend Engineering', skills: ['React', 'TypeScript', 'JavaScript', 'Accessibility'] },
      { label: 'Backend Engineering', skills: ['APIs', 'Node.js', 'Python', 'Databases'] },
      { label: 'Cloud & DevOps', skills: ['AWS', 'Docker', 'CI/CD', 'Kubernetes'] },
      { label: 'Engineering Quality', skills: ['Performance', 'Reliability', 'Documentation', 'Collaboration'] },
    ],
    positioning: 'Position the CV around shipped software, technical quality, maintainability, collaboration, and product/business impact. Keep senior claims grounded in actual ownership, scale, and outcomes.',
  },
  {
    id: 'software_qa',
    family: 'Software Quality Assurance / Testing',
    domain: 'software_quality',
    aliases: [
      'quality assurance analyst',
      'qa analyst',
      'quality assurance engineer',
      'qa engineer',
      'quality engineer',
      'software quality assurance analyst',
      'sqa analyst',
      'software quality assurance engineer',
      'sqa engineer',
      'software test engineer',
      'test engineer',
      'automation tester',
      'software tester',
      'automation test engineer',
    ],
    titlePatterns: [
      /\bqa\b/i,
      /\bquality\s+assurance\b/i,
      /\bsoftware\s+test(er|ing)?\b/i,
      /\btest\s+engineer\b/i,
      /\bautomation\s+test(er|ing)?\b/i,
      /\bsqa\b/i,
      /\bsdet\b/i,
    ],
    credibilitySignals: ['test planning', 'defect reporting', 'test automation', 'quality standards', 'release confidence', 'collaboration with developers'],
    evidencePatterns: [/\btest cases?\b/i, /\btest plan\b/i, /\bbug\b/i, /\bdefect\b/i, /\bregression\b/i, /\bautomati(?:on|ng)\b/i, /\bselenium|cypress|playwright\b/i, /\bjira\b/i],
    riskClaims: ['quality ownership for entire org', 'zero defects guarantee', 'release gate ownership', 'performance testing ownership', 'security testing ownership'],
    transferableEvidence: ['software engineering -> test automation and quality discipline', 'support escalations -> reproduction and defect triage evidence', 'operations scripting -> automated checks and tooling'],
    skillCategories: [
      { label: 'Test Design', skills: ['Test Planning', 'Test Cases', 'Regression Testing', 'Exploratory Testing'] },
      { label: 'Automation', skills: ['Test Automation', 'CI Integration', 'Selenium', 'Cypress', 'Playwright'] },
      { label: 'Defect Management', skills: ['Bug Reporting', 'Triage', 'Reproduction Steps', 'Root Cause Collaboration'] },
      { label: 'Quality Practices', skills: ['Quality Standards', 'Release Readiness', 'Documentation', 'Risk-based Testing'] },
      { label: 'Tooling & Collaboration', skills: ['Jira', 'Git', 'Code Review Participation', 'Developer Collaboration'] },
    ],
    sources: [
      {
        taxonomy: 'O*NET',
        code: '15-1253.00',
        title: 'Software Quality Assurance Analysts and Testers',
        url: 'https://www.onetonline.org/link/summary/15-1253.00',
      },
      {
        taxonomy: 'ESCO',
        title: 'ESCO web-service API (reference only)',
        url: 'https://esco.ec.europa.eu/en/use-esco/use-esco-services-api/esco-web-service-api',
      },
    ],
    positioning: 'Position the CV around deliberate testing practices, defect discovery and reporting, automation that improves delivery confidence, and quality collaboration with engineers. Avoid absolute/guarantee claims or implying final release authority unless proven.',
  },
  {
    id: 'devops_sre',
    family: 'DevOps / SRE / Platform',
    domain: 'devops',
    aliases: ['devops engineer', 'site reliability engineer', 'sre', 'platform engineer', 'cloud engineer', 'infrastructure engineer'],
    titlePatterns: [/\bdevops\b/i, /\bsre\b/i, /\bsite\s+reliability\b/i, /\bplatform\s+engineer\b/i, /\bcloud\s+engineer\b/i, /\binfrastructure\s+engineer\b/i],
    credibilitySignals: ['reliability', 'incident response', 'automation', 'infrastructure as code', 'deployment pipelines', 'observability'],
    evidencePatterns: [/\bincident\b/i, /\breliability\b/i, /\bautomation\b/i, /\bci.?cd\b/i, /\bterraform\b/i, /\bkubernetes\b/i, /\bmonitoring\b/i, /\brca\b/i],
    riskClaims: ['SLO ownership', 'on-call ownership', 'cost optimisation', 'security ownership', 'multi-region architecture'],
    transferableEvidence: ['support escalation -> incident response', 'automation scripts -> platform tooling', 'cloud support -> infrastructure operations'],
    skillCategories: [
      { label: 'Cloud & Infrastructure', skills: ['AWS', 'Azure', 'GCP', 'Terraform', 'Infrastructure as Code'] },
      { label: 'Containers & Orchestration', skills: ['Docker', 'Kubernetes', 'Helm', 'Container Platforms'] },
      { label: 'CI/CD & Release', skills: ['GitHub Actions', 'GitLab CI', 'Jenkins', 'Azure DevOps', 'Deployment Automation'] },
      { label: 'Reliability & Observability', skills: ['Incident Response', 'RCA', 'Monitoring', 'Logging', 'Runbooks'] },
      { label: 'Automation & Scripting', skills: ['Python', 'Bash', 'Go', 'Scripting', 'Tooling'] },
    ],
    positioning: 'Position the CV around production reliability, automation, cloud infrastructure, deployment efficiency, and operational maturity. Do not invent scale, SLOs, or cost savings without source evidence.',
  },
  {
    id: 'security_analyst',
    family: 'Information Security',
    domain: 'cybersecurity',
    aliases: [
      'information security analyst',
      'security analyst',
      'network security analyst',
      'information security specialist',
      'information security officer',
      'information systems security analyst',
      'information systems security officer',
      'information technology security analyst',
      'it security analyst',
      'isso',
    ],
    titlePatterns: [
      /\binformation\s+security\b/i,
      /\bsecurity\s+analyst\b/i,
      /\bnetwork\s+security\b/i,
      /\bit\s+security\b/i,
      /\bcyber\s*security\b/i,
      /\bisso\b/i,
    ],
    credibilitySignals: ['security monitoring', 'incident response', 'risk assessment', 'vulnerability management', 'security controls', 'policy/procedure'],
    evidencePatterns: [/\bsiem\b/i, /\bincident\b/i, /\bvulnerab/i, /\bthreat\b/i, /\bsecurity\s+monitor/i, /\brisk\b/i, /\bcontrols?\b/i, /\bpolicy\b/i, /\biam\b|\bidentity\b/i],
    riskClaims: ['CISSP', 'ISO 27001 ownership', 'SOC 2 ownership', 'regulatory sign-off', 'penetration testing ownership', 'red team leadership'],
    transferableEvidence: ['DevOps reliability -> incident response evidence', 'compliance work -> controls/policy evidence', 'network administration -> security monitoring and access control'],
    skillCategories: [
      { label: 'Monitoring & Response', skills: ['SIEM', 'Incident Response', 'Alert Triage', 'RCA'] },
      { label: 'Risk & Controls', skills: ['Risk Assessment', 'Security Controls', 'Policy', 'Audit Support'] },
      { label: 'Vulnerability Management', skills: ['Vulnerability Scanning', 'Remediation Tracking', 'Patch Coordination', 'Security Testing Basics'] },
      { label: 'Identity & Access', skills: ['IAM', 'Access Control', 'Least Privilege', 'MFA'] },
      { label: 'Security Tooling', skills: ['EDR', 'Log Analysis', 'Ticketing', 'Documentation'] },
    ],
    sources: [
      {
        taxonomy: 'O*NET',
        code: '15-1212.00',
        title: 'Information Security Analysts',
        url: 'https://www.onetonline.org/link/summary/15-1212.00',
      },
      {
        taxonomy: 'ESCO',
        title: 'ESCO web-service API (reference only)',
        url: 'https://esco.ec.europa.eu/en/use-esco/use-esco-services-api/esco-web-service-api',
      },
    ],
    positioning: 'Position the CV around security monitoring, incident response, vulnerability remediation, risk/control discipline, and evidence-backed policy work. Avoid certification, sign-off, or offensive-security ownership claims unless proven.',
  },
  {
    id: 'systems_administrator',
    family: 'IT Operations / Systems Administration',
    domain: 'it_operations',
    aliases: [
      'systems administrator',
      'system administrator',
      'network administrator',
      'network manager',
      'network coordinator',
      'lan administrator',
      'local area network administrator',
      'lan specialist',
      'information technology specialist',
      'it specialist',
    ],
    titlePatterns: [
      /\bsystems?\s+administrator\b/i,
      /\bnetwork\s+administrator\b/i,
      /\blan\s+(specialist|administrator)\b/i,
      /\binformation\s+technology\s+specialist\b/i,
      /\bit\s+specialist\b/i,
    ],
    credibilitySignals: ['system monitoring', 'availability', 'backups', 'patching', 'access control', 'troubleshooting'],
    evidencePatterns: [/\bactive\s+directory\b/i, /\bwindows\s+server\b/i, /\blinux\b/i, /\bbackup\b/i, /\bdisaster recovery\b/i, /\bvmware\b/i, /\bpatch/i, /\bmonitor/i, /\bserver\b/i, /\bnetwork\b/i],
    riskClaims: ['24/7 on-call ownership', 'network architecture ownership', 'budget ownership', 'security sign-off', 'domain admin privileges'],
    transferableEvidence: ['DevOps tooling -> automation for operations', 'support escalation -> troubleshooting and incident coordination', 'documentation -> runbooks and standard operating procedures'],
    skillCategories: [
      { label: 'Systems & Servers', skills: ['Windows Server', 'Linux', 'Virtualisation', 'Server Administration'] },
      { label: 'Network Operations', skills: ['LAN/WAN Basics', 'DNS/DHCP Basics', 'Network Troubleshooting', 'VPN Basics'] },
      { label: 'Operations & Reliability', skills: ['Monitoring', 'Backups', 'Disaster Recovery Basics', 'Patch Management'] },
      { label: 'Access & Identity', skills: ['Active Directory', 'User Access', 'Permissions', 'Provisioning'] },
      { label: 'Automation & Documentation', skills: ['Scripting', 'Runbooks', 'Ticketing', 'Documentation'] },
    ],
    sources: [
      {
        taxonomy: 'O*NET',
        code: '15-1244.00',
        title: 'Network and Computer Systems Administrators',
        url: 'https://www.onetonline.org/link/summary/15-1244.00',
      },
      {
        taxonomy: 'ESCO',
        title: 'ESCO occupations pillar overview (reference only)',
        url: 'https://esco.ec.europa.eu/en/classification/occupation-main',
      },
    ],
    positioning: 'Position the CV around reliable system/network operations, monitoring, backups, access control, patching discipline, and pragmatic troubleshooting. Avoid architecture ownership, privileged access, or security sign-off claims unless proven.',
  },
  {
    id: 'data_analytics',
    family: 'Data / Analytics',
    domain: 'data_science',
    aliases: [
      'data analyst',
      'business analyst',
      'business intelligence analyst',
      'business intelligence consultant',
      'bi analyst',
      'bi consultant',
      'analytics engineer',
      'data scientist',
      'reporting analyst',
    ],
    titlePatterns: [
      /\bdata\s+analyst\b/i,
      /\bbusiness\s+analyst\b/i,
      /\bbusiness\s+intelligence\b/i,
      /\bbi\s+analyst\b/i,
      /\bbi\s+consultant\b/i,
      /\banalytics?\s+engineer\b/i,
      /\bdata\s+scientist\b/i,
    ],
    credibilitySignals: ['analysis', 'insight generation', 'reporting', 'stakeholder requirements', 'data quality', 'decision support'],
    evidencePatterns: [/\banalys/i, /\breport/i, /\bdashboard\b/i, /\bmetric/i, /\bforecast/i, /\binsight/i, /\bsql\b/i, /\bdata\b/i],
    riskClaims: ['statistical modelling', 'machine learning', 'executive reporting ownership', 'forecast ownership'],
    transferableEvidence: ['SQL/reporting work -> analytics evidence', 'support diagnostics -> data-led problem solving', 'automation -> repeatable reporting'],
    skillCategories: [
      { label: 'Data Analysis', skills: ['SQL', 'Data Cleaning', 'Exploratory Analysis', 'Insight Generation'] },
      { label: 'Reporting & BI', skills: ['Dashboards', 'Power BI', 'Tableau', 'Looker', 'Excel'] },
      { label: 'Stakeholder Requirements', skills: ['Requirements Gathering', 'Communication', 'Business Analysis', 'Documentation'] },
      { label: 'Data Engineering Basics', skills: ['ETL', 'Pipelines', 'Data Quality', 'Automation'] },
      { label: 'Decision Support', skills: ['Metrics', 'Forecasting', 'Trend Analysis', 'Recommendations'] },
    ],
    sources: [
      {
        taxonomy: 'O*NET',
        code: '15-2051.01',
        title: 'Business Intelligence Analysts',
        url: 'https://www.onetonline.org/link/summary/15-2051.01',
      },
      {
        taxonomy: 'O*NET',
        code: '15-2051.00',
        title: 'Data Scientists',
        url: 'https://www.onetonline.org/link/summary/15-2051.00',
      },
      {
        taxonomy: 'ESCO',
        title: 'ESCO occupations pillar overview (reference only)',
        url: 'https://esco.ec.europa.eu/en/classification/occupation-main',
      },
    ],
    positioning: 'Position the CV around analytical judgement, decision support, data quality, stakeholder requirements, and reporting outcomes. Avoid advanced modelling claims unless the CV proves them.',
  },
  {
    id: 'data_engineer',
    family: 'Data Engineering',
    domain: 'data_engineering',
    aliases: [
      'data engineer',
      'database architect',
      'data architect',
      'database developer',
      'database programmer',
      'data warehouse architect',
      'data warehouse developer',
      'data warehousing specialist',
      'etl developer',
    ],
    titlePatterns: [
      /\bdata\s+engineer\b/i,
      /\bdatabase\s+architect\b/i,
      /\bdata\s+architect\b/i,
      /\bdata\s+warehouse\b/i,
      /\bdata\s+warehousing\b/i,
      /\betl\s+developer\b/i,
    ],
    credibilitySignals: ['data pipelines', 'ETL/ELT delivery', 'data modelling', 'data quality', 'warehouse performance', 'reliable datasets'],
    evidencePatterns: [/\betl|elt\b/i, /\bpipeline\b/i, /\bdata\s+model/i, /\bwarehouse\b/i, /\b(sql|postgres|mysql|snowflake|bigquery|redshift)\b/i, /\bairflow|prefect|dagster\b/i, /\bdbt\b/i],
    riskClaims: ['enterprise data strategy ownership', 'org-wide data governance ownership', 'security/compliance sign-off', '24/7 production on-call'],
    transferableEvidence: ['backend engineering -> data service reliability', 'analytics/reporting -> dataset quality improvement', 'platform engineering -> workflow orchestration and observability'],
    skillCategories: [
      { label: 'Pipelines & Orchestration', skills: ['ETL/ELT', 'Batch Pipelines', 'Streaming Basics', 'Workflow Orchestration'] },
      { label: 'Data Modelling & Warehousing', skills: ['Dimensional Modelling', 'Schema Design', 'Data Warehousing', 'Performance Tuning'] },
      { label: 'Quality & Reliability', skills: ['Data Quality Checks', 'Testing', 'Monitoring', 'Incident Response'] },
      { label: 'SQL & Storage', skills: ['SQL', 'PostgreSQL', 'Snowflake', 'BigQuery', 'Redshift'] },
      { label: 'Automation & Governance', skills: ['Automation', 'Documentation', 'Lineage Basics', 'Access Controls Basics'] },
    ],
    sources: [
      {
        taxonomy: 'O*NET',
        code: '15-1243.00',
        title: 'Database Architects',
        url: 'https://www.onetonline.org/link/summary/15-1243.00',
      },
      {
        taxonomy: 'O*NET',
        code: '15-1243.01',
        title: 'Data Warehousing Specialists',
        url: 'https://www.onetonline.org/link/summary/15-1243.01',
      },
      {
        taxonomy: 'ESCO',
        title: 'ESCO web-service API (reference only)',
        url: 'https://esco.ec.europa.eu/en/use-esco/use-esco-services-api/esco-web-service-api',
      },
    ],
    positioning: 'Position the CV around reliable data pipelines, data modelling, warehouse performance, data quality, and dependable datasets for stakeholders. Avoid data strategy/governance ownership claims unless explicitly proven.',
  },
  {
    id: 'customer_success',
    family: 'Customer Success / Support',
    domain: 'operations',
    aliases: ['customer success manager', 'customer success engineer', 'technical support engineer', 'support engineer', 'implementation consultant', 'technical account manager'],
    titlePatterns: [/\bcustomer\s+success\b/i, /\btechnical\s+support\b/i, /\bsupport\s+engineer\b/i, /\bimplementation\s+consultant\b/i, /\btechnical\s+account\s+manager\b/i],
    credibilitySignals: ['customer outcomes', 'adoption', 'technical escalation', 'renewal support', 'implementation', 'stakeholder communication'],
    evidencePatterns: [/\bcustomer\b/i, /\bsupport\b/i, /\bescalation\b/i, /\bimplementation\b/i, /\badoption\b/i, /\brenewal\b/i, /\bonboarding\b/i, /\bstakeholder\b/i],
    riskClaims: ['quota ownership', 'renewal ownership', 'commercial negotiation', 'expansion revenue', 'executive sponsor management'],
    transferableEvidence: ['technical support -> customer success problem solving', 'incident handling -> escalation management', 'documentation -> adoption enablement'],
    skillCategories: [
      { label: 'Customer Outcomes', skills: ['Adoption', 'Value Realisation', 'Customer Health', 'Success Planning'] },
      { label: 'Technical Escalation', skills: ['Troubleshooting', 'Incident Management', 'Root Cause Analysis', 'Platform Diagnostics'] },
      { label: 'Implementation & Onboarding', skills: ['Implementation Support', 'Onboarding', 'Integration Support', 'Documentation'] },
      { label: 'Stakeholder Communication', skills: ['Executive Communication', 'Cross-functional Collaboration', 'Expectation Management', 'Presentations'] },
      { label: 'Product & Process Feedback', skills: ['Voice of Customer', 'Support Insights', 'Process Improvement', 'Knowledge Base'] },
    ],
    positioning: 'Position the CV around customer outcomes, technical escalation, adoption, onboarding, and communication. Keep commercial claims separate unless the CV proves renewal, expansion, or quota ownership.',
  },
  {
    id: 'sales',
    family: 'Sales / Account Management',
    domain: 'sales',
    aliases: ['account executive', 'sales manager', 'business development manager', 'sales development representative', 'account manager'],
    titlePatterns: [/\baccount\s+executive\b/i, /\bsales\s+manager\b/i, /\bbusiness\s+development\b/i, /\bsdr\b/i, /\baccount\s+manager\b/i],
    credibilitySignals: ['pipeline generation', 'discovery', 'qualification', 'closing', 'account growth', 'forecasting'],
    evidencePatterns: [/\bpipeline\b/i, /\bquota\b/i, /\bclosed\b/i, /\bdeal\b/i, /\bdiscovery\b/i, /\bforecast\b/i, /\baccount\b/i, /\brevenue\b/i],
    riskClaims: ['quota attainment', 'revenue generated', 'enterprise closing', 'forecast ownership', 'team leadership'],
    transferableEvidence: ['customer support -> consultative discovery', 'technical demos -> sales support', 'stakeholder work -> account engagement'],
    skillCategories: [
      { label: 'Sales Execution', skills: ['Discovery', 'Qualification', 'Pipeline Management', 'Closing'] },
      { label: 'Account Management', skills: ['Account Planning', 'Stakeholder Mapping', 'Expansion', 'Customer Relationships'] },
      { label: 'Revenue Operations', skills: ['Forecasting', 'CRM Hygiene', 'Sales Reporting', 'Territory Planning'] },
      { label: 'Communication', skills: ['Negotiation', 'Presentations', 'Objection Handling', 'Executive Communication'] },
      { label: 'Market & Product Knowledge', skills: ['Value Proposition', 'Competitive Positioning', 'Product Demos', 'Business Cases'] },
    ],
    positioning: 'Position the CV around measurable commercial execution, customer discovery, account growth, and deal progression. Do not invent quotas, revenue, or close rates.',
  },
  {
    id: 'marketing',
    family: 'Marketing',
    domain: 'marketing',
    aliases: ['marketing manager', 'digital marketing manager', 'growth marketer', 'content marketer', 'brand manager', 'campaign manager'],
    titlePatterns: [/\bmarketing\b/i, /\bgrowth\s+marketer\b/i, /\bbrand\s+manager\b/i, /\bcampaign\s+manager\b/i, /\bcontent\s+marketer\b/i],
    credibilitySignals: ['campaigns', 'audience insight', 'channel strategy', 'content', 'conversion metrics', 'brand positioning'],
    evidencePatterns: [/\bcampaign\b/i, /\bcontent\b/i, /\bseo\b/i, /\bconversion\b/i, /\bleads?\b/i, /\bbrand\b/i, /\baudience\b/i, /\bchannel\b/i],
    riskClaims: ['budget ownership', 'paid media spend', 'conversion uplift', 'pipeline influence', 'brand strategy ownership'],
    transferableEvidence: ['documentation/content -> content marketing', 'analytics -> performance reporting', 'customer-facing work -> audience insight'],
    skillCategories: [
      { label: 'Campaign Management', skills: ['Campaign Planning', 'Execution', 'Channel Coordination', 'Content Calendar'] },
      { label: 'Digital Marketing', skills: ['SEO', 'Email Marketing', 'Paid Media', 'Social Media'] },
      { label: 'Content & Brand', skills: ['Copywriting', 'Brand Positioning', 'Messaging', 'Thought Leadership'] },
      { label: 'Analytics & Reporting', skills: ['Conversion Metrics', 'A/B Testing', 'Dashboards', 'Performance Reporting'] },
      { label: 'Stakeholder Collaboration', skills: ['Sales Alignment', 'Creative Briefs', 'Cross-functional Collaboration', 'Agency Management'] },
    ],
    positioning: 'Position the CV around campaign execution, audience understanding, channel performance, content quality, and measurable marketing outcomes. Avoid budget or pipeline claims without evidence.',
  },
  {
    id: 'finance',
    family: 'Finance / Accounting',
    domain: 'finance',
    aliases: ['finance analyst', 'financial analyst', 'accountant', 'management accountant', 'fp&a analyst', 'finance manager'],
    titlePatterns: [/\bfinanc(?:e|ial)\s+analyst\b/i, /\baccountant\b/i, /\bfp&a\b/i, /\bfinance\s+manager\b/i, /\bmanagement\s+accountant\b/i],
    credibilitySignals: ['financial analysis', 'forecasting', 'budgeting', 'controls', 'reporting', 'stakeholder decision support'],
    evidencePatterns: [/\bforecast/i, /\bbudget/i, /\bfinancial\b/i, /\bvariance\b/i, /\breport/i, /\baccount/i, /\bcontrol/i, /\breconciliation\b/i],
    riskClaims: ['statutory accounts ownership', 'audit ownership', 'P&L ownership', 'tax compliance', 'forecast accuracy improvements'],
    transferableEvidence: ['reporting -> financial analysis', 'process improvement -> controls/process finance', 'data analysis -> FP&A support'],
    skillCategories: [
      { label: 'Financial Analysis', skills: ['Variance Analysis', 'Forecasting', 'Budgeting', 'Scenario Analysis'] },
      { label: 'Reporting & Controls', skills: ['Month-End Reporting', 'Reconciliation', 'Internal Controls', 'Audit Support'] },
      { label: 'Commercial Finance', skills: ['Decision Support', 'Business Partnering', 'KPI Reporting', 'Cost Analysis'] },
      { label: 'Systems & Tools', skills: ['Excel', 'ERP Systems', 'Power BI', 'SQL'] },
      { label: 'Governance & Compliance', skills: ['Accounting Standards', 'Risk Management', 'Policy Compliance', 'Documentation'] },
    ],
    positioning: 'Position the CV around financial discipline, reporting accuracy, analysis, controls, and business decision support. Do not invent audit, tax, or P&L ownership.',
  },
  {
    id: 'operations',
    family: 'Operations / Project Management',
    domain: 'operations',
    aliases: ['operations manager', 'project manager', 'programme manager', 'program manager', 'delivery manager', 'business operations manager'],
    titlePatterns: [/\boperations?\s+manager\b/i, /\bproject\s+manager\b/i, /\bprogramme?\s+manager\b/i, /\bdelivery\s+manager\b/i, /\bbusiness\s+operations\b/i],
    credibilitySignals: ['process improvement', 'delivery planning', 'risk management', 'stakeholder coordination', 'resource planning', 'operational reporting'],
    evidencePatterns: [/\bprocess\b/i, /\bproject\b/i, /\bdelivery\b/i, /\brisk\b/i, /\bstakeholder\b/i, /\boperations?\b/i, /\bplanning\b/i, /\breporting\b/i],
    riskClaims: ['budget ownership', 'portfolio ownership', 'headcount management', 'programme governance', 'vendor contract ownership'],
    transferableEvidence: ['incident coordination -> delivery/risk management', 'documentation -> process improvement', 'cross-functional support -> stakeholder coordination'],
    skillCategories: [
      { label: 'Operational Delivery', skills: ['Project Planning', 'Delivery Tracking', 'Process Improvement', 'Operational Reporting'] },
      { label: 'Stakeholder Coordination', skills: ['Cross-functional Collaboration', 'Communication', 'Expectation Management', 'Governance'] },
      { label: 'Risk & Issue Management', skills: ['Risk Management', 'Issue Resolution', 'Escalation Management', 'Change Control'] },
      { label: 'Resource & Vendor Management', skills: ['Resource Planning', 'Vendor Coordination', 'SLA Management', 'Prioritisation'] },
      { label: 'Tools & Reporting', skills: ['Jira', 'Excel', 'Dashboards', 'Documentation'] },
    ],
    positioning: 'Position the CV around delivery discipline, process improvement, operational control, stakeholder coordination, and measurable execution. Avoid budget/headcount ownership unless proven.',
  },
  {
    id: 'hr_people',
    family: 'HR / People',
    domain: 'hr',
    aliases: ['hr manager', 'people partner', 'hr business partner', 'talent acquisition', 'recruiter', 'people operations'],
    titlePatterns: [/\bhr\b/i, /\bhuman\s+resources\b/i, /\bpeople\s+(partner|operations)\b/i, /\btalent\s+acquisition\b/i, /\brecruiter\b/i],
    credibilitySignals: ['employee relations', 'recruitment', 'people processes', 'policy', 'onboarding', 'stakeholder advisory'],
    evidencePatterns: [/\brecruit/i, /\bonboarding\b/i, /\bemployees?\b/i, /\bpolicy\b/i, /\bpeople\b/i, /\btalent\b/i, /\bemployee relations\b/i],
    riskClaims: ['ER case ownership', 'policy ownership', 'workforce planning', 'compensation ownership', 'union negotiations'],
    transferableEvidence: ['mentoring -> people development', 'documentation -> process/policy support', 'stakeholder support -> HR advisory'],
    skillCategories: [
      { label: 'People Operations', skills: ['Onboarding', 'HR Processes', 'Policy Support', 'Employee Lifecycle'] },
      { label: 'Talent Acquisition', skills: ['Sourcing', 'Interview Coordination', 'Candidate Experience', 'Hiring Manager Support'] },
      { label: 'Employee Relations', skills: ['Case Support', 'Conflict Resolution', 'Documentation', 'Confidentiality'] },
      { label: 'Stakeholder Advisory', skills: ['Communication', 'Coaching', 'Manager Support', 'Change Management'] },
      { label: 'HR Systems & Reporting', skills: ['HRIS', 'Reporting', 'Data Accuracy', 'Compliance'] },
    ],
    positioning: 'Position the CV around trusted people processes, communication, employee experience, policy discipline, and stakeholder support. Avoid sensitive HR ownership claims unless clearly proven.',
  },
  {
    id: 'legal_compliance',
    family: 'Legal / Compliance',
    domain: 'legal',
    aliases: ['legal counsel', 'paralegal', 'compliance officer', 'risk officer', 'contracts manager', 'privacy officer'],
    titlePatterns: [/\blegal\b/i, /\bparalegal\b/i, /\bcompliance\b/i, /\brisk\s+officer\b/i, /\bcontracts?\s+manager\b/i, /\bprivacy\s+officer\b/i],
    credibilitySignals: ['regulatory compliance', 'contract review', 'risk assessment', 'policy', 'documentation', 'stakeholder advice'],
    evidencePatterns: [/\bcontract\b/i, /\bcompliance\b/i, /\brisk\b/i, /\bregulatory\b/i, /\bpolicy\b/i, /\baudit\b/i, /\bprivacy\b/i, /\blegal\b/i],
    riskClaims: ['qualified lawyer status', 'legal advice ownership', 'regulatory sign-off', 'litigation ownership', 'DPO ownership'],
    transferableEvidence: ['security/compliance work -> controls evidence', 'documentation -> policy/process support', 'stakeholder escalation -> risk communication'],
    skillCategories: [
      { label: 'Compliance & Risk', skills: ['Regulatory Compliance', 'Risk Assessment', 'Controls', 'Audit Support'] },
      { label: 'Contracts & Documentation', skills: ['Contract Review', 'Documentation', 'Policy Support', 'Records Management'] },
      { label: 'Privacy & Governance', skills: ['Data Protection', 'Governance', 'Information Security', 'Policy Compliance'] },
      { label: 'Stakeholder Advisory', skills: ['Communication', 'Issue Escalation', 'Training Support', 'Cross-functional Collaboration'] },
      { label: 'Process Improvement', skills: ['Process Mapping', 'Reporting', 'Quality Assurance', 'Continuous Improvement'] },
    ],
    positioning: 'Position the CV around compliance discipline, risk awareness, documentation quality, and stakeholder support. Do not imply licensed legal advice or regulatory sign-off unless proven.',
  },
  {
    id: 'healthcare_admin',
    family: 'Healthcare Administration',
    domain: 'healthcare',
    aliases: ['healthcare administrator', 'clinical administrator', 'practice manager', 'patient coordinator', 'healthcare operations manager'],
    titlePatterns: [/\bhealthcare\b/i, /\bclinical\s+administrator\b/i, /\bpractice\s+manager\b/i, /\bpatient\s+coordinator\b/i],
    credibilitySignals: ['patient coordination', 'clinical operations', 'records accuracy', 'compliance', 'scheduling', 'service quality'],
    evidencePatterns: [/\bpatient\b/i, /\bclinical\b/i, /\bhealthcare\b/i, /\brecords?\b/i, /\bscheduling\b/i, /\bcompliance\b/i, /\bservice quality\b/i],
    riskClaims: ['clinical decision making', 'regulated clinical duties', 'CQC ownership', 'patient outcome claims', 'medical coding expertise'],
    transferableEvidence: ['customer support -> patient service coordination', 'operations -> clinic administration', 'data accuracy -> records quality'],
    skillCategories: [
      { label: 'Patient Coordination', skills: ['Scheduling', 'Patient Communication', 'Service Quality', 'Issue Resolution'] },
      { label: 'Clinical Administration', skills: ['Records Management', 'Workflow Coordination', 'Documentation', 'Data Accuracy'] },
      { label: 'Compliance & Governance', skills: ['Confidentiality', 'Policy Compliance', 'Audit Support', 'Risk Escalation'] },
      { label: 'Operations Support', skills: ['Process Improvement', 'Resource Coordination', 'Reporting', 'Team Collaboration'] },
      { label: 'Systems & Communication', skills: ['Healthcare Systems', 'Email/Phone Support', 'Stakeholder Communication', 'Excel'] },
    ],
    positioning: 'Position the CV around service quality, coordination, accuracy, confidentiality, compliance, and operational support. Avoid clinical authority claims unless explicitly present.',
  },
  {
    id: 'education_training',
    family: 'Education / Training',
    domain: 'education',
    aliases: ['teacher', 'trainer', 'learning and development', 'instructional designer', 'education coordinator', 'lecturer'],
    titlePatterns: [/\bteacher\b/i, /\btrainer\b/i, /\blearning\s+(and|&)\s+development\b/i, /\binstructional\s+designer\b/i, /\beducation\s+coordinator\b/i, /\blecturer\b/i],
    credibilitySignals: ['curriculum design', 'learner support', 'assessment', 'facilitation', 'training delivery', 'learning outcomes'],
    evidencePatterns: [/\btraining\b/i, /\btaught\b/i, /\bteacher\b/i, /\bcurriculum\b/i, /\blearning\b/i, /\bassessment\b/i, /\bfacilitat/i, /\bcoaching\b/i],
    riskClaims: ['qualified teacher status', 'curriculum ownership', 'regulated safeguarding lead', 'assessment authority', 'institution leadership'],
    transferableEvidence: ['documentation -> learning materials', 'mentoring -> training delivery', 'customer enablement -> learner support'],
    skillCategories: [
      { label: 'Training Delivery', skills: ['Facilitation', 'Workshops', 'Learner Engagement', 'Presentation Skills'] },
      { label: 'Learning Design', skills: ['Curriculum Design', 'Instructional Materials', 'Assessment Design', 'Learning Objectives'] },
      { label: 'Learner Support', skills: ['Coaching', 'Feedback', 'Progress Tracking', 'Inclusive Practice'] },
      { label: 'Programme Coordination', skills: ['Scheduling', 'Stakeholder Communication', 'Administration', 'Reporting'] },
      { label: 'Digital Learning', skills: ['LMS', 'E-learning', 'Documentation', 'Content Creation'] },
    ],
    positioning: 'Position the CV around learning outcomes, facilitation, learner support, curriculum/materials, and programme coordination. Avoid formal qualification or safeguarding claims unless proven.',
  },
];

const NORMALISE_RE = /[^a-z0-9+#.]+/g;

export class RoleProfileService {
  constructor(profiles = ROLE_PROFILES) {
    this.profiles = profiles;
  }

  classify(jdData = {}) {
    const text = this._profileText(jdData);
    if (!text.trim()) return null;

    const scored = this.profiles
      .map(profile => ({ profile, score: this._scoreProfile(profile, text) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.profile || null;
  }

  enrichJDData(jdData = {}) {
    const existing = jdData.roleProfile?.id
      ? this.profiles.find(profile => profile.id === jdData.roleProfile.id)
      : null;
    const profile = existing || this.classify(jdData);
    if (!profile) return jdData;

    return {
      ...jdData,
      domain: !jdData.domain || jdData.domain === 'other' ? profile.domain : jdData.domain,
      targetPositioning: jdData.targetPositioning || profile.positioning,
      skillCategories: Array.isArray(jdData.skillCategories) && jdData.skillCategories.length > 0
        ? jdData.skillCategories
        : profile.skillCategories,
      credibilitySignals: this._mergeLists(jdData.credibilitySignals, profile.credibilitySignals),
      transferableEvidence: this._mergeLists(jdData.transferableEvidence, profile.transferableEvidence),
      unsupportedClaimRisks: this._mergeLists(jdData.unsupportedClaimRisks, profile.riskClaims),
      roleProfile: this._publicProfile(profile),
    };
  }

  buildCredibilityGuidance(jdData = {}) {
    const profile = jdData.roleProfile?.id
      ? this.profiles.find(item => item.id === jdData.roleProfile.id)
      : this.classify(jdData);
    if (!profile) return '';

    return [
      `  • Role family: ${profile.family}. A credible CV must prove: ${profile.credibilitySignals.join(', ')}.`,
      `  • Transferable evidence to look for: ${profile.transferableEvidence.join('; ')}.`,
      `  • High-risk claims requiring direct CV evidence or user confirmation: ${profile.riskClaims.join(', ')}.`,
      '  • If the CV lacks direct evidence for the target role, frame adjacent experience honestly instead of inventing a new role identity.',
    ].join('\n');
  }

  validateCredibility({ originalCvData = {}, jdData = {}, tailoredText = '', confirmedSkills = [] } = {}) {
    const profile = jdData.roleProfile?.id
      ? this.profiles.find(item => item.id === jdData.roleProfile.id)
      : this.classify(jdData);
    if (!profile || !tailoredText) return [];

    const warnings = [];
    const output = String(tailoredText || '');
    const originalText = String(originalCvData?.rawText || '');
    const confirmedText = String(confirmedSkills || []).toLowerCase();
    const summary = this._extractSection(output, /^professional\s+summary$/i, /^(core\s+competenc(?:y|ies)|professional\s+experience|experience|employment|work\s+history|education|certifications?|skills)$/i);
    const experience = this._extractSection(output, /^(professional\s+experience|experience|employment|work\s+history)$/i, /^(education|certifications?|projects?|skills|core\s+competenc(?:y|ies))$/i);
    const competencies = this._extractSection(output, /^core\s+competenc(?:y|ies)$/i, /^(professional\s+experience|experience|employment|work\s+history|education|certifications?|projects?|skills)$/i);
    const proofText = `${summary} ${experience}`;

    const signalHits = profile.credibilitySignals.filter(signal => this._containsConcept(proofText, signal));
    if (signalHits.length < Math.min(2, profile.credibilitySignals.length)) {
      warnings.push(`Tailored CV may not read credibly for ${profile.family}; summary/experience should prove role signals such as ${profile.credibilitySignals.slice(0, 4).join(', ')}.`);
    }

    const experienceHits = profile.evidencePatterns.filter(pattern => pattern.test(experience));
    const originalHits = profile.evidencePatterns.filter(pattern => pattern.test(originalText));
    if (originalHits.length > 0 && experienceHits.length === 0) {
      warnings.push(`${profile.family} evidence from the original CV is not visible in the tailored experience bullets.`);
    }

    for (const risk of profile.riskClaims) {
      const riskRe = this._riskPattern(risk);
      if (!riskRe.test(competencies) && !riskRe.test(summary)) continue;
      if (!riskRe.test(originalText) && !riskRe.test(confirmedText)) {
        warnings.push(`High-risk ${profile.family} claim appears without original CV evidence or user confirmation: "${risk}".`);
      }
    }

    return warnings;
  }

  getSkillCategoriesForDomain(domain) {
    const profile = this.profiles.find(item => item.domain === domain);
    return profile?.skillCategories || [];
  }

  _scoreProfile(profile, text) {
    let score = 0;
    const normalised = this._normalise(text);

    for (const pattern of profile.titlePatterns || []) {
      if (pattern.test(text)) score += 15;
    }
    for (const alias of profile.aliases || []) {
      const aliasNorm = this._normalise(alias);
      if (aliasNorm && normalised.includes(aliasNorm)) score += aliasNorm.split(' ').length >= 2 ? 8 : 3;
    }
    for (const signal of profile.credibilitySignals || []) {
      if (normalised.includes(this._normalise(signal))) score += 2;
    }
    for (const cat of profile.skillCategories || []) {
      for (const skill of cat.skills || []) {
        if (normalised.includes(this._normalise(skill))) score += 1;
      }
    }
    return score;
  }

  _profileText(jdData = {}) {
    return [
      jdData.jobTitle,
      jdData.domain,
      jdData.targetPositioning,
      ...(jdData.requiredSkills || []),
      ...(jdData.preferredSkills || []),
      ...(jdData.tools || []),
      ...(jdData.responsibilities || []),
      ...(jdData.softSkills || []),
      ...(jdData.atsKeywords || []),
    ].join(' ');
  }

  _publicProfile(profile) {
    return {
      id: profile.id,
      family: profile.family,
      domain: profile.domain,
      credibilitySignals: profile.credibilitySignals,
      riskClaims: profile.riskClaims,
      transferableEvidence: profile.transferableEvidence,
    };
  }

  _extractSection(text, headingRe, stopHeadingRe) {
    const lines = String(text || '').split('\n');
    const start = lines.findIndex(line => headingRe.test(String(line || '').trim()));
    if (start === -1) return '';

    const collected = [];
    for (const line of lines.slice(start + 1)) {
      const trimmed = String(line || '').trim();
      if (stopHeadingRe.test(trimmed)) break;
      if (trimmed) collected.push(trimmed.replace(/^[-•*●▪◦–—]\s*/, ''));
    }
    return collected.join(' ');
  }

  _containsConcept(text, concept) {
    const haystack = this._normalise(text);
    const needle = this._normalise(concept);
    if (!needle) return false;
    if (haystack.includes(needle)) return true;
    return needle.split(' ').filter(part => part.length >= 5).some(part => haystack.includes(part));
  }

  _riskPattern(risk) {
    const text = String(risk || '').toLowerCase();
    if (/medd?picc/.test(text)) return /\bMEDD?P?ICC\b/i;
    if (/p&l/.test(text)) return /\bP&L\b|\bprofit\s+and\s+loss\b/i;
    if (/rfp|rfi/.test(text)) return /\bRFP\b|\bRFI\b/i;
    if (/poc|pov|proof/.test(text)) return /\bPOC\b|\bPOV\b|proof of concept|proof of value/i;
    if (/revenue|quota|commercial/.test(text)) return /\brevenue\b|\bquota\b|\bcommercial\b|\bclosed\b|\bpipeline\b/i;
    if (/budget/.test(text)) return /\bbudget\b|\bspend\b/i;
    if (/people|line management|hiring|performance/.test(text)) return /\bline management\b|\bmanaged\b|\bhiring\b|\bperformance review\b/i;
    return new RegExp(`\\b${this._escapeRegExp(String(risk).split(/\s+/)[0])}\\b`, 'i');
  }

  _mergeLists(primary = [], fallback = []) {
    const seen = new Set();
    const merged = [];
    for (const item of [...(primary || []), ...(fallback || [])]) {
      const clean = String(item || '').trim();
      const key = this._normalise(clean);
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      merged.push(clean);
    }
    return merged;
  }

  _normalise(value) {
    return String(value || '').toLowerCase().replace(NORMALISE_RE, ' ').replace(/\s+/g, ' ').trim();
  }

  _escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export default RoleProfileService;
