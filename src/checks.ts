/**
 * checks.ts —— 可在页面上展开的计算自检。
 * 同时导出 naiveLonLatAccumKm，用于直观对比“按平面经纬度增量硬累加”
 * 在极区会多算多少路程（我们的真实距离不使用这种算法）。
 */
import {
  EARTH_RADIUS_KM,
  buildGreatCircle,
  closestTToVector,
  haversineAngle,
  type GreatCircle,
} from './geo';
import { LANDMARKS } from './landmarks';
import { createProjector, projectPath } from './projections';

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * 反面教材：把经纬度当成等距平面，逐采样点累加
 * R * sqrt(Δlat² + Δlon²)（弧度）。极区 Δlon 被放大，必然多算。
 */
export function naiveLonLatAccumKm(gc: GreatCircle): number {
  let sum = 0;
  for (let i = 1; i < gc.samples.length; i++) {
    const a = gc.samples[i - 1].ll;
    const b = gc.samples[i].ll;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    let dLon = ((b.lon - a.lon) * Math.PI) / 180;
    if (dLon > Math.PI) dLon -= 2 * Math.PI;
    if (dLon < -Math.PI) dLon += 2 * Math.PI;
    sum += Math.hypot(dLat, dLon) * EARTH_RADIUS_KM;
  }
  return sum;
}

export function runSelfTests(): TestResult[] {
  const results: TestResult[] = [];
  const ok = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  const sh = LANDMARKS.find((l) => l.id === 'shanghai')!.ll;
  const la = LANDMARKS.find((l) => l.id === 'losangeles')!.ll;
  const bj = LANDMARKS.find((l) => l.id === 'beijing')!.ll;
  const ny = LANDMARKS.find((l) => l.id === 'newyork')!.ll;

  // 1. at(0)/at(1) 严格回到端点
  const gc = buildGreatCircle(sh, la);
  const e0 = gc.at(0).vec.distanceTo(gc.a);
  const e1 = gc.at(1).vec.distanceTo(gc.b);
  ok(
    '参数 t=0/1 精确落在起终点',
    e0 < 1e-9 && e1 < 1e-9,
    `误差 ${Math.max(e0, e1).toExponential(2)}`,
  );

  // 2. 大圆中心角与 Haversine 一致，距离 = R·ω
  const hv = haversineAngle(sh, la);
  ok(
    '大圆中心角与 Haversine 公式一致',
    Math.abs(hv - gc.omega) < 1e-12,
    `ω=${((gc.omega * 180) / Math.PI).toFixed(3)}°, 偏差 ${Math.abs(hv - gc.omega).toExponential(2)} rad`,
  );

  // 3. 任意 t 的距离严格为 t·全程，两个视图共用
  const p = gc.at(0.37);
  const expect = 0.37 * gc.totalKm;
  ok(
    '沿途距离 = t × 全程（双视图同源）',
    Math.abs(p.distanceKm - expect) < 1e-9,
    `t=0.37 → ${p.distanceKm.toFixed(2)} km`,
  );

  // 4. 最近点解析解往返一致
  let maxErr = 0;
  for (const t of [0.02, 0.15, 0.37, 0.5, 0.71, 0.95]) {
    const r = closestTToVector(gc, gc.at(t).vec);
    maxErr = Math.max(maxErr, Math.abs(r.t - t));
  }
  ok(
    '球面拾取最近参数 t 解析往返',
    maxErr < 1e-3,
    `最大 |Δt|=${maxErr.toExponential(2)}`,
  );

  // 5. 跨反经线：等距圆柱投影必须断成 ≥2 段，且没有横跨全宽的连接
  const eq = createProjector('equirect', 900, 460, bj);
  const segs = projectPath(gc.samples.map((s) => s.ll), eq);
  const b = eq.bounds;
  const mapW = b.kind === 'rect' ? b.x1 - b.x0 : 900;
  const spansFullWidth = segs.some((s) => {
    const xs = s.map((q) => q.x);
    return Math.max(...xs) - Math.min(...xs) > mapW * 0.9;
  });
  ok(
    '跨反经线航线在经纬图上断段、无横穿直线',
    segs.length >= 2 && !spansFullWidth,
    `断为 ${segs.length} 段，最大段宽 ${(Math.max(...segs.map((s) => Math.max(...s.map((q) => q.x)) - Math.min(...s.map((q) => q.x)))) / mapW * 100).toFixed(0)}% 图宽`,
  );

  // 6. 极地航线：错误的经纬度累加显著多算，而大圆距离不受影响
  const polar = buildGreatCircle(bj, ny);
  const naive = naiveLonLatAccumKm(polar);
  const over = naive / polar.totalKm - 1;
  ok(
    '极区不按经度增量多算路程',
    over > 0.5 && polar.totalKm > 9000 && polar.totalKm < 12000,
    `北京–纽约大圆 ${polar.totalKm.toFixed(0)} km；平面经纬度硬累加 ${naive.toFixed(0)} km（多算 ${(over * 100).toFixed(0)}%）`,
  );

  // 7. 重合 / 对跖判定
  const same = buildGreatCircle(bj, bj);
  const anti = buildGreatCircle(bj, { lat: -bj.lat, lon: bj.lon + 180 > 180 ? bj.lon - 180 : bj.lon + 180 });
  ok(
    '重合点判定为距离 0 且路线不唯一',
    same.kind === 'coincident' && same.totalKm === 0 && !same.unique,
    `kind=${same.kind}, total=${same.totalKm}`,
  );
  ok(
    '对跖点判定为路线不唯一但距离唯一',
    anti.kind === 'antipodal' && !anti.unique && Math.abs(anti.totalKm - Math.PI * EARTH_RADIUS_KM) < 1,
    `kind=${anti.kind}, total=${anti.totalKm.toFixed(0)} km`,
  );

  // 8. 方位投影中心恰好投影到圆心
  const az = createProjector('azimuthal', 500, 500, bj);
  const c = az.project(bj);
  const cb = az.bounds;
  const cx = cb.kind === 'circle' ? cb.cx : 250;
  const cy = cb.kind === 'circle' ? cb.cy : 250;
  ok(
    '方位投影以指定地标为圆心',
    Math.hypot(c.x - cx, c.y - cy) < 1e-6,
    `中心投影偏差 ${Math.hypot(c.x - cx, c.y - cy).toExponential(2)} px`,
  );

  return results;
}
