import { MULTICOLUMN_CV_TEXT } from './multicolumn-cv.js';

export const CV_QUALITY_CORPUS = [
  {
    id: 'conventional-customer-operations',
    layout: 'single-column reverse chronological',
    cvText: `Jordan Lee
jordan.lee@example.test | +44 7700 900123 | London, UK
PROFESSIONAL SUMMARY
Customer operations specialist experienced in SaaS onboarding, account support, and process improvement.
CORE COMPETENCIES
Customer Support, Salesforce, Zendesk, Data Analysis, Stakeholder Communication
PROFESSIONAL EXPERIENCE
Orbit Software | London, UK
Customer Success Specialist
Mar 2022 - Present
• Managed onboarding for 40 enterprise accounts and maintained a 96% satisfaction score.
• Used Salesforce and Zendesk to resolve customer issues and identify recurring product gaps.
Civic Retail | London, UK
Operations Assistant
Jun 2020 - Feb 2022
• Coordinated weekly inventory reports and supplier communications.
EDUCATION
BA Business Management, Northbridge University, 2020`,
    jdData: {
      jobTitle: 'Customer Success Manager',
      company: 'Fictional Cloud Ltd',
      requiredSkills: ['Customer Support', 'Salesforce', 'Stakeholder Communication'],
      tools: ['Zendesk'],
      atsKeywords: ['SaaS onboarding', 'Salesforce', 'Zendesk'],
    },
    expected: {
      name: 'Jordan Lee',
      roles: [
        ['Orbit Software | London, UK', 'Customer Success Specialist', 'Mar 2022 - Present'],
        ['Civic Retail | London, UK', 'Operations Assistant', 'Jun 2020 - Feb 2022'],
      ],
      skills: ['Customer Support', 'Salesforce', 'Zendesk', 'Stakeholder Communication'],
      projects: [],
      retained: ['BA Business Management, Northbridge University, 2020', '96% satisfaction score'],
      supportedKeywords: ['SaaS onboarding', 'Salesforce', 'Zendesk'],
    },
  },
  {
    id: 'flattened-multicolumn-support',
    layout: 'flattened multi-column with trailing dates and projects',
    cvText: MULTICOLUMN_CV_TEXT,
    jdData: {
      jobTitle: 'Senior Developer Support Engineer',
      company: 'Fictional API Platform',
      requiredSkills: ['REST APIs', 'Incident Management', 'Root Cause Analysis'],
      tools: ['PostgreSQL', 'Docker', 'Sentry'],
      atsKeywords: ['request tracing', 'webhooks', 'developer support'],
    },
    expected: {
      name: 'Alex Morgan',
      roles: [
        ['Northstar Payments', 'Team Lead, Developer Support', 'Feb 2021 - Present'],
        ['Harbor Systems', 'Senior Software Engineer', 'Aug 2020 - Jan 2021'],
        ['Freelance/Contract', 'Software Engineer', 'May 2019 - Aug 2020'],
      ],
      skills: ['REST APIs', 'PostgreSQL', 'Docker', 'Sentry'],
      projects: [
        { name: 'SprintBoard', url: 'https://sprintboard.example.test' },
        { name: 'PayCycle', url: 'https://paycycle.example.test' },
      ],
      retained: ['SprintBoard', 'https://paycycle.example.test', 'reducing resolution time by 25%'],
      supportedKeywords: ['REST APIs', 'PostgreSQL', 'Docker', 'Sentry'],
    },
  },
  {
    id: 'early-career-project-heavy',
    layout: 'sparse early-career CV with projects before experience',
    cvText: `Sam Rivera
sam.rivera@example.test | github.com/sam-rivera
SUMMARY
Computer science graduate building accessible web applications and data tools.
SKILLS
JavaScript, React, Python, SQL, Git
PROJECTS
Campus Access Map (https://campus-map.example.test)
Built an accessible React map used by student volunteers to report blocked routes.
Skills: React, JavaScript, Accessibility
Study Planner (https://study-planner.example.test)
Created a Python and SQLite scheduling tool for coursework deadlines.
Skills: Python, SQLite
EXPERIENCE
Community Food Hub
Volunteer Coordinator
Sep 2023 - May 2024
• Coordinated delivery schedules for 15 volunteers using shared digital tools.
EDUCATION
BSc Computer Science, Westborough University, 2024`,
    jdData: {
      jobTitle: 'Junior Software Engineer',
      company: 'Fictional Civic Tech',
      requiredSkills: ['JavaScript', 'React', 'Python'],
      tools: ['Git', 'SQLite'],
      atsKeywords: ['accessible web applications', 'React', 'Python'],
    },
    expected: {
      name: 'Sam Rivera',
      roles: [['Community Food Hub', 'Volunteer Coordinator', 'Sep 2023 - May 2024']],
      skills: ['JavaScript', 'React', 'Python', 'Git', 'SQLite'],
      projects: [
        { name: 'Campus Access Map', url: 'https://campus-map.example.test' },
        { name: 'Study Planner', url: 'https://study-planner.example.test' },
      ],
      retained: ['BSc Computer Science, Westborough University, 2024', '15 volunteers'],
      supportedKeywords: ['JavaScript', 'React', 'Python', 'SQLite'],
    },
  },
  {
    id: 'mixed-language-academic',
    layout: 'academic CV with English headings and bilingual evidence',
    cvText: `Dr Amina Diallo
amina.diallo@example.test | Paris, France
PROFESSIONAL SUMMARY
Research scientist specialising in natural language processing and reproducible machine learning. Expérience internationale en analyse de textes multilingues.
TECHNICAL SKILLS
Python, PyTorch, Natural Language Processing, Reproducible Research, French, English
PROFESSIONAL EXPERIENCE
Institut Lumière | Paris, France
Research Fellow
Oct 2021 - Present
• Developed PyTorch models for multilingual document classification.
• Published reproducible evaluation code and mentored three graduate researchers.
PROJECTS
Open Corpus Toolkit (https://corpus.example.test)
Released a Python toolkit for cleaning bilingual research datasets.
Skills: Python, NLP, Data Quality
EDUCATION / CERTIFICATIONS
PhD Computer Science, Université Nouvelle, 2021
MSc Data Science, Université Nouvelle, 2017
PUBLICATIONS
Diallo, A. Reproducible Evaluation for Multilingual Models, 2023`,
    jdData: {
      jobTitle: 'Applied NLP Scientist',
      company: 'Fictional Research Lab',
      requiredSkills: ['Natural Language Processing', 'Reproducible Research', 'Python'],
      tools: ['PyTorch'],
      atsKeywords: ['multilingual', 'PyTorch', 'reproducible evaluation'],
    },
    expected: {
      name: 'Dr Amina Diallo',
      roles: [['Institut Lumière | Paris, France', 'Research Fellow', 'Oct 2021 - Present']],
      skills: ['Python', 'PyTorch', 'Natural Language Processing', 'Reproducible Research'],
      projects: [{ name: 'Open Corpus Toolkit', url: 'https://corpus.example.test' }],
      retained: ['PhD Computer Science, Université Nouvelle, 2021', 'three graduate researchers'],
      supportedKeywords: ['multilingual', 'Python', 'PyTorch'],
    },
  },
  {
    id: 'nonstandard-bullet-markers',
    layout: 'single-column with extraction-style double-angle bullets',
    cvText: `Taylor Chen
taylor.chen@example.test
PROFESSIONAL SUMMARY
Platform engineer focused on reliable services and practical automation.
TECHNICAL SKILLS
Go, Kubernetes, Prometheus, Terraform, Linux
PROFESSIONAL EXPERIENCE
Beacon Hosting | Remote
Platform Engineer
Jan 2022 - Present
>> Automated Kubernetes deployments with Terraform and reduced release failures by 30%.
>> Built Prometheus dashboards and incident runbooks for production services.
Delta Labs | Remote
Junior Systems Engineer
Jul 2020 - Dec 2021
>> Maintained Linux services and wrote Go utilities for operational checks.
EDUCATION, CERTIFICATIONS & RECOGNITION
BEng Software Engineering, Eastport Institute, 2020`,
    jdData: {
      jobTitle: 'Platform Reliability Engineer',
      company: 'Fictional Hosting Co',
      requiredSkills: ['Kubernetes', 'Terraform', 'Linux'],
      tools: ['Prometheus', 'Go'],
      atsKeywords: ['incident runbooks', 'Kubernetes', 'Prometheus'],
    },
    expected: {
      name: 'Taylor Chen',
      roles: [
        ['Beacon Hosting | Remote', 'Platform Engineer', 'Jan 2022 - Present'],
        ['Delta Labs | Remote', 'Junior Systems Engineer', 'Jul 2020 - Dec 2021'],
      ],
      skills: ['Go', 'Kubernetes', 'Prometheus', 'Terraform', 'Linux'],
      projects: [],
      retained: ['BEng Software Engineering, Eastport Institute, 2020', 'reduced release failures by 30%'],
      supportedKeywords: ['Kubernetes', 'Terraform', 'Prometheus', 'incident runbooks'],
    },
  },
];
