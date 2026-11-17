import { describe, it, expect } from 'vitest';
import {
  ArmParams,
  JointAngles,
  PEDESTAL_HEIGHT,
  forwardKinematics,
  forwardKinematicsExplicit,
  solveIK,
  worldToLocal,
  localToWorld,
  distance,
  clampAngles,
  wrapDeg,
  maxReach,
  REACH_TOLERANCE,
} from '../src/kinematics';

const params: ArmParams = {
  link1: 0.8,
  link2: 0.7,
  link3: 0.5,
  limits: {
    q1: { min: -170, max: 170 },
    q2: { min: -80, max: 80 },
    q3: { min: -130, max: 130 },
    q4: { min: -130, max: 130 },
  },
};

const rng = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
};

const randomAngles = (r: () => number): JointAngles => ({
  q1: -160 + r() * 320,
  q2: -75 + r() * 150,
  q3: -120 + r() * 240,
  q4: -120 + r() * 240,
});

describe('two independent FK implementations', () => {
  it('agree on 200 random in-limit poses', () => {
    const r = rng(42);
    let maxErr = 0;
    for (let i = 0; i < 200; i++) {
      const a = randomAngles(r);
      const p1 = forwardKinematics(params, a).end;
      const p2 = forwardKinematicsExplicit(params, a);
      const err = distance(p1, p2);
      maxErr = Math.max(maxErr, err);
      expect(err).toBeLessThan(1e-12);
    }
    expect(maxErr).toBeLessThan(1e-12);
  });

  it('straight arm reaches exactly L1+L2+L3 along +X at pedestal height', () => {
    const straight: JointAngles = { q1: 0, q2: 0, q3: 0, q4: 0 };
    const end = forwardKinematics(params, straight).end;
    expect(end.x).toBeCloseTo(maxReach(params), 12);
    expect(end.y).toBeCloseTo(PEDESTAL_HEIGHT, 12);
    expect(end.z).toBeCloseTo(0, 12);
  });

  it('explicit known bent pose matches hand-calculated trig values', () => {
    // q2=30, q3=-60, q4=30 -> link directions 30°, -30°, 0°
    const a: JointAngles = { q1: 0, q2: 30, q3: -60, q4: 30 };
    const end = forwardKinematicsExplicit(params, a);
    const c30 = Math.cos(Math.PI / 6);
    const s30 = 0.5;
    const x = 0.8 * c30 + 0.7 * c30 + 0.5;
    const y = PEDESTAL_HEIGHT + 0.8 * s30 - 0.7 * s30;
    expect(end.x).toBeCloseTo(x, 12);
    expect(end.y).toBeCloseTo(y, 12);
    expect(end.z).toBeCloseTo(0, 12);
  });

  it('nested links: J3 and J4 chain positions are consistent with link unit vectors', () => {
    const r = rng(7);
    for (let i = 0; i < 50; i++) {
      const a = randomAngles(r);
      const fk = forwardKinematics(params, a);
      const [, , j3, j4] = fk.joints;
      expect(distance(j3, fk.joints[1])).toBeCloseTo(params.link1, 10);
      expect(distance(j4, j3)).toBeCloseTo(params.link2, 10);
      expect(distance(fk.end, j4)).toBeCloseTo(params.link3, 10);
    }
  });
});

describe('base rigid transform', () => {
  it('worldToLocal/localToWorld are exact inverses including yaw', () => {
    const r = rng(99);
    const base = { position: { x: 1.2, y: 0, z: -0.7 }, yawDeg: 53 };
    for (let i = 0; i < 50; i++) {
      const w = { x: r() * 4 - 2, y: r() * 3, z: r() * 4 - 2 };
      const back = localToWorld(worldToLocal(w, base), base);
      expect(back.x).toBeCloseTo(w.x, 12);
      expect(back.y).toBeCloseTo(w.y, 12);
      expect(back.z).toBeCloseTo(w.z, 12);
    }
  });

  it('rotating the base 45° rotates the end world position but keeps local angles', () => {
    const a: JointAngles = { q1: 0, q2: 20, q3: 40, q4: -60 };
    const local = forwardKinematics(params, a).end;
    const w0 = localToWorld(local, { position: { x: 0, y: 0, z: 0 }, yawDeg: 0 });
    const w45 = localToWorld(local, { position: { x: 0, y: 0, z: 0 }, yawDeg: 45 });
    // radial distance from base origin is invariant
    const r0 = Math.hypot(w0.x, w0.z);
    const r45 = Math.hypot(w45.x, w45.z);
    expect(r45).toBeCloseTo(r0, 12);
    expect(w45.y).toBeCloseTo(w0.y, 12);
    // azimuth advances by exactly 45°
    const az0 = Math.atan2(w0.z, w0.x);
    const az45 = Math.atan2(w45.z, w45.x);
    expect(wrapDeg(((az45 - az0) * 180) / Math.PI)).toBeCloseTo(-45, 10);
  });
});

describe('IK solver', () => {
  const start: JointAngles = { q1: 10, q2: 30, q3: -40, q4: 30 };

  it('reaches reachable targets inside the workspace within tolerance', () => {
    const targets = [
      { x: 1.2, y: PEDESTAL_HEIGHT + 0.45, z: 0.35 },
      { x: 0.6, y: PEDESTAL_HEIGHT - 0.2, z: 0.8 },
      { x: 1.5, y: PEDESTAL_HEIGHT + 0.1, z: -0.6 },
      { x: 0.9, y: PEDESTAL_HEIGHT + 0.6, z: 0.9 },
    ];
    for (const t of targets) {
      const res = solveIK(params, t, start);
      expect(res.reached, `target ${JSON.stringify(t)} should be reached`).toBe(true);
      expect(res.residual).toBeLessThanOrEqual(REACH_TOLERANCE);
      // every joint stays inside its limits
      for (const k of ['q1', 'q2', 'q3', 'q4'] as const) {
        expect(res.angles[k]).toBeGreaterThanOrEqual(params.limits[k].min - 1e-9);
        expect(res.angles[k]).toBeLessThanOrEqual(params.limits[k].max + 1e-9);
      }
    }
  });

  it('out-of-reach target: stays legal, reports too-far and nonzero residual', () => {
    const t = { x: maxReach(params) * 1.6, y: PEDESTAL_HEIGHT + 0.2, z: 0 };
    const res = solveIK(params, t, start);
    expect(res.reached).toBe(false);
    expect(res.reason).toBe('too-far');
    expect(res.residual).toBeGreaterThan(REACH_TOLERANCE);
    // global optimum for an unreachable target: straight arm (q3=q4=0)
    // pointing at the target's bearing
    expect(res.angles.q3).toBeCloseTo(0, 8);
    expect(res.angles.q4).toBeCloseTo(0, 8);
    const bearing =
      (Math.atan2(0.2, maxReach(params) * 1.6) * 180) / Math.PI;
    expect(res.angles.q2).toBeCloseTo(bearing, 6);
  });

  it('joint-limited target: within total length but unreachable due to q2 limit', () => {
    // nearly straight up (elevation ~87°); q2 is capped at 80°
    const t = { x: 0.1, y: PEDESTAL_HEIGHT + 1.99, z: 0 };
    expect(Math.hypot(t.x, t.y - PEDESTAL_HEIGHT)).toBeLessThan(maxReach(params));
    const res = solveIK(params, t, start);
    expect(res.reached).toBe(false);
    expect(res.reason).toBe('limited');
    expect(res.residual).toBeGreaterThan(REACH_TOLERANCE);
    for (const k of ['q1', 'q2', 'q3', 'q4'] as const) {
      expect(res.angles[k]).toBeGreaterThanOrEqual(params.limits[k].min - 1e-9);
      expect(res.angles[k]).toBeLessThanOrEqual(params.limits[k].max + 1e-9);
    }
  });

  it('re-enters reachable range and reaches again after a too-far target', () => {
    const far = solveIK(
      params,
      { x: maxReach(params) * 1.5, y: PEDESTAL_HEIGHT, z: 0 },
      start
    );
    expect(far.reached).toBe(false);
    const near = solveIK(
      params,
      { x: 1.1, y: PEDESTAL_HEIGHT + 0.3, z: 0.2 },
      far.angles
    );
    expect(near.reached).toBe(true);
  });

  it('continuous cross-side path stays smooth: no angle jump > 40° between samples', () => {
    const h = PEDESTAL_HEIGHT;
    const path = [
      { x: 1.5, y: h + 0.12, z: 0.9 },
      { x: 1.0, y: h + 0.22, z: 0.45 },
      { x: 0.5, y: h + 0.17, z: 0.08 },
      { x: 0.45, y: h + 0.12, z: -0.05 },
      { x: 0.9, y: h + 0.22, z: -0.5 },
      { x: 1.5, y: h + 0.12, z: -0.9 },
    ];
    // dense sub-sampling at the runtime frame rate (0.9 unit/s / 60 fps)
    const stepsPerSegment = 67;
    const dense: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      for (let s = 0; s < stepsPerSegment; s++) {
        const f = s / stepsPerSegment;
        dense.push({
          x: path[i].x + (path[i + 1].x - path[i].x) * f,
          y: path[i].y + (path[i + 1].y - path[i].y) * f,
          z: path[i].z + (path[i + 1].z - path[i].z) * f,
        });
      }
    }
    dense.push(path[path.length - 1]);

    // warm-start the first point exactly like the runtime does, then walk
    // the path at frame rate; warm starts must avoid whole-arm flips
    let angles = solveIK(params, dense[0], start).angles;
    let maxJump = 0;
    for (let i = 1; i < dense.length; i++) {
      const t = dense[i];
      const res = solveIK(params, t, angles);
      for (const k of ['q1', 'q2', 'q3', 'q4'] as const) {
        maxJump = Math.max(maxJump, Math.abs(wrapDeg(res.angles[k] - angles[k])));
      }
      angles = res.angles;
    }
    // observed per-frame worst case ~37°; bound leaves margin while still
    // catching any branch flip (a flip would exceed 90° in one step)
    expect(maxJump).toBeLessThan(45);
  });

  it('never returns angles outside limits even from out-of-limit warm starts', () => {
    const bad: JointAngles = { q1: 999, q2: -999, q3: 1234, q4: -1234 };
    const res = solveIK(params, { x: 1, y: PEDESTAL_HEIGHT, z: 0 }, bad);
    const clamped = clampAngles(bad, params);
    expect(res.angles.q1).toBeGreaterThanOrEqual(params.limits.q1.min);
    expect(res.angles.q1).toBeLessThanOrEqual(params.limits.q1.max);
    expect(clamped.q2).toBe(params.limits.q2.min);
    expect(clamped.q3).toBe(params.limits.q3.max);
    expect(clamped.q4).toBe(params.limits.q4.min);
    for (const k of ['q1', 'q2', 'q3', 'q4'] as const) {
      expect(res.angles[k]).toBeGreaterThanOrEqual(params.limits[k].min - 1e-9);
      expect(res.angles[k]).toBeLessThanOrEqual(params.limits[k].max + 1e-9);
    }
  });
});
