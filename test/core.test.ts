import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBleedFixture, createHandImage, createImage, createLeafTexture } from '../src/core/image.ts';
import {
  buildComparison,
  countPassing,
  downsampleNaive,
  downsampleSafe,
} from '../src/core/mips.ts';
import { runAtlasChecks } from '../src/core/atlasChecks.ts';
import { DOLLY_SAMPLES, lodAtElapsed, lodAtProgress } from '../src/core/samples.ts';

test('hand4 has a manually countable area and loses at ordinary L1', () => {
  const image = createHandImage('hand4');
  assert.equal(image.width, 4);
  assert.equal(image.height, 4);
  assert.equal(countPassing(image, 128), 4);

  const comparison = buildComparison(image, 128);
  const ordinaryL1 = comparison.ordinary.levels[1];
  assert.equal(ordinaryL1.width, 2);
  assert.equal(ordinaryL1.height, 2);
  assert.equal(ordinaryL1.passCount, 0);
  assert.equal(ordinaryL1.expectedCount, 1);
  assert.equal(ordinaryL1.targetCount, 1);
  assert.equal(comparison.ordinary.firstLossLevel, 1);
  assert.equal(comparison.ordinary.severeLossLevel, 1);

  const areaL1 = comparison.area.levels[1];
  assert.equal(areaL1.passCount, 1);
  assert.equal(areaL1.targetCount, 1);

  const areaL2 = comparison.area.levels[2];
  assert.equal(areaL2.width, 1);
  assert.equal(areaL2.targetCount, 0);
  assert.ok(Math.abs(areaL2.deltaRatio - -0.25) < 1e-9);
  assert.ok(areaL2.equivalentSourceDelta < -3.9 && areaL2.equivalentSourceDelta > -4.1);
});

test('hand8 shows four isolated tips disappearing before the opaque core', () => {
  const image = createHandImage('hand8');
  assert.equal(countPassing(image, 128), 20);
  const comparison = buildComparison(image, 128);
  assert.equal(comparison.ordinary.levels[1].passCount, 4);
  assert.equal(comparison.ordinary.levels[1].targetCount, 5);
  assert.equal(comparison.ordinary.firstLossLevel, 1);
  assert.equal(comparison.ordinary.levels[2].passCount, 1);
  assert.equal(comparison.ordinary.levels[2].targetCount, 1);
});

test('alpha-weighted downsample ignores dirty transparent RGB', () => {
  const image = createImage(2, 2);
  const red = [255, 0, 0, 255];
  const dirty = [255, 0, 255, 0];
  image.data.set(red, 0);
  image.data.set(dirty, 4);
  image.data.set(dirty, 8);
  image.data.set(dirty, 12);

  const safe = downsampleSafe(image);
  assert.equal(safe.width, 1);
  assert.equal(safe.data[3], 64);
  assert.deepEqual([safe.data[0], safe.data[1], safe.data[2]], [255, 0, 0]);

  const naive = downsampleNaive(image);
  assert.equal(naive.data[3], 64);
  assert.ok(naive.data[2] > 150, 'naive average should visibly borrow magenta dirty RGB');
});

test('atlas edge checks pass and the control algorithm reproduces bleeding', () => {
  const result = runAtlasChecks();
  for (const check of result.checks) {
    assert.equal(check.pass, true, `${check.label}: ${check.detail}`);
  }

  const fixture = createBleedFixture();
  assert.equal(fixture.width, 4);
  assert.equal(fixture.height, 4);
});

test('area regeneration always meets its integer target for repeatable thresholds', () => {
  const image = createLeafTexture();
  assert.ok(countPassing(image, 128) > 200);

  for (const cutoff of [0, 32, 96, 128, 200, 255]) {
    const comparison = buildComparison(image, cutoff);
    for (const level of comparison.area.levels) {
      assert.equal(
        level.passCount,
        level.targetCount,
        `cutoff ${cutoff}, L${level.level} should have exact target count`,
      );
    }
  }
});

test('procedural texture contains both dense and transparent pore areas', () => {
  const image = createLeafTexture();
  const passing = countPassing(image, 128);
  assert.ok(passing > image.width * image.height * 0.04);
  assert.ok(passing < image.width * image.height * 0.85);
  assert.ok(countPassing(image, 255) > 0);
});

test('both dolly samples are deterministic, monotonic, and reach tiny levels', () => {
  for (const sample of DOLLY_SAMPLES) {
    assert.ok(sample.keys.length >= 2);
    assert.equal(lodAtElapsed(sample, 12_345), lodAtElapsed(sample, 12_345));
    let previous = Number.NEGATIVE_INFINITY;
    for (let i = 0; i <= 100; i++) {
      const lod = lodAtProgress(sample, i / 100);
      assert.ok(lod >= previous - 1e-9, `${sample.id} must not dolly back toward the camera`);
      previous = lod;
    }
    assert.ok(lodAtProgress(sample, 1) >= 6);
  }
});
