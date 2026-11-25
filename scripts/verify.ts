import assert from 'node:assert/strict';
import { runAllChecks } from '../src/checks.ts';

const results = runAllChecks();
for (const result of results) {
  console.log(`${result.pass ? '✅' : '❌'} ${result.label} — ${result.detail}`);
}
assert.ok(results.every((r) => r.pass), '存在未通过的模拟自检');
console.log('\n全部模拟自检通过。');
