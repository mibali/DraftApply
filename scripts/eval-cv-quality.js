import { evaluateCvQualityCorpus } from '../shared/cv-quality-evaluator.js';
import { CV_QUALITY_CORPUS } from '../tests/fixtures/cv-quality-corpus.js';

const report = evaluateCvQualityCorpus(CV_QUALITY_CORPUS);

process.stdout.write(`CV generation quality eval (${report.cases.length} synthetic CV layouts)\n`);
process.stdout.write('='.repeat(78) + '\n');
for (const result of report.cases) {
  const metrics = Object.entries(result.metrics)
    .map(([name, value]) => `${name}=${value.toFixed(2)}`)
    .join(' ');
  process.stdout.write(`[${result.pass ? 'PASS' : 'FAIL'}] ${result.id} — ${result.layout}\n`);
  process.stdout.write(`  ${metrics}\n`);
  process.stdout.write(`  roles=${result.counts.parsedRoles} projects=${result.counts.parsedProjects} skills=${result.counts.parsedSkills} acceptedBullets=${result.counts.acceptedBullets} validatedClaims=${result.counts.validatedClaims}\n`);
  for (const failure of result.failures) process.stdout.write(`  - ${failure}\n`);
}

process.stdout.write('\nAggregate\n');
for (const [name, value] of Object.entries(report.aggregate)) {
  process.stdout.write(`  ${name}: ${value.toFixed(2)}\n`);
}

if (!report.pass) {
  process.stderr.write('\nFAIL: at least one CV layout did not meet the deterministic quality gates.\n');
  process.exitCode = 1;
} else {
  process.stdout.write('\nPASS: every fixture retained its source facts and rejected adversarial model content.\n');
}
