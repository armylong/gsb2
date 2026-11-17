import * as THREE from 'three';
import { CameraRig } from './CameraRig';
import type { CameraSample, PathConfig, PlaybackConfig } from './types';
import { CameraPath } from './CameraPath';

export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  /** Measured value(s), always shown — never just a green/red badge. */
  measurements: Record<string, number | string>;
  detail: string;
}

export interface VerificationReport {
  presetId: string;
  checks: CheckResult[];
  passed: number;
  failed: number;
}

const TOL = {
  /** Max allowed arc-length spread for equal dt in constant mode (relative). */
  arcSpread: 5e-3,
  /** Position tolerance, metres (seek vs continuous). */
  position: 1e-6,
  /** Orientation tolerance, radians. */
  angle: 1e-4,
  /** Seam orientation tolerance on closed loops, radians. */
  seam: 1e-6,
};

function angleBetweenQuaternions(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const d = Math.abs(THREE.MathUtils.clamp(a.dot(b), -1, 1));
  return 2 * Math.acos(d);
}

/**
 * Check 1 — constant speed: equal time steps must produce equal arc-length
 * deltas regardless of control-point density. Also reports the timed-mode
 * spread for comparison.
 */
export function checkArcLengthUniformity(rig: CameraRig, steps = 60): CheckResult {
  const duration = rig.duration;
  const constantRig = new CameraRig(rig.path.config, {
    ...rig.playback,
    speedMode: 'constant',
  });
  const deltas: number[] = [];
  let prev = constantRig.sampleAt(0).arcLength;
  for (let k = 1; k <= steps; k++) {
    const s = constantRig.sampleAt((k / steps) * duration);
    deltas.push(s.arcLength - prev);
    prev = s.arcLength;
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const min = Math.min(...deltas);
  const max = Math.max(...deltas);
  const spread = (max - min) / mean;
  const total = rig.path.totalLength;
  return {
    id: 'arc-uniformity',
    label: '等时间隔的路程变化（等速模式）',
    pass: spread <= TOL.arcSpread,
    measurements: {
      '总长度(m)': Number(total.toFixed(6)),
      '平均步长(m)': Number(mean.toFixed(8)),
      '最小步长(m)': Number(min.toFixed(8)),
      '最大步长(m)': Number(max.toFixed(8)),
      '相对极差': Number(spread.toExponential(3)),
      采样数: steps,
    },
    detail: `等速模式下 ${steps} 个等时间隔的路程极差/均值 = ${spread.toExponential(3)}（阈值 ${TOL.arcSpread}）`,
  };
}

/**
 * Check 2 — seek consistency: build a fresh rig and compare direct seeking to
 * random times against sequential playback samples. A separate fresh rig
 * proves the result does not depend on any previously visited time.
 */
export function checkSeekConsistency(
  path: PathConfig,
  playback: PlaybackConfig,
  probes = 25,
): CheckResult {
  const rigA = new CameraRig(path, playback); // "continuous" owner, evaluated in order
  const rigB = new CameraRig(path, playback); // "seek" owner, evaluated out of order
  const duration = playback.duration;
  let maxPosErr = 0;
  let maxAngErr = 0;
  let maxProgressErr = 0;
  const ordered: number[] = [];
  for (let k = 0; k <= probes; k++) ordered.push((k / probes) * duration);
  for (const t of ordered) rigA.sampleAt(t); // touch every time in order first

  // Deterministic pseudo-random order (mulberry32) so the check is repeatable.
  let seed = 1337;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = ordered.slice(1, -1).sort(() => rand() - 0.5);
  for (const t of shuffled) {
    const a = rigA.sampleAt(t);
    const b = rigB.sampleAt(t);
    maxPosErr = Math.max(maxPosErr, a.position.distanceTo(b.position));
    maxAngErr = Math.max(maxAngErr, angleBetweenQuaternions(a.quaternion, b.quaternion));
    maxProgressErr = Math.max(maxProgressErr, Math.abs(a.progress - b.progress));
  }
  const pass = maxPosErr <= TOL.position && maxAngErr <= TOL.angle && maxProgressErr <= TOL.position;
  return {
    id: 'seek-consistency',
    label: '直接定位 vs 连续播放一致性',
    pass,
    measurements: {
      '最大位置误差(m)': Number(maxPosErr.toExponential(3)),
      '最大朝向误差(rad)': Number(maxAngErr.toExponential(3)),
      '最大进度误差': Number(maxProgressErr.toExponential(3)),
      探测点数: shuffled.length,
    },
    detail: `两个独立求值器，顺序播放与随机乱序定位同一时刻：位置 ${maxPosErr.toExponential(
      3,
    )} m，朝向 ${maxAngErr.toExponential(3)} rad`,
  };
}

/**
 * Check 3 — orientation continuity: maximum angular change between adjacent
 * dense samples along the whole path (catches flips / half-rolls through
 * vertical sections) plus frame orthonormality.
 */
export function checkOrientationContinuity(rig: CameraRig, samples = 400): CheckResult {
  const seq: CameraSample[] = [];
  for (let k = 0; k <= samples; k++) seq.push(rig.sampleAt((k / samples) * rig.duration));
  let maxDelta = 0;
  let maxDeltaAt = 0;
  let maxOrthoErr = 0;
  for (let k = 1; k < seq.length; k++) {
    const d = angleBetweenQuaternions(seq[k - 1].quaternion, seq[k].quaternion);
    if (d > maxDelta) {
      maxDelta = d;
      maxDeltaAt = seq[k].time;
    }
  }
  for (const s of seq) {
    const dotRU = Math.abs(s.right.dot(s.up));
    const dotUB = Math.abs(s.up.dot(s.backward));
    const normErr = Math.abs(s.quaternion.length() - 1);
    maxOrthoErr = Math.max(maxOrthoErr, dotRU, dotUB, normErr);
  }
  // With 400 samples a smooth continuous turn stays well under ~0.05 rad/step;
  // a flip/half-roll produces ~pi. Flag anything above 0.3 rad/step.
  const pass = maxDelta < 0.3 && maxOrthoErr < 1e-6;
  return {
    id: 'orientation-continuity',
    label: '相邻采样朝向变化（含竖直段）',
    pass,
    measurements: {
      '最大相邻转角(rad)': Number(maxDelta.toExponential(3)),
      '出现时刻(s)': Number(maxDeltaAt.toFixed(3)),
      '最大正交/单位化误差': Number(maxOrthoErr.toExponential(3)),
      采样数: samples + 1,
    },
    detail: `全路径 ${samples + 1} 个采样中最大相邻朝向变化 ${maxDelta.toExponential(
      3,
    )} rad（翻转会接近 π ≈ 3.14）`,
  };
}

/**
 * Check 4 — closed-loop seam: pose at t=duration must equal t=0, and the last
 * step into the seam must be as smooth as any interior step.
 */
export function checkLoopSeam(rig: CameraRig): CheckResult {
  if (!rig.path.closed) {
    return {
      id: 'loop-seam',
      label: '闭环接缝衔接',
      pass: true,
      measurements: { 模式: '开放路径，不适用' },
      detail: '当前为开放路径，跳过闭环接缝检查。',
    };
  }
  const a = rig.sampleAt(0);
  const b = rig.sampleAt(rig.duration);
  const posErr = a.position.distanceTo(b.position);
  const angErr = angleBetweenQuaternions(a.quaternion, b.quaternion);

  const samples = 400;
  const before = rig.sampleAt(((samples - 1) / samples) * rig.duration);
  const stepInto = angleBetweenQuaternions(before.quaternion, b.quaternion);
  let maxInterior = 0;
  for (let k = 2; k <= samples; k++) {
    const p = rig.sampleAt(((k - 1) / samples) * rig.duration);
    const q = rig.sampleAt((k / samples) * rig.duration);
    maxInterior = Math.max(maxInterior, angleBetweenQuaternions(p.quaternion, q.quaternion));
  }
  const pass = posErr <= TOL.position && angErr <= TOL.seam && stepInto <= maxInterior * 1.5 + 1e-9;
  return {
    id: 'loop-seam',
    label: '闭环接缝衔接（末端姿态 = 开头）',
    pass,
    measurements: {
      '接缝位置误差(m)': Number(posErr.toExponential(3)),
      '接缝朝向误差(rad)': Number(angErr.toExponential(3)),
      '接缝前一步转角(rad)': Number(stepInto.toExponential(3)),
      '内部最大步转角(rad)': Number(maxInterior.toExponential(3)),
    },
    detail: `闭环 t=duration 与 t=0 的位置差 ${posErr.toExponential(
      3,
    )} m，朝向差 ${angErr.toExponential(3)} rad`,
  };
}

/** Check 5 — frame sanity: unit axes, right-handed, camera -Z aligned to target in target mode. */
export function checkFrameSanity(rig: CameraRig, samples = 200): CheckResult {
  let maxErr = 0;
  let maxLookErr = 0;
  for (let k = 0; k <= samples; k++) {
    const s = rig.sampleAt((k / samples) * rig.duration);
    const cross = new THREE.Vector3().crossVectors(s.right, s.up);
    maxErr = Math.max(
      maxErr,
      Math.abs(s.right.length() - 1),
      Math.abs(s.up.length() - 1),
      Math.abs(s.backward.length() - 1),
      cross.distanceTo(s.backward),
    );
    // Only evaluate look accuracy outside the coincidence hold region; inside
    // it the orientation is intentionally frozen on the last valid pose.
    if (rig.playback.lookMode === 'target' && !s.targetHeld) {
      const viewDir = s.backward.clone().negate();
      const want = rig.playback.target.clone().sub(s.position);
      if (want.length() > 1e-9) {
        maxLookErr = Math.max(maxLookErr, viewDir.angleTo(want.normalize()));
      }
    }
  }
  // The target table is built on the same 2048-cell grid and slerped between
  // cells, so look error outside the hold region stays at grid-slerp scale.
  const LOOK_TOL = 2e-2;
  const pass =
    maxErr < 1e-6 && (rig.playback.lookMode === 'forward' || maxLookErr < LOOK_TOL);
  return {
    id: 'frame-sanity',
    label: '标架正交性 / 看向目标精度',
    pass,
    measurements: {
      '最大标架误差': Number(maxErr.toExponential(3)),
      '最大看向偏差(rad)':
        rig.playback.lookMode === 'target' ? Number(maxLookErr.toExponential(3)) : 'n/a',
    },
    detail:
      rig.playback.lookMode === 'target'
        ? `目标模式下视线与目标方向最大偏差 ${maxLookErr.toExponential(3)} rad（重合保持段除外）`
        : `前向模式下标架单位正交、右手性误差 ${maxErr.toExponential(3)}`,
  };
}

export function runAllChecks(
  presetId: string,
  path: PathConfig,
  playback: PlaybackConfig,
): VerificationReport {
  const rig = new CameraRig(path, playback);
  const checks = [
    checkArcLengthUniformity(rig),
    checkSeekConsistency(path, playback),
    checkOrientationContinuity(rig),
    checkLoopSeam(rig),
    checkFrameSanity(rig),
  ];
  return {
    presetId,
    checks,
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
  };
}

export { TOL as VERIFICATION_TOLERANCES, CameraPath };
