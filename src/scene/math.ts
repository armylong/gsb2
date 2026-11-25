import {
  RIDGES,
  SUN_AZIMUTH_RAD,
  VERTICAL_FOV_DEG,
  type CpuHit,
  type SceneParams,
  type Vec3,
} from './config';

export const DEG = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function sunDirection(pick: Pick<SceneParams, 'sunElevationDeg'>): Vec3 {
  const e = pick.sunElevationDeg * DEG;
  const c = Math.cos(e);
  return [
    Math.sin(SUN_AZIMUTH_RAD) * c,
    Math.sin(e),
    Math.cos(SUN_AZIMUTH_RAD) * c,
  ];
}

export interface CameraBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  tanHalfFov: number;
  aspect: number;
}

export function cameraBasis(
  params: Pick<SceneParams, 'viewPitchDeg' | 'yawDeg'>,
  aspect: number,
): CameraBasis {
  const pitch = params.viewPitchDeg * DEG;
  const yaw = params.yawDeg * DEG;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);

  const forward: Vec3 = [sy * cp, sp, cy * cp];
  const right: Vec3 = [cy, 0, -sy];
  // cross(forward, right)
  const up: Vec3 = [-sp * sy, cp, -sp * cy];
  return {
    forward,
    right,
    up,
    tanHalfFov: Math.tan((VERTICAL_FOV_DEG * DEG) / 2),
    aspect,
  };
}

function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-12) return [0, 1, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function viewRay(
  params: Pick<SceneParams, 'viewPitchDeg' | 'yawDeg'>,
  ndcX: number,
  ndcY: number,
  aspect: number,
): Vec3 {
  const b = cameraBasis(params, aspect);
  let d = b.forward;
  d = addScaled(d, b.right, ndcX * b.tanHalfFov * aspect);
  d = addScaled(d, b.up, ndcY * b.tanHalfFov);
  return normalize(d);
}

export function directionAngles(d: Vec3): { elevationDeg: number; azimuthDeg: number } {
  const elevationDeg = Math.asin(clamp(d[1], -1, 1)) / DEG;
  // Matches theta = atan(x, z) used by the cylindrical ridges.
  const azimuthDeg = Math.atan2(d[0], d[2]) / DEG;
  return { elevationDeg, azimuthDeg };
}

export function projectDirection(
  d: Vec3,
  params: Pick<SceneParams, 'viewPitchDeg' | 'yawDeg'>,
  aspect: number,
): { x: number; y: number; visible: boolean } | null {
  const b = cameraBasis(params, aspect);
  const dot = (a: Vec3, v: Vec3) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const f = dot(d, b.forward);
  if (f <= 0.02) return null;
  const x = dot(d, b.right) / f / (b.tanHalfFov * aspect);
  const y = dot(d, b.up) / f / b.tanHalfFov;
  return { x, y, visible: Math.abs(x) <= 1.05 && Math.abs(y) <= 1.05 };
}

/** Exact counterpart of ridgeHeightTheta in the WebGL fragment shader. */
export function ridgeHeightTheta(
  theta: number,
  spec: (typeof RIDGES)[number],
): number {
  const s = spec.seed;
  const wave =
    0.5 * Math.sin(3 * theta + s) +
    0.27 * Math.sin(7 * theta - s * 1.7) +
    0.15 * Math.sin(13 * theta + s * 0.71) +
    0.08 * Math.sin(23 * theta + s * 2.13);
  return Math.max(0.12, spec.baseKm + spec.amplitudeKm * wave);
}

export function intersectSceneCpu(
  cameraHeightKm: number,
  rd: Vec3,
): CpuHit {
  const ro: Vec3 = [0, cameraHeightKm, 0];
  let best: CpuHit = { id: 0, label: '天空', distanceKm: Number.POSITIVE_INFINITY, point: ro };

  if (rd[1] < -1e-7) {
    const t = -ro[1] / rd[1];
    if (t > 0) {
      best = {
        id: 3,
        label: '地面',
        distanceKm: t,
        point: [ro[0] + rd[0] * t, 0, ro[2] + rd[2] * t],
      };
    }
  }

  const horizontalLength = Math.hypot(rd[0], rd[2]);
  if (horizontalLength > 1e-5) {
    for (const ridge of RIDGES) {
      const t = ridge.radiusKm / horizontalLength;
      if (t <= 0 || t >= best.distanceKm) continue;
      const p: Vec3 = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
      const theta = Math.atan2(p[0], p[2]);
      const h = ridgeHeightTheta(theta, ridge);
      if (p[1] <= h) {
        best = {
          id: ridge.id,
          label: ridge.name,
          distanceKm: t,
          point: p,
        };
      }
    }
  }

  if (best.id === 0 || !Number.isFinite(best.distanceKm)) {
    return { id: 0, label: '天空', distanceKm: 0, point: ro };
  }
  return best;
}

export function horizonDipDeg(cameraHeightKm: number, radiusKm = 6371): number {
  const h = Math.max(0.0005, cameraHeightKm);
  return Math.acos(clamp(radiusKm / (radiusKm + h), -1, 1)) / DEG;
}

export function horizonDirection(params: SceneParams): Vec3 {
  // A point just above the flat-scene/astronomical horizon. This stays clear of
  // numerical tangent ambiguity while still sampling the horizon accumulation.
  const yaw = params.yawDeg * DEG;
  const pitch = 0.18 * DEG;
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

export function farRidgeDirection(): Vec3 {
  // A fixed saddle where the 22 km ridge rises above the 8 km ridge.
  const azimuth = 58 * DEG;
  const elevation = 3.15 * DEG;
  const ce = Math.cos(elevation);
  return [
    Math.sin(azimuth) * ce,
    Math.sin(elevation),
    Math.cos(azimuth) * ce,
  ];
}

/** Direction exactly opposite the sun; useful as a back-scattering probe. */
export function antiSunDirection(params: SceneParams): Vec3 {
  const s = sunDirection(params);
  return [-s[0], -s[1], -s[2]];
}

export function eyeHeightFromSlider(value01: number): number {
  // 2 m to 2000 m on a perceptual logarithmic slider.
  return 0.002 * 1000 ** clamp(value01 / 1000, 0, 1);
}

export function sliderFromEyeHeight(heightKm: number): number {
  return clamp((Math.log(heightKm / 0.002) / Math.log(1000)) * 1000, 0, 1000);
}

export function exposureScale(ev: number): number {
  return Math.pow(2, ev);
}
