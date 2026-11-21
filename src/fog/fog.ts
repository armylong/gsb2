import * as THREE from 'three';

/** 雾区 + 光照的全部可调参数（GUI 与 shader 共用） */
export interface FogParams {
  // 雾盒 AABB（中心 + 尺寸）
  boxCenter: THREE.Vector3;
  boxSize: THREE.Vector3;

  // 密度模型 ρ(y) = density * exp(-(y - boxMin.y) / falloff)
  density: number; // 底层密度 ρ0
  falloff: number; // 高度衰减尺度 h（米）

  // 颜色 / 光照
  fogTint: THREE.Color;
  ambient: THREE.Color; // 环境亮度
  sunColor: THREE.Color;
  sunIntensity: number;
  sunAzimuth: number; // 度，世界 -Z 方向为 0
  sunElevation: number; // 度
  anisotropy: number; // HG 相位 g，0 = 无方向

  // 开关
  fogEnabled: boolean;
  showBounds: boolean;
}

/** 雾区预设：切换后深度、雾和原画面仍共用同一套几何，天然对齐 */
export interface FogPreset {
  name: string;
  center: [number, number, number];
  size: [number, number, number];
  density: number;
  falloff: number;
}

export const FOG_PRESETS: FogPreset[] = [
  { name: '标准雾区（跨门框）', center: [0, 1.5, 0], size: [8, 3, 8], density: 0.16, falloff: 1.4 },
  { name: '贴地低雾（更矮更宽）', center: [0, 0.9, 0], size: [10, 1.8, 9], density: 0.22, falloff: 0.9 },
  { name: '零密度对照场景', center: [0, 1.5, 0], size: [8, 3, 8], density: 0.0, falloff: 1.4 },
];

export function createDefaultParams(): FogParams {
  const p = FOG_PRESETS[0];
  return {
    boxCenter: new THREE.Vector3(...p.center),
    boxSize: new THREE.Vector3(...p.size),
    density: p.density,
    falloff: p.falloff,
    fogTint: new THREE.Color(0xcfd8e6),
    ambient: new THREE.Color(0x556070),
    sunColor: new THREE.Color(0xfff2dd),
    sunIntensity: 1.1,
    sunAzimuth: 0,
    sunElevation: 35,
    anisotropy: 0.35,
    fogEnabled: true,
    showBounds: true,
  };
}

/** 方位角/仰角 → 指向光源的单位向量（azimuth=0 表示光从相机正前方照来，即沿 -Z） */
export function sunDirection(azimuthDeg: number, elevationDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const ce = Math.cos(el);
  return out.set(-Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce).normalize();
}

export function boxMinMax(p: FogParams, outMin: THREE.Vector3, outMax: THREE.Vector3): void {
  outMin.copy(p.boxCenter).addScaledVector(p.boxSize, -0.5);
  outMax.copy(p.boxCenter).addScaledVector(p.boxSize, 0.5);
}

// ---------------------------------------------------------------------------
// 以下是 shaders.ts 中 GLSL 数学的 CPU 镜像，点选读数用同一套公式，
// 保证「画面看到的雾」和「面板读到的长度/厚度」严格一致。
// ---------------------------------------------------------------------------

export interface RayBoxHit {
  hit: boolean;
  enter: number;
  leave: number;
}

/** slab 求交，enter 相对相机被钳到 >= 0 */
export function rayBox(
  ro: THREE.Vector3,
  rd: THREE.Vector3,
  bMin: THREE.Vector3,
  bMax: THREE.Vector3,
): RayBoxHit {
  const EPS = 1e-6;
  let tNear = -Infinity;
  let tFar = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = ro[axis];
    const d = rd[axis];
    if (Math.abs(d) < EPS) {
      if (o < bMin[axis] || o > bMax[axis]) return { hit: false, enter: 0, leave: 0 };
      continue;
    }
    let t1 = (bMin[axis] - o) / d;
    let t2 = (bMax[axis] - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
  }
  tNear = Math.max(tNear, 0);
  if (tFar < tNear - EPS) return { hit: false, enter: 0, leave: 0 };
  return { hit: true, enter: tNear, leave: Math.max(tFar, tNear) };
}

/** ρ(y) = ρ0 · exp(-(y - yMin)/h) */
export function densityAt(p: THREE.Vector3, bMin: THREE.Vector3, density: number, falloff: number): number {
  const h = Math.max(falloff, 0.05);
  return density * Math.exp(-(p.y - bMin.y) / h);
}

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();

/** 沿射线 [ta, tb] 的光学厚度解析积分 */
export function opticalDepth(
  ro: THREE.Vector3,
  rd: THREE.Vector3,
  ta: number,
  tb: number,
  bMin: THREE.Vector3,
  density: number,
  falloff: number,
): number {
  const h = Math.max(falloff, 0.05);
  const da = densityAt(_tmpA.copy(ro).addScaledVector(rd, ta), bMin, density, falloff);
  const db = densityAt(_tmpB.copy(ro).addScaledVector(rd, tb), bMin, density, falloff);
  if (Math.abs(rd.y) < 1e-4) return da * (tb - ta);
  return (h * (da - db)) / rd.y;
}

/** Henyey-Greenstein 相位函数 */
export function hgPhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  const denom = 1 + g2 - 2 * g * cosTheta;
  return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(denom, 1e-4), 1.5));
}
