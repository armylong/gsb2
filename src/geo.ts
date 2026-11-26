/**
 * geo.ts —— 全部几何/距离计算的唯一事实来源。
 *
 * 关键设计：
 * - 经纬度只用于输入、显示和平面投影；
 * - 航线在三维单位球向量上构造（大圆平面旋转），距离 = 地心角 × R；
 * - 因此极区经度剧烈变化不会带来任何额外路程；
 * - 两个视图的位置指示都来自同一个 GreatCircle.at(t)，读数天然一致。
 */
import * as THREE from 'three';

export const EARTH_RADIUS_KM = 6371;
export const DEG = Math.PI / 180;

/** 小于此地心角（弧度）视为起终点重合 */
export const COINCIDENT_EPS = 1e-7;
/** 距 π 小于此值视为精确对跖（浮点容差） */
export const ANTIPODAL_EPS = 1e-6;
/** 距 π 小于 2° 给出“接近对跖、数值敏感”的提示 */
export const NEAR_ANTIPODAL_RAD = 2 * DEG;

export interface LonLat {
  lon: number; // 度，[-180, 180]
  lat: number; // 度，[-90, 90]
}

export type RouteKind = 'normal' | 'coincident' | 'antipodal';

export interface GeoPoint {
  t: number;
  ll: LonLat;
  vec: THREE.Vector3; // 单位向量
  centralAngle: number; // 从起点起的地心角 [0, π]
  distanceKm: number;
}

export interface GreatCircle {
  start: LonLat;
  end: LonLat;
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** 大圆平面的单位法向（旋转轴），对跖时为确定性任选方向 */
  axis: THREE.Vector3;
  /** 地心角 [0, π] */
  omega: number;
  totalKm: number;
  kind: RouteKind;
  /** 最短弧是否唯一：重合（长度 0 但路线任意）与对跖均为 false */
  unique: boolean;
  nearAntipodal: boolean;
  /** 对跖时当前展示的弧只是无穷多个解中的一个 */
  illustrative: boolean;
  samples: GeoPoint[];
  at: (t: number) => GeoPoint;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function wrapLon(lon: number): number {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  if (l === -180) l = 180;
  return l;
}

export function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/** 经纬度 -> 单位球向量。约定 y 为地轴，lon=0 指向 +x，lon=90E 指向 +z */
export function lonLatToVector3(ll: LonLat): THREE.Vector3 {
  const lat = ll.lat * DEG;
  const lon = ll.lon * DEG;
  const cosLat = Math.cos(lat);
  return new THREE.Vector3(
    cosLat * Math.cos(lon),
    Math.sin(lat),
    cosLat * Math.sin(lon),
  );
}

/** 单位球向量 -> 经纬度 */
export function vector3ToLonLat(v: THREE.Vector3): LonLat {
  const n = v.clone().normalize();
  return {
    lat: (Math.asin(clamp(n.y, -1, 1)) / DEG),
    lon: (Math.atan2(n.z, n.x) / DEG),
  };
}

/** Haversine 地心角，仅用于自检交叉验证 */
export function haversineAngle(a: LonLat, b: LonLat): number {
  const p1 = a.lat * DEG;
  const p2 = b.lat * DEG;
  const dPhi = (b.lat - a.lat) * DEG;
  const dLam = wrapPi((b.lon - a.lon) * DEG);
  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLam / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const UP = new THREE.Vector3(0, 1, 0);
const REF_X = new THREE.Vector3(1, 0, 0);

/**
 * 构造两点间唯一的大圆劣弧（地心角 ≤ π）。
 * - 重合：omega=0，at(t) 恒为起点；
 * - 对跖：有无穷多条半圆弧，用一个确定性参考方向选平面，并标记 illustrative。
 */
export function buildGreatCircle(
  start: LonLat,
  end: LonLat,
  sampleCount = 720,
): GreatCircle {
  const s: LonLat = { lon: wrapLon(start.lon), lat: clamp(start.lat, -90, 90) };
  const e: LonLat = { lon: wrapLon(end.lon), lat: clamp(end.lat, -90, 90) };
  const a = lonLatToVector3(s);
  const b = lonLatToVector3(e);
  const dot = clamp(a.dot(b), -1, 1);
  const omega = Math.acos(dot);

  let kind: RouteKind = 'normal';
  if (omega < COINCIDENT_EPS) kind = 'coincident';
  else if (Math.PI - omega < ANTIPODAL_EPS) kind = 'antipodal';

  let axis: THREE.Vector3;
  if (kind === 'normal') {
    axis = new THREE.Vector3().crossVectors(a, b);
    if (axis.lengthSq() < 1e-20) {
      // 理论上 omega 不在两端时不会发生，兜底走对跖逻辑
      kind = 'antipodal';
    } else {
      axis.normalize();
    }
  }

  if (kind === 'coincident') {
    axis = UP.clone();
  } else if (kind === 'antipodal') {
    // 选一个与 a 不平行的参考向量，张成确定的大圆平面
    const ref = Math.abs(a.y) < 0.9 ? UP : REF_X;
    axis = new THREE.Vector3().crossVectors(a, ref).normalize();
  }

  const finalKind = kind;
  const finalAxis = axis!;
  const unique = finalKind === 'normal';
  const nearAntipodal =
    finalKind === 'normal' && Math.PI - omega < NEAR_ANTIPODAL_RAD;

  const at = (tRaw: number): GeoPoint => {
    const t = clamp(tRaw, 0, 1);
    const vec = new THREE.Vector3();
    if (finalKind === 'coincident' || omega < 1e-12) {
      vec.copy(a);
    } else {
      // 绕大圆平面法向旋转 t*omega，数值稳定且严格在大圆上
      vec.copy(a).applyAxisAngle(finalAxis, t * omega);
    }
    const centralAngle = t * omega;
    return {
      t,
      vec,
      ll: vector3ToLonLat(vec),
      centralAngle,
      distanceKm: centralAngle * EARTH_RADIUS_KM,
    };
  };

  const samples: GeoPoint[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(at(i / (sampleCount - 1)));
  }

  return {
    start: s,
    end: e,
    a,
    b,
    axis: finalAxis,
    omega,
    totalKm: omega * EARTH_RADIUS_KM,
    kind: finalKind,
    unique,
    nearAntipodal,
    illustrative: finalKind === 'antipodal',
    samples,
    at,
  };
}

/**
 * 求单位向量 q 到大圆劣弧的最近参数 t（解析投影，连续不量化）。
 * 做法：把 q 投影到大圆平面 (a, axis)，用 atan2 求角度，再夹到 [0,1]。
 * 返回 t 与到最近点的地心角距离（弧度，用于抓取阈值）。
 */
export function closestTToVector(
  gc: GreatCircle,
  qRaw: THREE.Vector3,
): { t: number; angleToRoute: number } {
  const q = qRaw.clone().normalize();
  if (gc.kind === 'coincident') {
    return { t: 0, angleToRoute: Math.acos(clamp(q.dot(gc.a), -1, 1)) };
  }
  const e1 = gc.a;
  // e2 = axis × a，与 a 正交，构成旋转角 θ 的正方向基
  const e2 = new THREE.Vector3().crossVectors(gc.axis, gc.a).normalize();
  const qp = q
    .clone()
    .addScaledVector(gc.axis, -q.dot(gc.axis)); // 投影到大圆平面
  const theta = Math.atan2(qp.dot(e2), qp.dot(e1)); // [-π, π]
  let t = theta / gc.omega;
  t = clamp(t, 0, 1);
  const nearest = gc.at(t).vec;
  const angleToRoute = Math.acos(clamp(q.dot(nearest), -1, 1));
  return { t, angleToRoute };
}

/** 格式化坐标 */
export function formatLonLat(ll: LonLat, digits = 2): string {
  const ns = ll.lat >= 0 ? 'N' : 'S';
  const ew = ll.lon >= 0 ? 'E' : 'W';
  return `${Math.abs(ll.lat).toFixed(digits)}°${ns}, ${Math.abs(ll.lon).toFixed(
    digits,
  )}°${ew}`;
}

/** 带正负号的十进制度，用于输入框 */
export function llToInputs(ll: LonLat): { lat: string; lon: string } {
  return {
    lat: ll.lat.toFixed(4),
    lon: ll.lon.toFixed(4),
  };
}

export function formatKm(km: number): string {
  return Math.round(km).toLocaleString('zh-CN');
}
