import * as THREE from 'three';

/** 一组完整可对比的实验参数 */
export interface ParamSet {
  /** 灯板尺寸（米），宽 x 高（发光面的两条边长） */
  width: number;
  height: number;
  /** RectAreaLight 发光强度，物理单位 nits（cd/m²），面积变化时保持不变 = 等发光面亮度 */
  luminance: number;
  /** true: 改尺寸保持面亮度(nits)不变；false: 保持总光通量近似不变（面积变了就反推 nits） */
  constantLuminance: boolean;
  /** 灯板世界位置 */
  position: [number, number, number];
  /** 灯板欧拉角（度），-Z 为发光法线方向 */
  rotationDeg: [number, number, number];
  /** 圆柱（粗糙金属 metalness=1）粗糙度 */
  metalRoughness: number;
  /** 平板（哑光 metalness=0）粗糙度 */
  plateRoughness: number;
  /** 金属基础色 */
  metalColor: string;
  /** 哑光板基础色（反照率） */
  plateColor: string;
  /** 点光源开关（同场参照） */
  pointOn: boolean;
  pointIntensity: number; // candela（物理单位）
  pointPosition: [number, number, number];
  /** 环境光（极弱，仅保证背面可辨认） */
  ambient: number;
}

export const MIN_LIGHT_SIDE = 0.02;

export function defaultParams(): ParamSet {
  return {
    width: 0.8,
    height: 0.12,
    luminance: 120,
    constantLuminance: true,
    position: [0, 1.4, 0.6],
    rotationDeg: [-35, 0, 0],
    metalRoughness: 0.35,
    plateRoughness: 0.55,
    metalColor: '#b8bec8',
    plateColor: '#8a8f99',
    pointOn: false,
    pointIntensity: 25,
    pointPosition: [-1.6, 1.5, 1.2],
    ambient: 0.06,
  };
}

export interface Preset {
  id: string;
  label: string;
  desc: string;
  build: () => ParamSet;
}

function aimAt(p: ParamSet, target: THREE.Vector3): ParamSet {
  const e = new THREE.Euler(
    THREE.MathUtils.degToRad(p.rotationDeg[0]),
    THREE.MathUtils.degToRad(p.rotationDeg[1]),
    THREE.MathUtils.degToRad(p.rotationDeg[2]),
  );
  const q = new THREE.Quaternion().setFromEuler(e);
  // 让灯板 -Z 法线指向 target
  const dir = new THREE.Vector3(...target).sub(new THREE.Vector3(...p.position)).normalize();
  q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  const e2 = new THREE.Euler().setFromQuaternion(q);
  return {
    ...p,
    rotationDeg: [
      THREE.MathUtils.radToDeg(e2.x),
      THREE.MathUtils.radToDeg(e2.y),
      THREE.MathUtils.radToDeg(e2.z),
    ],
  };
}

/** 预设 1：正对（发光面水平朝下，-Z 指向地面），窄灯条 vs 宽灯板，中心位置完全相同 */
function headOn(width: number, height: number): ParamSet {
  const p = defaultParams();
  p.width = width;
  p.height = height;
  p.position = [0, 1.2, 0];
  // aimAt 会把发光法线 -Z 转向地面目标，对应欧拉角 pitch ≈ -90°
  return aimAt(p, new THREE.Vector3(0, 0, 0));
}

/** 预设 2：斜照 45°，同样保持灯中心一致，只改宽度 */
function oblique(width: number, height: number): ParamSet {
  const p = defaultParams();
  p.width = width;
  p.height = height;
  p.position = [1.1, 1.1, 1.1];
  return aimAt(p, new THREE.Vector3(0, 0.35, 0));
}

export const PRESETS: Preset[] = [
  {
    id: 'front-narrow',
    label: '正对·窄灯条',
    desc: '0.4m 窄长条，正对平板中心',
    build: () => headOn(0.4, 0.1),
  },
  {
    id: 'front-wide',
    label: '正对·宽灯板',
    desc: '1.6m 宽灯板，同一中心、同一面亮度',
    build: () => headOn(1.6, 0.1),
  },
  {
    id: 'oblique-narrow',
    label: '斜照·窄灯条',
    desc: '45° 斜照，0.4m 窄灯',
    build: () => oblique(0.4, 0.1),
  },
  {
    id: 'oblique-wide',
    label: '斜照·宽灯板',
    desc: '45° 斜照，1.6m 宽灯，中心一致',
    build: () => oblique(1.6, 0.1),
  },
];

/** 应用“等总光通量”模式：以 0.8x0.12 基准面积反推 nits */
export function effectiveLuminance(p: ParamSet): number {
  if (p.constantLuminance) return p.luminance;
  const refArea = 0.8 * 0.12;
  const area = Math.max(p.width * p.height, MIN_LIGHT_SIDE * MIN_LIGHT_SIDE);
  return (p.luminance * refArea) / area;
}

export function cloneParams(p: ParamSet): ParamSet {
  return {
    ...p,
    position: [...p.position] as [number, number, number],
    rotationDeg: [...p.rotationDeg] as [number, number, number],
    pointPosition: [...p.pointPosition] as [number, number, number],
  };
}
