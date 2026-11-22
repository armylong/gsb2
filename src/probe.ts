import * as THREE from 'three';
import type { LightRig, PointRig } from './lightRig';
import type { ParamSet } from './params';

export type SurfaceKind = 'metal' | 'plate';

export interface SurfacePoint {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  kind: SurfaceKind;
  roughness: number;
  metalness: number;
  albedo: THREE.Color;
}

export interface ProbeResult {
  /** 探针所在表面的名称与实际粗糙度（随所测参数组而定） */
  surfaceLabel: string;
  roughness: number;
  metalness: number;
  /** 该点接收到的辐照度（相对单位，矩形灯 + 点光 + 环境） */
  irradiance: number;
  /** 沿指定观察方向反射出的亮度（nits 量级的相对值，含漫反射+镜面反射） */
  reflectedLuminance: number;
  /** 其中镜面分量 */
  specularLuminance: number;
  /** 其中漫反射分量 */
  diffuseLuminance: number;
  /** 灯板对该点张的立体角（sr） */
  solidAngle: number;
  /** 反射斑估计：沿灯板长边 / 短边方向在表面上的展开长度（米，含粗糙度模糊） */
  spotLong: number;
  spotShort: number;
  /** 点光源贡献占比（0-1） */
  pointShare: number;
  /** 灯板在该点的入射角（度，法线与灯中心方向夹角） */
  incidenceDeg: number;
  /** 点到灯板中心距离 */
  distance: number;
}

const GRID = 24;
const EPS = 1e-6;

// --- GGX / Cook-Torrance 微表面 BRDF ---
function ggxD(nDotH: number, rough: number): number {
  const a2 = Math.max(rough * rough * rough * rough, EPS);
  const d = nDotH * nDotH * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

function smithG(nDotX: number, rough: number): number {
  const k = (rough * rough) / 2;
  return nDotX / (nDotX * (1 - k) + k);
}

function schlickF(cosTheta: number, f0: number): number {
  return f0 + (1 - f0) * Math.pow(1 - Math.min(cosTheta, 1), 5);
}

/** 单次方向采样的 BRDF 值（漫反射 + 镜面） */
function brdf(
  n: THREE.Vector3,
  wi: THREE.Vector3,
  wo: THREE.Vector3,
  sp: SurfacePoint,
): { spec: number; diff: number } {
  const nDotI = Math.max(n.dot(wi), 0);
  const nDotO = Math.max(n.dot(wo), 0);
  if (nDotI <= 0 || nDotO <= 0) return { spec: 0, diff: 0 };
  const h = wi.clone().add(wo).normalize();
  const nDotH = Math.max(n.dot(h), 0);
  const vDotH = Math.max(wo.dot(h), 0);
  const D = ggxD(nDotH, sp.roughness);
  const G = smithG(nDotI, sp.roughness) * smithG(nDotO, sp.roughness);
  const f0 = sp.metalness >= 0.5 ? luminanceOf(sp.albedo) : 0.04;
  const F = schlickF(vDotH, f0);
  const denom = Math.max(4 * nDotI * nDotO, EPS);
  const spec = (D * G * F) / denom;
  const diff = ((1 - sp.metalness) * luminanceOf(sp.albedo)) / Math.PI;
  return { spec, diff };
}

function luminanceOf(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

interface RectFrame {
  center: THREE.Vector3;
  u: THREE.Vector3; // 长边方向
  v: THREE.Vector3; // 短边方向
  halfW: number;
  halfH: number;
  normal: THREE.Vector3;
}

function rectFrame(corners: THREE.Vector3[]): RectFrame {
  const center = corners[0].clone().add(corners[2]).multiplyScalar(0.5);
  const u = corners[1].clone().sub(corners[0]).normalize();
  const v = corners[3].clone().sub(corners[0]).normalize();
  const halfW = corners[0].distanceTo(corners[1]) / 2;
  const halfH = corners[0].distanceTo(corners[3]) / 2;
  // 角点 (-,-)→(+,-)→(+,+)→(-,+) 使 u×v 指向局部 +Z（灯背面）；
  // RectAreaLight 朝局部 -Z 发光，故发光法线 = v×u
  const normal = v.clone().cross(u).normalize();
  return { center, u, v, halfW, halfH, normal };
}

export function probe(
  sp: SurfacePoint,
  viewDir: THREE.Vector3,
  rig: LightRig,
  pointRig: PointRig,
  p: ParamSet,
): ProbeResult {
  const corners = rig.worldCorners();
  const frame = rectFrame(corners);
  const n = sp.normal.clone().normalize();
  const wo = viewDir.clone().normalize();

  let irradiance = 0;
  let specLum = 0;
  let diffLum = 0;
  let solidAngle = 0;

  const du = (2 * frame.halfW) / GRID;
  const dv = (2 * frame.halfH) / GRID;
  const rectLum = Math.max(rig.light.intensity, 0); // nits
  const tmp = new THREE.Vector3();

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      tmp
        .copy(frame.center)
        .addScaledVector(frame.u, -frame.halfW + (i + 0.5) * du)
        .addScaledVector(frame.v, -frame.halfH + (j + 0.5) * dv);
      const toPoint = sp.point.clone().sub(tmp); // 灯面样本 -> 受光点
      const dist2 = toPoint.lengthSq();
      if (dist2 < 1e-8) continue;
      const dist = Math.sqrt(dist2);
      const lOut = toPoint.multiplyScalar(1 / dist); // 灯->点 单位向量
      const wi = lOut.clone().negate(); // 点->灯，用于表面 BRDF
      const nDotI = n.dot(wi);
      if (nDotI <= 0) continue;
      // 灯板背面不发光：发光法线 frame.normal 必须与“灯->点”同向
      const emitCos = frame.normal.dot(lOut);
      if (emitCos <= 0) continue;
      const dArea = du * dv;
      // 立体角元 dΩ = A·cos(灯法线, 灯->点) / r²
      const dOmega = (dArea * emitCos) / dist2;
      solidAngle += dOmega;
      const e = rectLum * nDotI * dOmega;
      irradiance += e;
      const b = brdf(n, wi, wo, sp);
      specLum += b.spec * e;
      diffLum += b.diff * e;
    }
  }

  // 点光源参照：I(candela)/r^2，decay=2
  let pointE = 0;
  let pointSpec = 0;
  let pointDiff = 0;
  if (p.pointOn) {
    const toP = pointRig.light.position.clone().sub(sp.point);
    const d = toP.length();
    if (d > 1e-4) {
      const wi = toP.multiplyScalar(1 / d);
      const nDotI = n.dot(wi);
      if (nDotI > 0) {
        pointE = (p.pointIntensity * nDotI) / (d * d);
        const b = brdf(n, wi, wo, sp);
        pointSpec = b.spec * pointE;
        pointDiff = b.diff * pointE;
        irradiance += pointE;
        specLum += pointSpec;
        diffLum += pointDiff;
      }
    }
  }

  irradiance += p.ambient * Math.PI;
  diffLum += ((1 - sp.metalness) * luminanceOf(sp.albedo) * p.ambient);

  // --- 反射斑尺寸估计 ---
  const toCenter = frame.center.clone().sub(sp.point);
  const dist = toCenter.length();
  const dirToLight = toCenter.clone().normalize();
  const incidence = n.dot(dirToLight);
  const incidenceDeg = THREE.MathUtils.radToDeg(
    Math.acos(THREE.MathUtils.clamp(incidence, -1, 1)),
  );

  // 几何足迹：灯板边缘经透视投影到探针切平面的反射斑半宽
  // 半宽 × 轴的切平面分量 × (探针到灯距离 / 法向距离)；灯越宽足迹越大，掠射时自然拉长
  const dNormal = Math.max(toCenter.dot(n), 1e-3);
  const surfaceHalf = (axis: THREE.Vector3, half: number): number => {
    const axisTangent = axis.clone().addScaledVector(n, -axis.dot(n)).length();
    return half * axisTangent * (dist / dNormal);
  };
  const surfU = surfaceHalf(frame.u, frame.halfW);
  const surfV = surfaceHalf(frame.v, frame.halfH);
  // GGX 主瓣角宽约 roughness/2（弧度），换算成表面模糊半宽，与几何足迹平方叠加
  const blur = sp.roughness * 0.5 * dNormal;
  const longAlongU = frame.halfW >= frame.halfH;
  const geoLong = longAlongU ? surfU : surfV;
  const geoShort = longAlongU ? surfV : surfU;
  const spotLong = 2 * Math.hypot(geoLong, blur);
  const spotShort = 2 * Math.hypot(geoShort, blur);

  const totalLum = specLum + diffLum;
  return {
    surfaceLabel: sp.kind === 'metal' ? '粗糙金属（圆柱）' : '哑光板（平板）',
    roughness: sp.roughness,
    metalness: sp.metalness,
    irradiance,
    reflectedLuminance: totalLum,
    specularLuminance: specLum,
    diffuseLuminance: diffLum,
    solidAngle,
    spotLong,
    spotShort,
    pointShare: totalLum > 1e-9 ? (pointSpec + pointDiff) / totalLum : 0,
    incidenceDeg,
    distance: dist,
  };
}
