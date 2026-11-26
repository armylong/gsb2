import { runLocalValidation } from '../src/validation';

const report = runLocalValidation();

for (const check of report.checks) {
  const mark = check.ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${check.name}\n       ${check.detail}`);
}

const passed = report.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${report.checks.length} checks passed`);

if (!report.ok) {
  process.exit(1);
}
