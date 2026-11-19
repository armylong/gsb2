/**
 * Regenerate the committed sample PNGs under samples/ from the deterministic
 * generator in server/samples.ts. Run with: npm run samples:write
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSamples } from '../server/samples';
import { normalizeSourceKey } from '../shared/identity';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'samples');

async function main(): Promise<void> {
  const samples = await generateSamples();
  await fs.rm(out, { recursive: true, force: true });
  for (const sample of samples) {
    const target = path.join(out, normalizeSourceKey(sample.key));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, sample.png);
  }
  await fs.writeFile(
    path.join(out, 'README.txt'),
    [
      'Generated sample PNGs used by the tool, tests and docs.',
      'Regenerate with: npm run samples:write',
      'The generator is deterministic (no randomness), so repeated runs',
      'produce byte-identical files.',
      '',
      'characters/hero_idle.png      irregular character, 64x96 canvas',
      'characters/hero_run_1..3.png  same canvas, different silhouette',
      'alternate/hero_idle.png       same basename, different directory and pixels',
      'ui/empty_placeholder.png      fully transparent frame (kept, not dropped)',
      'effects/slash.png             irregular effect with semi-transparent edges',
      'ui/hollow_frame.png           hollow frame, trim keeps the full canvas',
      'strips/tall_banner.png        16x300 strip, packs rotated',
      'strips/wide_banner.png        260x14 strip, packs rotated',
      'characters/tiny_dot.png       off-center 2x1 content inside an 8x8 canvas',
      'backgrounds/big_ring.png      220x220 frame, unplaced on small pages',
      '',
    ].join('\n'),
  );
  console.log(`wrote ${samples.length} sample PNGs to ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
