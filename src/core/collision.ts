/**
 * 确定性碰撞扫描:
 * - 把检查区间等分为固定步数 (与帧率/播放速度无关);
 * - 状态切换点用二分法精化到 1e-5 时间精度;
 * - 区分 "贴边 (grazing, 侵入深度 <= grazingTol)" 与 "进入障碍 (penetrating)"。
 */
import { getPose, type Mechanism, type Pose } from './kinematics';
import { type OBB, type SatResult, type Vec3, satOBB } from './math3d';

export interface ObstacleSpec {
  id: string;
  name: string;
  center: Vec3;
  size: Vec3;
}

export type PartKind = 'door' | 'tray';
export type ContactKind = 'grazing' | 'penetrating';

export interface ContactLabel {
  kind: ContactKind;
  /** 撞到的障碍面名称 (如 "障碍A: 正面 +Z") */
  obstacleFace: string;
  /** 零件侧接触面/边描述 */
  partSide: string;
}

export interface CollisionEvent {
  obstacleId: string;
  obstacleName: string;
  part: PartKind;
  kind: ContactKind;
  /** 首次接触的归一化时刻 */
  enterT: number;
  /** 分开时刻 (区间结束仍接触则等于区间右端) */
  exitT: number;
  /** 区间内最大侵入深度 (mm) */
  maxDepth: number;
  /** 最大侵入出现的时刻 */
  maxDepthT: number;
  enterLabel: ContactLabel;
}

export interface LiveContact {
  obstacleId: string;
  obstacleName: string;
  part: PartKind;
  kind: ContactKind;
  depth: number;
  point: Vec3;
  normal: Vec3;
  label: ContactLabel;
}

export interface ScanOptions {
  /** 检查区间 (归一化时刻) */
  range: [number, number];
  /** 等分扫描步数 */
  steps?: number;
  /** 接触判定容差 (净距 <= 该值视为接触), mm */
  contactTol?: number;
  /** 贴边/侵入分界的侵入深度, mm */
  grazingTol?: number;
}

export interface ScanResult {
  events: CollisionEvent[];
  range: [number, number];
  steps: number;
}

const AXIS_NAMES = ['X', 'Y', 'Z'];
const FACE_SIGN = ['−', '+'];

function faceName(prefix: string, axisIndex: number, sign: number): string {
  return `${prefix}: ${FACE_SIGN[sign > 0 ? 1 : 0]}${AXIS_NAMES[axisIndex]} 面`;
}

function partFaceName(part: PartKind, axisIndex: number, sign: number): string {
  const pn = part === 'door' ? '门板' : '托板';
  return `${pn} ${FACE_SIGN[sign > 0 ? 1 : 0]}${AXIS_NAMES[axisIndex]} 面`;
}

function buildLabel(
  part: PartKind,
  obstacleName: string,
  res: SatResult,
  kind: ContactKind,
  partBox: OBB,
  obstacleBox: OBB,
): ContactLabel {
  if (res.source.type === 'face') {
    const src = res.source;
    if (src.obb === 1) {
      // 分离轴是障碍自身的面轴 => 零件撞到障碍某个面,
      // 用接触点在障碍该轴上的分量判断正/负面
      const sign = dot3(sub3(res.point, obstacleBox.center), obstacleBox.axes[src.axisIndex]) >= 0 ? 1 : -1;
      return {
        kind,
        obstacleFace: faceName(obstacleName, src.axisIndex, sign),
        partSide: `${part === 'door' ? '门板' : '托板'}表面`,
      };
    }
    const sign = dot3(sub3(res.point, partBox.center), partBox.axes[src.axisIndex]) >= 0 ? 1 : -1;
    return {
      kind,
      obstacleFace: `${obstacleName} 表面`,
      partSide: partFaceName(part, src.axisIndex, sign),
    };
  }
  return {
    kind,
    obstacleFace: `${obstacleName} 棱边 (平行 ${AXIS_NAMES[res.source.bAxisIndex]} 轴)`,
    partSide: `${part === 'door' ? '门板' : '托板'} 棱边 (平行 ${AXIS_NAMES[res.source.aAxisIndex]} 轴)`,
  };
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function obstacleOBB(o: ObstacleSpec): OBB {
  return {
    center: [...o.center] as Vec3,
    half: [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  };
}

function partOBB(pose: Pose, part: PartKind): OBB {
  return part === 'door' ? pose.doorOBB : pose.trayOBB;
}

/** 某一时刻全部零件对全部障碍的接触情况 (用于当前姿态高亮) */
export function contactsAt(
  m: Mechanism,
  obstacles: ObstacleSpec[],
  t: number,
  contactTol: number,
  grazingTol: number,
): LiveContact[] {
  const pose = getPose(m, t);
  const out: LiveContact[] = [];
  for (const o of obstacles) {
    for (const part of ['door', 'tray'] as PartKind[]) {
      const res = satOBB(partOBB(pose, part), obstacleOBB(o), contactTol);
      if (res.contact) {
        const kind: ContactKind = res.depth <= grazingTol ? 'grazing' : 'penetrating';
        out.push({
          obstacleId: o.id,
          obstacleName: o.name,
          part,
          kind,
          depth: res.depth,
          point: res.point,
          normal: res.normal,
          label: buildLabel(part, o.name, res, kind, partOBB(pose, part), obstacleOBB(o)),
        });
      }
    }
  }
  return out;
}

/** 在已知接触/分离状态切换处做二分, 返回满足 sat.contact === target 的边界时刻 */
function bisect(
  poseAt: (t: number) => Pose,
  pair: { o: ObstacleSpec; part: PartKind },
  lo: number,
  hi: number,
  target: boolean,
  contactTol: number,
): number {
  let a = lo;
  let b = hi;
  const ob = obstacleOBB(pair.o);
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2;
    const res = satOBB(partOBB(poseAt(mid), pair.part), ob, contactTol);
    if (res.contact === target) b = mid;
    else a = mid;
  }
  return (a + b) / 2;
}

interface Active {
  evt: CollisionEvent;
  prevT: number;
}

/**
 * 完整扫描。事件只覆盖给定 range; 当 range 收紧或转动范围改短时,
 * 调用方丢弃旧结果重新扫描即可 (本函数不缓存任何状态)。
 */
export function scanCollisions(
  m: Mechanism,
  obstacles: ObstacleSpec[],
  opts: ScanOptions,
): ScanResult {
  const steps = opts.steps ?? 600;
  const contactTol = opts.contactTol ?? 1;
  const grazingTol = opts.grazingTol ?? 1;
  const [t0, t1] = opts.range;

  const poseAt = (t: number) => getPose(m, t);
  const obbs = obstacles.map(obstacleOBB);

  const active = new Map<string, Active>();
  const finished: CollisionEvent[] = [];

  const keyOf = (id: string, part: PartKind) => `${id}|${part}`;

  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const prevT = i === 0 ? t0 : t0 + ((t1 - t0) * (i - 1)) / steps;
    const pose = poseAt(t);
    for (let oi = 0; oi < obstacles.length; oi++) {
      const o = obstacles[oi];
      const ob = obbs[oi];
      for (const part of ['door', 'tray'] as PartKind[]) {
        const key = keyOf(o.id, part);
        const res = satOBB(partOBB(pose, part), ob, contactTol);
        const cur = active.get(key);
        if (res.contact) {
          const kindNow: ContactKind = res.depth <= grazingTol ? 'grazing' : 'penetrating';
          if (!cur) {
            const enterT = i === 0 ? t0 : bisect(poseAt, { o, part }, prevT, t, true, contactTol);
            active.set(key, {
              evt: {
                obstacleId: o.id,
                obstacleName: o.name,
                part,
                kind: kindNow,
                enterT,
                exitT: t1,
                maxDepth: Math.max(0, res.depth),
                maxDepthT: t,
                enterLabel: buildLabel(part, o.name, res, kindNow, partOBB(pose, part), ob),
              },
              prevT: t,
            });
          } else {
            if (kindNow === 'penetrating') {
              cur.evt.kind = 'penetrating';
              // 事件升级为侵入时, 标签类型与事件级别保持一致
              cur.evt.enterLabel.kind = 'penetrating';
            }
            if (res.depth > cur.evt.maxDepth) {
              cur.evt.maxDepth = res.depth;
              cur.evt.maxDepthT = t;
            }
            cur.prevT = t;
          }
        } else if (cur) {
          cur.evt.exitT = bisect(poseAt, { o, part }, cur.prevT, t, false, contactTol);
          finished.push(cur.evt);
          active.delete(key);
        }
      }
    }
  }

  for (const cur of active.values()) {
    cur.evt.exitT = t1;
    finished.push(cur.evt);
  }

  finished.sort((x, y) => x.enterT - y.enterT || x.obstacleId.localeCompare(y.obstacleId));
  const merged = mergeNearbyEvents(finished, (t1 - t0) / steps);
  return { events: merged, range: [t0, t1], steps };
}

/**
 * 合并容差边缘的抖动: 同一障碍+零件的相邻事件, 若中断间隙不超过一个采样跨度,
 * 视为同一次接触 (grazing 在接触容差边界上下抖动时会产生这种碎片)。
 */
function mergeNearbyEvents(events: CollisionEvent[], sampleSpan: number): CollisionEvent[] {
  // 仅合并接触容差边界的数值抖动 (中断不超过一个采样跨度);
  // 几何上真实分离的接触窗口必须保留为独立事件。
  const mergeGap = Math.max(sampleSpan, 1e-6);
  const out: CollisionEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.obstacleId === e.obstacleId &&
      prev.part === e.part &&
      e.enterT - prev.exitT <= mergeGap
    ) {
      prev.exitT = e.exitT;
      // 合并后取更严重的类型与更大的侵入
      if (e.kind === 'penetrating') {
        prev.kind = 'penetrating';
        prev.enterLabel.kind = 'penetrating';
      }
      if (e.maxDepth > prev.maxDepth) {
        prev.maxDepth = e.maxDepth;
        prev.maxDepthT = e.maxDepthT;
      }
    } else {
      out.push({ ...e, enterLabel: { ...e.enterLabel } });
    }
  }
  return out;
}
