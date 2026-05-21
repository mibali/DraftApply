/**
 * Local salary benchmark snapshot.
 *
 * This file is intentionally data-light until the monthly official-source
 * importer populates benchmark rows. Do not hand-enter market salaries here:
 * every row should come from a source listed in metadata.sources.
 */

export const SALARY_BENCHMARKS = {
  schemaVersion: 1,
  updatedAt: null,
  sources: [
    {
      id: 'ons-ashe',
      name: 'ONS Annual Survey of Hours and Earnings',
      country: 'UK',
      url: 'https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/earningsandworkinghours',
      cadence: 'annual',
      notes: 'Official UK earnings statistics. Monthly automation should refresh the derived snapshot when new tables are available.',
    },
    {
      id: 'bls-oews',
      name: 'BLS Occupational Employment and Wage Statistics',
      country: 'US',
      url: 'https://www.bls.gov/oes/tables.htm',
      cadence: 'annual',
      notes: 'Official US occupational wage statistics. Monthly automation should refresh the derived snapshot when new tables are available.',
    },
    {
      id: 'esco',
      name: 'ESCO Occupation Classification',
      country: 'EU',
      url: 'https://esco.ec.europa.eu/en/use-esco/download',
      cadence: 'periodic',
      notes: 'Occupation taxonomy used for role-title normalisation, not a salary source by itself.',
    },
  ],
  benchmarks: [],
};

export default SALARY_BENCHMARKS;
