#!/usr/bin/env node
/**
 * Prints a machine-checkable snapshot of every scenario's real vision data.
 * Usage: npx tsx?  → this project runs it through vite-node instead:
 *   npx vite-node scripts/verify-scenarios.mjs
 */
import { Sandbox } from '../src/sandbox.ts';
import { SCENARIOS } from '../src/scenarios.ts';
import { axialToOffset } from '../src/hex.ts';

const failures = [];
for (const spec of SCENARIOS) {
  const sandbox = new Sandbox({ scenarioId: spec.id });
  const results = sandbox.expectations();
  console.log(`\n== ${spec.id} · ${spec.title} ==`);
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(
      `  [${mark}] (${r.col},${r.row}) expected ${r.expect}; actual ${r.actual} — ${r.note}`,
    );
    if (!r.ok) failures.push({ scenario: spec.id, ...r });
  }
  const visible = [...sandbox.vision.current.visible].map((key) => {
    const [q, r] = key.split(',').map(Number);
    return axialToOffset(q, r);
  });
  console.log(`  visible cells: ${visible.length}`);
  console.log(`  explored cells: ${sandbox.vision.exploredCells.size}`);
}
if (failures.length) {
  console.error(`\n${failures.length} expectation(s) failed`);
  process.exit(1);
}
console.log('\nAll scenario expectations match real vision data.');
