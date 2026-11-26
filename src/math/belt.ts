/**
 * 闭合带几何：三只滚轮（凸包顺序）+ 相邻轮之间的外切直线段 + 每只轮上的包角弧。
 *
 * 整条闭合带路按弧长 s 参数化，元素交替出现：
 *   wrap(轮 i) -> line(轮 i -> 轮 i+1) -> wrap(轮 i+1) -> ...
 * 运动约定：沿带路 s 增大方向前进时，每只轮上的包角均为顺时针方向，
 * 外法线 n = 右法线(ty, -tx)（背离轮心）。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Pulley {
  center: Vec2;
  radius: number;
}

export interface LineSeg {
  kind: 'line';
  start: Vec2; // 轮 i 上的离开点
  end: Vec2; // 轮 i+1 上的进入点
  s0: number;
  s1: number;
  from: number;
  to: number;
}

export interface ArcSeg {
  kind: 'arc';
  center: Vec2;
  radius: number;
  thetaStart: number;
  thetaEnd: number;
  /** 顺时针包角，始终为正（弧度），等于弧长 / 半径 */
  wrap: number;
  s0: number;
  s1: number;
  pulley: number;
}

export type PathSeg = LineSeg | ArcSeg;

export interface BeltPath {
  segments: PathSeg[];
  length: number;
  /** 每只轮的接触范围（极角区间，世界坐标） */
  contacts: { pulley: number; thetaStart: number; thetaEnd: number; wrap: number }[];
  pulleys: Pulley[];
}

export type ConflictReason =
  | 'overlap' // 两只轮相交（两轮距离不足）
  | 'containment' // 一只轮被另一只完全包住，外切线不存在
  | 'wrap' // 包角过小，该轮被带路绕过
  | 'crossing'; // 直线段互相交叉（偏心布置等）

export interface Conflict {
  reason: ConflictReason;
  wheels: number[];
  message: string;
}

export interface BuildResult {
  ok: boolean;
  path?: BeltPath;
  conflicts: Conflict[];
}

export const MIN_WRAP = 0.05; // 约 2.9°，小于此视为包角失效

// ---------- 基础向量工具 ----------

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => v(a.x + b.x, a.y + b.y);
export const sub = (a: Vec2, b: Vec2): Vec2 => v(a.x - b.x, a.y - b.y);
export const scale = (a: Vec2, k: number): Vec2 => v(a.x * k, a.y * k);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => len(sub(a, b));
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return v(a.x / l, a.y / l);
};
export const rightNormal = (t: Vec2): Vec2 => v(t.y, -t.x); // 右法线（外法线）

/** 角度规范化到 [0, 2π) */
export function mod2pi(a: number): number {
  const x = a % (2 * Math.PI);
  return x < 0 ? x + 2 * Math.PI : x;
}

// ---------- 外切线 ----------

/**
 * 求轮 a -> 轮 b 的外切线，沿 s 增大方向行进。
 * 轮心按凸包逆时针排列时，外法线在行进方向右侧（即 n = 右法线，cross(d, n) < 0），
 * 轮上的包角弧因此为顺时针方向。
 * 返回两个切点（a 上的离开点、b 上的进入点）。
 */
export function externalTangent(a: Pulley, b: Pulley): { p: Vec2; q: Vec2; t: Vec2; n: Vec2 } | null {
  const d = sub(b.center, a.center);
  const dLen = len(d);
  const dr = b.radius - a.radius;
  if (dLen < 1e-9) return null;
  if (dLen <= Math.abs(dr) + 1e-9) return null; // 包含关系，无外切线

  // 外切线切点处两半径平行（外法线同为 n），由 (q-p) ⟂ n 得 d·n = ra - rb
  const base = Math.acos(Math.min(1, Math.max(-1, (a.radius - b.radius) / dLen)));
  const phi = Math.atan2(d.y, d.x);

  for (const alpha of [phi + base, phi - base]) {
    const n = v(Math.cos(alpha), Math.sin(alpha));
    if (cross(d, n) <= 0) continue; // 取连心线左侧的外法线（n 在 d 逆时针方向）
    const p = add(a.center, scale(n, a.radius));
    const q = add(b.center, scale(n, b.radius));
    const t = norm(sub(q, p));
    return { p, q, t, n };
  }
  return null;
}

// ---------- 冲突检测辅助 ----------

function segIntersectInterior(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-10) return false;
  const t = cross(sub(q1, p1), s) / denom;
  const u = cross(sub(q1, p1), r) / denom;
  const eps = 1e-7;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

function pointSegDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return dist(p, add(a, scale(ab, t)));
}

// ---------- 带路构建 ----------

export function buildBelt(pulleys: Pulley[]): BuildResult {
  const n = pulleys.length;
  const conflicts: Conflict[] = [];

  // 1) 轮间直接相交 / 包含
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist(pulleys[i].center, pulleys[j].center);
      const ri = pulleys[i].radius;
      const rj = pulleys[j].radius;
      if (d < ri + rj - 1e-7) {
        if (d + Math.min(ri, rj) <= Math.max(ri, rj) + 1e-7) {
          conflicts.push({
            reason: 'containment',
            wheels: [i, j],
            message: `轮 ${i} 与轮 ${j} 存在包含关系，外切线不存在（中心距 ${d.toFixed(2)}，半径 ${ri.toFixed(2)}/${rj.toFixed(2)}）`,
          });
        } else {
          conflicts.push({
            reason: 'overlap',
            wheels: [i, j],
            message: `轮 ${i} 与轮 ${j} 两轮距离不足、实体相交（中心距 ${d.toFixed(2)} < 半径和 ${(ri + rj).toFixed(2)}）`,
          });
        }
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  // 2) 相邻轮外切线
  const tangents: ({ p: Vec2; q: Vec2; t: Vec2; n: Vec2 } | null)[] = [];
  for (let i = 0; i < n; i++) {
    const t = externalTangent(pulleys[i], pulleys[(i + 1) % n]);
    if (!t) {
      conflicts.push({
        reason: 'containment',
        wheels: [i, (i + 1) % n],
        message: `轮 ${i} 与轮 ${(i + 1) % n} 之间无法作出外切线`,
      });
    }
    tangents.push(t);
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  // 3) 直线段之间交叉（内部交点）
  const lines: { a: Vec2; b: Vec2; from: number; to: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i]!;
    lines.push({ a: t.p, b: t.q, from: i, to: (i + 1) % n });
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (segIntersectInterior(lines[i].a, lines[i].b, lines[j].a, lines[j].b)) {
        conflicts.push({
          reason: 'crossing',
          wheels: [lines[i].from, lines[i].to, lines[j].from, lines[j].to],
          message: `直线段（轮 ${lines[i].from}→${lines[i].to}）与（轮 ${lines[j].from}→${lines[j].to}）在内部交叉，带路不闭合`,
        });
      }
    }
  }

  // 4) 非相邻轮实体穿过直线段（偏心轮挤入直段）
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      if (k === lines[i].from || k === lines[i].to) continue;
      const d = pointSegDistance(pulleys[k].center, lines[i].a, lines[i].b);
      if (d < pulleys[k].radius - 1e-7) {
        conflicts.push({
          reason: 'crossing',
          wheels: [k, lines[i].from, lines[i].to],
          message: `轮 ${k} 侵入轮 ${lines[i].from}→${lines[i].to} 的直线段（距 ${d.toFixed(2)} < 半径 ${pulleys[k].radius.toFixed(2)}）`,
        });
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  // 5) 组装路径并计算包角
  const segments: PathSeg[] = [];
  const contacts: BeltPath['contacts'] = [];
  let s = 0;

  for (let i = 0; i < n; i++) {
    const prev = tangents[(i - 1 + n) % n]!; // 进入轮 i 的切线
    const next = tangents[i]!; // 离开轮 i 的切线
    const pulley = pulleys[i];

    const entry = prev.q; // 轮 i 上的进入点
    const exit = next.p; // 轮 i 上的离开点
    const thetaIn = mod2pi(Math.atan2(entry.y - pulley.center.y, entry.x - pulley.center.x));
    const thetaOut = mod2pi(Math.atan2(exit.y - pulley.center.y, exit.x - pulley.center.x));
    const wrap = mod2pi(thetaIn - thetaOut); // 顺时针扫过角度

    if (wrap < MIN_WRAP) {
      conflicts.push({
        reason: 'wrap',
        wheels: [i],
        message: `轮 ${i} 的接触包角仅 ${(wrap * 180 / Math.PI).toFixed(1)}°，带路无法有效贴合该轮`,
      });
      continue;
    }

    const arc: ArcSeg = {
      kind: 'arc',
      center: pulley.center,
      radius: pulley.radius,
      thetaStart: thetaIn,
      thetaEnd: thetaOut,
      wrap,
      s0: s,
      s1: s + pulley.radius * wrap,
      pulley: i,
    };
    segments.push(arc);
    contacts.push({ pulley: i, thetaStart: thetaIn, thetaEnd: thetaOut, wrap });
    s = arc.s1;

    const lineLen = dist(next.p, next.q);
    const line: LineSeg = {
      kind: 'line',
      start: next.p,
      end: next.q,
      s0: s,
      s1: s + lineLen,
      from: i,
      to: (i + 1) % n,
    };
    segments.push(line);
    s = line.s1;
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  return { ok: true, conflicts: [], path: { segments, length: s, contacts, pulleys } };
}

// ---------- 按弧长采样（直段 / 弯段统一接口） ----------

export interface Sample {
  p: Vec2;
  tangent: Vec2;
  normal: Vec2; // 外法线（左法线）
  curvature: number; // 1/r，直线为 0
  pulley: number; // 所在轮编号；直线段为 -1
}

export function sampleAt(path: BeltPath, sRaw: number): Sample {
  const s = ((sRaw % path.length) + path.length) % path.length;

  // 元素数量很少（2n），线性扫描即可
  for (const seg of path.segments) {
    if (s > seg.s1 && !(seg === path.segments[path.segments.length - 1])) continue;

    if (seg.kind === 'line') {
      const t = Math.min(1, Math.max(0, (s - seg.s0) / (seg.s1 - seg.s0 || 1)));
      const tangent = norm(sub(seg.end, seg.start));
      return {
        p: add(seg.start, scale(sub(seg.end, seg.start), t)),
        tangent,
        normal: rightNormal(tangent),
        curvature: 0,
        pulley: -1,
      };
    }

    const u = Math.min(1, Math.max(0, (s - seg.s0) / (seg.s1 - seg.s0 || 1)));
    const theta = seg.thetaStart - u * seg.wrap; // 顺时针
    const radial = v(Math.cos(theta), Math.sin(theta));
    const tangent = v(radial.y, -radial.x); // 顺时针切向
    return {
      p: add(seg.center, scale(radial, seg.radius)),
      tangent,
      normal: radial,
      curvature: 1 / seg.radius,
      pulley: seg.pulley,
    };
  }

  // 浮点兜底
  return sampleAt(path, 0);
}
