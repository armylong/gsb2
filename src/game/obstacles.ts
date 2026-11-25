import type { ObstacleDef, Pose, PoseMap } from './types';

// 四块可移动遮挡物：两朵云、一面大雾幕、一架木屏
export const OBSTACLES: ObstacleDef[] = [
  {
    id: 'cloud-a',
    name: '东山云',
    shape: {
      kind: 'cloud',
      circles: [
        { dx: 0, dy: 0, r: 27 },
        { dx: -25, dy: 9, r: 20 },
        { dx: 25, dy: 9, r: 20 },
        { dx: 2, dy: 14, r: 21 },
      ],
    },
  },
  {
    id: 'cloud-b',
    name: '西山云',
    shape: {
      kind: 'cloud',
      circles: [
        { dx: 0, dy: 0, r: 25 },
        { dx: -23, dy: 8, r: 18 },
        { dx: 23, dy: 8, r: 18 },
        { dx: 0, dy: 13, r: 19 },
      ],
    },
  },
  { id: 'veil', name: '隔山雾幕', shape: { kind: 'veil', r: 47 } },
  { id: 'screen', name: '移动木屏', shape: { kind: 'screen', w: 122, h: 36 } },
  { id: 'shield', name: '游骑皮盾', shape: { kind: 'shield', r: 15 } },
];

export const OBSTACLE_MAP: Record<string, ObstacleDef> = Object.fromEntries(
  OBSTACLES.map((o) => [o.id, o]),
);

/** 初始 / 安全停泊位（前景，不遮挡任何站台间视线） */
export const PARKED: Record<string, Pose> = {
  'cloud-a': { x: 88, y: 588 },
  'cloud-b': { x: 912, y: 588 },
  veil: { x: 392, y: 582 },
  screen: { x: 636, y: 600 },
  shield: { x: 250, y: 608 },
};

export function cloneParked(): Record<string, Pose> {
  return Object.fromEntries(Object.entries(PARKED).map(([k, p]) => [k, { ...p }]));
}

// ---------- 线段 vs 形状 ----------

interface XY {
  x: number;
  y: number;
}

function distPointSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentHitsCircle(a: XY, b: XY, c: XY, r: number): boolean {
  return distPointSegment(c, a, b) <= r;
}

function pointInRect(p: XY, c: XY, w: number, h: number): boolean {
  return Math.abs(p.x - c.x) <= w / 2 && Math.abs(p.y - c.y) <= h / 2;
}

function segmentsIntersect(p1: XY, p2: XY, p3: XY, p4: XY): boolean {
  const d = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  const r = { x: p2.x - p1.x, y: p2.y - p1.y };
  const s = { x: p4.x - p3.x, y: p4.y - p3.y };
  const denom = d(r.x, r.y, s.x, s.y);
  if (denom === 0) return false;
  const qp = { x: p3.x - p1.x, y: p3.y - p1.y };
  const t = d(qp.x, qp.y, s.x, s.y) / denom;
  const u = d(qp.x, qp.y, r.x, r.y) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function segmentHitsRect(a: XY, b: XY, c: XY, w: number, h: number): boolean {
  if (pointInRect(a, c, w, h) || pointInRect(b, c, w, h)) return true;
  const x0 = c.x - w / 2;
  const x1 = c.x + w / 2;
  const y0 = c.y - h / 2;
  const y1 = c.y + h / 2;
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

/** 线段视线是否被某块遮挡物挡住；返回遮挡物 id 或 null */
export function blockedBy(
  eyePos: Pose,
  target: Pose,
  pose: Pose,
  def: ObstacleDef,
): boolean {
  const shape = def.shape;
  if (shape.kind === 'cloud') {
    return shape.circles.some((c) =>
      segmentHitsCircle(eyePos, target, { x: pose.x + c.dx, y: pose.y + c.dy }, c.r),
    );
  }
  if (shape.kind === 'veil' || shape.kind === 'shield') {
    return segmentHitsCircle(eyePos, target, pose, shape.r);
  }
  return segmentHitsRect(eyePos, target, pose, shape.w, shape.h);
}

/** 找到第一块挡住视线的遮挡物 id */
export function firstBlocker(
  eyePos: Pose,
  target: Pose,
  poses: PoseMap,
): string | null {
  for (const def of OBSTACLES) {
    const pose = poses[def.id];
    if (pose && blockedBy(eyePos, target, pose, def)) return def.id;
  }
  return null;
}

export function obstacleAt(
  x: number,
  y: number,
  poses: PoseMap,
): string | null {
  // 后绘制的在上层，倒序拾取
  for (let i = OBSTACLES.length - 1; i >= 0; i--) {
    const def = OBSTACLES[i];
    const p = poses[def.id];
    if (!p) continue;
    const shape = def.shape;
    if (shape.kind === 'screen') {
      if (pointInRect({ x, y }, p, shape.w, shape.h)) return def.id;
    } else if (shape.kind === 'veil' || shape.kind === 'shield') {
      if (Math.hypot(x - p.x, y - p.y) <= shape.r + 4) return def.id;
    } else {
      if (
        shape.circles.some(
          (c) => Math.hypot(x - (p.x + c.dx), y - (p.y + c.dy)) <= c.r + 4,
        )
      ) {
        return def.id;
      }
    }
  }
  return null;
}
