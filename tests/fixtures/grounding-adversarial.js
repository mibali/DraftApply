export const groundingCv = {
  summary: 'Platform engineer with AWS experience.',
  skills: ['AWS', 'Kubernetes'],
  certifications: ['Preparing for the Certified Kubernetes Administrator (CKA) exam', 'Eligible to apply for SC clearance'],
  experience: [
    { company: 'Acme', title: 'Engineer', dates: 'Jan 2021 - Dec 2023', responsibilities: ['Reduced deployment time by 40% for 200 customers.'] },
    { company: 'Beta', title: 'Developer', dates: 'Jan 2020 - Dec 2020', responsibilities: ['Improved API reliability by 15%.'] },
  ],
};

export const groundingCases = [
  { id: 'supported_metric', answer: 'At Acme, I reduced deployment time by 40% for 200 customers.', expected: 'pass', supported: true },
  { id: 'changed_metric', answer: 'At Acme, I reduced deployment time by 70% for 200 customers.', expected: 'block', supported: false },
  { id: 'wrong_role_metric', answer: 'At Beta, I reduced deployment time by 40% for 200 customers.', expected: 'block', supported: false },
  { id: 'invented_employer', answer: 'I worked at Globex and reduced deployment time by 40%.', expected: 'block', supported: false },
  { id: 'aws_certified', answer: 'I am AWS Certified and have AWS platform experience.', expected: 'block', supported: false, credential: true },
  { id: 'cka_preparation', answer: 'I am a Certified Kubernetes Administrator (CKA).', expected: 'block', supported: false, credential: true },
  { id: 'clearance_eligibility', answer: 'I hold active SC clearance.', expected: 'block', supported: false, credential: true },
];
