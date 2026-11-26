import { runChecks } from './checks';

const results = runChecks();
const failed = results.filter((r) => !r.ok);

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (failed.length) {
  console.error(`${failed.length} check(s) failed`);
  process.exitCode = 1;
}
