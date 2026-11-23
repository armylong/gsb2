import {
  BLOCKS,
  BACK_RULER,
  FRAME_BARS,
  FRONT_RULER,
  PLANES,
  TANK,
  WORLD_BOUNDS,
  type V3,
} from './geometry';
import { at, dot, hitBox, hitPlane, norm, scale, sub } from './vector';

export type MediumName = 'air' | 'glass' | 'water';

export interface IORSet {
  air: number;
  glass: number;
  water: number;
}

export const REAL_IOR: IORSet = { air: 1.0, glass: 1.5, water: 1.333 };
export const UNIT_IOR: IORSet = { air: 1.0, glass: 1.0, water: 1.0 };

export type TraceStatus =
  | 'ruler-back'
  | 'ruler-front'
  | 'blocked-frame'
  | 'blocked-block'
  | 'out-of-range';

export interface TraceEvent {
  kind: 'refract' | 'tir' | 'ruler' | 'blocked' | 'escape' | 'out-of-range';
  surface: string;
  point: V3;
  medium1?: MediumName;
  medium2?: MediumName;
  n1?: number;
  n2?: number;
  /** 入射角（度，相对法线） */
  thetaI?: number;
  /** 折射角（度） */
  thetaT?: number;
  /** 该界面临界角（度），n1<=n2 时为 null */
  critical?: number | null;
  detail?: string;
}

export interface Reading {
  x: number;
  y: number;
  label: string;
}

export interface TraceResult {
  status: TraceStatus;
  points: V3[];
  events: TraceEvent[];
  endpoint: V3;
  reading?: Reading;
  blockName?: string;
  blockerName?: string;
  /** n=1 基线（同起点同方向直线）会到达的位置，用于核对折射位移 */
  baseline: TraceResult | null;
  /** 视线在第一个介质边界之前的原始方向延长线与后标尺的交点（表观方向读数） */
  apparentPoint: V3 | null;
}

type Axis = 'x' | 'y' | 'z';

interface RefractSurface {
  kind: 'refract';
  name: string;
  axis: Axis;
  value: number;
  loA: number; hiA: number;
  loB: number; hiB: number;
  axisA: Axis; axisB: Axis;
}

interface BoxSurface {
  kind: 'ruler' | 'opaque' | 'escape';
  name: string;
  min: V3;
  max: V3;
  rulerId?: 'back' | 'front';
}

const EPS = 1e-6;
const MAX_BOUNCE = 24;

/** 全部可折射介质边界（与场景玻璃/水面一一对应） */
function buildRefractSurfaces(): RefractSurface[] {
  const hx = TANK.innerHalf.x;
  const hy = TANK.innerHalf.y;
  const hz = TANK.innerHalf.z;
  const s: RefractSurface[] = [];
  const rect = (
    name: string,
    axis: Axis,
    value: number,
    axisA: Axis,
    loA: number,
    hiA: number,
    axisB: Axis,
    loB: number,
    hiB: number,
  ): RefractSurface => ({ kind: 'refract', name, axis, value, axisA, loA, hiA, axisB, loB, hiB });

  s.push(rect('前玻璃·外表面', 'z', PLANES.frontOuter, 'x', -hx, hx, 'y', 0, hy));
  s.push(rect('前玻璃·内表面', 'z', PLANES.frontInner, 'x', -hx, hx, 'y', 0, hy));
  s.push(rect('后玻璃·内表面', 'z', PLANES.backInner, 'x', -hx, hx, 'y', 0, hy));
  s.push(rect('后玻璃·外表面', 'z', PLANES.backOuter, 'x', -hx, hx, 'y', 0, hy));
  s.push(rect('右玻璃·内表面', 'x', PLANES.rightInner, 'z', -hz, hz, 'y', 0, hy));
  s.push(rect('右玻璃·外表面', 'x', PLANES.rightOuter, 'z', -hz, hz, 'y', 0, hy));
  s.push(rect('左玻璃·内表面', 'x', PLANES.leftInner, 'z', -hz, hz, 'y', 0, hy));
  s.push(rect('左玻璃·外表面', 'x', PLANES.leftOuter, 'z', -hz, hz, 'y', 0, hy));
  s.push(rect('水面', 'y', PLANES.waterY, 'x', -hx, hx, 'z', -hz, hz));
  return s;
}

const REFRACT_SURFACES = buildRefractSurfaces();

const BOX_SURFACES: BoxSurface[] = [
  {
    kind: 'ruler',
    name: '后标尺',
    rulerId: 'back',
    min: { x: BACK_RULER.x0, y: BACK_RULER.y0, z: BACK_RULER.z - 0.15 },
    max: { x: BACK_RULER.x1, y: BACK_RULER.y1, z: BACK_RULER.z + 0.15 },
  },
  {
    kind: 'ruler',
    name: '前标尺',
    rulerId: 'front',
    min: { x: FRONT_RULER.x0, y: FRONT_RULER.y0, z: FRONT_RULER.z - 0.15 },
    max: { x: FRONT_RULER.x1, y: FRONT_RULER.y1, z: FRONT_RULER.z + 0.15 },
  },
  ...FRAME_BARS.map((b) => ({ kind: 'opaque' as const, name: b.name, min: b.min, max: b.max })),
  ...BLOCKS.map((b) => ({ kind: 'opaque' as const, name: b.name, min: b.min, max: b.max })),
];

/** 点是否在世界逃逸边界内部（相机通常在外部，属正常；光线从内部穿出才算超范围） */
function insideWorld(p: V3): boolean {
  return (
    p.x > WORLD_BOUNDS.min.x && p.x < WORLD_BOUNDS.max.x &&
    p.y > WORLD_BOUNDS.min.y && p.y < WORLD_BOUNDS.max.y &&
    p.z > WORLD_BOUNDS.min.z && p.z < WORLD_BOUNDS.max.z
  );
}

/** 射线穿出世界边界的 t（仅当起点在内部时有意义） */
function worldExitT(o: V3, d: V3): number | null {
  if (!insideWorld(o)) return null;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(d[axis]) < 1e-12) continue;
    const t1 = (WORLD_BOUNDS.min[axis] - o[axis]) / d[axis];
    const t2 = (WORLD_BOUNDS.max[axis] - o[axis]) / d[axis];
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  return Number.isFinite(tmax) && tmax > EPS ? tmax : null;
}

/** 按位置判定所在介质（玻璃槽 → 玻璃；内腔水下 → 水；其余 → 空气） */
export function mediumAt(p: V3): MediumName {
  const hx = TANK.innerHalf.x;
  const hy = TANK.innerHalf.y;
  const hz = TANK.innerHalf.z;
  const g = TANK.glass;
  const inGlass =
    (p.z >= hz - EPS && p.z <= hz + g + EPS && Math.abs(p.x) <= hx + EPS && p.y >= -EPS && p.y <= hy + EPS) ||
    (p.z >= -hz - g - EPS && p.z <= -hz + EPS && Math.abs(p.x) <= hx + EPS && p.y >= -EPS && p.y <= hy + EPS) ||
    (p.x >= hx - EPS && p.x <= hx + g + EPS && Math.abs(p.z) <= hz + EPS && p.y >= -EPS && p.y <= hy + EPS) ||
    (p.x >= -hx - g - EPS && p.x <= -hx + EPS && Math.abs(p.z) <= hz + EPS && p.y >= -EPS && p.y <= hy + EPS);
  if (inGlass) return 'glass';
  const inCavity = Math.abs(p.x) < hx && Math.abs(p.z) < hz && p.y > 0 && p.y < hy;
  if (inCavity && p.y < PLANES.waterY - EPS) return 'water';
  return 'air';
}

const MEDIUM_LABEL: Record<MediumName, string> = { air: '空气', glass: '玻璃', water: '水' };
export const mediumLabel = (m: MediumName): string => MEDIUM_LABEL[m];

interface NearestHit {
  t: number;
  kind: 'refract' | 'ruler' | 'opaque' | 'escape';
  surface: RefractSurface | BoxSurface;
  point: V3;
}

function nearestHit(o: V3, d: V3): NearestHit | null {
  let best: NearestHit | null = null;
  const consider = (t: number | null, kind: NearestHit['kind'], surface: RefractSurface | BoxSurface) => {
    if (t === null || t <= EPS) return;
    if (best === null || t < best.t) best = { t, kind, surface, point: at(o, d, t) };
  };

  for (const s of REFRACT_SURFACES) {
    const t = hitPlane(o, d, s.axis, s.value);
    if (t === null) continue;
    const p = at(o, d, t);
    const a = p[s.axisA];
    const b = p[s.axisB];
    const tol = 1e-5;
    if (a >= s.loA - tol && a <= s.hiA + tol && b >= s.loB - tol && b <= s.hiB + tol) {
      consider(t, 'refract', s);
    }
  }
  for (const b of BOX_SURFACES) {
    consider(hitBox(o, d, b.min, b.max), b.kind, b);
  }
  return best;
}

function axisNormal(axis: Axis, sign: 1 | -1): V3 {
  return axis === 'x' ? { x: sign, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: sign, z: 0 } : { x: 0, y: 0, z: sign };
}

function readingAt(p: V3, rulerId: 'back' | 'front'): Reading {
  // 标尺坐标以槽底内表面 y=0、内腔中线 x=0 为零位
  return {
    x: p.x,
    y: p.y,
    label: `${rulerId === 'back' ? '后标尺' : '前标尺'}  x=${p.x.toFixed(1)} cm, y=${p.y.toFixed(1)} cm`,
  };
}

/**
 * 单条光线追踪。
 * withBaseline=true 时附带全 n=1 直线基线（复用同一套遮挡几何），
 * 用于把等折射率 / 不等折射率结果放在同一套刻度上核对。
 */
export function traceRay(origin: V3, dirInput: V3, iors: IORSet, withBaseline = true): TraceResult {
  const result = traceImpl(origin, dirInput, iors, false);
  if (withBaseline) {
    result.baseline = traceImpl(origin, dirInput, UNIT_IOR, true);
  }
  const apparent = linePlane(origin, norm(dirInput), 'z', BACK_RULER.z);
  result.apparentPoint = apparent;
  return result;
}

function traceImpl(origin: V3, dirInput: V3, iors: IORSet, isBaseline: boolean): TraceResult {
  const d0 = norm(dirInput);
  let o = { ...origin };
  let d = d0;
  const points: V3[] = [{ ...origin }];
  const events: TraceEvent[] = [];
  let status: TraceStatus = 'out-of-range';
  let endpoint = { ...origin };
  let reading: Reading | undefined;
  let blockName: string | undefined;
  let blockerName: string | undefined;

  const iorOf = (m: MediumName): number => iors[m];

  for (let bounce = 0; bounce < MAX_BOUNCE; bounce++) {
    const hit = nearestHit(o, d);
    const exitT = worldExitT(o, d);
    if (hit === null || (exitT !== null && exitT < hit.t)) {
      // 穿出世界边界且此前没有任何命中 → 超出槽体可用范围
      const tOut = exitT ?? 30;
      endpoint = at(o, d, tOut);
      status = 'out-of-range';
      points.push(endpoint);
      if (!isBaseline) {
        events.push({
          kind: 'out-of-range',
          surface: '世界边界',
          point: endpoint,
          detail:
            exitT !== null
              ? '折射后路径超出槽体可用范围（红色虚线端），该画面位置没有对应的标尺读数'
              : '光线在到达标尺/方块前离开槽体可用范围',
        });
      }
      break;
    }
    const p = hit.point;

    if (hit.kind === 'ruler') {
      const bs = hit.surface as BoxSurface;
      points.push(p);
      const rulerId = bs.rulerId!;
      status = rulerId === 'back' ? 'ruler-back' : 'ruler-front';
      endpoint = p;
      reading = readingAt(p, rulerId);
      if (!isBaseline) {
        events.push({ kind: 'ruler', surface: bs.name, point: p, detail: reading.label });
      }
      break;
    }

    if (hit.kind === 'opaque') {
      const bs = hit.surface as BoxSurface;
      points.push(p);
      endpoint = p;
      blockerName = bs.name;
      const isBlock = BLOCKS.some((b) => b.name === bs.name);
      status = isBlock ? 'blocked-block' : 'blocked-frame';
      blockName = isBlock ? bs.name : undefined;
      if (!isBaseline) {
        events.push({
          kind: 'blocked',
          surface: bs.name,
          point: p,
          detail: isBlock ? `击中水中 ${bs.name}（不透明），路径终止` : `被不透明槽框「${bs.name}」挡住，保持正常遮挡`,
        });
      }
      break;
    }

    // 折射 / 全反射
    const s = hit.surface as RefractSurface;
    const m1 = mediumAt(o);
    const m2 = mediumAt(at(p, d, EPS * 10));
    const n1 = iorOf(m1);
    const n2 = iorOf(m2);
    const planeN = axisNormal(s.axis, 1);
    // 法线取朝向入射一侧
    const n = dot(d, planeN) > 0 ? scale(planeN, -1) : planeN;
    const cosI = -dot(d, n);
    const thetaI = (Math.acos(Math.min(1, Math.max(-1, cosI))) * 180) / Math.PI;
    const critical = n1 > n2 + 1e-12 ? (Math.asin(n2 / n1) * 180) / Math.PI : null;
    const sinT = (n1 / n2) * Math.sqrt(Math.max(0, 1 - cosI * cosI));

    points.push(p);

    if (sinT >= 1 - 1e-9) {
      const dRefl = norm(sub(d, scale(n, 2 * dot(d, n))));
      if (!isBaseline) {
        events.push({
          kind: 'tir',
          surface: s.name,
          point: p,
          medium1: m1,
          medium2: m2,
          n1,
          n2,
          thetaI,
          critical,
          detail: `入射角 ${thetaI.toFixed(1)}° ≥ 临界角 ${critical!.toFixed(1)}°，发生全反射，光线不进入${MEDIUM_LABEL[m2]}`,
        });
      }
      o = at(p, dRefl, EPS * 10);
      d = dRefl;
      continue;
    }

    const cosT = Math.sqrt(Math.max(0, 1 - sinT * sinT));
    const dRefr = norm({
      x: (n1 / n2) * d.x + ((n1 / n2) * cosI - cosT) * n.x,
      y: (n1 / n2) * d.y + ((n1 / n2) * cosI - cosT) * n.y,
      z: (n1 / n2) * d.z + ((n1 / n2) * cosI - cosT) * n.z,
    });
    const thetaT = (Math.acos(Math.min(1, Math.max(-1, cosT))) * 180) / Math.PI;
    if (!isBaseline) {
      events.push({
        kind: 'refract',
        surface: s.name,
        point: p,
        medium1: m1,
        medium2: m2,
        n1,
        n2,
        thetaI,
        thetaT,
        critical,
        detail: `${MEDIUM_LABEL[m1]}(n=${n1.toFixed(3)}) → ${MEDIUM_LABEL[m2]}(n=${n2.toFixed(3)})，入射角 ${thetaI.toFixed(1)}°，折射角 ${thetaT.toFixed(1)}°${
          critical !== null ? `，临界角 ${critical.toFixed(1)}°` : ''
        }`,
      });
    }
    o = at(p, dRefr, EPS * 10);
    d = dRefr;
  }

  // 反弹次数耗尽（全反射来回）也归入超范围
  if (status === 'out-of-range' && points.length >= MAX_BOUNCE) {
    endpoint = points[points.length - 1];
  }

  return {
    status,
    points,
    events,
    endpoint,
    reading,
    blockName,
    blockerName,
    baseline: null,
    apparentPoint: null,
  };
}

/** 直线与轴对齐平面交点（不含范围判断），用于表观读数 */
export function linePlane(origin: V3, dir: V3, axis: Axis, value: number): V3 | null {
  const t = hitPlane(origin, dir, axis, value);
  return t === null ? null : at(origin, dir, t);
}

/** 两条追踪结果在同一标尺上的位移 */
export function shiftText(actual: Reading | undefined, base: Reading | undefined): string {
  if (!actual || !base) return '—';
  const dx = actual.x - base.x;
  const dy = actual.y - base.y;
  if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return '0.0 cm（与基线重合）';
  const parts: string[] = [];
  if (Math.abs(dx) >= 0.05) parts.push(`水平 Δx=${dx >= 0 ? '+' : ''}${dx.toFixed(1)} cm`);
  if (Math.abs(dy) >= 0.05) parts.push(`竖直 Δy=${dy >= 0 ? '+' : ''}${dy.toFixed(1)} cm`);
  return parts.join('，');
}
