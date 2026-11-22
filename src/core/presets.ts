import {
  type Pose,
  type TrackSegment,
  type Vec2,
  arcFromPose,
  dist,
  headingOf,
  lineFromPose,
  rad,
} from './geometry.ts';
import type { NodeDef, PortId, TrackNetworkInit } from './network.ts';
import { TrackNetwork, portA, portB } from './network.ts';
import { type SwitchHints, computeSwitches } from './switch.ts';

/**
 * 场景/文档模型。
 *
 * Doc 是可编辑的 (拖动、旋转、拖端点), 每次编辑后由 docToNetwork 重建拓扑,
 * 校验器重新给出断开/非法转角等错误; 车辆通过 rebind 挂到新网络并做故障安全处理。
 */

export interface TrackDoc {
  title: string;
  segments: TrackSegment[];
  nodes: NodeDef[];
  /** 端口 -> 节点 id。未列出的端口视为断开。 */
  links: Record<PortId, string>;
  start: { segmentId: string; s: number };
  /** 分叉主方向提示 (对称分叉时用来固定主/备)。 */
  hints?: SwitchHints;
  presetId?: string;
}

export interface Preset {
  id: string;
  title: string;
  description: string;
  doc: TrackDoc;
}

/** 端点吸附半径: 拖端点时离节点多近算 "接上了"。 */
export const SNAP_DIST = 14;

export function docToNetwork(doc: TrackDoc): TrackNetwork {
  const init: TrackNetworkInit = {
    segments: doc.segments,
    nodes: doc.nodes,
    links: doc.links,
    start: doc.start,
  };
  return new TrackNetwork(init);
}

export function switchesFor(doc: TrackDoc, network = docToNetwork(doc)) {
  return computeSwitches(network, doc.hints ?? {});
}

export function cloneDoc(doc: TrackDoc): TrackDoc {
  return {
    title: doc.title,
    segments: [...doc.segments],
    nodes: doc.nodes.map((n) => ({ ...n, pos: { ...n.pos } })),
    links: { ...doc.links },
    start: { ...doc.start },
    ...(doc.hints ? { hints: JSON.parse(JSON.stringify(doc.hints)) as SwitchHints } : {}),
    ...(doc.presetId ? { presetId: doc.presetId } : {}),
  };
}

// ---------------------------------------------------------------------------
// 预设场景
// ---------------------------------------------------------------------------

interface LinePiece {
  kind: 'line';
  length: number;
}

interface ArcPiece {
  kind: 'arc';
  radius: number;
  /** 扫角 (度), 正 = 行进方向角增大。 */
  turnDeg: number;
}

type Piece = LinePiece | ArcPiece;

interface ChainResult {
  segments: TrackSegment[];
  /** 各接头位姿, 下标 0 = 起点, 末尾 = 终点。 */
  joints: Pose[];
}

/** 从起始位姿依次铺轨, 每段起点 = 上一段终点且相切。 */
function buildChain(prefix: string, start: Pose, pieces: Piece[]): ChainResult {
  const segments: TrackSegment[] = [];
  const joints: Pose[] = [{ pos: { ...start.pos }, tangent: { ...start.tangent } }];
  let pose = start;
  pieces.forEach((piece, i) => {
    const id = `${prefix}${i + 1}`;
    const seg =
      piece.kind === 'line'
        ? lineFromPose(id, pose, piece.length)
        : arcFromPose(id, pose, piece.radius, rad(piece.turnDeg));
    segments.push(seg);
    pose = seg.poseAt(1);
    joints.push({ pos: { ...pose.pos }, tangent: { ...pose.tangent } });
  });
  return { segments, joints };
}

function poseAt(x: number, y: number, headingDeg: number): Pose {
  const a = rad(headingDeg);
  return { pos: { x, y }, tangent: { x: Math.cos(a), y: Math.sin(a) } };
}

function assertClose(a: Vec2, b: Vec2, what: string, eps = 1e-6): void {
  if (dist(a, b) > eps) {
    throw new Error(
      `${what} 未闭合: (${a.x.toFixed(3)}, ${a.y.toFixed(3)}) vs (${b.x.toFixed(3)}, ${b.y.toFixed(3)})`,
    );
  }
}

/** 预设 1: 圆角矩形闭环 (4 直 + 4 个 90° 圆弧)。 */
export function presetLoop(): Preset {
  const start = poseAt(240, 220, 0);
  const { segments, joints } = buildChain('L', start, [
    { kind: 'line', length: 400 },
    { kind: 'arc', radius: 120, turnDeg: 90 },
    { kind: 'line', length: 200 },
    { kind: 'arc', radius: 120, turnDeg: 90 },
    { kind: 'line', length: 400 },
    { kind: 'arc', radius: 120, turnDeg: 90 },
    { kind: 'line', length: 200 },
    { kind: 'arc', radius: 120, turnDeg: 90 },
  ]);
  assertClose(joints[joints.length - 1]!.pos, start.pos, '闭环预设');

  const nodes: NodeDef[] = joints.slice(0, -1).map((j, i) => ({
    id: `N${i}`,
    pos: { ...j.pos },
    label: i === 0 ? '起点 N0' : `N${i}`,
  }));
  const links: Record<PortId, string> = {};
  segments.forEach((seg, i) => {
    links[portA(seg.id)] = `N${i}`;
    links[portB(seg.id)] = `N${(i + 1) % segments.length}`;
  });

  return {
    id: 'loop',
    title: '闭环',
    description: '4 条直线 + 4 个 90° 圆弧 (R=120) 组成的闭合环线; 无道岔, 车会一直绕圈。',
    doc: {
      title: '闭环 (圆角矩形)',
      segments,
      nodes,
      links,
      start: { segmentId: segments[0]!.id, s: 0 },
      presetId: 'loop',
    },
  };
}

/** 预设 2: 连续急弯 (R=25 的 90°/180° 紧弯 + 短直), 开放线路。 */
export function presetSharp(): Preset {
  const start = poseAt(200, 200, 0);
  const { segments, joints } = buildChain('H', start, [
    { kind: 'line', length: 100 },
    { kind: 'arc', radius: 25, turnDeg: 90 },
    { kind: 'line', length: 100 },
    { kind: 'arc', radius: 25, turnDeg: -90 },
    { kind: 'line', length: 100 },
    { kind: 'arc', radius: 25, turnDeg: 90 },
    { kind: 'line', length: 100 },
    { kind: 'arc', radius: 25, turnDeg: -90 },
    { kind: 'line', length: 100 },
    { kind: 'arc', radius: 25, turnDeg: 180 },
    { kind: 'line', length: 100 },
  ]);

  const nodes: NodeDef[] = joints.map((j, i) => ({
    id: `H${i}`,
    pos: { ...j.pos },
    label: i === 0 ? '起点 H0' : i === joints.length - 1 ? '终点' : `H${i}`,
  }));
  const links: Record<PortId, string> = {};
  segments.forEach((seg, i) => {
    links[portA(seg.id)] = `H${i}`;
    links[portB(seg.id)] = `H${i + 1}`;
  });

  return {
    id: 'sharp',
    title: '急弯',
    description: 'R=25 的连续 90° S 弯与 180° 发夹弯; 弯道再急, 线速度也保持不变。',
    doc: {
      title: '急弯 (R=25)',
      segments,
      nodes,
      links,
      start: { segmentId: segments[0]!.id, s: 0 },
      presetId: 'sharp',
    },
  };
}

/**
 * 预设 3: 分叉闭环。J 处分叉, 主方向是直行主线 F2, 备选方向是偏 22° 的绕行弧 FX, 两路在 K 汇合。
 */
export function presetFork(): Preset {
  const start = poseAt(240, 220, 0);
  const { segments, joints } = buildChain('F', start, [
    { kind: 'line', length: 200 }, // F1: 起点 -> J(440,220)
    { kind: 'line', length: 160 }, // F2: 主线 J -> K(600,220)
    { kind: 'line', length: 40 }, // F3: K -> (640,220)
    { kind: 'arc', radius: 120, turnDeg: 90 }, // F4
    { kind: 'line', length: 200 }, // F5
    { kind: 'arc', radius: 120, turnDeg: 90 }, // F6
    { kind: 'line', length: 400 }, // F7
    { kind: 'arc', radius: 120, turnDeg: 90 }, // F8
    { kind: 'line', length: 200 }, // F9
    { kind: 'arc', radius: 120, turnDeg: 90 }, // F10
  ]);
  assertClose(joints[joints.length - 1]!.pos, start.pos, '分叉闭环');

  const J = joints[1]!;
  const K = joints[2]!;
  assertClose(J.pos, { x: 440, y: 220 }, '分叉点 J');
  assertClose(K.pos, { x: 600, y: 220 }, '汇合点 K');

  // 绕行弧: 从 J 以 -22° 上行, 终点精确落到 K。
  const halfDeg = 22;
  const half = rad(halfDeg);
  const chord = dist(J.pos, K.pos);
  const radius = chord / 2 / Math.sin(half);
  const bypass = arcFromPose('FX', poseAt(J.pos.x, J.pos.y, -halfDeg), radius, 2 * half);
  assertClose(bypass.poseAt(1).pos, K.pos, '绕行弧终点');

  const nodeDefs: NodeDef[] = joints.slice(0, -1).map((j, i) => {
    const id = i === 0 ? 'P0' : i === 1 ? 'J' : i === 2 ? 'K' : `P${i}`;
    const label = i === 0 ? '起点 P0' : i === 1 ? '分叉 J' : i === 2 ? '汇合 K' : id;
    return { id, pos: { ...j.pos }, label };
  });
  const links: Record<PortId, string> = {};
  segments.forEach((seg, i) => {
    links[portA(seg.id)] = nodeDefs[i]!.id;
    links[portB(seg.id)] = nodeDefs[(i + 1) % segments.length]!.id;
  });
  links[portA(bypass.id)] = 'J';
  links[portB(bypass.id)] = 'K';

  return {
    id: 'fork',
    title: '分叉',
    description: 'J 处分叉: 主方向走直行主线 F2, 备选方向走偏 22° 的绕行弧 FX; 两路在 K 汇合后继续环线。',
    doc: {
      title: '分叉闭环',
      segments: [...segments, bypass],
      nodes: nodeDefs,
      links,
      start: { segmentId: segments[0]!.id, s: 0 },
      hints: { primaryByNode: { J: segments[1]!.id } },
      presetId: 'fork',
    },
  };
}

export function buildPresets(): Preset[] {
  return [presetLoop(), presetSharp(), presetFork()];
}

export function presetById(id: string): Preset | undefined {
  return buildPresets().find((p) => p.id === id);
}

export function headingDeg(pose: Pose): number {
  return (headingOf(pose.tangent) * 180) / Math.PI;
}
