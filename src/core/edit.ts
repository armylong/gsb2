import {
  type Pose,
  type TrackSegment,
  type Vec2,
  ArcSegment,
  LineSegment,
  add,
  arcFromPose,
  dist,
  lineFromPose,
  norm,
  rotate,
  sub,
} from './geometry.ts';
import type { TrackDoc } from './presets.ts';
import { SNAP_DIST, cloneDoc } from './presets.ts';
import { type PortId, portA, portB } from './network.ts';

/**
 * 文档编辑操作。
 *
 * 设计原则 (对应需求 1/4):
 * - "加直线 / 加圆弧" 永远从上一条轨段的 B 端出发并与它相切, 因此新接头天然满足
 *   端点连接规则; 新段落会得到自己的 B 端节点。
 * - "拖整段 / 拖节点" 故意 **不** 联动节点, 于是节点与端点错位 => 校验器报断开。
 * - "绕 A 端旋转" 保持 A 端贴合节点, 但会改变 B 端行进方向 => 接缝处产生非法转角。
 * 这样两类故障都能在界面上被复现出来。
 */

let seq = 0;
function nextId(prefix = 'E'): string {
  seq += 1;
  return `${prefix}${seq}`;
}

export function translateSegment(seg: TrackSegment, delta: Vec2): TrackSegment {
  if (seg instanceof LineSegment) {
    return new LineSegment({ id: seg.id, start: add(seg.start, delta), end: add(seg.end, delta) });
  }
  const arc = seg as ArcSegment;
  return new ArcSegment({
    id: arc.id,
    center: add(arc.center, delta),
    radius: arc.radius,
    startAngle: arc.startAngle,
    sweep: arc.sweep,
  });
}

export function rotateSegmentAbout(seg: TrackSegment, pivot: Vec2, angle: number): TrackSegment {
  if (seg instanceof LineSegment) {
    return new LineSegment({
      id: seg.id,
      start: add(pivot, rotate(sub(seg.start, pivot), angle)),
      end: add(pivot, rotate(sub(seg.end, pivot), angle)),
    });
  }
  const arc = seg as ArcSegment;
  return new ArcSegment({
    id: arc.id,
    center: add(pivot, rotate(sub(arc.center, pivot), angle)),
    radius: arc.radius,
    startAngle: arc.startAngle + angle,
    sweep: arc.sweep,
  });
}

/** 把某段替换为新几何, 返回新文档。 */
export function replaceSegment(doc: TrackDoc, seg: TrackSegment): TrackDoc {
  const next = cloneDoc(doc);
  next.segments = next.segments.map((s) => (s.id === seg.id ? seg : s));
  return next;
}

export function removeSegment(doc: TrackDoc, segmentId: string): TrackDoc {
  const next = cloneDoc(doc);
  next.segments = next.segments.filter((s) => s.id !== segmentId);
  delete next.links[portA(segmentId)];
  delete next.links[portB(segmentId)];
  if (next.start.segmentId === segmentId && next.segments.length > 0) {
    next.start = { segmentId: next.segments[0]!.id, s: 0 };
  }
  return next;
}

/** 移动节点 (轨段端点是独立对象, 因此会立刻 "断开")。 */
export function moveNode(doc: TrackDoc, nodeId: string, delta: Vec2): TrackDoc {
  const next = cloneDoc(doc);
  next.nodes = next.nodes.map((n) => (n.id === nodeId ? { ...n, pos: add(n.pos, delta) } : n));
  return next;
}

/** 新建节点 id。 */
function newNodeId(doc: TrackDoc): string {
  let i = doc.nodes.length;
  let id = `N${i}`;
  while (doc.nodes.some((n) => n.id === id)) {
    i += 1;
    id = `N${i}`;
  }
  return id;
}

/**
 * 从某段 B 端延伸一条直线。返回新文档与被创建的段 id。
 * 原 B 端节点被复用为接头; 新段 B 端新建节点。
 */
export function appendLine(
  doc: TrackDoc,
  fromSegmentId: string,
  length: number,
): { doc: TrackDoc; segmentId: string } {
  const from = doc.segments.find((s) => s.id === fromSegmentId);
  if (!from) throw new Error(`找不到轨段 ${fromSegmentId}`);
  const pose = from.poseAt(1);
  const id = nextId('E');
  const seg = lineFromPose(id, pose, length);
  return attachNewSegment(doc, seg, fromSegmentId);
}

/** 从某段 B 端延伸一段圆弧 (与 B 端相切)。 */
export function appendArc(
  doc: TrackDoc,
  fromSegmentId: string,
  radius: number,
  turnDeg: number,
): { doc: TrackDoc; segmentId: string } {
  const from = doc.segments.find((s) => s.id === fromSegmentId);
  if (!from) throw new Error(`找不到轨段 ${fromSegmentId}`);
  const pose = from.poseAt(1);
  const id = nextId('E');
  const seg = arcFromPose(id, pose, radius, (turnDeg * Math.PI) / 180);
  return attachNewSegment(doc, seg, fromSegmentId);
}

function attachNewSegment(
  doc: TrackDoc,
  seg: TrackSegment,
  fromSegmentId: string,
): { doc: TrackDoc; segmentId: string } {
  const next = cloneDoc(doc);
  next.segments.push(seg);
  // A 端优先接源段 B 端所在的节点; 否则退化为 "附近节点" 或新建。
  const linked = next.links[portB(fromSegmentId)];
  const anchorNodeId =
    linked && next.nodes.some((n) => n.id === linked) ? linked : findNodeAt(next, seg.poseAt(0).pos);
  if (anchorNodeId) {
    // 若不把新段 B 端接出去, 那源段的 B 端就不该再独自占有这个节点? 不: 一入多出正是分叉。
    next.links[portA(seg.id)] = anchorNodeId;
  } else {
    const nodeId = newNodeId(next);
    next.nodes.push({ id: nodeId, pos: { ...seg.poseAt(0).pos }, label: nodeId });
    next.links[portA(seg.id)] = nodeId;
  }
  const endNodeId = newNodeId(next);
  next.nodes.push({ id: endNodeId, pos: { ...seg.poseAt(1).pos }, label: endNodeId });
  next.links[portB(seg.id)] = endNodeId;
  delete next.presetId;
  if (!next.segments.some((s) => s.id === next.start.segmentId)) {
    next.start = { segmentId: seg.id, s: 0 };
  }
  return { doc: next, segmentId: seg.id };
}

/** 找到位置最接近的节点 (吸附)。 */
export function findNodeAt(doc: TrackDoc, pos: Vec2, radius = SNAP_DIST): string | null {
  if (radius <= 0) return null; // 关闭吸附时不自动并入任何节点
  let best: { id: string; d: number } | null = null;
  for (const n of doc.nodes) {
    const d = dist(n.pos, pos);
    if (d <= radius && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best?.id ?? null;
}

/** 找到某个位置附近的段端点及其出射切线 (用于绘制时延续方向)。 */
export function findExtensionAt(
  doc: TrackDoc,
  pos: Vec2,
  radius = SNAP_DIST,
): { point: Vec2; tangent: Vec2; segmentId: string; nodeId: string | null } | null {
  if (radius <= 0) return null;
  let best: { d: number; point: Vec2; tangent: Vec2; segmentId: string; nodeId: string | null } | null = null;
  for (const seg of doc.segments) {
    for (const end of ['B', 'A'] as const) {
      const pose = seg.poseAt(end === 'B' ? 1 : 0);
      const d = dist(pose.pos, pos);
      if (d > radius) continue;
      if (best && d >= best.d) continue;
      const tangent = end === 'B' ? pose.tangent : { x: -pose.tangent.x, y: -pose.tangent.y };
      const nodeId = doc.links[end === 'B' ? portB(seg.id) : portA(seg.id)] ?? null;
      best = { d, point: { ...pose.pos }, tangent, segmentId: seg.id, nodeId };
    }
  }
  return best ? { point: best.point, tangent: best.tangent, segmentId: best.segmentId, nodeId: best.nodeId } : null;
}

/**
 * 手动绘制的轨段: 起点 / 终点可分别接到给定 (或就近吸附到的) 节点。
 * 若终点落在已有节点附近, 会直接并入该节点 —— 这正是 "分叉/合流" 的产生方式。
 */
export function addDrawnSegment(
  doc: TrackDoc,
  seg: TrackSegment,
  opts: { startNodeId?: string | null; endNodeId?: string | null; snapRadius?: number } = {},
): { doc: TrackDoc; segmentId: string } {
  const next = cloneDoc(doc);
  const snapRadius = opts.snapRadius ?? SNAP_DIST;
  next.segments.push(seg);

  const attach = (candidateNodeId: string | null | undefined, at: Vec2, port: PortId): void => {
    let nodeId = candidateNodeId ?? null;
    if (nodeId && !next.nodes.some((n) => n.id === nodeId)) nodeId = null;
    if (!nodeId) nodeId = findNodeAt(next, at, snapRadius);
    if (!nodeId) {
      nodeId = newNodeId(next);
      next.nodes.push({ id: nodeId, pos: { ...at }, label: nodeId });
    }
    next.links[port] = nodeId;
  };

  attach(opts.startNodeId, seg.poseAt(0).pos, portA(seg.id));
  attach(opts.endNodeId, seg.poseAt(1).pos, portB(seg.id));
  delete next.presetId;
  if (!next.segments.some((s) => s.id === next.start.segmentId)) {
    next.start = { segmentId: seg.id, s: 0 };
  }
  return { doc: next, segmentId: seg.id };
}

export interface HitSegment {
  segmentId: string;
  distance: number;
  /** 命中点在该段上的参数 u。 */
  u: number;
}

/** 命中测试: 返回离点最近的轨段 (在容差内)。 */
export function hitSegment(doc: TrackDoc, pos: Vec2, worldTolerance: number): HitSegment | null {
  let best: HitSegment | null = null;
  for (const seg of doc.segments) {
    const n = 96;
    for (let i = 0; i < n; i += 1) {
      const u = i / (n - 1);
      const p = seg.poseAt(u).pos;
      const d = dist(p, pos);
      if (d <= worldTolerance && (!best || d < best.distance)) {
        best = { segmentId: seg.id, distance: d, u };
      }
    }
  }
  return best;
}

export function hitNode(doc: TrackDoc, pos: Vec2, worldTolerance: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const n of doc.nodes) {
    const d = dist(n.pos, pos);
    if (d <= worldTolerance && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best?.id ?? null;
}

/** 旋转手柄位置: 从段中点沿法线外推。 */
export function rotateHandlePos(seg: TrackSegment, offset: number): Vec2 {
  const mid = seg.poseAt(0.5);
  const normal = norm({ x: -mid.tangent.y, y: mid.tangent.x });
  return add(mid.pos, { x: normal.x * offset, y: normal.y * offset });
}

export function midpoint(seg: TrackSegment): Pose {
  return seg.poseAt(0.5);
}
