import { createHandImage } from '../src/core/image.ts';
import { buildComparison, formatPercent } from '../src/core/mips.ts';
import { DOLLY_SAMPLES, lodAtProgress } from '../src/core/samples.ts';

function printHandTable(): void {
  const image = createHandImage('hand4');
  const comparison = buildComparison(image, 128);

  console.log('\nHand-calculable 4x4 alpha map (threshold: alpha >= 128)');
  for (let y = 0; y < image.height; y++) {
    const row: string[] = [];
    for (let x = 0; x < image.width; x++) {
      const a = image.data[(y * image.width + x) * 4 + 3];
      row.push(a === 0 ? '  .' : String(a).padStart(4));
    }
    console.log(row.join(' '));
  }

  console.log('\nLevel  size   ordinary pass/target  delta-ratio   area pass/target  delta-ratio');
  for (let level = 0; level < comparison.ordinary.levels.length; level++) {
    const ordinary = comparison.ordinary.levels[level];
    const area = comparison.area.levels[level];
    console.log(
      `L${level}     ${String(ordinary.width).padStart(2)}x${String(ordinary.height).padEnd(2)} ` +
        `${String(ordinary.passCount).padStart(4)}/${String(ordinary.targetCount).padEnd(4)}          ` +
        `${formatPercent(ordinary.deltaRatio, 1).padStart(7)}      ` +
        `${String(area.passCount).padStart(4)}/${String(area.targetCount).padEnd(4)}         ` +
        `${formatPercent(area.deltaRatio, 1).padStart(7)}`,
    );
  }

  console.log(`\nOrdinary first loss level: L${comparison.ordinary.firstLossLevel ?? 'none'}`);
}

function printSamples(): void {
  console.log('\nRepeatable dolly samples');
  for (const sample of DOLLY_SAMPLES) {
    console.log(`\n${sample.id} — ${sample.label}`);
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      console.log(`  p=${progress.toFixed(2)}  LOD=${lodAtProgress(sample, progress).toFixed(2)}`);
    }
  }
}

printHandTable();
printSamples();
