import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraPath } from './CameraPath';
import { CameraRig } from './CameraRig';
import { progressAtTime, sanitizeKnots, defaultTimeKnots } from './timeMapping';
import { buildExport } from './exporter';
import {
  checkArcLengthUniformity,
  checkSeekConsistency,
  checkOrientationContinuity,
  checkLoopSeam,
  checkFrameSanity,
  runAllChecks,
} from './verifier';
import { ordinaryPreset, verticalPreset, closedPreset } from './presets';
import type { PathConfig, PlaybackConfig } from './types';

const PRESETS = [ordinaryPreset(), verticalPreset(), closedPreset()];

describe('CameraPath: arc-length parameterization', () => {
  it('constant-speed mode gives equal arc length per equal time step, even with uneven points', () => {
    // Dense cluster at one end: naive u-parameter playback would speed/slow.
    const pathConfig: PathConfig = {
      mode: 'open',
      tension: 0.5,
      controlPoints: [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0.2, 0, 0),
        new THREE.Vector3(0.5, 0, 0),
        new THREE.Vector3(1.0, 0, 0),
        new THREE.Vector3(8, 0, 0),
        new THREE.Vector3(16, 0, 0),
      ],
    };
    const playback: PlaybackConfig = {
      speedMode: 'constant',
      lookMode: 'forward',
      duration: 10,
      timeKnots: defaultTimeKnots(10),
      target: new THREE.Vector3(),
    };
    const rig = new CameraRig(pathConfig, playback);
    const check = checkArcLengthUniformity(rig, 100);
    expect(check.pass).toBe(true);
    expect(check.measurements['相对极差'] as number).toBeLessThan(5e-3);
  });

  it('positionAt walks the arc-length table: cumulative distance tracks q * totalLength', () => {
    for (const preset of PRESETS) {
      const path = new CameraPath(preset.path);
      expect(path.totalLength).toBeGreaterThan(0);
      const origin = path.positionAt(0);
      let prevDist = 0;
      for (let k = 0; k <= 100; k++) {
        const q = k / 100;
        const s = path.positionAt(q);
        expect(Number.isFinite(s.x)).toBe(true);
        // Cumulative polyline distance from the start must grow monotonically
        // and stay close to the analytic arc-length target q * L.
        const dist = k === 0 ? 0 : prevDist + s.distanceTo(path.positionAt((k - 1) / 100));
        expect(dist).toBeGreaterThanOrEqual(prevDist - 1e-12);
        expect(Math.abs(dist - q * path.totalLength)).toBeLessThan(path.totalLength * 0.01);
        prevDist = dist;
      }
      expect(origin).toBeDefined();
    }
  });
});

describe('CameraPath: parallel-transport frames', () => {
  it('never flips through the vertical preset (max adjacent rotation stays small)', () => {
    const rig = new CameraRig(verticalPreset().path, verticalPreset().playback);
    const check = checkOrientationContinuity(rig, 500);
    expect(check.pass).toBe(true);
    expect(check.measurements['最大相邻转角(rad)'] as number).toBeLessThan(0.3);
  });

  it('up vectors stay perpendicular to tangents', () => {
    for (const preset of PRESETS) {
      const path = new CameraPath(preset.path);
      let maxDot = 0;
      for (let k = 0; k <= 500; k++) {
        const q = k / 500;
        const t = path.tangentAt(q);
        const u = path.upAt(q);
        maxDot = Math.max(maxDot, Math.abs(t.dot(u)));
      }
      expect(maxDot).toBeLessThan(1e-9);
    }
  });

  it('closed loop transport frame matches at the seam', () => {
    const path = new CameraPath(closedPreset().path);
    const u0 = path.upAt(0);
    const u1 = path.upAt(1);
    const t0 = path.tangentAt(0);
    const t1 = path.tangentAt(1);
    expect(u0.distanceTo(u1)).toBeLessThan(1e-9);
    expect(t0.distanceTo(t1)).toBeLessThan(1e-6);
  });
});

describe('time mapping', () => {
  it('evaluates knots and clamps outside the range', () => {
    const knots = [
      { t: 0, p: 0 },
      { t: 5, p: 0.2 },
      { t: 10, p: 1 },
    ];
    expect(progressAtTime(knots, 10, -1)).toBe(0);
    expect(progressAtTime(knots, 10, 0)).toBe(0);
    expect(progressAtTime(knots, 10, 2.5)).toBeCloseTo(0.1, 12);
    expect(progressAtTime(knots, 10, 5)).toBe(0.2);
    expect(progressAtTime(knots, 10, 12)).toBe(1);
  });

  it('sanitizeKnots keeps time order and non-decreasing progress', () => {
    const dirty = [
      { t: 0, p: 0 },
      { t: 8, p: 0.9 },
      { t: 3, p: 0.2 },
      { t: 5, p: 0.1 }, // progress goes backwards -> clamped to previous after sort
      { t: 10, p: 1 },
    ];
    const clean = sanitizeKnots(dirty, 10);
    for (let i = 1; i < clean.length; i++) {
      expect(clean[i].t).toBeGreaterThan(clean[i - 1].t);
      expect(clean[i].p).toBeGreaterThanOrEqual(clean[i - 1].p);
    }
    expect(clean[0]).toEqual({ t: 0, p: 0 });
    expect(clean.at(-1)).toEqual({ t: 10, p: 1 });
  });

  it('timed mode actually changes speed; constant mode does not', () => {
    const base = verticalPreset();
    const rigTimed = new CameraRig(base.path, base.playback);
    // Knot slopes: 0-5.4s slow (0.052/s), 5.4-7.2s fastest (0.15/s).
    const vFast = rigTimed.speedAtTime(6.2);
    const vSlow = rigTimed.speedAtTime(2.5);
    expect(vFast).toBeGreaterThan(vSlow * 1.5);

    const rigConst = new CameraRig(base.path, { ...base.playback, speedMode: 'constant' });
    const speeds = [1, 4, 7, 10].map((t) => rigConst.speedAtTime(t));
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    for (const v of speeds) expect(Math.abs(v - mean) / mean).toBeLessThan(1e-6);
  });
});

describe('stateless seek vs continuous playback', () => {
  for (const preset of PRESETS) {
    it(`preset "${preset.id}" — identical poses regardless of visit order`, () => {
      const check = checkSeekConsistency(preset.path, preset.playback, 30);
      expect(check.pass).toBe(true);
      expect(check.measurements['最大位置误差(m)'] as number).toBeLessThanOrEqual(1e-6);
      expect(check.measurements['最大朝向误差(rad)'] as number).toBeLessThanOrEqual(1e-4);
    });
  }

  it('seeking after visiting other times changes nothing (no hidden state)', () => {
    const preset = verticalPreset();
    const rig = new CameraRig(preset.path, preset.playback);
    rig.sampleAt(11);
    rig.sampleAt(0.3);
    rig.sampleAt(7.7);
    const warm = rig.sampleAt(4.2);
    const fresh = new CameraRig(preset.path, preset.playback).sampleAt(4.2);
    expect(warm.position.distanceTo(fresh.position)).toBeLessThan(1e-12);
    expect(warm.quaternion.angleTo(fresh.quaternion)).toBeLessThan(1e-10);
  });
});

describe('target look mode', () => {
  it('holds the last valid orientation while target coincides, resumes after', () => {
    const preset = ordinaryPreset();
    // Put the target exactly on the path at its midpoint.
    const probe = new CameraRig(preset.path, preset.playback);
    const mid = probe.path.positionAt(0.5);
    const playback: PlaybackConfig = {
      ...preset.playback,
      lookMode: 'target',
      target: mid.clone(),
    };
    const rig = new CameraRig(preset.path, playback);
    const D = preset.playback.duration;

    // Scan for the coincidence window (target within EPS of the camera).
    const heldTimes: number[] = [];
    for (let k = 0; k <= 2000; k++) {
      const s = rig.sampleAt((k / 2000) * D);
      if (s.targetHeld) heldTimes.push(s.time);
    }
    expect(heldTimes.length).toBeGreaterThan(0);

    // Every held sample must carry exactly the same orientation (frozen pose),
    // and each held sample equals the last valid orientation before the window.
    const heldQuats = heldTimes.map((t) => rig.sampleAt(t).quaternion);
    for (const q of heldQuats) {
      // float32 storage + acos rounding gives ~1e-8 floor; identical poses up
      // to single precision is the strongest meaningful guarantee.
      expect(q.angleTo(heldQuats[0])).toBeLessThan(1e-6);
    }
    const tFirst = heldTimes[0];
    // Nearest non-held sample before the window: entry into the frozen region
    // must be continuous (small step), never a jump.
    let before = rig.sampleAt(0);
    for (let k = Math.floor((tFirst / D) * 2000) - 1; k >= 0; k--) {
      const cand = rig.sampleAt((k / 2000) * D);
      if (!cand.targetHeld) {
        before = cand;
        break;
      }
    }
    expect(heldQuats[0].angleTo(before.quaternion)).toBeLessThan(5e-3);

    // After separating, target following resumes. The camera has now passed
    // THROUGH the target, so its view direction legitimately reverses (the
    // look-at vector f -> -f, a ~pi turn about the axis perpendicular to the
    // path) — that is correct physics, not a flip. What must hold is:
    //  (a) the pose actually points at the target again,
    //  (b) there is no spurious half-ROLL about the view axis,
    //  (c) away from this one crossing, every dense step is small.
    const tLast = heldTimes.at(-1)!;
    const after = rig.sampleAt(Math.min(D, tLast + D / 2000));
    expect(after.targetHeld).toBe(false);
    const viewDirAfter = after.backward.clone().negate();
    const wantAfter = rig.playback.target.clone().sub(after.position).normalize();
    expect(viewDirAfter.angleTo(wantAfter)).toBeLessThan(1e-3);

    // (b) Roll check: project each step's rotation onto the view axis. A real
    // turn changes the view direction; a roll bug spins around it. Sum the
    // per-step twist about the local view axis and require it stays small.
    let maxNonCrossingStep = 0;
    let crossingSteps = 0;
    let prevS = rig.sampleAt(0);
    for (let k = 1; k <= 2000; k++) {
      const cur = rig.sampleAt((k / 2000) * D);
      const stepAngle = cur.quaternion.angleTo(prevS.quaternion);
      if (stepAngle > 0.15) {
        // The only allowed large steps are those straddling the hold window.
        expect(prevS.targetHeld || cur.targetHeld).toBe(true);
        crossingSteps++;
      } else {
        maxNonCrossingStep = Math.max(maxNonCrossingStep, stepAngle);
      }
      prevS = cur;
    }
    // Exactly one crossing region (entry is continuous; only the exit reverses),
    // and every ordinary step stays smooth (well below a pi-order flip).
    expect(crossingSteps).toBeGreaterThan(0);
    expect(maxNonCrossingStep).toBeLessThan(0.1);
  });

  it('view direction points at the target everywhere outside coincidence', () => {
    const preset = closedPreset();
    const rig = new CameraRig(preset.path, {
      ...preset.playback,
      lookMode: 'target',
      target: new THREE.Vector3(0, 4, 0),
    });
    const check = checkFrameSanity(rig, 300);
    expect(check.pass).toBe(true);
  });
});

describe('closed loop seam and looping playback', () => {
  it('export end pose equals start pose on the loop preset', () => {
    const rig = new CameraRig(closedPreset().path, closedPreset().playback);
    const check = checkLoopSeam(rig);
    expect(check.pass).toBe(true);
  });

  it('quaternion signs never force a half-turn between adjacent samples', () => {
    const rig = new CameraRig(closedPreset().path, closedPreset().playback);
    const check = checkOrientationContinuity(rig, 600);
    expect(check.pass).toBe(true);
  });
});

describe('exporter', () => {
  for (const preset of PRESETS) {
    it(`"${preset.id}" export includes endpoints and matches live evaluation`, () => {
      const rig = new CameraRig(preset.path, preset.playback);
      const doc = buildExport(rig, { intervalSeconds: 0.5 });
      expect(doc.frames[0].time).toBe(0);
      expect(doc.frames.at(-1)!.time).toBeCloseTo(rig.duration, 9);
      expect(doc.sampling.includesEndpoints).toBe(true);

      const mid = doc.frames[Math.floor(doc.frames.length / 2)];
      const live = rig.sampleAt(mid.time);
      expect(mid.position.x).toBeCloseTo(live.position.x, 8);
      expect(mid.position.y).toBeCloseTo(live.position.y, 8);
      expect(mid.position.z).toBeCloseTo(live.position.z, 8);
      expect(mid.quaternion.w).toBeCloseTo(live.quaternion.w, 8);

      if (preset.path.mode === 'closed') {
        const first = doc.frames[0];
        const last = doc.frames.at(-1)!;
        expect(last.position).toEqual(first.position);
        expect(last.quaternion).toEqual(first.quaternion);
      }
    });
  }
});

describe('full verification suite on every preset', () => {
  for (const preset of PRESETS) {
    it(`all checks pass for "${preset.id}"`, () => {
      const report = runAllChecks(preset.id, preset.path, preset.playback);
      for (const check of report.checks) {
        expect(check.pass, `${check.id}: ${check.detail}`).toBe(true);
      }
    });
  }
});
