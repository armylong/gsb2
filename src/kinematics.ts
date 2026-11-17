/**
 * Pure-math robot-arm kinematics.
 *
 * Geometry (base local frame, degrees for joint angles):
 *
 *   base pedestal top  B = (0, PEDESTAL_HEIGHT, 0)
 *   J1 (yaw axis Y)    at B, angle q1 rotates around Y
 *   J2 (pitch axis Z)  at B, q2 rotates around the yawed Z axis
 *   J3 (pitch axis Z)  at J2 + link1 * e1, q3
 *   J4 (pitch axis Z)  at J3 + link2 * e2, q4
 *   end E             at J4 + link3 * e3
 *
 * The three pitch joints share parallel (Z) axes, so the arm is planar in
 * the vertical plane selected by q1. All three planar joints have their own
 * independent angle limits (limits apply to the joint variable, not the
 * accumulated bend).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface JointLimit {
  min: number; // degrees
  max: number; // degrees
}

export interface ArmParams {
  link1: number;
  link2: number;
  link3: number;
  limits: {
    q1: JointLimit;
    q2: JointLimit;
    q3: JointLimit;
    q4: JointLimit;
  };
}

export interface JointAngles {
  q1: number; // yaw, deg
  q2: number; // shoulder pitch, deg
  q3: number; // elbow pitch, deg
  q4: number; // wrist pitch, deg
}

export interface FKResult {
  joints: [Vec3, Vec3, Vec3, Vec3]; // J1..J4 positions in base local frame
  end: Vec3; // end-effector position in base local frame
  links: [Vec3, Vec3, Vec3]; // unit directions of the three links
}

export interface IKResult {
  angles: JointAngles;
  endLocal: Vec3;
  residual: number;
  reached: boolean;
  iterations: number;
  reason: 'reached' | 'too-far' | 'limited' | 'near-axis';
}

/** Fixed pedestal height: base frame origin sits on the ground, J1 is here. */
export const PEDESTAL_HEIGHT = 0.22;
export const REACH_TOLERANCE = 0.005; // 5 mm

export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(a: number): number {
  let r = ((a + 180) % 360 + 360) % 360 - 180;
  if (r === -180) r = 180;
  return r;
}

/** Rotate vector around Y by angle in degrees (right-hand rule). */
function rotY(p: Vec3, deg: number): Vec3 {
  const c = Math.cos(deg2rad(deg));
  const s = Math.sin(deg2rad(deg));
  return { x: c * p.x + s * p.z, y: p.y, z: -s * p.x + c * p.z };
}

/** Rotate vector around Z by angle in degrees (right-hand rule). */
function rotZ(p: Vec3, deg: number): Vec3 {
  const c = Math.cos(deg2rad(deg));
  const s = Math.sin(deg2rad(deg));
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y, z: p.z };
}

export function clampAngles(a: JointAngles, p: ArmParams): JointAngles {
  return {
    q1: clamp(a.q1, p.limits.q1.min, p.limits.q1.max),
    q2: clamp(a.q2, p.limits.q2.min, p.limits.q2.max),
    q3: clamp(a.q3, p.limits.q3.min, p.limits.q3.max),
    q4: clamp(a.q4, p.limits.q4.min, p.limits.q4.max),
  };
}

/**
 * Forward kinematics in the BASE LOCAL frame, built as nested frame
 * composition (parent rotation -> child direction -> child position).
 * The three.js scene graph mirrors exactly this nesting.
 */
export function forwardKinematics(params: ArmParams, angles: JointAngles): FKResult {
  const B: Vec3 = v(0, PEDESTAL_HEIGHT, 0);

  // Rest directions point along +X; each pitch joint rotates around its own
  // (yawed) Z axis. J1 yaws the whole plane around Y.
  const e1 = rotY(rotZ(v(1, 0, 0), angles.q2), angles.q1);
  const e2 = rotY(rotZ(v(1, 0, 0), angles.q2 + angles.q3), angles.q1);
  const e3 = rotY(rotZ(v(1, 0, 0), angles.q2 + angles.q3 + angles.q4), angles.q1);

  const j1 = B;
  const j2 = B; // J1 and J2 share the pedestal-top pivot (different axes)
  const j3 = add(j2, scale(e1, params.link1));
  const j4 = add(j3, scale(e2, params.link2));
  const end = add(j4, scale(e3, params.link3));

  return { joints: [j1, j2, j3, j4], end, links: [e1, e2, e3] };
}

/**
 * Independent FK implementation using explicit per-link trigonometry rather
 * than frame composition. Used by the known-pose checks so the "expected"
 * and "actual" values are computed by two separate derivations.
 */
export function forwardKinematicsExplicit(params: ArmParams, angles: JointAngles): Vec3 {
  const c1 = Math.cos(deg2rad(angles.q1));
  const s1 = Math.sin(deg2rad(angles.q1));
  const bend = (rad: number) => ({
    x: Math.cos(rad),
    y: Math.sin(rad),
  });
  const b2 = bend(deg2rad(angles.q2));
  const b3 = bend(deg2rad(angles.q2 + angles.q3));
  const b4 = bend(deg2rad(angles.q2 + angles.q3 + angles.q4));

  // Horizontal (x,z) plane projection uses cos(yaw)/sin(yaw); vertical is y.
  const push = (b: { x: number; y: number }, len: number): Vec3 => ({
    x: len * b.x * c1,
    y: len * b.y,
    z: -len * b.x * s1,
  });

  let p: Vec3 = v(0, PEDESTAL_HEIGHT, 0);
  p = add(p, push(b2, params.link1));
  p = add(p, push(b3, params.link2));
  p = add(p, push(b4, params.link3));
  return p;
}

export function maxReach(params: ArmParams): number {
  return params.link1 + params.link2 + params.link3;
}

// ---------------------------------------------------------------------------
// Base (rigid) transform helpers: the base group carries translation + Y yaw.
// ---------------------------------------------------------------------------

export interface BaseTransform {
  position: Vec3;
  yawDeg: number;
}

export function worldToLocal(w: Vec3, base: BaseTransform): Vec3 {
  const shifted = sub(w, base.position);
  // inverse of rotY(yaw): rotate by -yaw
  return rotY(shifted, -base.yawDeg);
}

export function localToWorld(l: Vec3, base: BaseTransform): Vec3 {
  return add(rotY(l, base.yawDeg), base.position);
}

// ---------------------------------------------------------------------------
// Inverse kinematics: yaw alignment + planar CCD with per-joint limits.
// Warm-started from the previous angles, so continuous target motion keeps
// the same branch (no whole-arm flips).
// ---------------------------------------------------------------------------

interface PlanarPoint {
  x: number;
  y: number;
}

function planarFK(
  params: ArmParams,
  a: JointAngles
): { pivots: [PlanarPoint, PlanarPoint, PlanarPoint, PlanarPoint]; end: PlanarPoint } {
  const B: PlanarPoint = { x: 0, y: PEDESTAL_HEIGHT };
  const p2 = B;
  const p3 = {
    x: p2.x + params.link1 * Math.cos(deg2rad(a.q2)),
    y: p2.y + params.link1 * Math.sin(deg2rad(a.q2)),
  };
  const p4 = {
    x: p3.x + params.link2 * Math.cos(deg2rad(a.q2 + a.q3)),
    y: p3.y + params.link2 * Math.sin(deg2rad(a.q2 + a.q3)),
  };
  const end = {
    x: p4.x + params.link3 * Math.cos(deg2rad(a.q2 + a.q3 + a.q4)),
    y: p4.y + params.link3 * Math.sin(deg2rad(a.q2 + a.q3 + a.q4)),
  };
  return { pivots: [B, p2, p3, p4], end };
}

const planarAngle = (from: PlanarPoint, to: PlanarPoint): number =>
  rad2deg(Math.atan2(to.y - from.y, to.x - from.x));

export function solveIK(
  params: ArmParams,
  targetLocal: Vec3,
  start: JointAngles,
  ccdIterations = 45,
  refineIterations = 150
): IKResult {
  const angles = clampAngles(start, params);
  const total = maxReach(params);

  const radial = Math.hypot(targetLocal.x, targetLocal.z);
  const relY = targetLocal.y - PEDESTAL_HEIGHT;
  const planarDistance = Math.hypot(radial, relY);
  const tooFar = planarDistance > total + 1e-9;

  // Planar target (remove yaw): x = radial distance, y = absolute height.
  const planarTarget: PlanarPoint = { x: radial, y: targetLocal.y };
  const jointKeys = ['q2', 'q3', 'q4'] as const;

  // --- yaw: align the arm plane with the target (atan2, continuous) --------
  // rotY(yaw) maps local +X to (cos yaw, 0, -sin yaw), so yaw = atan2(-z, x).
  if (radial > 1e-6) {
    const desiredYaw = rad2deg(Math.atan2(-targetLocal.z, targetLocal.x));
    angles.q1 = clamp(
      angles.q1 + wrapDeg(desiredYaw - angles.q1),
      params.limits.q1.min,
      params.limits.q1.max
    );
  }

  // --- out of reach: the straight arm pointing at the target is the
  // global residual minimum (links can never be longer than their sum) ------
  if (tooFar) {
    const phi = rad2deg(Math.atan2(relY, radial));
    const straight = clampAngles(
      { q1: angles.q1, q2: phi, q3: 0, q4: 0 },
      params
    );
    const fk = forwardKinematics(params, straight);
    return {
      angles: straight,
      endLocal: fk.end,
      residual: distance(fk.end, targetLocal),
      reached: false,
      iterations: 0,
      reason: 'too-far',
    };
  }

  // --- phase 1: damped planar CCD sweeps (wrist -> elbow -> shoulder) ------
  // Per-joint per-iteration move cap keeps consecutive solves continuous:
  // a target moving a little can never make one joint swing 60°.
  const CCD_MAX_STEP = 8; // degrees
  let iterations = 0;
  for (iterations = 0; iterations < ccdIterations; iterations++) {
    const { pivots, end } = planarFK(params, angles);
    let moved = 0;
    for (let j = 2; j >= 0; j--) {
      const cur = planarAngle(pivots[j], end);
      const tgt = planarAngle(pivots[j], planarTarget);
      const delta = clamp(wrapDeg(tgt - cur), -CCD_MAX_STEP, CCD_MAX_STEP);
      if (Math.abs(delta) < 1e-9) continue;
      const key = jointKeys[j];
      const lim = params.limits[key];
      const before = angles[key];
      angles[key] = clamp(before + delta, lim.min, lim.max);
      moved += Math.abs(angles[key] - before);
    }
    if (moved < 1e-7) break;
  }

  // --- phase 2: projected-gradient refinement on squared planar distance ---
  // Escapes CCD local minima when a joint sits against its limit. Each move
  // is projected back into the active joint box (active-set style).
  // A small warm-start regularizer keeps the redundant third DOF on the same
  // posture branch, so continuous target motion cannot trigger whole-arm
  // reconfiguration (no gratuitous flips between equivalent IK solutions).
  const warm = { ...angles };
  // Gentle branch bias only: tiny compared with the distance gradient, so it
  // can never pin a joint against a limit or block convergence to a target.
  const postureWeight = 1e-8;
  const planarResidualSq = (a: JointAngles): number => {
    const e = planarFK(params, a).end;
    const dx = e.x - planarTarget.x;
    const dy = e.y - planarTarget.y;
    let posture = 0;
    for (const key of jointKeys) {
      posture += (a[key] - warm[key]) ** 2;
    }
    return dx * dx + dy * dy + postureWeight * posture;
  };
  const eps = 0.05; // degrees, finite-difference step
  let step = 0.5; // max degrees moved per joint per refinement iteration
  const REFINEMENT_MAX_STEP = 6; // hard per-joint cap, keeps solves continuous
  let bestSq = planarResidualSq(angles);

  for (let k = 0; k < refineIterations; k++) {
    const grad: number[] = [];
    for (const key of jointKeys) {
      const probe = { ...angles, [key]: angles[key] + eps };
      grad.push((planarResidualSq(probe) - bestSq) / eps);
    }
    const gNorm = Math.hypot(...grad) || 1;
    const candidate = { ...angles };
    for (let j = 0; j < 3; j++) {
      const key = jointKeys[j];
      const lim = params.limits[key];
      const raw = (-grad[j] / gNorm) * step;
      const move = clamp(raw, -REFINEMENT_MAX_STEP, REFINEMENT_MAX_STEP);
      candidate[key] = clamp(angles[key] + move, lim.min, lim.max);
    }
    const candSq = planarResidualSq(candidate);
    if (candSq < bestSq - 1e-14) {
      Object.assign(angles, candidate);
      bestSq = candSq;
    } else {
      step *= 0.5;
      if (step < 1e-5) break;
    }
    if (bestSq <= REACH_TOLERANCE * REACH_TOLERANCE) break;
  }

  const fk = forwardKinematics(params, angles);
  const residual = distance(fk.end, targetLocal);
  const reached = residual <= REACH_TOLERANCE;

  let reason: IKResult['reason'];
  if (reached) reason = 'reached';
  else if (radial <= 1e-6 && Math.abs(relY) > 1e-6) reason = 'near-axis';
  else reason = 'limited';

  return {
    angles,
    endLocal: fk.end,
    residual,
    reached,
    iterations,
    reason,
  };
}
